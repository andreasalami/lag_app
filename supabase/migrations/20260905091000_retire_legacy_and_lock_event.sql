begin;
-- All order mutations lock the event before the order, then delivery/stock rows.
create or replace function public.lock_open_order_event(p_order_id uuid)
returns void language plpgsql security definer set search_path=public as $$
begin
  perform 1 from public.order_events e join public.orders o on o.event_id=e.id
    where o.id=p_order_id and e.is_current and e.permanently_closed_at is null for key share of e;
  if not found then raise exception 'event_closed'; end if;
end;
$$;
revoke execute on function public.lock_open_order_event(uuid) from public,anon,authenticated;

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
  return jsonb_build_object('delivery_id', delivery_id,
    'status', case when total_delivered >= total_quantity then 'consegnato' else 'ritiro_parziale' end);
end;
$$;

create or replace function public.cancel_order_for_station(
  p_order_id uuid, p_station text, p_device_id text
)
returns void
language plpgsql security definer set search_path = public as $$
declare order_row public.orders%rowtype; device_hash_value text;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role in ('cassa', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  device_hash_value := encode(extensions.digest(p_device_id, 'sha256'), 'hex');
  perform public.lock_open_order_event(p_order_id);
  select * into order_row from public.orders where id = p_order_id for update;
  if not found or order_row.status <> 'in_attesa_pagamento' or not exists (
    select 1 from public.order_claim_devices claims where claims.order_id = p_order_id
      and claims.station = p_station and claims.device_hash = device_hash_value and claims.expires_at > now()
  ) then raise exception 'claim_lost'; end if;
  perform public.apply_order_stock(order_row.items, '[]'::jsonb);
  update public.orders set status = 'annullato', cancelled_at = now() where id = p_order_id;
  delete from public.order_claim_devices where order_id = p_order_id;
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
end;
$$;
-- Retired APIs: frontend uses only station-based RPCs. Never re-grant these.
revoke execute on function public.claim_order(uuid, text) from public, anon, authenticated, service_role;
revoke execute on function public.claim_order_by_qr(text, text) from public, anon, authenticated, service_role;
revoke execute on function public.release_order_claim(uuid, text) from public, anon, authenticated, service_role;
revoke execute on function public.update_claimed_order(uuid, text, text, text, jsonb) from public, anon, authenticated, service_role;
revoke execute on function public.cancel_claimed_order(uuid, text) from public, anon, authenticated, service_role;
revoke execute on function public.pay_claimed_order(uuid, text) from public, anon, authenticated, service_role;
revoke execute on function public.deliver_order(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.deliver_order_by_qr(text) from public, anon, authenticated, service_role;
commit;
