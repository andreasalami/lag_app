-- Reliability hardening for the multi-station order workflow.
-- This migration is intentionally forward-only and can be applied after the
-- four 2026-09-01 migrations without rebuilding production data.

begin;

-- Pending public orders reserve stock for at most 45 minutes.
alter table public.orders add column if not exists pending_expires_at timestamptz;
alter table public.orders add column if not exists expired_at timestamptz;
alter table public.orders add column if not exists submission_client_hash text;

update public.orders
set pending_expires_at = created_at + interval '45 minutes'
where status = 'in_attesa_pagamento' and pending_expires_at is null;

create index if not exists orders_pending_expiry_idx
  on public.orders (pending_expires_at)
  where status = 'in_attesa_pagamento';

create index if not exists orders_submission_client_recent_idx
  on public.orders (event_id, submission_client_hash, created_at desc)
  where submission_client_hash is not null;

update public.orders target
set submission_client_hash = null, pending_expires_at = null
from public.order_events event
where target.event_id = event.id and event.permanently_closed_at is not null;

create or replace function public.anonymize_closed_order_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.permanently_closed_at is null and new.permanently_closed_at is not null then
    update public.orders
    set submission_client_hash = null, pending_expires_at = null
    where event_id = new.id;
  end if;
  return new;
end;
$$;

revoke all on function public.anonymize_closed_order_event() from public, anon, authenticated;
drop trigger if exists anonymize_closed_order_event on public.order_events;
create trigger anonymize_closed_order_event
  after update of permanently_closed_at on public.order_events
  for each row execute function public.anonymize_closed_order_event();

create or replace function public.set_order_pending_expiry()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = 'in_attesa_pagamento' then
    new.pending_expires_at := coalesce(new.pending_expires_at, coalesce(new.created_at, now()) + interval '45 minutes');
  else
    new.pending_expires_at := null;
  end if;
  return new;
end;
$$;

revoke all on function public.set_order_pending_expiry() from public, anon, authenticated;
drop trigger if exists set_order_pending_expiry on public.orders;
create trigger set_order_pending_expiry
  before insert or update of status, pending_expires_at on public.orders
  for each row execute function public.set_order_pending_expiry();

create or replace function public.expire_stale_orders()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  event_row record;
  expired_order public.orders%rowtype;
  expired_count integer := 0;
begin
  for event_row in
    select event.id
    from public.order_events event
    where exists (
      select 1 from public.orders target
      where target.event_id = event.id
        and target.status = 'in_attesa_pagamento'
        and target.pending_expires_at <= now()
    )
    order by event.id
    for key share of event
  loop
    for expired_order in
      select target.*
      from public.orders target
      where target.event_id = event_row.id
        and target.status = 'in_attesa_pagamento'
        and target.pending_expires_at <= now()
      order by target.id
      for update skip locked
    loop
      perform public.apply_order_stock(expired_order.items, '[]'::jsonb);
      update public.orders
      set status = 'annullato', cancelled_at = now(), expired_at = now(),
        pending_expires_at = null, claimed_token_hash = null, claim_expires_at = null
      where id = expired_order.id;
      delete from public.order_claim_devices where order_id = expired_order.id;
      expired_count := expired_count + 1;
    end loop;
  end loop;
  return expired_count;
end;
$$;

revoke execute on function public.expire_stale_orders() from public, anon, authenticated;

-- Keep one active claim per order. When duplicate rows exist, retain only the
-- most recent non-expired lease before changing the primary key.
delete from public.order_claim_devices where expires_at <= now();
delete from public.order_claim_devices older
using public.order_claim_devices newer
where older.order_id = newer.order_id
  and (older.expires_at, older.device_hash) < (newer.expires_at, newer.device_hash);

alter table public.order_claim_devices drop constraint if exists order_claim_devices_pkey;
alter table public.order_claim_devices add primary key (order_id);

create or replace function public.claim_order_for_station(
  p_order_id uuid, p_station text, p_device_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  order_row public.orders%rowtype;
  device_hash_value text;
  active_device_hash text;
  lease_expires_at timestamptz := now() + interval '30 seconds';
begin
  if not exists (select 1 from public.profiles profile where profile.id = auth.uid() and profile.role in ('cassa', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_station !~ '^cassa_[1-5]$' then raise exception 'invalid_station'; end if;
  if p_device_id is null or length(p_device_id) not between 32 and 80 then raise exception 'invalid_device'; end if;
  device_hash_value := encode(extensions.digest(p_device_id, 'sha256'), 'hex');
  perform public.expire_stale_orders();
  delete from public.order_claim_devices where expires_at <= now();
  select * into order_row from public.orders where id = p_order_id for update;
  if not found or order_row.status <> 'in_attesa_pagamento' then raise exception 'order_not_available'; end if;
  select claims.device_hash into active_device_hash
  from public.order_claim_devices claims
  where claims.order_id = p_order_id and claims.expires_at > now();
  if active_device_hash is not null and active_device_hash <> device_hash_value then
    raise exception 'order_already_claimed';
  end if;
  insert into public.order_claim_devices (order_id, station, device_hash, expires_at)
    values (p_order_id, p_station, device_hash_value, lease_expires_at)
    on conflict (order_id) do update
      set station = excluded.station, device_hash = excluded.device_hash, expires_at = excluded.expires_at
      where public.order_claim_devices.device_hash = excluded.device_hash
        or public.order_claim_devices.expires_at <= now();
  if not found then raise exception 'order_already_claimed'; end if;
  return (to_jsonb(order_row) - 'qr_token_hash' - 'claimed_token_hash' - 'client_request_id'
    - 'submission_client_hash')
    || jsonb_build_object('claimed_station', p_station, 'claim_expires_at', lease_expires_at);
end;
$$;

revoke execute on function public.claim_order_for_station(uuid, text, text) from public;
grant execute on function public.claim_order_for_station(uuid, text, text) to authenticated;

-- Successful mutating operations are recorded so a retry with the same UUID
-- returns the original result instead of applying the mutation twice.
create table if not exists public.order_operations (
  operation_id uuid primary key,
  operation_kind text not null check (operation_kind in ('pay', 'cancel', 'deliver', 'undo_delivery', 'counter_order')),
  order_id uuid references public.orders(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  station text,
  request_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists order_operations_order_created_idx
  on public.order_operations (order_id, created_at desc);

alter table public.order_operations enable row level security;
revoke all on public.order_operations from public, anon, authenticated;

create or replace function public.cached_order_operation(
  p_operation_id uuid, p_operation_kind text, p_order_id uuid,
  p_station text, p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare operation_row public.order_operations%rowtype;
begin
  if p_operation_id is null then raise exception 'invalid_operation_id'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_operation_id::text, 0));
  select * into operation_row from public.order_operations where operation_id = p_operation_id;
  if not found then return null; end if;
  if operation_row.operation_kind <> p_operation_kind
    or operation_row.order_id is distinct from p_order_id
    or operation_row.actor_id <> auth.uid()
    or operation_row.station is distinct from p_station
    or operation_row.request_hash <> p_request_hash then
    raise exception 'operation_id_conflict';
  end if;
  return operation_row.result;
end;
$$;

create or replace function public.complete_order_operation(
  p_operation_id uuid, p_operation_kind text, p_order_id uuid,
  p_station text, p_request_hash text, p_result jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.order_operations (
    operation_id, operation_kind, order_id, actor_id, station, request_hash, result
  ) values (
    p_operation_id, p_operation_kind, p_order_id, auth.uid(), p_station, p_request_hash, p_result
  );
  return p_result;
end;
$$;

revoke execute on function public.cached_order_operation(uuid, text, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.complete_order_operation(uuid, text, uuid, text, text, jsonb) from public, anon, authenticated;

drop function if exists public.pay_order_for_station(uuid, text, text);
create function public.pay_order_for_station(
  p_order_id uuid, p_station text, p_device_id text,
  p_operation_id uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  order_row public.orders%rowtype;
  event_row public.order_events%rowtype;
  device_hash_value text;
  request_hash text;
  cached_result jsonb;
  result jsonb;
begin
  if not exists (select 1 from public.profiles profile where profile.id = auth.uid() and profile.role in ('cassa', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_station !~ '^cassa_[1-5]$' then raise exception 'invalid_station'; end if;
  if p_device_id is null or length(p_device_id) not between 32 and 80 then raise exception 'invalid_device'; end if;
  device_hash_value := encode(extensions.digest(p_device_id, 'sha256'), 'hex');
  request_hash := encode(extensions.digest(concat_ws(':', 'pay', p_order_id, p_station, device_hash_value), 'sha256'), 'hex');
  cached_result := public.cached_order_operation(p_operation_id, 'pay', p_order_id, p_station, request_hash);
  if cached_result is not null then return cached_result; end if;
  select event.* into event_row from public.order_events event
    join public.orders target on target.event_id = event.id
    where target.id = p_order_id for key share of event;
  if not found or event_row.permanently_closed_at is not null then raise exception 'event_closed'; end if;
  select * into order_row from public.orders where id = p_order_id for update;
  if not found or order_row.status <> 'in_attesa_pagamento' or not exists (
    select 1 from public.order_claim_devices claims where claims.order_id = p_order_id
      and claims.station = p_station and claims.device_hash = device_hash_value and claims.expires_at > now()
  ) then raise exception 'claim_lost'; end if;
  perform public.seed_order_fulfillment(order_row.id, order_row.items);
  update public.orders set status = 'pagato', paid_at = now(), delivered_at = null,
    completed_at = null, pending_expires_at = null, claimed_token_hash = null, claim_expires_at = null
    where id = p_order_id returning * into order_row;
  delete from public.order_claim_devices where order_id = p_order_id;
  result := to_jsonb(order_row) - 'qr_token_hash' - 'claimed_token_hash'
    - 'client_request_id' - 'submission_client_hash';
  return public.complete_order_operation(p_operation_id, 'pay', p_order_id, p_station, request_hash, result);
end;
$$;

revoke execute on function public.pay_order_for_station(uuid, text, text, uuid) from public;
grant execute on function public.pay_order_for_station(uuid, text, text, uuid) to authenticated;

drop function if exists public.cancel_order_for_station(uuid, text, text);
create function public.cancel_order_for_station(
  p_order_id uuid, p_station text, p_device_id text,
  p_operation_id uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  order_row public.orders%rowtype;
  device_hash_value text;
  request_hash text;
  cached_result jsonb;
  result jsonb;
begin
  if not exists (select 1 from public.profiles profile where profile.id = auth.uid() and profile.role in ('cassa', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_station !~ '^cassa_[1-5]$' then raise exception 'invalid_station'; end if;
  if p_device_id is null or length(p_device_id) not between 32 and 80 then raise exception 'invalid_device'; end if;
  device_hash_value := encode(extensions.digest(p_device_id, 'sha256'), 'hex');
  request_hash := encode(extensions.digest(concat_ws(':', 'cancel', p_order_id, p_station, device_hash_value), 'sha256'), 'hex');
  cached_result := public.cached_order_operation(p_operation_id, 'cancel', p_order_id, p_station, request_hash);
  if cached_result is not null then return cached_result; end if;
  select * into order_row from public.orders where id = p_order_id for update;
  if not found or order_row.status <> 'in_attesa_pagamento' or not exists (
    select 1 from public.order_claim_devices claims where claims.order_id = p_order_id
      and claims.station = p_station and claims.device_hash = device_hash_value and claims.expires_at > now()
  ) then raise exception 'claim_lost'; end if;
  perform public.apply_order_stock(order_row.items, '[]'::jsonb);
  update public.orders set status = 'annullato', cancelled_at = now(), pending_expires_at = null
    where id = p_order_id;
  delete from public.order_claim_devices where order_id = p_order_id;
  result := jsonb_build_object('order_id', p_order_id, 'status', 'annullato');
  return public.complete_order_operation(p_operation_id, 'cancel', p_order_id, p_station, request_hash, result);
end;
$$;

revoke execute on function public.cancel_order_for_station(uuid, text, text, uuid) from public;
grant execute on function public.cancel_order_for_station(uuid, text, text, uuid) to authenticated;

drop function if exists public.deliver_fulfillment_items(uuid, text, jsonb);
create function public.deliver_fulfillment_items(
  p_order_id uuid, p_station text, p_items jsonb,
  p_operation_id uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  order_row public.orders%rowtype;
  normalized jsonb;
  delivery_id uuid;
  total_quantity integer;
  total_delivered integer;
  request_hash text;
  cached_result jsonb;
  result jsonb;
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
  with requested as (
    select (item->>'id')::uuid id, sum((item->>'qty')::integer)::integer qty
    from jsonb_array_elements(p_items) item group by 1
  )
  select jsonb_agg(jsonb_build_object('id', requested.id, 'qty', requested.qty) order by requested.id)
  into normalized from requested;
  request_hash := encode(extensions.digest(
    jsonb_build_object('kind', 'deliver', 'order_id', p_order_id, 'station', p_station, 'items', normalized)::text,
    'sha256'), 'hex');
  cached_result := public.cached_order_operation(p_operation_id, 'deliver', p_order_id, p_station, request_hash);
  if cached_result is not null then return cached_result; end if;
  select * into order_row from public.orders where id = p_order_id for update;
  if not found or order_row.status not in ('pagato', 'ritiro_parziale') then raise exception 'order_not_available'; end if;
  if exists (
    select 1
    from jsonb_array_elements(normalized) item
    left join public.order_fulfillment_items fulfillment
      on fulfillment.order_id = p_order_id and fulfillment.menu_item_id = (item->>'id')::uuid
    where fulfillment.menu_item_id is null or fulfillment.station <> p_station
      or (item->>'qty')::integer > fulfillment.quantity - fulfillment.delivered_quantity
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
  result := jsonb_build_object('delivery_id', delivery_id,
    'status', case when total_delivered >= total_quantity then 'consegnato' else 'ritiro_parziale' end);
  return public.complete_order_operation(p_operation_id, 'deliver', p_order_id, p_station, request_hash, result);
end;
$$;

revoke execute on function public.deliver_fulfillment_items(uuid, text, jsonb, uuid) from public;
grant execute on function public.deliver_fulfillment_items(uuid, text, jsonb, uuid) to authenticated;

create or replace function public.get_recent_fulfillment_deliveries(p_station text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare result jsonb; user_role text;
begin
  if not public.fulfillment_station_allowed(p_station) then raise exception 'not_authorized' using errcode = '42501'; end if;
  select role into user_role from public.profiles where id = auth.uid();
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', delivery.id, 'order_id', delivery.order_id,
    'display_number', orders_row.display_number, 'alias', orders_row.alias,
    'station', delivery.station, 'quantities', delivery.quantities,
    'created_at', delivery.created_at,
    'can_undo', event.permanently_closed_at is null
      and (user_role = 'admin' or delivery.created_at > now() - interval '5 minutes')
  ) order by delivery.created_at desc), '[]'::jsonb) into result
  from public.fulfillment_deliveries delivery
  join public.orders orders_row on orders_row.id = delivery.order_id
  join public.order_events event on event.id = orders_row.event_id
  where delivery.station = p_station and delivery.reversed_at is null
    and delivery.created_at > now() - interval '30 minutes';
  return result;
end;
$$;

revoke execute on function public.get_recent_fulfillment_deliveries(text) from public;
grant execute on function public.get_recent_fulfillment_deliveries(text) to authenticated;

drop function if exists public.undo_fulfillment_delivery(uuid, text);
create function public.undo_fulfillment_delivery(
  p_delivery_id uuid, p_station text,
  p_operation_id uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  delivery_row public.fulfillment_deliveries%rowtype;
  user_role text;
  request_hash text;
  cached_result jsonb;
  result jsonb;
begin
  select role into user_role from public.profiles where id = auth.uid();
  if user_role is null then raise exception 'not_authorized' using errcode = '42501'; end if;
  request_hash := encode(extensions.digest(concat_ws(':', 'undo_delivery', p_delivery_id, p_station), 'sha256'), 'hex');
  cached_result := public.cached_order_operation(p_operation_id, 'undo_delivery', null, p_station, request_hash);
  if cached_result is not null then return cached_result; end if;
  select * into delivery_row from public.fulfillment_deliveries where id = p_delivery_id for update;
  if not found or delivery_row.reversed_at is not null then raise exception 'delivery_not_available'; end if;
  if exists (
    select 1 from public.orders target join public.order_events event on event.id = target.event_id
    where target.id = delivery_row.order_id and event.permanently_closed_at is not null
  ) then raise exception 'event_closed'; end if;
  if user_role <> 'admin' and (
    not public.fulfillment_station_allowed(p_station)
    or delivery_row.station <> p_station
    or delivery_row.created_at <= now() - interval '5 minutes'
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
  result := jsonb_build_object('delivery_id', p_delivery_id, 'order_id', delivery_row.order_id, 'reversed', true);
  -- The order id is intentionally omitted from the cache lookup because it is
  -- not known until the delivery row is locked. Keep the same null key here.
  return public.complete_order_operation(p_operation_id, 'undo_delivery', null, p_station, request_hash, result);
end;
$$;

revoke execute on function public.undo_fulfillment_delivery(uuid, text, uuid) from public;
grant execute on function public.undo_fulfillment_delivery(uuid, text, uuid) to authenticated;

drop function if exists public.create_counter_order(text, text, jsonb);
create function public.create_counter_order(
  p_alias text, p_notes text, p_items jsonb,
  p_operation_id uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  event_row public.order_events%rowtype;
  normalized jsonb;
  calculated_total numeric;
  next_number bigint;
  created_order public.orders%rowtype;
  request_hash text;
  cached_result jsonb;
  result jsonb;
begin
  if not exists (select 1 from public.profiles profile where profile.id = auth.uid() and profile.role in ('cassa', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_alias is null or length(btrim(p_alias)) not between 2 and 32 then raise exception 'invalid_alias'; end if;
  if length(coalesce(p_notes, '')) > 300 then raise exception 'notes_too_long'; end if;
  request_hash := encode(extensions.digest(jsonb_build_object(
    'kind', 'counter_order', 'alias', btrim(p_alias),
    'notes', nullif(btrim(coalesce(p_notes, '')), ''), 'items', p_items
  )::text, 'sha256'), 'hex');
  cached_result := public.cached_order_operation(p_operation_id, 'counter_order', null, null, request_hash);
  if cached_result is not null then return cached_result; end if;
  select * into event_row from public.order_events where is_current for no key update;
  if not found or event_row.permanently_closed_at is not null then raise exception 'event_closed'; end if;
  normalized := public.normalize_order_items(p_items);
  perform public.apply_order_stock('[]'::jsonb, normalized);
  select sum((line->>'price')::numeric * (line->>'qty')::integer)
    into calculated_total from jsonb_array_elements(normalized) line;
  select coalesce(max(display_number), 0) + 1 into next_number from public.orders where event_id = event_row.id;
  insert into public.orders (event_id, display_number, alias, notes, items, total, status, paid_at)
    values (event_row.id, next_number, btrim(p_alias), nullif(btrim(coalesce(p_notes, '')), ''),
      normalized, calculated_total::numeric(7,2), 'pagato', now()) returning * into created_order;
  perform public.seed_order_fulfillment(created_order.id, created_order.items);
  result := to_jsonb(created_order) - 'qr_token_hash' - 'claimed_token_hash'
    - 'client_request_id' - 'submission_client_hash';
  return public.complete_order_operation(p_operation_id, 'counter_order', null, null, request_hash, result);
end;
$$;

revoke execute on function public.create_counter_order(text, text, jsonb, uuid) from public;
grant execute on function public.create_counter_order(text, text, jsonb, uuid) to authenticated;

-- Anonymous submissions get a lightweight per-device limit. This does not
-- replace Turnstile, but contains accidental loops and basic scripted abuse.
drop function if exists public.submit_public_order(text, text, jsonb, uuid, text, text);
create function public.submit_public_order(
  p_alias text,
  p_notes text,
  p_items jsonb,
  p_client_request_id uuid,
  p_qr_token text,
  p_bot_field text default '',
  p_client_id text default null
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
  recent_client_orders integer;
  client_hash_value text;
begin
  if coalesce(p_bot_field, '') <> '' then raise exception 'invalid_request'; end if;
  if p_alias is null or length(btrim(p_alias)) not between 2 and 32
    or btrim(p_alias) !~ '^[[:alnum:]][[:alnum:] _-]*$' then raise exception 'invalid_alias'; end if;
  if length(coalesce(p_notes, '')) > 300 then raise exception 'notes_too_long'; end if;
  if p_client_request_id is null then raise exception 'invalid_client_request_id'; end if;
  if p_qr_token is null or length(p_qr_token) not between 32 and 80 then raise exception 'invalid_qr_token'; end if;
  if p_client_id is not null and length(p_client_id) not between 32 and 80 then raise exception 'invalid_client_id'; end if;
  client_hash_value := encode(extensions.digest(coalesce(p_client_id, p_client_request_id::text), 'sha256'), 'hex');
  perform public.expire_stale_orders();
  select * into event_row from public.order_events where is_current for no key update;
  if not found then raise exception 'no_event'; end if;
  select * into existing_order from public.orders
  where event_id = event_row.id and client_request_id = p_client_request_id;
  if found then
    if existing_order.qr_token_hash is distinct from encode(extensions.digest(p_qr_token, 'sha256'), 'hex') then
      raise exception 'request_id_conflict';
    end if;
    if existing_order.status <> 'in_attesa_pagamento' then raise exception 'request_already_processed'; end if;
    return jsonb_build_object(
      'event_id', event_row.id, 'event_name', event_row.name,
      'order_id', existing_order.id, 'display_number', existing_order.display_number,
      'alias', existing_order.alias, 'notes', existing_order.notes,
      'items', existing_order.items, 'total', existing_order.total, 'qr_token', p_qr_token,
      'expires_at', existing_order.pending_expires_at
    );
  end if;
  if event_row.permanently_closed_at is not null then raise exception 'event_closed'; end if;
  if event_row.manual_closed then raise exception 'ordering_paused'; end if;
  if now() < event_row.opens_at then raise exception 'not_open_yet'; end if;
  if now() > event_row.closes_at then raise exception 'ordering_closed'; end if;
  select count(*) into recent_client_orders from public.orders
    where event_id = event_row.id and submission_client_hash = client_hash_value
      and created_at > now() - interval '10 minutes';
  if recent_client_orders >= 6 then raise exception 'submission_rate_limited'; end if;
  select count(*) into pending_count from public.orders
    where event_id = event_row.id and status = 'in_attesa_pagamento';
  if pending_count >= event_row.max_pending_orders then raise exception 'capacity_reached'; end if;
  normalized := public.normalize_order_items(p_items);
  select sum((line->>'price')::numeric * (line->>'qty')::integer)
    into calculated_total from jsonb_array_elements(normalized) line;
  if calculated_total > 99999.99 then raise exception 'order_total_too_high'; end if;
  perform public.apply_order_stock('[]'::jsonb, normalized);
  select coalesce(max(display_number), 0) + 1 into next_number
    from public.orders where event_id = event_row.id;
  insert into public.orders (
    event_id, display_number, alias, notes, items, total, status,
    qr_token_hash, client_request_id, submission_client_hash, pending_expires_at
  ) values (
    event_row.id, next_number, btrim(p_alias), nullif(btrim(coalesce(p_notes, '')), ''),
    normalized, calculated_total::numeric(7,2), 'in_attesa_pagamento',
    encode(extensions.digest(p_qr_token, 'sha256'), 'hex'), p_client_request_id,
    client_hash_value, now() + interval '45 minutes'
  ) returning id into existing_order.id;
  return jsonb_build_object(
    'event_id', event_row.id, 'event_name', event_row.name,
    'order_id', existing_order.id, 'display_number', next_number,
    'alias', btrim(p_alias), 'notes', nullif(btrim(coalesce(p_notes, '')), ''),
    'items', normalized, 'total', calculated_total, 'qr_token', p_qr_token,
    'expires_at', now() + interval '45 minutes'
  );
end;
$$;

revoke execute on function public.submit_public_order(text, text, jsonb, uuid, text, text, text) from public;
grant execute on function public.submit_public_order(text, text, jsonb, uuid, text, text, text) to anon, authenticated;

-- Expire stale reservations before returning operational queues or capacity.
drop function if exists public.get_cashier_pending_orders();
create function public.get_cashier_pending_orders(p_device_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare result jsonb; device_hash_value text;
begin
  if not exists (select 1 from public.profiles profile where profile.id = auth.uid() and profile.role in ('cassa', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_device_id is not null and length(p_device_id) not between 32 and 80 then raise exception 'invalid_device'; end if;
  device_hash_value := case when p_device_id is null then null
    else encode(extensions.digest(p_device_id, 'sha256'), 'hex') end;
  perform public.expire_stale_orders();
  delete from public.order_claim_devices where expires_at <= now();
  select coalesce(jsonb_agg(to_jsonb(queue_row) order by queue_row.created_at), '[]'::jsonb)
  into result from (
    select orders_row.id, orders_row.event_id, orders_row.display_number,
      orders_row.alias, orders_row.total, orders_row.created_at, orders_row.status,
      orders_row.pending_expires_at,
      claim.station as claimed_station, claim.expires_at as claim_expires_at,
      claim.device_hash = device_hash_value as claimed_by_device
    from public.orders orders_row
    left join public.order_claim_devices claim on claim.order_id = orders_row.id and claim.expires_at > now()
    where orders_row.status = 'in_attesa_pagamento'
  ) queue_row;
  return result;
end;
$$;

revoke execute on function public.get_cashier_pending_orders(text) from public;
grant execute on function public.get_cashier_pending_orders(text) to authenticated;

create or replace function public.get_ordering_status()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare event_row public.order_events%rowtype; pending_count integer; reason text;
begin
  perform public.expire_stale_orders();
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
    'accepting', reason is null, 'reason', reason,
    'event_id', event_row.id, 'event_name', event_row.name,
    'opens_at', event_row.opens_at, 'closes_at', event_row.closes_at
  );
end;
$$;

revoke execute on function public.get_ordering_status() from public;
grant execute on function public.get_ordering_status() to anon, authenticated;

-- Old token-based staff RPCs bypass station ownership and fulfillment. Remove
-- them now that the deployment is a controlled cutover with no legacy tabs.
drop function if exists public.deliver_order_by_qr(text);
drop function if exists public.deliver_order(uuid);
drop function if exists public.pay_claimed_order(uuid, text);
drop function if exists public.cancel_claimed_order(uuid, text);
drop function if exists public.update_claimed_order(uuid, text, text, text, jsonb);
drop function if exists public.release_order_claim(uuid, text);
drop function if exists public.claim_order_by_qr(text, text);
drop function if exists public.claim_order(uuid, text);

-- Keep the audit table bounded without requiring pg_cron. Cleanup happens on
-- every stale-order sweep and never removes recent operational evidence.
create or replace function public.expire_stale_orders()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare event_row record; expired_order public.orders%rowtype; expired_count integer := 0;
begin
  delete from public.order_operations where created_at < now() - interval '90 days';
  for event_row in
    select event.id
    from public.order_events event
    where exists (
      select 1 from public.orders target
      where target.event_id = event.id
        and target.status = 'in_attesa_pagamento'
        and target.pending_expires_at <= now()
    )
    order by event.id for key share of event
  loop
    for expired_order in
      select target.* from public.orders target
      where target.event_id = event_row.id and target.status = 'in_attesa_pagamento'
        and target.pending_expires_at <= now()
      order by target.id for update skip locked
    loop
      perform public.apply_order_stock(expired_order.items, '[]'::jsonb);
      update public.orders
      set status = 'annullato', cancelled_at = now(), expired_at = now(),
        pending_expires_at = null, claimed_token_hash = null, claim_expires_at = null
      where id = expired_order.id;
      delete from public.order_claim_devices where order_id = expired_order.id;
      expired_count := expired_count + 1;
    end loop;
  end loop;
  return expired_count;
end;
$$;

revoke execute on function public.expire_stale_orders() from public, anon, authenticated;

create index if not exists order_operations_created_at_idx
  on public.order_operations (created_at);

create or replace function public.get_public_order_statuses(p_qr_tokens text[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare result jsonb;
begin
  if p_qr_tokens is null or cardinality(p_qr_tokens) < 1 or cardinality(p_qr_tokens) > 50 then
    raise exception 'invalid_qr_tokens';
  end if;
  if exists (select 1 from unnest(p_qr_tokens) token
    where token is null or length(token) not between 32 and 80) then raise exception 'invalid_qr_tokens'; end if;
  perform public.expire_stale_orders();
  select coalesce(jsonb_agg(jsonb_build_object(
    'order_id', orders_row.id, 'status', orders_row.status,
    'expired', orders_row.expired_at is not null,
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

revoke execute on function public.get_public_order_statuses(text[]) from public;
grant execute on function public.get_public_order_statuses(text[]) to anon, authenticated;

create or replace function public.get_order_event_admin_state()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare event_row public.order_events%rowtype; pending_count integer;
begin
  if not exists (select 1 from public.profiles profile where profile.id = auth.uid() and profile.role in ('cassa', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform public.expire_stale_orders();
  select * into event_row from public.order_events where is_current limit 1;
  select count(*) into pending_count from public.orders
    where event_id = event_row.id and status = 'in_attesa_pagamento';
  return to_jsonb(event_row) || jsonb_build_object('pending_count', pending_count);
end;
$$;

revoke execute on function public.get_order_event_admin_state() from public;
grant execute on function public.get_order_event_admin_state() to authenticated;

commit;
