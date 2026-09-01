-- Ruolo Bar e nuova destinazione Furgone esterno.
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('pending', 'admin', 'staff', 'tournament_manager', 'cassa', 'cucina', 'bar'));

alter table public.menu_items drop constraint if exists menu_items_subcategory_valid;
alter table public.menu_items add constraint menu_items_subcategory_valid check (
  (category = 'cibo' and subcategory in ('primi', 'secondi', 'contorni', 'dolci', 'furgone'))
  or (category = 'bevande' and subcategory in ('birre', 'vini', 'drinks', 'bevande'))
);

-- Lo stato globale resta semplice; il dettaglio vive nelle righe di evasione.
alter table public.orders drop constraint if exists orders_status_valid;
alter table public.orders add constraint orders_status_valid
  check (status in ('in_attesa_pagamento', 'pagato', 'ritiro_parziale', 'consegnato', 'annullato'));

-- Il client deve conoscere la sottosezione per mostrare e instradare ogni voce.
create or replace function public.get_ordering_catalog()
returns jsonb language plpgsql security definer set search_path = public as $$
declare status_payload jsonb; catalog jsonb;
begin
  status_payload := public.get_ordering_status();
  if not coalesce((status_payload->>'accepting')::boolean, false) then
    return status_payload || jsonb_build_object('items', '[]'::jsonb);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'category', category, 'subcategory', subcategory,
    'name', name, 'price', price, 'available_portions', available_portions,
    'stock_capacity', stock_capacity, 'allergens', to_jsonb(allergens)
  ) order by category, subcategory, name), '[]'::jsonb)
  into catalog from public.menu_items;
  return status_payload || jsonb_build_object('items', catalog);
end;
$$;
revoke execute on function public.get_ordering_catalog() from public;
grant execute on function public.get_ordering_catalog() to anon, authenticated;

create table if not exists public.order_claim_devices (
  order_id uuid not null references public.orders(id) on delete cascade,
  station text not null check (station in ('cassa_1', 'cassa_2', 'cassa_3', 'cassa_4', 'cassa_5')),
  device_hash text not null check (device_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  primary key (order_id, device_hash)
);
create index if not exists order_claim_devices_active_idx
  on public.order_claim_devices (order_id, expires_at);
alter table public.order_claim_devices enable row level security;
revoke all on public.order_claim_devices from public, anon, authenticated;

create table if not exists public.order_fulfillment_items (
  order_id uuid not null references public.orders(id) on delete cascade,
  menu_item_id uuid not null,
  name text not null,
  category text not null check (category in ('cibo', 'bevande')),
  subcategory text not null,
  station text not null check (station in ('primi', 'secondi', 'contorni', 'dolci', 'furgone', 'birre', 'drinks', 'bar')),
  quantity integer not null check (quantity > 0),
  delivered_quantity integer not null default 0 check (delivered_quantity >= 0 and delivered_quantity <= quantity),
  primary key (order_id, menu_item_id)
);
create index if not exists order_fulfillment_station_idx
  on public.order_fulfillment_items (station, order_id)
  where delivered_quantity < quantity;
alter table public.order_fulfillment_items enable row level security;
revoke all on public.order_fulfillment_items from public, anon, authenticated;

create table if not exists public.fulfillment_deliveries (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  station text not null check (station in ('primi', 'secondi', 'contorni', 'dolci', 'furgone', 'birre', 'drinks', 'bar')),
  quantities jsonb not null check (jsonb_typeof(quantities) = 'array'),
  delivered_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  reversed_at timestamptz,
  reversed_by uuid references auth.users(id)
);
create index if not exists fulfillment_deliveries_recent_idx
  on public.fulfillment_deliveries (station, created_at desc)
  where reversed_at is null;
alter table public.fulfillment_deliveries enable row level security;
revoke all on public.fulfillment_deliveries from public, anon, authenticated;

create or replace function public.normalize_order_items(p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare normalized jsonb;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array'
    or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 100 then
    raise exception 'invalid_order_items';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_items) line
    where jsonb_typeof(line) <> 'object'
      or coalesce(line->>'id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or coalesce(line->>'qty', '') !~ '^[1-9][0-9]*$'
      or case when coalesce(line->>'qty', '') ~ '^[1-9][0-9]*$'
        then (line->>'qty')::numeric > 999 else false end
  ) then raise exception 'invalid_order_items'; end if;

  with requested as (
    select (line->>'id')::uuid id, sum((line->>'qty')::integer)::integer qty
    from jsonb_array_elements(p_items) line group by (line->>'id')::uuid
  )
  select jsonb_agg(jsonb_build_object(
    'id', menu.id, 'name', menu.name, 'category', menu.category,
    'subcategory', menu.subcategory, 'allergens', to_jsonb(menu.allergens),
    'qty', requested.qty, 'price', menu.price
  ) order by menu.category, menu.subcategory, menu.name, menu.id)
  into normalized from requested join public.menu_items menu on menu.id = requested.id;

  if normalized is null or jsonb_array_length(normalized) <> (
    select count(distinct (line->>'id')) from jsonb_array_elements(p_items) line
  ) then raise exception 'unknown_menu_item'; end if;
  return normalized;
end;
$$;
revoke execute on function public.normalize_order_items(jsonb) from public, anon, authenticated;

create or replace function public.seed_order_fulfillment(p_order_id uuid, p_items jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.order_fulfillment_items (
    order_id, menu_item_id, name, category, subcategory, station, quantity
  )
  select p_order_id, (line->>'id')::uuid, line->>'name', line->>'category',
    coalesce(line->>'subcategory', menu.subcategory,
      case line->>'category' when 'cibo' then 'secondi' else 'bevande' end),
    case coalesce(line->>'subcategory', menu.subcategory,
      case line->>'category' when 'cibo' then 'secondi' else 'bevande' end)
      when 'vini' then 'bar' when 'bevande' then 'bar'
      else coalesce(line->>'subcategory', menu.subcategory,
        case line->>'category' when 'cibo' then 'secondi' else 'bevande' end) end,
    (line->>'qty')::integer
  from jsonb_array_elements(p_items) line
  left join public.menu_items menu on menu.id = (line->>'id')::uuid
  on conflict (order_id, menu_item_id) do nothing;
end;
$$;
revoke execute on function public.seed_order_fulfillment(uuid, jsonb) from public, anon, authenticated;

-- Recupera eventuali ordini già pagati prima della migrazione.
do $$
declare existing_order record;
begin
  for existing_order in select id, items from public.orders where status in ('pagato', 'ritiro_parziale') loop
    perform public.seed_order_fulfillment(existing_order.id, existing_order.items);
  end loop;
end
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
revoke execute on function public.get_cashier_pending_orders() from public;
grant execute on function public.get_cashier_pending_orders() to authenticated;

create or replace function public.claim_order_for_station(
  p_order_id uuid, p_station text, p_device_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare order_row public.orders%rowtype; device_hash text; active_station text;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role in ('cassa', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_station !~ '^cassa_[1-5]$' then raise exception 'invalid_station'; end if;
  if p_device_id is null or length(p_device_id) not between 32 and 80 then raise exception 'invalid_device'; end if;
  device_hash := encode(extensions.digest(p_device_id, 'sha256'), 'hex');
  delete from public.order_claim_devices where expires_at <= now();
  select * into order_row from public.orders where id = p_order_id for update;
  if not found or order_row.status <> 'in_attesa_pagamento' then raise exception 'order_not_available'; end if;
  select station into active_station from public.order_claim_devices
    where order_id = p_order_id and expires_at > now() limit 1;
  if active_station is not null and active_station <> p_station then raise exception 'order_already_claimed'; end if;
  insert into public.order_claim_devices (order_id, station, device_hash, expires_at)
    values (p_order_id, p_station, device_hash, now() + interval '30 seconds')
    on conflict (order_id, device_hash) do update
      set station = excluded.station, expires_at = excluded.expires_at;
  return (to_jsonb(order_row) - 'qr_token_hash' - 'claimed_token_hash' - 'client_request_id')
    || jsonb_build_object('claimed_station', p_station, 'claim_expires_at', now() + interval '30 seconds');
end;
$$;
revoke execute on function public.claim_order_for_station(uuid, text, text) from public;
grant execute on function public.claim_order_for_station(uuid, text, text) to authenticated;

create or replace function public.claim_order_by_qr_for_station(
  p_qr_token text, p_station text, p_device_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare target_id uuid;
begin
  if p_qr_token is null or length(p_qr_token) not between 32 and 80 then raise exception 'invalid_qr_token'; end if;
  select id into target_id from public.orders
  where qr_token_hash = encode(extensions.digest(p_qr_token, 'sha256'), 'hex')
    and status = 'in_attesa_pagamento';
  if target_id is null then raise exception 'order_not_available'; end if;
  return public.claim_order_for_station(target_id, p_station, p_device_id);
end;
$$;
revoke execute on function public.claim_order_by_qr_for_station(text, text, text) from public;
grant execute on function public.claim_order_by_qr_for_station(text, text, text) to authenticated;

create or replace function public.release_order_for_station(
  p_order_id uuid, p_station text, p_device_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role in ('cassa', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  delete from public.order_claim_devices
  where order_id = p_order_id and station = p_station
    and device_hash = encode(extensions.digest(p_device_id, 'sha256'), 'hex');
end;
$$;
revoke execute on function public.release_order_for_station(uuid, text, text) from public;
grant execute on function public.release_order_for_station(uuid, text, text) to authenticated;

create or replace function public.force_release_order(p_order_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role in ('cassa', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  delete from public.order_claim_devices where order_id = p_order_id;
end;
$$;
revoke execute on function public.force_release_order(uuid) from public;
grant execute on function public.force_release_order(uuid) to authenticated;

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
    where target.id = p_order_id for key share of event;
  if not found or event_row.permanently_closed_at is not null then raise exception 'event_closed'; end if;
  select * into order_row from public.orders where id = p_order_id for update;
  if not found or order_row.status <> 'in_attesa_pagamento' or not exists (
    select 1 from public.order_claim_devices claims where claims.order_id = p_order_id
      and claims.station = p_station and claims.device_hash = device_hash_value and claims.expires_at > now()
  ) then raise exception 'claim_lost'; end if;
  perform public.seed_order_fulfillment(order_row.id, order_row.items);
  update public.orders set status = 'pagato', paid_at = now(), delivered_at = null,
    completed_at = null, claimed_token_hash = null, claim_expires_at = null
    where id = p_order_id returning * into order_row;
  delete from public.order_claim_devices where order_id = p_order_id;
  return to_jsonb(order_row) - 'qr_token_hash' - 'claimed_token_hash' - 'client_request_id';
end;
$$;
revoke execute on function public.pay_order_for_station(uuid, text, text) from public;
grant execute on function public.pay_order_for_station(uuid, text, text) to authenticated;

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
revoke execute on function public.cancel_order_for_station(uuid, text, text) from public;
grant execute on function public.cancel_order_for_station(uuid, text, text) to authenticated;

create or replace function public.fulfillment_station_allowed(p_station text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and (
      role = 'admin'
      or (role = 'cucina' and p_station in ('cucina', 'primi', 'secondi', 'contorni', 'dolci', 'furgone'))
      or (role = 'bar' and p_station in ('birre', 'drinks', 'bar'))
    )
  );
$$;
revoke execute on function public.fulfillment_station_allowed(text) from public, anon, authenticated;

create or replace function public.get_fulfillment_queue(p_station text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare result jsonb;
begin
  if not public.fulfillment_station_allowed(p_station) then raise exception 'not_authorized' using errcode = '42501'; end if;
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
revoke execute on function public.get_fulfillment_queue(text) from public;
grant execute on function public.get_fulfillment_queue(text) to authenticated;

create or replace function public.get_fulfillment_order_by_qr(p_qr_token text, p_station text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare result jsonb;
begin
  if not public.fulfillment_station_allowed(p_station) then raise exception 'not_authorized' using errcode = '42501'; end if;
  if p_qr_token is null or length(p_qr_token) not between 32 and 80 then raise exception 'invalid_qr_token'; end if;
  select jsonb_build_object(
    'id', orders_row.id, 'display_number', orders_row.display_number,
    'alias', orders_row.alias, 'notes', orders_row.notes, 'paid_at', orders_row.paid_at,
    'status', orders_row.status,
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
revoke execute on function public.get_fulfillment_order_by_qr(text, text) from public;
grant execute on function public.get_fulfillment_order_by_qr(text, text) to authenticated;

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
revoke execute on function public.deliver_fulfillment_items(uuid, text, jsonb) from public;
grant execute on function public.deliver_fulfillment_items(uuid, text, jsonb) to authenticated;

create or replace function public.get_recent_fulfillment_deliveries(p_station text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare result jsonb;
begin
  if not public.fulfillment_station_allowed(p_station) then raise exception 'not_authorized' using errcode = '42501'; end if;
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
revoke execute on function public.get_recent_fulfillment_deliveries(text) from public;
grant execute on function public.get_recent_fulfillment_deliveries(text) to authenticated;

create or replace function public.undo_fulfillment_delivery(p_delivery_id uuid, p_station text)
returns void language plpgsql security definer set search_path = public as $$
declare delivery_row public.fulfillment_deliveries%rowtype; user_role text;
begin
  select role into user_role from public.profiles where id = auth.uid();
  select * into delivery_row from public.fulfillment_deliveries where id = p_delivery_id for update;
  if not found or delivery_row.reversed_at is not null then raise exception 'delivery_not_available'; end if;
  if user_role = 'admin' and exists (
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
end;
$$;
revoke execute on function public.undo_fulfillment_delivery(uuid, text) from public;
grant execute on function public.undo_fulfillment_delivery(uuid, text) to authenticated;

create or replace function public.get_public_order_statuses(p_qr_tokens text[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare result jsonb;
begin
  if p_qr_tokens is null or cardinality(p_qr_tokens) < 1 or cardinality(p_qr_tokens) > 50 then
    raise exception 'invalid_qr_tokens';
  end if;
  if exists (select 1 from unnest(p_qr_tokens) token
    where token is null or length(token) not between 32 and 80) then raise exception 'invalid_qr_tokens'; end if;
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
revoke execute on function public.get_public_order_statuses(text[]) from public;
grant execute on function public.get_public_order_statuses(text[]) to anon, authenticated;

-- Gli ordini creati d'emergenza in cassa entrano sempre nelle code di ritiro.
create or replace function public.create_counter_order(p_alias text, p_notes text, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare event_row public.order_events%rowtype; normalized jsonb; calculated_total numeric;
  next_number bigint; created_order public.orders%rowtype;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role in ('cassa', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_alias is null or length(btrim(p_alias)) not between 2 and 32 then raise exception 'invalid_alias'; end if;
  if length(coalesce(p_notes, '')) > 300 then raise exception 'notes_too_long'; end if;
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
  return to_jsonb(created_order) - 'qr_token_hash' - 'claimed_token_hash' - 'client_request_id';
end;
$$;
revoke execute on function public.create_counter_order(text, text, jsonb) from public;
grant execute on function public.create_counter_order(text, text, jsonb) to authenticated;

-- I ruoli di evasione leggono gli ordini attivi tramite le RPC filtrate.
drop policy if exists "La cucina legge solo gli ordini pagati" on public.orders;
create policy "Le postazioni leggono gli ordini in preparazione"
  on public.orders for select using (
    status in ('pagato', 'ritiro_parziale', 'consegnato')
    and exists (select 1 from public.profiles where id = auth.uid() and role in ('cucina', 'bar', 'admin'))
  );

-- Pulisce i vecchi claim; il nuovo flusso usa sessioni per dispositivo.
update public.orders set claimed_token_hash = null, claim_expires_at = null
where claimed_token_hash is not null or claim_expires_at is not null;

create or replace function public.close_order_event()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare event_row public.order_events%rowtype; report jsonb;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role in ('cassa', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into event_row from public.order_events where is_current for update;
  if not found then raise exception 'no_event'; end if;
  if event_row.permanently_closed_at is not null then return event_row.final_report; end if;

  -- Completa l'ordine globale dei lock evento -> ordini -> menu. Le altre RPC
  -- mutanti mantengono un lock condiviso sull'evento finché hanno finito.
  perform 1 from public.orders
  where event_id = event_row.id order by id for update;

  with reserved as (
    select (line->>'id')::uuid id, sum((line->>'qty')::integer)::integer qty
    from public.orders orders_row
    cross join lateral jsonb_array_elements(orders_row.items) line
    where orders_row.event_id = event_row.id and orders_row.status = 'in_attesa_pagamento'
    group by 1
  )
  update public.menu_items menu set
    stock_capacity = case
      when menu.available_portions is not null and menu.stock_capacity is not null
        then greatest(menu.stock_capacity, menu.available_portions + reserved.qty)
      else menu.stock_capacity end,
    available_portions = case
      when menu.available_portions is null then null else menu.available_portions + reserved.qty end
  from reserved where menu.id = reserved.id;

  select jsonb_build_object(
    'event_id', event_row.id,
    'event_name', event_row.name,
    'closed_at', now(),
    'summary', jsonb_build_object(
      'orders_total', count(*),
      'orders_paid', count(*) filter (where status in ('pagato', 'ritiro_parziale', 'consegnato')),
      'orders_cancelled', count(*) filter (where status = 'annullato'),
      'orders_abandoned', count(*) filter (where status = 'in_attesa_pagamento'),
      'revenue_total', coalesce(sum(total) filter (where status in ('pagato', 'ritiro_parziale', 'consegnato')), 0)
    ),
    'products', coalesce((
      select jsonb_agg(product order by product->>'name') from (
        select jsonb_build_object(
          'id', line->>'id', 'name', line->>'name', 'category', line->>'category',
          'quantity', sum((line->>'qty')::integer),
          'revenue', sum((line->>'qty')::integer * (line->>'price')::numeric)
        ) product
        from public.orders paid_order
        cross join lateral jsonb_array_elements(paid_order.items) line
        where paid_order.event_id = event_row.id and paid_order.status in ('pagato', 'ritiro_parziale', 'consegnato')
        group by line->>'id', line->>'name', line->>'category'
      ) products_rows
    ), '[]'::jsonb),
    'orders', coalesce(jsonb_agg(jsonb_build_object(
      'number', display_number, 'created_at', created_at, 'paid_at', paid_at,
      'status', case when status = 'in_attesa_pagamento' then 'abbandonato' else status end,
      'items', items, 'total', total
    ) order by display_number), '[]'::jsonb)
  ) into report from public.orders where event_id = event_row.id;

  update public.orders set
    status = case
      when status = 'in_attesa_pagamento' then 'annullato'
      when status in ('pagato', 'ritiro_parziale') then 'consegnato'
      else status end,
    cancelled_at = case when status = 'in_attesa_pagamento' then now() else cancelled_at end,
    delivered_at = case when status in ('pagato', 'ritiro_parziale') then now() else delivered_at end,
    completed_at = case when status in ('pagato', 'ritiro_parziale') then now() else completed_at end,
    alias = null, notes = null, qr_token_hash = null, client_request_id = null,
    claimed_token_hash = null, claim_expires_at = null
  where event_id = event_row.id;
  update public.order_events set permanently_closed_at = now(), manual_closed = true,
    final_report = report - 'orders' where id = event_row.id;
  return report;
end;
$$;

revoke execute on function public.close_order_event() from public;
grant execute on function public.close_order_event() to authenticated;

-- Abilita gli aggiornamenti live; il client mantiene anche un polling di sicurezza.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
    and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'order_fulfillment_items') then
    alter publication supabase_realtime add table public.order_fulfillment_items;
  end if;
end
$$;
