begin;

-- Menu modificabile durante l'evento (2026-11-10).
-- Regola: un ordine già inviato conserva i suoi articoli; sospensione ed eliminazione
-- valgono solo per gli ordini successivi e non bloccano mai cassa, scadenze o ordinazioni.

-- La sospensione è separata dalla scorta: annullare o far scadere un ordine restituisce
-- le porzioni ma non riapre il prodotto.
alter table public.menu_items add column if not exists suspended boolean not null default false;

create or replace function public.apply_order_stock(p_old_items jsonb, p_new_items jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  delta_row record;
  menu_row record;
  unavailable_names text[] := '{}'::text[];
begin
  for delta_row in
    with old_lines as (
      select (line->>'id')::uuid id, sum((line->>'qty')::integer)::integer qty
      from jsonb_array_elements(coalesce(p_old_items, '[]'::jsonb)) line group by 1
    ), new_lines as (
      select (line->>'id')::uuid id, sum((line->>'qty')::integer)::integer qty
      from jsonb_array_elements(coalesce(p_new_items, '[]'::jsonb)) line group by 1
    )
    select coalesce(n.id, o.id) id,
      coalesce(n.qty, 0) - coalesce(o.qty, 0) delta
    from old_lines o full join new_lines n on n.id = o.id
    order by 1
  loop
    select name, available_portions, suspended into menu_row
    from public.menu_items where id = delta_row.id for update;
    if not found then
      -- Prodotto eliminato dal menu: chi restituisce scorte prosegue con gli altri prodotti.
      if delta_row.delta > 0 then raise exception 'unknown_menu_item'; end if;
      continue;
    end if;
    if delta_row.delta > 0 and (menu_row.suspended
      or (menu_row.available_portions is not null and menu_row.available_portions < delta_row.delta)) then
      unavailable_names := array_append(unavailable_names, menu_row.name);
    end if;
  end loop;

  if cardinality(unavailable_names) > 0 then
    raise exception 'stock_unavailable:%', array_to_string(unavailable_names, ', ');
  end if;

  with old_lines as (
    select (line->>'id')::uuid id, sum((line->>'qty')::integer)::integer qty
    from jsonb_array_elements(coalesce(p_old_items, '[]'::jsonb)) line group by 1
  ), new_lines as (
    select (line->>'id')::uuid id, sum((line->>'qty')::integer)::integer qty
    from jsonb_array_elements(coalesce(p_new_items, '[]'::jsonb)) line group by 1
  ), deltas as (
    select coalesce(n.id, o.id) id, coalesce(n.qty, 0) - coalesce(o.qty, 0) delta
    from old_lines o full join new_lines n on n.id = o.id
  )
  update public.menu_items menu
  set stock_capacity = case
      when menu.available_portions is not null and menu.stock_capacity is not null and deltas.delta < 0
        then greatest(menu.stock_capacity, menu.available_portions - deltas.delta)
      else menu.stock_capacity end,
    available_portions = case when menu.available_portions is null then null
      else menu.available_portions - deltas.delta end
  from deltas where menu.id = deltas.id and deltas.delta <> 0;
end;
$$;

revoke execute on function public.apply_order_stock(jsonb, jsonb) from public, anon, authenticated;

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
    'stock_capacity', stock_capacity, 'allergens', to_jsonb(allergens), 'suspended', suspended
  ) order by category, subcategory, name), '[]'::jsonb)
  into catalog from public.menu_items;
  return status_payload || jsonb_build_object('items', catalog);
end;
$$;
revoke execute on function public.get_ordering_catalog() from public;
grant execute on function public.get_ordering_catalog() to anon, authenticated;

-- Scorta dopo una modifica dello staff: si applica la differenza tra il numero scritto e
-- quello che lo staff vedeva, così le vendite avvenute nel frattempo non vengono sovrascritte.
create or replace function public.menu_stock_after_edit(p_current integer, p_original integer, p_requested integer)
returns integer language sql immutable as $$
  select case
    when p_requested is null then null
    when p_current is null or p_original is null then p_requested
    else greatest(0, p_current + (p_requested - p_original)) end;
$$;
revoke execute on function public.menu_stock_after_edit(integer, integer, integer) from public;
grant execute on function public.menu_stock_after_edit(integer, integer, integer) to authenticated;

-- Il tipo restituito cambia (void -> jsonb): la vecchia firma va eliminata.
drop function if exists public.bulk_upsert_menu_items(jsonb, jsonb, uuid[]);

create or replace function public.bulk_upsert_menu_items(
  p_created jsonb default '[]'::jsonb,
  p_updated jsonb default '[]'::jsonb,
  p_deleted uuid[] default '{}'::uuid[]
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  missing uuid[];
  existing_count integer;
  changed_count integer;
begin
  p_created := coalesce(p_created, '[]'::jsonb);
  p_updated := coalesce(p_updated, '[]'::jsonb);
  p_deleted := coalesce(p_deleted, '{}'::uuid[]);
  if jsonb_typeof(p_created) <> 'array' or jsonb_typeof(p_updated) <> 'array' then
    raise exception 'created and updated must be arrays';
  end if;

  -- L'id scelto dal dispositivo rende ripetibile il salvataggio: un secondo invio non crea doppioni.
  insert into public.menu_items (id, category, subcategory, name, price, available_portions, stock_capacity, allergens)
  select coalesce((elem->>'id')::uuid, gen_random_uuid()),
    elem->>'category', elem->>'subcategory', btrim(elem->>'name'), (elem->>'price')::numeric,
    (elem->>'available_portions')::integer, (elem->>'available_portions')::integer,
    coalesce((select array_agg(value::smallint order by value::smallint)
      from jsonb_array_elements_text(coalesce(elem->'allergens', '[]'::jsonb))), '{}'::smallint[])
  from jsonb_array_elements(p_created) elem
  on conflict (id) do nothing;

  -- Stesso ordine di blocco degli ordini (per id): modifiche, eliminazioni e vendite non si incrociano.
  perform 1 from public.menu_items menu
  where menu.id = any(p_deleted)
    or menu.id in (select (elem->>'id')::uuid from jsonb_array_elements(p_updated) elem)
  order by menu.id
  for update;

  select coalesce(array_agg(wanted.id), '{}'::uuid[]) into missing
  from (select distinct (elem->>'id')::uuid id from jsonb_array_elements(p_updated) elem) wanted
  where not exists (select 1 from public.menu_items menu where menu.id = wanted.id);
  select count(*) into existing_count from public.menu_items menu
  where menu.id in (select (elem->>'id')::uuid from jsonb_array_elements(p_updated) elem);

  -- Ogni dispositivo invia solo i campi che ha cambiato: due modifiche su campi diversi convivono.
  with changed as (
    update public.menu_items menu
    set category = case when edit.elem ? 'category' then edit.elem->>'category' else menu.category end,
      subcategory = case when edit.elem ? 'subcategory' then edit.elem->>'subcategory' else menu.subcategory end,
      name = case when edit.elem ? 'name' then btrim(edit.elem->>'name') else menu.name end,
      price = case when edit.elem ? 'price' then (edit.elem->>'price')::numeric else menu.price end,
      allergens = case when edit.elem ? 'allergens'
        then coalesce((select array_agg(value::smallint order by value::smallint)
          from jsonb_array_elements_text(edit.elem->'allergens')), '{}'::smallint[])
        else menu.allergens end,
      available_portions = case when edit.stock_edit
        then public.menu_stock_after_edit(menu.available_portions, edit.original, edit.requested)
        else menu.available_portions end,
      stock_capacity = case when edit.stock_edit
        then public.menu_stock_after_edit(menu.available_portions, edit.original, edit.requested)
        else menu.stock_capacity end
    from (
      select elem, (elem->>'id')::uuid id,
        (elem ? 'available_portions' and (elem->>'available_portions')::integer
          is distinct from (elem->>'original_available_portions')::integer) stock_edit,
        (elem->>'available_portions')::integer requested,
        (elem->>'original_available_portions')::integer original
      from jsonb_array_elements(p_updated) elem
    ) edit
    where menu.id = edit.id
    returning menu.id
  )
  select count(*) into changed_count from changed;
  -- L'RLS scarta in silenzio le righe non modificabili dal ruolo: qui diventa un errore esplicito.
  if changed_count < existing_count then raise exception 'not_authorized' using errcode = '42501'; end if;

  delete from public.menu_items where id = any(p_deleted);
  if exists (select 1 from public.menu_items where id = any(p_deleted)) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  return jsonb_build_object('missing', to_jsonb(missing));
end;
$$;

revoke execute on function public.bulk_upsert_menu_items(jsonb, jsonb, uuid[]) from public;
grant execute on function public.bulk_upsert_menu_items(jsonb, jsonb, uuid[]) to authenticated;

-- Quanto resta da evadere per ogni prodotto: chi sospende o elimina lo vede prima di confermare,
-- e la cucina lo consulta nel pannello Pietanze. Solo conteggi, nessun dato degli ordini.
create or replace function public.get_menu_item_commitments()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare result jsonb;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role in ('staff', 'cucina', 'bar', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', totals.id, 'paid_portions', totals.paid_portions, 'paid_orders', totals.paid_orders,
    'unpaid_portions', totals.unpaid_portions, 'unpaid_orders', totals.unpaid_orders)), '[]'::jsonb)
  into result from (
    select parts.id, sum(parts.paid_portions)::integer paid_portions, sum(parts.paid_orders)::integer paid_orders,
      sum(parts.unpaid_portions)::integer unpaid_portions, sum(parts.unpaid_orders)::integer unpaid_orders
    from (
      select fulfillment.menu_item_id id, sum(fulfillment.quantity - fulfillment.delivered_quantity) paid_portions,
        count(*) paid_orders, 0 unpaid_portions, 0 unpaid_orders
      from public.order_fulfillment_items fulfillment
      join public.orders orders_row on orders_row.id = fulfillment.order_id
      where orders_row.status in ('pagato', 'ritiro_parziale')
        and fulfillment.delivered_quantity < fulfillment.quantity
      group by fulfillment.menu_item_id
      union all
      select (line->>'id')::uuid, 0, 0, sum((line->>'qty')::integer), count(*)
      from public.orders orders_row
      cross join lateral jsonb_array_elements(orders_row.items) line
      where orders_row.status = 'in_attesa_pagamento'
      group by 1
    ) parts
    group by parts.id
  ) totals;
  return result;
end;
$$;
revoke execute on function public.get_menu_item_commitments() from public, anon;
grant execute on function public.get_menu_item_commitments() to authenticated;

-- Nuovo parametro p_expected_total: la firma precedente va eliminata, altrimenti resterebbe come overload.
drop function if exists public.submit_public_order(text,text,jsonb,uuid,text,text,uuid,text,text);

create or replace function public.submit_public_order(
  p_alias text,
  p_notes text,
  p_items jsonb,
  p_client_request_id uuid,
  p_qr_token text,
  p_bot_field text default '',
  p_expected_event_id uuid default null,
  p_recovery_token text default null,
  p_preparation_mode text default 'immediate',
  p_expected_total numeric default null
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
  stored_mode text;
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
  -- Il cliente ha confermato un totale: se un prezzo è cambiato nel frattempo lo deve rivedere.
  if p_expected_total is not null and round(p_expected_total, 2) <> calculated_total then
    raise exception 'price_changed';
  end if;
  perform public.apply_order_stock('[]'::jsonb, normalized);
  select coalesce(max(display_number), 0) + 1 into next_number
    from public.orders where event_id = event_row.id;
  stored_mode := case when exists(select 1 from jsonb_array_elements(normalized) i where i->>'category'='cibo')
    then p_preparation_mode else 'immediate' end;

  insert into public.orders (
    event_id, display_number, alias, notes, items, total, status,
    qr_token_hash, client_request_id, recovery_token_hash, recovery_request_id, preparation_mode
  ) values (
    event_row.id, next_number, btrim(p_alias), nullif(btrim(coalesce(p_notes, '')), ''),
    normalized, calculated_total::numeric(7,2), 'in_attesa_pagamento',
    encode(extensions.digest(p_qr_token, 'sha256'), 'hex'), p_client_request_id,
    case when p_recovery_token is not null then encode(extensions.digest(p_recovery_token,'sha256'),'hex') end,
    case when p_recovery_token is not null then p_client_request_id end,
    stored_mode
  ) returning id into existing_order.id;

  return jsonb_build_object(
    'event_id', event_row.id, 'event_name', event_row.name,
    'order_id', existing_order.id, 'display_number', next_number,
    'status', 'in_attesa_pagamento', 'alias', btrim(p_alias), 'notes', nullif(btrim(coalesce(p_notes, '')), ''),
    'preparation_mode',stored_mode,'kitchen_state','none',
    'items', normalized, 'total', calculated_total, 'qr_token', p_qr_token
  );
end;
$$;
revoke execute on function public.submit_public_order(text,text,jsonb,uuid,text,text,uuid,text,text,numeric) from public,anon,authenticated;
grant execute on function public.submit_public_order(text,text,jsonb,uuid,text,text,uuid,text,text,numeric) to service_role;

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
  if p_station is null or p_station !~ '^cassa_[1-5]$' then raise exception 'invalid_station'; end if;
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
  -- unavailable_items: righe sospese o eliminate dopo l'invio. Solo informazione per la cassa:
  -- l'ordine resta valido e il totale non cambia.
  return (to_jsonb(order_row) - 'qr_token_hash' - 'claimed_token_hash' - 'client_request_id')
    || jsonb_build_object('claimed_station', p_station, 'claim_expires_at', now() + interval '30 seconds',
      'unavailable_items', coalesce((
        select jsonb_agg(line->>'id') from jsonb_array_elements(order_row.items) line
        where not exists (select 1 from public.menu_items menu
          where menu.id = (line->>'id')::uuid and not menu.suspended)), '[]'::jsonb));
end;
$$;
revoke execute on function public.claim_order_for_station(uuid, text, text) from public;
grant execute on function public.claim_order_for_station(uuid, text, text) to authenticated;

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
  -- Risposta persa dopo un pagamento riuscito: il nuovo tentativo deve dire che è già pagato.
  if found and order_row.status in ('pagato', 'ritiro_parziale', 'consegnato') then raise exception 'already_paid'; end if;
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
revoke execute on function public.pay_order_for_station(uuid, text, text) from public;
grant execute on function public.pay_order_for_station(uuid, text, text) to authenticated;

create or replace function public.create_counter_order(p_alias text, p_notes text, p_items jsonb, p_preparation_mode text default 'immediate')
returns jsonb language plpgsql security definer set search_path = public as $$
declare event_row public.order_events%rowtype; normalized jsonb; calculated_total numeric;
  next_number bigint; created_order public.orders%rowtype; stored_mode text;
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
  select sum((line->>'price')::numeric * (line->>'qty')::integer)
    into calculated_total from jsonb_array_elements(normalized) line;
  if calculated_total > 99999.99 then raise exception 'order_total_too_high'; end if;
  -- Senza cibo non c'è nulla da preparare più tardi: come per gli ordini pubblici, vale "subito".
  stored_mode := case when exists(select 1 from jsonb_array_elements(normalized) i where i->>'category'='cibo')
    then p_preparation_mode else 'immediate' end;
  perform public.promote_kitchen_waiting(event_row.id);
  if stored_mode='immediate' and exists(select 1 from jsonb_array_elements(normalized) i where i->>'category'='cibo')
    and public.kitchen_occupied(event_row.id)>=100 then raise exception 'kitchen_capacity_reached'; end if;
  perform public.apply_order_stock('[]'::jsonb, normalized);
  select coalesce(max(display_number), 0) + 1 into next_number from public.orders where event_id = event_row.id;
  insert into public.orders (event_id, display_number, alias, notes, items, total, status, paid_at, preparation_mode)
    values (event_row.id, next_number, btrim(p_alias), nullif(btrim(coalesce(p_notes, '')), ''),
      normalized, calculated_total::numeric(7,2), 'pagato', now(), stored_mode) returning * into created_order;
  perform public.seed_order_fulfillment(created_order.id, created_order.items);
  update public.orders set kitchen_state=case when not exists(select 1 from public.order_fulfillment_items where order_id=created_order.id and category='cibo') then 'none'
    when stored_mode='deferred' then 'dormant' else 'active' end,
    kitchen_requested_at=case when stored_mode='immediate' then clock_timestamp() end,
    kitchen_started_at=case when stored_mode='immediate' then clock_timestamp() end
    where id=created_order.id returning * into created_order;
  return to_jsonb(created_order) - 'qr_token_hash' - 'claimed_token_hash' - 'client_request_id';
end;
$$;
revoke execute on function public.create_counter_order(text,text,jsonb,text) from public;
grant execute on function public.create_counter_order(text,text,jsonb,text) to authenticated;

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
    where coalesce(item->>'id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or coalesce(item->>'qty', '') !~ '^[1-9][0-9]{0,3}$') then raise exception 'invalid_delivery'; end if;
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
revoke execute on function public.deliver_fulfillment_items(uuid, text, jsonb) from public;
grant execute on function public.deliver_fulfillment_items(uuid, text, jsonb) to authenticated;

create or replace function public.update_order_event(
  p_name text, p_opens_at timestamptz, p_closes_at timestamptz, p_max_pending_orders integer,
  p_evening_count integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare event_row public.order_events%rowtype;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role in ('cassa', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if btrim(coalesce(p_name, '')) = '' or length(p_name) > 100
    or p_opens_at is null or p_closes_at is null or p_max_pending_orders is null
    or p_closes_at <= p_opens_at or p_max_pending_orders not between 10 and 1000
    or p_evening_count not between 1 and 3 then
    raise exception 'invalid_event_settings';
  end if;
  -- Senza p_evening_count (client non aggiornato) la durata resta quella salvata.
  update public.order_events set name = btrim(p_name), opens_at = p_opens_at,
    closes_at = p_closes_at, max_pending_orders = p_max_pending_orders,
    evening_count = coalesce(p_evening_count, evening_count)
  where is_current and permanently_closed_at is null returning * into event_row;
  if not found then raise exception 'event_closed'; end if;
  return to_jsonb(event_row);
end;
$$;

revoke execute on function public.update_order_event(text, timestamptz, timestamptz, integer, integer) from public;
grant execute on function public.update_order_event(text, timestamptz, timestamptz, integer, integer) to authenticated;

-- Scaletta: stesse regole del menu (solo i campi cambiati, id scelti dal dispositivo,
-- righe eliminate da un altro dispositivo segnalate). Il tipo restituito cambia: void -> jsonb.
drop function if exists public.save_program(integer, jsonb, jsonb, uuid[]);

create or replace function public.save_program(
  p_days integer,
  p_created jsonb default '[]'::jsonb,
  p_updated jsonb default '[]'::jsonb,
  p_deleted uuid[] default '{}'::uuid[]
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare missing uuid[]; effective_days integer;
begin
  p_created := coalesce(p_created, '[]'::jsonb);
  p_updated := coalesce(p_updated, '[]'::jsonb);
  p_deleted := coalesce(p_deleted, '{}'::uuid[]);
  -- p_days null: il dispositivo non ha cambiato i giorni e non li riporta a un valore vecchio.
  effective_days := coalesce(p_days, (select days from public.program_settings where id = 'main'), 1);
  if effective_days not between 1 and 3 then
    raise exception 'days must be between 1 and 3';
  end if;
  if jsonb_typeof(p_created) <> 'array' or jsonb_typeof(p_updated) <> 'array' then
    raise exception 'created and updated must be arrays';
  end if;
  if exists (
    select 1
    from (
      select elem, true required from jsonb_array_elements(p_created) elem
      union all
      select elem, elem ? 'day' from jsonb_array_elements(p_updated) elem
    ) slot
    where slot.required and (coalesce(slot.elem->>'day', '') !~ '^[1-3]$'
      or case when coalesce(slot.elem->>'day', '') ~ '^[1-3]$'
        then (slot.elem->>'day')::integer > effective_days else false end)
  ) then
    raise exception 'every slot day must fit within the published event days';
  end if;

  if p_days is not null then
    insert into public.program_settings (id, days, updated_at)
    values ('main', p_days, now())
    on conflict (id) do update set days = excluded.days, updated_at = excluded.updated_at;
  end if;

  insert into public.program_slots (id, day, stage, title, start_time, end_time)
  select coalesce((elem->>'id')::uuid, gen_random_uuid()), (elem->>'day')::integer, elem->>'stage',
    btrim(elem->>'title'), elem->>'start_time', elem->>'end_time'
  from jsonb_array_elements(p_created) elem
  on conflict (id) do nothing;

  select coalesce(array_agg(wanted.id), '{}'::uuid[]) into missing
  from (select distinct (elem->>'id')::uuid id from jsonb_array_elements(p_updated) elem) wanted
  where not exists (select 1 from public.program_slots slot where slot.id = wanted.id);

  update public.program_slots slot
  set day = case when elem ? 'day' then (elem->>'day')::integer else slot.day end,
    stage = case when elem ? 'stage' then elem->>'stage' else slot.stage end,
    title = case when elem ? 'title' then btrim(elem->>'title') else slot.title end,
    start_time = case when elem ? 'start_time' then elem->>'start_time' else slot.start_time end,
    end_time = case when elem ? 'end_time' then elem->>'end_time' else slot.end_time end
  from jsonb_array_elements(p_updated) elem
  where slot.id = (elem->>'id')::uuid;

  delete from public.program_slots where id = any(p_deleted);

  -- Chi riduce i giorni non vede gli eventi aggiunti nel frattempo da un altro dispositivo:
  -- nessun evento deve restare in un giorno non più pubblicato.
  if p_days is not null and exists (select 1 from public.program_slots where day > p_days) then
    raise exception 'slots_beyond_days';
  end if;

  return jsonb_build_object('missing', to_jsonb(missing));
end;
$$;

revoke execute on function public.save_program(integer, jsonb, jsonb, uuid[]) from public;
grant execute on function public.save_program(integer, jsonb, jsonb, uuid[]) to authenticated;

commit;
