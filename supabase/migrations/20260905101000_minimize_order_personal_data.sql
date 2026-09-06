begin;
create or replace function public.purge_completed_order_personal_data()
returns void language plpgsql security definer set search_path=public as $$
begin
 perform 1 from public.orders
  where (alias is not null or notes is not null) and
    (status='annullato' or (status='consegnato' and delivered_at <= now()-interval '5 minutes'))
  order by id for update;
 update public.orders set alias=null,notes=null
  where (alias is not null or notes is not null) and
    (status='annullato' or (status='consegnato' and delivered_at <= now()-interval '5 minutes'));
end;
$$;
revoke execute on function public.purge_completed_order_personal_data() from public,anon,authenticated;
create index if not exists orders_personal_data_cleanup_idx on public.orders(status,delivered_at)
 where alias is not null or notes is not null;
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
  perform public.purge_completed_order_personal_data();
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
  perform public.purge_completed_order_personal_data();
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

create or replace function public.get_fulfillment_queue(p_station text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare result jsonb;
begin
  if not public.fulfillment_station_allowed(p_station) then raise exception 'not_authorized' using errcode = '42501'; end if;
  perform public.purge_completed_order_personal_data();
  select coalesce(jsonb_agg(order_payload order by paid_at, display_number), '[]'::jsonb) into result
  from (
    select orders_row.id, orders_row.display_number, orders_row.alias, orders_row.notes,
      orders_row.paid_at, orders_row.status,
      jsonb_agg(jsonb_build_object(
        'id', fulfillment.menu_item_id, 'name', fulfillment.name,
        'subcategory', fulfillment.subcategory, 'station', fulfillment.station,
        'quantity', fulfillment.quantity, 'delivered_quantity', fulfillment.delivered_quantity
      ) order by fulfillment.subcategory, fulfillment.name) as items
    from public.orders orders_row
    join public.order_fulfillment_items fulfillment on fulfillment.order_id = orders_row.id
    where orders_row.status in ('pagato', 'ritiro_parziale')
      and fulfillment.delivered_quantity < fulfillment.quantity
      and (case when p_station = 'cucina' then fulfillment.category = 'cibo' else fulfillment.station = p_station end)
    group by orders_row.id
  ) order_payload;
  return result;
end;
$$;

create or replace function public.get_recent_fulfillment_deliveries(p_station text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare result jsonb;
begin
  if not public.fulfillment_station_allowed(p_station) then raise exception 'not_authorized' using errcode = '42501'; end if;
  perform public.purge_completed_order_personal_data();
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', delivery.id, 'order_id', delivery.order_id,
    'display_number', orders_row.display_number, 'alias', orders_row.alias,
    'station', delivery.station, 'quantities', delivery.quantities,
    'created_at', delivery.created_at, 'can_undo', delivery.created_at > now() - interval '5 minutes'
  ) order by delivery.created_at desc), '[]'::jsonb) into result
  from public.fulfillment_deliveries delivery
  join public.orders orders_row on orders_row.id = delivery.order_id
  where delivery.station = p_station and delivery.reversed_at is null
    and delivery.created_at > now() - interval '30 minutes';
  return result;
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
  update public.orders set status = 'annullato', cancelled_at = now(), alias = null, notes = null where id = p_order_id;
  delete from public.order_claim_devices where order_id = p_order_id;
end;
$$;
-- Full rows contain unnecessary cross-area data; staff use filtered RPCs.
drop policy if exists "La cucina legge solo gli ordini pagati" on public.orders;
drop policy if exists "Le postazioni leggono gli ordini in preparazione" on public.orders;
drop policy if exists "Admin leggono gli ordini operativi" on public.orders;
create policy "Admin leggono gli ordini operativi" on public.orders for select
 using (exists(select 1 from public.profiles where id=auth.uid() and role='admin'));
commit;
