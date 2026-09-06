begin;
alter table public.orders add column if not exists preparation_mode text not null default 'immediate' check(preparation_mode in ('immediate','deferred'));
alter table public.orders add column if not exists kitchen_state text not null default 'none' check(kitchen_state in ('none','reserved','dormant','waiting','active','done'));
alter table public.orders add column if not exists kitchen_requested_at timestamptz;
alter table public.orders add column if not exists kitchen_started_at timestamptz;
create index if not exists orders_kitchen_queue_idx on public.orders(event_id,kitchen_state,kitchen_requested_at,id);
-- Existing paid food orders keep their place; nothing is cancelled during upgrade.
update public.orders o set kitchen_state='active',kitchen_requested_at=paid_at,kitchen_started_at=paid_at
where kitchen_state='none' and status in ('pagato','ritiro_parziale')
and exists(select 1 from public.order_fulfillment_items f where f.order_id=o.id and f.category='cibo' and f.delivered_quantity<f.quantity);

create or replace function public.kitchen_occupied(p_event_id uuid,p_exclude uuid default null)
returns integer language sql stable security definer set search_path=public as $$
 select count(*)::integer from public.orders o where o.event_id=p_event_id
 and (p_exclude is null or o.id<>p_exclude)
 and ((o.kitchen_state='active' and o.status in ('pagato','ritiro_parziale')
       and exists(select 1 from public.order_fulfillment_items f where f.order_id=o.id and f.category='cibo' and f.delivered_quantity<f.quantity))
   or (o.kitchen_state='reserved' and o.status='in_attesa_pagamento'
       and exists(select 1 from public.order_claim_devices c where c.order_id=o.id and c.expires_at>now())));
$$;
revoke execute on function public.kitchen_occupied(uuid,uuid) from public,anon,authenticated;

create or replace function public.promote_kitchen_waiting(p_event_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare free_slots integer;
begin
 if not exists(select 1 from public.orders where event_id=p_event_id and kitchen_state='waiting' and status in ('pagato','ritiro_parziale')) then return; end if;
 perform 1 from public.order_events where id=p_event_id and is_current and permanently_closed_at is null for update;
 if not found then return; end if;
 free_slots:=greatest(0,100-public.kitchen_occupied(p_event_id));
 if free_slots=0 then return; end if;
 update public.orders set kitchen_state='active',kitchen_started_at=now()
 where id in (select id from public.orders where event_id=p_event_id and kitchen_state='waiting'
   and status in ('pagato','ritiro_parziale') order by kitchen_requested_at,id limit free_slots for update);
end;
$$;
revoke execute on function public.promote_kitchen_waiting(uuid) from public,anon,authenticated;

create or replace function public.set_order_preparation(p_order_id uuid,p_station text,p_device_id text,p_mode text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare target public.orders%rowtype; has_food boolean;
begin
 if not exists(select 1 from public.profiles where id=auth.uid() and role in ('admin','cassa')) then
  raise exception 'not_authorized' using errcode='42501'; end if;
 if p_mode is null or p_mode not in ('immediate','deferred') then raise exception 'invalid_preparation_mode'; end if;
 perform public.lock_open_order_event(p_order_id);
 select * into target from public.orders where id=p_order_id for update;
 if not found or target.status<>'in_attesa_pagamento' or not exists(select 1 from public.order_claim_devices
   where order_id=p_order_id and station=p_station and device_hash=encode(extensions.digest(p_device_id,'sha256'),'hex') and expires_at>now())
 then raise exception 'claim_lost'; end if;
 has_food:=exists(select 1 from jsonb_array_elements(target.items) i where i->>'category'='cibo');
 -- Preserve an already reserved slot; new reservations follow paid customers waiting.
 perform public.promote_kitchen_waiting(target.event_id);
 update public.orders set preparation_mode=case when has_food then p_mode else 'immediate' end,
  kitchen_state=case when not has_food then 'none' when p_mode='deferred' then 'dormant'
    when public.kitchen_occupied(target.event_id,p_order_id)<100 then 'reserved' else 'none' end
 where id=p_order_id returning * into target;
 return to_jsonb(target)-'qr_token_hash'-'claimed_token_hash'-'client_request_id'-'recovery_token_hash'-'recovery_request_id';
end;
$$;
revoke execute on function public.set_order_preparation(uuid,text,text,text) from public;
grant execute on function public.set_order_preparation(uuid,text,text,text) to authenticated;

create or replace function public.activate_kitchen_order(p_order_id uuid,p_station text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare target public.orders%rowtype;
begin
 if p_station is null or p_station not in ('cucina','primi','secondi','contorni','dolci','furgone') or not public.fulfillment_station_allowed(p_station)
 then raise exception 'not_authorized' using errcode='42501'; end if;
 perform public.lock_open_order_event(p_order_id);
 select * into target from public.orders where id=p_order_id for update;
 if not found or target.status not in ('pagato','ritiro_parziale') or not exists(
   select 1 from public.order_fulfillment_items where order_id=p_order_id and category='cibo'
   and delivered_quantity<quantity and (p_station='cucina' or station=p_station))
 then raise exception 'order_not_available'; end if;
 if target.kitchen_state='dormant' then
   update public.orders set kitchen_state='waiting',kitchen_requested_at=clock_timestamp() where id=p_order_id;
 end if;
 perform public.promote_kitchen_waiting(target.event_id);
 select * into target from public.orders where id=p_order_id;
 return jsonb_build_object('order_id',target.id,'kitchen_state',target.kitchen_state);
end;
$$;
revoke execute on function public.activate_kitchen_order(uuid,text) from public;
grant execute on function public.activate_kitchen_order(uuid,text) to authenticated;

create or replace function public.reconcile_kitchen_order(p_order_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare target public.orders%rowtype;
begin
 select * into target from public.orders where id=p_order_id;
 if not exists(select 1 from public.order_fulfillment_items where order_id=p_order_id and category='cibo') then return; end if;
 if not exists(select 1 from public.order_fulfillment_items where order_id=p_order_id and category='cibo' and delivered_quantity<quantity) then
   update public.orders set kitchen_state='done' where id=p_order_id;
 elsif target.kitchen_state='done' then
   -- An undo restores quantities but cannot overfill the kitchen.
   update public.orders set kitchen_state='waiting',kitchen_requested_at=clock_timestamp(),kitchen_started_at=null where id=p_order_id;
 end if;
 perform public.promote_kitchen_waiting(target.event_id);
end;
$$;
revoke execute on function public.reconcile_kitchen_order(uuid) from public,anon,authenticated;

drop function if exists public.submit_public_order(text,text,jsonb,uuid,text,text,uuid,text);
drop function if exists public.create_counter_order(text,text,jsonb);
create or replace function public.lock_open_order_event(p_order_id uuid)
returns void language plpgsql security definer set search_path=public as $$
begin
  perform 1 from public.order_events e join public.orders o on o.event_id=e.id
    where o.id=p_order_id and e.is_current and e.permanently_closed_at is null for update of e;
  if not found then raise exception 'event_closed'; end if;
end;
$$;

create or replace function public.submit_public_order(
  p_alias text,
  p_notes text,
  p_items jsonb,
  p_client_request_id uuid,
  p_qr_token text,
  p_bot_field text default '',
  p_expected_event_id uuid default null,
  p_recovery_token text default null,
  p_preparation_mode text default 'immediate'
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
  if p_preparation_mode is null or p_preparation_mode not in ('immediate','deferred') then raise exception 'invalid_preparation_mode'; end if;
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
      'preparation_mode',existing_order.preparation_mode,'kitchen_state',existing_order.kitchen_state,
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

  -- The event lock already serializes creation. Retry lookup above does not consume this limit.
  if p_recovery_token is not null and (select count(*) from public.orders
      where recovery_token_hash = encode(extensions.digest(p_recovery_token,'sha256'),'hex')
        and created_at > now() - interval '1 minute') >= 3 then
    raise exception 'public_order_rate_limit';
  end if;

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
    qr_token_hash, client_request_id, recovery_token_hash, recovery_request_id, preparation_mode
  ) values (
    event_row.id, next_number, btrim(p_alias), nullif(btrim(coalesce(p_notes, '')), ''),
    normalized, calculated_total::numeric(7,2), 'in_attesa_pagamento',
    encode(extensions.digest(p_qr_token, 'sha256'), 'hex'), p_client_request_id,
    case when p_recovery_token is not null then encode(extensions.digest(p_recovery_token,'sha256'),'hex') end,
    case when p_recovery_token is not null then p_client_request_id end,
    case when exists(select 1 from jsonb_array_elements(normalized) i where i->>'category'='cibo') then p_preparation_mode else 'immediate' end
  ) returning id into existing_order.id;

  return jsonb_build_object(
    'event_id', event_row.id, 'event_name', event_row.name,
    'order_id', existing_order.id, 'display_number', next_number,
    'status', 'in_attesa_pagamento', 'alias', btrim(p_alias), 'notes', nullif(btrim(coalesce(p_notes, '')), ''),
    'preparation_mode',p_preparation_mode,'kitchen_state','none',
    'items', normalized, 'total', calculated_total, 'qr_token', p_qr_token
  );
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
    where o.id=p_order_id and e.permanently_closed_at is null for update of e;
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
  perform public.set_order_preparation(p_order_id,p_station,p_device_id,order_row.preparation_mode);
  select * into order_row from public.orders where id=p_order_id;
  return (to_jsonb(order_row) - 'qr_token_hash' - 'claimed_token_hash' - 'client_request_id')
    || jsonb_build_object('claimed_station', p_station, 'claim_expires_at', now() + interval '30 seconds');
end;
$$;

create or replace function public.pay_order_for_station(
  p_order_id uuid, p_station text, p_device_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare order_row public.orders%rowtype; event_row public.order_events%rowtype; device_hash_value text;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role in ('cassa', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  device_hash_value := encode(extensions.digest(p_device_id, 'sha256'), 'hex');
  select event.* into event_row from public.order_events event
    join public.orders target on target.event_id = event.id
    where target.id = p_order_id for update of event;
  if not found or event_row.permanently_closed_at is not null then raise exception 'event_closed'; end if;
  select * into order_row from public.orders where id = p_order_id for update;
  if not found or order_row.status <> 'in_attesa_pagamento' or not exists (
    select 1 from public.order_claim_devices claims where claims.order_id = p_order_id
      and claims.station = p_station and claims.device_hash = device_hash_value and claims.expires_at > now()
  ) then raise exception 'claim_lost'; end if;
  perform public.promote_kitchen_waiting(order_row.event_id);
  if order_row.preparation_mode='immediate' and exists(select 1 from jsonb_array_elements(order_row.items) i where i->>'category'='cibo')
    and public.kitchen_occupied(order_row.event_id,p_order_id)>=100 then raise exception 'kitchen_capacity_reached'; end if;
  perform public.seed_order_fulfillment(order_row.id, order_row.items);
  update public.orders set kitchen_state=case when not exists(select 1 from jsonb_array_elements(order_row.items) i where i->>'category'='cibo') then 'none' when order_row.preparation_mode='deferred' then 'dormant' else 'active' end,
    kitchen_requested_at=case when order_row.preparation_mode='immediate' then clock_timestamp() end,
    kitchen_started_at=case when order_row.preparation_mode='immediate' then clock_timestamp() end,
    status = 'pagato', paid_at = now(), delivered_at = null,
    completed_at = null, claimed_token_hash = null, claim_expires_at = null
    where id = p_order_id returning * into order_row;
  delete from public.order_claim_devices where order_id = p_order_id;
  return to_jsonb(order_row) - 'qr_token_hash' - 'claimed_token_hash' - 'client_request_id';
end;
$$;

create or replace function public.create_counter_order(p_alias text, p_notes text, p_items jsonb, p_preparation_mode text default 'immediate')
returns jsonb language plpgsql security definer set search_path = public as $$
declare event_row public.order_events%rowtype; normalized jsonb; calculated_total numeric;
  next_number bigint; created_order public.orders%rowtype;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role in ('cassa', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_preparation_mode is null or p_preparation_mode not in ('immediate','deferred') then raise exception 'invalid_preparation_mode'; end if;
  if p_alias is null or length(btrim(p_alias)) not between 2 and 32 then raise exception 'invalid_alias'; end if;
  if length(coalesce(p_notes, '')) > 300 then raise exception 'notes_too_long'; end if;
  select * into event_row from public.order_events where is_current for update;
  if not found or event_row.permanently_closed_at is not null then raise exception 'event_closed'; end if;
  normalized := public.normalize_order_items(p_items);
  perform public.promote_kitchen_waiting(event_row.id);
  if p_preparation_mode='immediate' and exists(select 1 from jsonb_array_elements(normalized) i where i->>'category'='cibo')
    and public.kitchen_occupied(event_row.id)>=100 then raise exception 'kitchen_capacity_reached'; end if;
  perform public.apply_order_stock('[]'::jsonb, normalized);
  select sum((line->>'price')::numeric * (line->>'qty')::integer)
    into calculated_total from jsonb_array_elements(normalized) line;
  select coalesce(max(display_number), 0) + 1 into next_number from public.orders where event_id = event_row.id;
  insert into public.orders (event_id, display_number, alias, notes, items, total, status, paid_at, preparation_mode)
    values (event_row.id, next_number, btrim(p_alias), nullif(btrim(coalesce(p_notes, '')), ''),
      normalized, calculated_total::numeric(7,2), 'pagato', now(), p_preparation_mode) returning * into created_order;
  perform public.seed_order_fulfillment(created_order.id, created_order.items);
  update public.orders set kitchen_state=case when not exists(select 1 from public.order_fulfillment_items where order_id=created_order.id and category='cibo') then 'none'
    when p_preparation_mode='deferred' then 'dormant' else 'active' end,
    kitchen_requested_at=case when p_preparation_mode='immediate' then clock_timestamp() end,
    kitchen_started_at=case when p_preparation_mode='immediate' then clock_timestamp() end
    where id=created_order.id returning * into created_order;
  return to_jsonb(created_order) - 'qr_token_hash' - 'claimed_token_hash' - 'client_request_id';
end;
$$;

create or replace function public.get_fulfillment_queue(p_station text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare result jsonb;
begin
  if not public.fulfillment_station_allowed(p_station) then raise exception 'not_authorized' using errcode = '42501'; end if;
  perform public.promote_kitchen_waiting(id) from public.order_events where is_current and permanently_closed_at is null;
  perform public.purge_completed_order_personal_data();
  select coalesce(jsonb_agg(order_payload order by kitchen_started_at nulls last, paid_at, display_number), '[]'::jsonb) into result
  from (
    select orders_row.id, orders_row.display_number, orders_row.alias, orders_row.notes,
      orders_row.paid_at, orders_row.status, orders_row.kitchen_state, orders_row.kitchen_started_at,
      jsonb_agg(jsonb_build_object(
        'id', fulfillment.menu_item_id, 'name', fulfillment.name,
        'subcategory', fulfillment.subcategory, 'station', fulfillment.station,
        'quantity', fulfillment.quantity, 'delivered_quantity', fulfillment.delivered_quantity
      ) order by fulfillment.subcategory, fulfillment.name) as items
    from public.orders orders_row
    join public.order_fulfillment_items fulfillment on fulfillment.order_id = orders_row.id
    where orders_row.status in ('pagato', 'ritiro_parziale')
      and (fulfillment.category<>'cibo' or orders_row.kitchen_state='active')
      and fulfillment.delivered_quantity < fulfillment.quantity
      and (case when p_station = 'cucina' then fulfillment.category = 'cibo' else fulfillment.station = p_station end)
    group by orders_row.id
  ) order_payload;
  return result;
end;
$$;

create or replace function public.get_fulfillment_order_by_qr(p_qr_token text, p_station text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare result jsonb;
begin
  if not public.fulfillment_station_allowed(p_station) then raise exception 'not_authorized' using errcode = '42501'; end if;
  if p_qr_token is null or length(p_qr_token) not between 32 and 80 then raise exception 'invalid_qr_token'; end if;
  select jsonb_build_object(
    'id', orders_row.id, 'display_number', orders_row.display_number,
    'alias', orders_row.alias, 'notes', orders_row.notes, 'paid_at', orders_row.paid_at,
    'status', orders_row.status, 'kitchen_state',orders_row.kitchen_state,
    'items', jsonb_agg(jsonb_build_object(
      'id', fulfillment.menu_item_id, 'name', fulfillment.name,
      'subcategory', fulfillment.subcategory, 'station', fulfillment.station,
      'quantity', fulfillment.quantity, 'delivered_quantity', fulfillment.delivered_quantity
    ) order by fulfillment.name)
  ) into result
  from public.orders orders_row
  join public.order_fulfillment_items fulfillment on fulfillment.order_id = orders_row.id
  where orders_row.qr_token_hash = encode(extensions.digest(p_qr_token, 'sha256'), 'hex')
    and orders_row.status in ('pagato', 'ritiro_parziale')
    and fulfillment.delivered_quantity < fulfillment.quantity
    and (case when p_station = 'cucina' then fulfillment.category = 'cibo' else fulfillment.station = p_station end)
  group by orders_row.id;
  if result is null then raise exception 'order_not_available'; end if;
  return result;
end;
$$;

create or replace function public.deliver_fulfillment_items(
  p_order_id uuid, p_station text, p_items jsonb
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare order_row public.orders%rowtype; normalized jsonb; delivery_id uuid;
  total_quantity integer; total_delivered integer;
begin
  if p_station = 'cucina' or not public.fulfillment_station_allowed(p_station) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'invalid_delivery';
  end if;
  if exists (select 1 from jsonb_array_elements(p_items) item
    where coalesce(item->>'id', '') !~* '^[0-9a-f-]{36}$'
      or coalesce(item->>'qty', '') !~ '^[1-9][0-9]*$') then raise exception 'invalid_delivery'; end if;
  perform public.lock_open_order_event(p_order_id);
  select * into order_row from public.orders where id = p_order_id for update;
  if not found or order_row.status not in ('pagato', 'ritiro_parziale') then raise exception 'order_not_available'; end if;

  if p_station in ('primi','secondi','contorni','dolci','furgone') and order_row.kitchen_state<>'active'
    then raise exception 'kitchen_not_active'; end if;
  with requested as (
    select (item->>'id')::uuid id, sum((item->>'qty')::integer)::integer qty
    from jsonb_array_elements(p_items) item group by 1
  )
  select jsonb_agg(jsonb_build_object('id', requested.id, 'qty', requested.qty)) into normalized
  from requested join public.order_fulfillment_items fulfillment
    on fulfillment.order_id = p_order_id and fulfillment.menu_item_id = requested.id
  where fulfillment.station = p_station and requested.qty <= fulfillment.quantity - fulfillment.delivered_quantity;
  if normalized is null or jsonb_array_length(normalized) <> (
    select count(distinct item->>'id') from jsonb_array_elements(p_items) item
  ) then raise exception 'invalid_delivery_quantity'; end if;

  update public.order_fulfillment_items fulfillment
  set delivered_quantity = fulfillment.delivered_quantity + requested.qty
  from (select (item->>'id')::uuid id, (item->>'qty')::integer qty
    from jsonb_array_elements(normalized) item) requested
  where fulfillment.order_id = p_order_id and fulfillment.menu_item_id = requested.id;

  insert into public.fulfillment_deliveries (order_id, station, quantities, delivered_by)
    values (p_order_id, p_station, normalized, auth.uid()) returning id into delivery_id;
  select sum(quantity), sum(delivered_quantity) into total_quantity, total_delivered
    from public.order_fulfillment_items where order_id = p_order_id;
  update public.orders set
    status = case when total_delivered >= total_quantity then 'consegnato' else 'ritiro_parziale' end,
    delivered_at = case when total_delivered >= total_quantity then now() else null end,
    completed_at = case when total_delivered >= total_quantity then now() else null end
    where id = p_order_id;
  perform public.reconcile_kitchen_order(p_order_id);
  return jsonb_build_object('delivery_id', delivery_id,
    'status', case when total_delivered >= total_quantity then 'consegnato' else 'ritiro_parziale' end);
end;
$$;

create or replace function public.undo_fulfillment_delivery(p_delivery_id uuid, p_station text)
returns void language plpgsql security definer set search_path = public as $$
declare delivery_row public.fulfillment_deliveries%rowtype; user_role text;
begin
  select role into user_role from public.profiles where id = auth.uid();
  if not coalesce(user_role in ('admin','cucina','bar'),false) then
    raise exception 'not_authorized' using errcode='42501';
  end if;
  select * into delivery_row from public.fulfillment_deliveries where id=p_delivery_id;
  if not found then raise exception 'delivery_not_available'; end if;
  perform public.lock_open_order_event(delivery_row.order_id);
  perform 1 from public.orders where id=delivery_row.order_id for update;
  select * into delivery_row from public.fulfillment_deliveries where id=p_delivery_id for update;
  if not found or delivery_row.reversed_at is not null then raise exception 'delivery_not_available'; end if;
  if user_role <> 'admin' and (
    not coalesce(public.fulfillment_station_allowed(p_station),false)
    or delivery_row.station is distinct from p_station
    or delivery_row.created_at <= now()-interval '5 minutes'
  ) then raise exception 'undo_window_expired'; end if;
  update public.order_fulfillment_items fulfillment
  set delivered_quantity = greatest(0, fulfillment.delivered_quantity - requested.qty)
  from (select (item->>'id')::uuid id, (item->>'qty')::integer qty
    from jsonb_array_elements(delivery_row.quantities) item) requested
  where fulfillment.order_id = delivery_row.order_id and fulfillment.menu_item_id = requested.id;
  update public.fulfillment_deliveries set reversed_at = now(), reversed_by = auth.uid()
    where id = p_delivery_id;
  update public.orders set status = case when exists (
      select 1 from public.order_fulfillment_items where order_id = delivery_row.order_id and delivered_quantity > 0
    ) then 'ritiro_parziale' else 'pagato' end,
    delivered_at = null, completed_at = null where id = delivery_row.order_id;
  perform public.reconcile_kitchen_order(delivery_row.order_id);
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
  perform public.purge_completed_order_personal_data();
  select coalesce(jsonb_agg(jsonb_build_object(
    'order_id', orders_row.id, 'status', orders_row.status,
    'preparation_mode',orders_row.preparation_mode,'kitchen_state',orders_row.kitchen_state,
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
revoke execute on function public.submit_public_order(text,text,jsonb,uuid,text,text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.submit_public_order(text,text,jsonb,uuid,text,text,uuid,text,text) to service_role;
revoke execute on function public.create_counter_order(text,text,jsonb,text) from public;
grant execute on function public.create_counter_order(text,text,jsonb,text) to authenticated;
create or replace function public.get_fulfillment_order_by_number(p_display_number integer, p_station text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare result jsonb;
begin
  if not public.fulfillment_station_allowed(p_station) then raise exception 'not_authorized' using errcode = '42501'; end if;
  if p_display_number is null or p_display_number<1 then raise exception 'invalid_order_number'; end if;
  select jsonb_build_object(
    'id', orders_row.id, 'display_number', orders_row.display_number,
    'alias', orders_row.alias, 'notes', orders_row.notes, 'paid_at', orders_row.paid_at,
    'status', orders_row.status, 'kitchen_state',orders_row.kitchen_state,
    'items', jsonb_agg(jsonb_build_object(
      'id', fulfillment.menu_item_id, 'name', fulfillment.name,
      'subcategory', fulfillment.subcategory, 'station', fulfillment.station,
      'quantity', fulfillment.quantity, 'delivered_quantity', fulfillment.delivered_quantity
    ) order by fulfillment.name)
  ) into result
  from public.orders orders_row
  join public.order_fulfillment_items fulfillment on fulfillment.order_id = orders_row.id
  where orders_row.display_number=p_display_number and orders_row.event_id=(select id from public.order_events where is_current and permanently_closed_at is null)
    and orders_row.status in ('pagato', 'ritiro_parziale')
    and fulfillment.delivered_quantity < fulfillment.quantity
    and (case when p_station = 'cucina' then fulfillment.category = 'cibo' else fulfillment.station = p_station end)
  group by orders_row.id;
  if result is null then raise exception 'order_not_available'; end if;
  return result;
end;
$$;
revoke execute on function public.get_fulfillment_order_by_number(integer,text) from public;
grant execute on function public.get_fulfillment_order_by_number(integer,text) to authenticated;

commit;
