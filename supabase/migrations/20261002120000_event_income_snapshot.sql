begin;

-- Situazione incassi consultabile anche a evento aperto (PDF della sezione
-- Gestione evento). Sola lettura e solo aggregati: alias, note e token non
-- escono mai da questa funzione.
create or replace function public.get_order_event_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare event_row public.order_events%rowtype; result jsonb;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role in ('cassa', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into event_row from public.order_events where is_current limit 1;
  if not found then raise exception 'no_event'; end if;

  with paid as (
    -- Dopo la chiusura definitiva report_status conserva lo stato reale dell'ordine.
    select total, items, paid_at from public.orders
    where event_id = event_row.id
      and coalesce(report_status, status) in ('pagato', 'ritiro_parziale', 'consegnato')
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
    'event_name', event_row.name,
    'generated_at', now(),
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
  ) into result;
  return result;
end;
$$;
revoke execute on function public.get_order_event_snapshot() from public, anon;
grant execute on function public.get_order_event_snapshot() to authenticated;

commit;
