begin;

-- Durata dell'evento in serate (1-3): il PDF della situazione incassi ha una parte
-- per ogni serata più il totale.
alter table public.order_events add column if not exists evening_count smallint not null default 1
  constraint order_events_evening_count_check check (evening_count between 1 and 3);

-- Nuovo parametro: le firme vecchie vanno eliminate, altrimenti resterebbero come overload.
drop function if exists public.update_order_event(text, timestamptz, timestamptz, integer);
drop function if exists public.create_next_order_event(text, timestamptz, timestamptz, integer);

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

create or replace function public.create_next_order_event(
  p_name text, p_opens_at timestamptz, p_closes_at timestamptz, p_max_pending_orders integer default 100,
  p_evening_count integer default 1
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
  if exists (select 1 from public.order_events where is_current and permanently_closed_at is null) then
    raise exception 'current_event_not_closed';
  end if;
  if btrim(coalesce(p_name, '')) = '' or p_closes_at <= p_opens_at
    or p_max_pending_orders not between 10 and 1000
    or p_evening_count is null or p_evening_count not between 1 and 3 then
    raise exception 'invalid_event_settings';
  end if;
  update public.order_events set is_current = false where is_current;
  insert into public.order_events (name, opens_at, closes_at, max_pending_orders, evening_count, is_current)
  values (btrim(p_name), p_opens_at, p_closes_at, p_max_pending_orders, p_evening_count, true)
  returning * into event_row;
  return to_jsonb(event_row);
end;
$$;

revoke execute on function public.create_next_order_event(text, timestamptz, timestamptz, integer, integer) from public;
grant execute on function public.create_next_order_event(text, timestamptz, timestamptz, integer, integer) to authenticated;

-- Statistiche di una serata (p_evening 1-3) o dell'intero evento (null). Interna:
-- la chiama solo get_order_event_snapshot, che ha già controllato il ruolo.
-- Una serata va dalle 06:00 alle 05:59 del giorno dopo (ora di Roma): un ordine
-- pagato all'01:00 di sabato conta per venerdì. La serata 1 è quella dell'apertura
-- ordini; un pagamento fuori dalla durata va nella serata più vicina.
create or replace function public.order_event_snapshot_part(p_event_id uuid, p_evening integer)
returns jsonb
language sql
stable
set search_path = public
as $$
  with event_row as (
    select evening_count, ((opens_at at time zone 'Europe/Rome') - interval '6 hours')::date as first_evening
    from public.order_events where id = p_event_id
  ), paid as (
    -- Dopo la chiusura definitiva report_status conserva lo stato reale dell'ordine.
    select total, items, paid_at from public.orders, event_row
    where event_id = p_event_id
      and coalesce(report_status, status) in ('pagato', 'ritiro_parziale', 'consegnato')
      and (p_evening is null or least(greatest(
        ((paid_at at time zone 'Europe/Rome') - interval '6 hours')::date - event_row.first_evening + 1, 1),
        event_row.evening_count) = p_evening)
  ), sold as (
    select line->>'id' as id, line->>'name' as name, line->>'category' as category,
      line->>'subcategory' as section, sum((line->>'qty')::integer) as quantity,
      sum((line->>'qty')::integer * (line->>'price')::numeric) as revenue
    from paid cross join lateral jsonb_array_elements(paid.items) line
    group by 1, 2, 3, 4
  ), products as (
    -- Anche i prodotti del menu mai venduti: il PDF li indica come "nessun pezzo venduto".
    select coalesce(sold.name, menu.name) as name,
      coalesce(sold.category, menu.category) as category,
      coalesce(sold.section, menu.subcategory) as section,
      coalesce(sold.quantity, 0) as quantity,
      coalesce(sold.revenue, 0) as revenue
    from sold full join public.menu_items menu on menu.id::text = sold.id
  )
  select jsonb_build_object(
    'revenue_total', (select coalesce(sum(total), 0) from paid),
    'orders_paid', (select count(*) from paid),
    -- Ora locale dell'evento: date_trunc sul fuso del server (UTC) sfaserebbe il grafico.
    'hours', (select coalesce(jsonb_agg(jsonb_build_object(
        'hour', hour, 'orders', orders, 'revenue', revenue) order by hour), '[]'::jsonb)
      from (select date_trunc('hour', paid_at at time zone 'Europe/Rome') as hour,
          count(*) as orders, sum(total) as revenue
        from paid where paid_at is not null group by 1) by_hour),
    'products', (select coalesce(jsonb_agg(jsonb_build_object(
        'name', name, 'category', category, 'section', section,
        'quantity', quantity, 'revenue', revenue) order by category, section, quantity desc, name), '[]'::jsonb)
      from products)
  );
$$;

revoke execute on function public.order_event_snapshot_part(uuid, integer) from public, anon, authenticated;

create or replace function public.get_order_event_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare event_row public.order_events%rowtype;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role in ('cassa', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into event_row from public.order_events where is_current limit 1;
  if not found then raise exception 'no_event'; end if;

  -- Con una sola serata le parti coinciderebbero con il totale: "evenings" resta vuoto.
  return jsonb_build_object('event_name', event_row.name, 'generated_at', now())
    || public.order_event_snapshot_part(event_row.id, null)
    || jsonb_build_object('evenings', case when event_row.evening_count = 1 then '[]'::jsonb else (
      select jsonb_agg(public.order_event_snapshot_part(event_row.id, evening) || jsonb_build_object(
          'evening', evening,
          'date', ((event_row.opens_at at time zone 'Europe/Rome') - interval '6 hours')::date + evening - 1)
        order by evening)
      from generate_series(1, event_row.evening_count) evening) end);
end;
$$;

revoke execute on function public.get_order_event_snapshot() from public, anon;
grant execute on function public.get_order_event_snapshot() to authenticated;

commit;
