-- Apply to the existing multi-station schema. Transactional, no remote execution.
begin;
-- Lazy expiry: no scheduler or paid infrastructure. Reads/checkout release old stock.
create or replace function public.expire_unpaid_orders()
returns integer language plpgsql security definer set search_path = public as $$
declare current_event uuid; expired_order record; released integer := 0;
begin
  -- Avoid acquiring an event lock on ordinary reads when there is no work.
  if not exists (select 1 from public.orders o join public.order_events e on e.id=o.event_id
    where e.is_current and e.permanently_closed_at is null
      and o.status='in_attesa_pagamento' and o.created_at <= now()-interval '60 minutes'
      and not exists (select 1 from public.order_claim_devices c where c.order_id=o.id and c.expires_at>now()))
    then return 0; end if;
  select id into current_event from public.order_events
    where is_current and permanently_closed_at is null for update;
  if not found then return 0; end if;
  for expired_order in select o.id,o.items from public.orders o
    where o.event_id=current_event and o.status='in_attesa_pagamento'
      and o.created_at <= now()-interval '60 minutes'
      and not exists (select 1 from public.order_claim_devices c where c.order_id=o.id and c.expires_at>now())
    order by o.id for update of o
  loop
    perform public.apply_order_stock(expired_order.items,'[]'::jsonb);
    update public.orders set status='annullato',cancelled_at=now(),alias=null,notes=null,
      claimed_token_hash=null,claim_expires_at=null where id=expired_order.id;
    delete from public.order_claim_devices where order_id=expired_order.id;
    released := released+1;
  end loop;
  return released;
end;
$$;
revoke execute on function public.expire_unpaid_orders() from public, anon, authenticated;
create index if not exists orders_pending_expiry_idx on public.orders(event_id,created_at)
  where status='in_attesa_pagamento';


create or replace function public.get_ordering_status()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  event_row public.order_events%rowtype;
  pending_count integer;
  reason text;
begin
  perform public.expire_unpaid_orders();
  select * into event_row from public.order_events where is_current limit 1;
  if not found then return jsonb_build_object('accepting', false, 'reason', 'no_event'); end if;
  select count(*) into pending_count from public.orders
    where event_id = event_row.id and status = 'in_attesa_pagamento';
  reason := case
    when event_row.permanently_closed_at is not null then 'event_closed'
    when event_row.manual_closed then 'ordering_paused'
    when now() < event_row.opens_at then 'not_open_yet'
    when now() > event_row.closes_at then 'ordering_closed'
    when pending_count >= event_row.max_pending_orders then 'capacity_reached'
    else null end;
  return jsonb_build_object(
    'accepting', reason is null,
    'reason', reason,
    'event_id', event_row.id,
    'event_name', event_row.name,
    'opens_at', event_row.opens_at,
    'closes_at', event_row.closes_at,
    'reservation_minutes', 60, 'max_item_quantity', 25, 'max_order_quantity', 60
  );
end;
$$;

create or replace function public.submit_public_order(
  p_alias text,
  p_notes text,
  p_items jsonb,
  p_client_request_id uuid,
  p_qr_token text,
  p_bot_field text default ''
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

  select * into existing_order from public.orders
  where event_id = event_row.id and client_request_id = p_client_request_id;
  if found then
    if existing_order.qr_token_hash is distinct from encode(extensions.digest(p_qr_token, 'sha256'), 'hex') then
      raise exception 'request_id_conflict';
    end if;
    if existing_order.status <> 'in_attesa_pagamento' then
      raise exception 'request_already_processed';
    end if;
    return jsonb_build_object(
      'event_id', event_row.id, 'event_name', event_row.name,
      'order_id', existing_order.id, 'display_number', existing_order.display_number,
      'alias', existing_order.alias, 'notes', existing_order.notes,
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
    qr_token_hash, client_request_id
  ) values (
    event_row.id, next_number, btrim(p_alias), nullif(btrim(coalesce(p_notes, '')), ''),
    normalized, calculated_total::numeric(7,2), 'in_attesa_pagamento',
    encode(extensions.digest(p_qr_token, 'sha256'), 'hex'), p_client_request_id
  ) returning id into existing_order.id;

  return jsonb_build_object(
    'event_id', event_row.id, 'event_name', event_row.name,
    'order_id', existing_order.id, 'display_number', next_number,
    'alias', btrim(p_alias), 'notes', nullif(btrim(coalesce(p_notes, '')), ''),
    'items', normalized, 'total', calculated_total, 'qr_token', p_qr_token
  );
end;
$$;

create or replace function public.get_cashier_pending_orders()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare result jsonb;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role in ('cassa', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform public.expire_unpaid_orders();
  delete from public.order_claim_devices where expires_at <= now();
  select coalesce(jsonb_agg(to_jsonb(queue_row) order by queue_row.created_at), '[]'::jsonb)
  into result from (
    select orders_row.id, orders_row.event_id, orders_row.display_number,
      orders_row.alias, orders_row.total, orders_row.created_at, orders_row.status,
      claim.station as claimed_station, claim.expires_at as claim_expires_at
    from public.orders orders_row
    left join lateral (
      select min(station) station, max(expires_at) expires_at
      from public.order_claim_devices
      where order_id = orders_row.id and expires_at > now()
    ) claim on true
    where orders_row.status = 'in_attesa_pagamento'
  ) queue_row;
  return result;
end;
$$;

create or replace function public.get_public_order_statuses(p_qr_tokens text[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare result jsonb;
begin
  if p_qr_tokens is null or cardinality(p_qr_tokens) < 1 or cardinality(p_qr_tokens) > 50 then
    raise exception 'invalid_qr_tokens';
  end if;
  if exists (select 1 from unnest(p_qr_tokens) token
    where token is null or length(token) not between 32 and 80) then raise exception 'invalid_qr_tokens'; end if;
  perform public.expire_unpaid_orders();
  select coalesce(jsonb_agg(jsonb_build_object(
    'order_id', orders_row.id, 'status', orders_row.status,
    'progress', coalesce(progress.payload, '[]'::jsonb)
  )), '[]'::jsonb) into result
  from public.orders orders_row
  left join lateral (
    select jsonb_agg(jsonb_build_object(
      'station', station, 'quantity', quantity, 'delivered', delivered
    ) order by station) payload
    from (select station, sum(quantity)::integer quantity,
      sum(delivered_quantity)::integer delivered
      from public.order_fulfillment_items where order_id = orders_row.id group by station) grouped
  ) progress on true
  where orders_row.qr_token_hash in (
    select encode(extensions.digest(token, 'sha256'), 'hex') from unnest(p_qr_tokens) token
  );
  return result;
end;
$$;

create or replace function public.claim_order_for_station(
  p_order_id uuid, p_station text, p_device_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare order_row public.orders%rowtype; device_hash_value text; active_station text;
begin
  if not exists (select 1 from public.profiles profile where profile.id = auth.uid() and profile.role in ('cassa', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_station !~ '^cassa_[1-5]$' then raise exception 'invalid_station'; end if;
  if p_device_id is null or length(p_device_id) not between 32 and 80 then raise exception 'invalid_device'; end if;
  perform 1 from public.order_events e join public.orders o on o.event_id=e.id
    where o.id=p_order_id and e.permanently_closed_at is null for key share of e;
  if not found then raise exception 'event_closed'; end if;
  device_hash_value := encode(extensions.digest(p_device_id, 'sha256'), 'hex');
  delete from public.order_claim_devices where expires_at <= now();
  select * into order_row from public.orders where id = p_order_id for update;
  if not found or order_row.status <> 'in_attesa_pagamento' then raise exception 'order_not_available'; end if;
  if order_row.created_at <= now()-interval '60 minutes' and not exists (
    select 1 from public.order_claim_devices c where c.order_id=p_order_id and c.expires_at>now()
  ) then raise exception 'reservation_expired'; end if;
  select claims.station into active_station from public.order_claim_devices claims
    where claims.order_id = p_order_id and claims.expires_at > now() limit 1;
  if active_station is not null and active_station <> p_station then raise exception 'order_already_claimed'; end if;
  insert into public.order_claim_devices (order_id, station, device_hash, expires_at)
    values (p_order_id, p_station, device_hash_value, now() + interval '30 seconds')
    on conflict (order_id, device_hash) do update
      set station = excluded.station, expires_at = excluded.expires_at;
  return (to_jsonb(order_row) - 'qr_token_hash' - 'claimed_token_hash' - 'client_request_id')
    || jsonb_build_object('claimed_station', p_station, 'claim_expires_at', now() + interval '30 seconds');
end;
$$;
commit;
