begin;
alter table public.orders add column if not exists recovery_token_hash text;
alter table public.orders add column if not exists recovery_request_id uuid;
create index if not exists orders_recovery_idx on public.orders(recovery_token_hash,created_at,id) where recovery_token_hash is not null;
create or replace function public.recovery_order_qr(p_token text,p_request uuid)
returns text language sql immutable set search_path=public as $$
 select substr(h,1,8)||'-'||substr(h,9,4)||'-4'||substr(h,14,3)||'-8'||substr(h,18,3)||'-'||substr(h,21,12)
 from (select encode(extensions.hmac(p_request::text,p_token,'sha256'),'hex') h) derived;
$$;
revoke execute on function public.recovery_order_qr(text,uuid) from public,anon,authenticated;
create or replace function public.recover_order_history(p_token text,p_before uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare token_hash text; result jsonb;
begin
 if p_token is null or p_token !~ '^[A-Za-z0-9_-]{43}$' then raise exception 'invalid_recovery_token'; end if;
 token_hash:=encode(extensions.digest(p_token,'sha256'),'hex');
 perform public.expire_unpaid_orders();
 perform public.purge_completed_order_personal_data();
 select coalesce(jsonb_agg(to_jsonb(page) order by page.created_at desc,page.order_id desc),'[]'::jsonb) into result from (
  select o.id order_id,o.event_id,e.name event_name,o.display_number,coalesce(o.alias,'Ordine #'||o.display_number) alias,o.notes,o.items,o.total,o.status,o.created_at,
    public.recovery_order_qr(p_token,o.recovery_request_id) qr_token,e.permanently_closed_at event_closed_at
  from public.orders o join public.order_events e on e.id=o.event_id
  where o.recovery_token_hash=token_hash and o.recovery_request_id is not null
    and (p_before is null or (o.created_at,o.id)<(select created_at,id from public.orders where id=p_before and recovery_token_hash=token_hash))
  order by o.created_at desc,o.id desc limit 50
 ) page;
 return result;
end;
$$;
revoke execute on function public.recover_order_history(text,uuid) from public;
grant execute on function public.recover_order_history(text,uuid) to anon,authenticated;

drop function if exists public.submit_public_order(text,text,jsonb,uuid,text,text,uuid);
create or replace function public.submit_public_order(
  p_alias text,
  p_notes text,
  p_items jsonb,
  p_client_request_id uuid,
  p_qr_token text,
  p_bot_field text default '',
  p_expected_event_id uuid default null,
  p_recovery_token text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  event_row public.order_events%rowtype;
  existing_order public.orders%rowtype;
  normalized jsonb;
  calculated_total numeric;
  next_number bigint;
  pending_count integer;
begin
  if p_recovery_token is not null and (p_recovery_token !~ '^[A-Za-z0-9_-]{43}$'
    or p_qr_token is distinct from public.recovery_order_qr(p_recovery_token,p_client_request_id)) then
    raise exception 'invalid_recovery_token';
  end if;
  if coalesce(p_bot_field, '') <> '' then raise exception 'invalid_request'; end if;
  if p_alias is null or length(btrim(p_alias)) not between 2 and 32
    or btrim(p_alias) !~ '^[[:alnum:]][[:alnum:] _-]*$' then
    raise exception 'invalid_alias';
  end if;
  if length(coalesce(p_notes, '')) > 300 then raise exception 'notes_too_long'; end if;
  if p_client_request_id is null then raise exception 'invalid_client_request_id'; end if;
  if p_qr_token is null or length(p_qr_token) not between 32 and 80 then raise exception 'invalid_qr_token'; end if;

  perform public.expire_unpaid_orders();

  select * into event_row from public.order_events where is_current for no key update;
  if not found then raise exception 'no_event'; end if;
  if p_expected_event_id is not null and p_expected_event_id <> event_row.id then raise exception 'event_changed'; end if;

  select * into existing_order from public.orders
  where event_id = event_row.id and client_request_id = p_client_request_id;
  if found then
    if existing_order.qr_token_hash is distinct from encode(extensions.digest(p_qr_token, 'sha256'), 'hex') then
      raise exception 'request_id_conflict';
    end if;
    return jsonb_build_object(
      'event_id', event_row.id, 'event_name', event_row.name,
      'order_id', existing_order.id, 'display_number', existing_order.display_number,
      'status', existing_order.status, 'alias', existing_order.alias, 'notes', existing_order.notes,
      'items', existing_order.items, 'total', existing_order.total, 'qr_token', p_qr_token
    );
  end if;

  if event_row.permanently_closed_at is not null then raise exception 'event_closed'; end if;
  if event_row.manual_closed then raise exception 'ordering_paused'; end if;
  if now() < event_row.opens_at then raise exception 'not_open_yet'; end if;
  if now() > event_row.closes_at then raise exception 'ordering_closed'; end if;
  select count(*) into pending_count from public.orders
    where event_id = event_row.id and status = 'in_attesa_pagamento';
  if pending_count >= event_row.max_pending_orders then raise exception 'capacity_reached'; end if;

  normalized := public.normalize_order_items(p_items);
  if exists (select 1 from jsonb_array_elements(normalized) line where (line->>'qty')::integer > 25)
    or (select sum((line->>'qty')::integer) from jsonb_array_elements(normalized) line) > 60 then
    raise exception 'public_order_quantity_limit';
  end if;
  select sum((line->>'price')::numeric * (line->>'qty')::integer)
    into calculated_total from jsonb_array_elements(normalized) line;
  if calculated_total > 99999.99 then raise exception 'order_total_too_high'; end if;
  perform public.apply_order_stock('[]'::jsonb, normalized);
  select coalesce(max(display_number), 0) + 1 into next_number
    from public.orders where event_id = event_row.id;

  insert into public.orders (
    event_id, display_number, alias, notes, items, total, status,
    qr_token_hash, client_request_id, recovery_token_hash, recovery_request_id
  ) values (
    event_row.id, next_number, btrim(p_alias), nullif(btrim(coalesce(p_notes, '')), ''),
    normalized, calculated_total::numeric(7,2), 'in_attesa_pagamento',
    encode(extensions.digest(p_qr_token, 'sha256'), 'hex'), p_client_request_id,
    case when p_recovery_token is not null then encode(extensions.digest(p_recovery_token,'sha256'),'hex') end,
    case when p_recovery_token is not null then p_client_request_id end
  ) returning id into existing_order.id;

  return jsonb_build_object(
    'event_id', event_row.id, 'event_name', event_row.name,
    'order_id', existing_order.id, 'display_number', next_number,
    'status', 'in_attesa_pagamento', 'alias', btrim(p_alias), 'notes', nullif(btrim(coalesce(p_notes, '')), ''),
    'items', normalized, 'total', calculated_total, 'qr_token', p_qr_token
  );
end;
$$;
revoke execute on function public.submit_public_order(text,text,jsonb,uuid,text,text,uuid,text) from public;
grant execute on function public.submit_public_order(text,text,jsonb,uuid,text,text,uuid,text) to anon,authenticated;
commit;
