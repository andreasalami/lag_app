begin;
alter table public.orders add column if not exists report_status text;
create or replace function public.get_order_event_report()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare report jsonb;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role in ('cassa', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select event_row.final_report || jsonb_build_object(
    'orders', coalesce(jsonb_agg(jsonb_build_object(
      'number', orders_row.display_number,
      'created_at', orders_row.created_at,
      'paid_at', orders_row.paid_at,
      'status', coalesce(orders_row.report_status, orders_row.status),
      'items', orders_row.items,
      'total', orders_row.total
    ) order by orders_row.display_number) filter (where orders_row.id is not null), '[]'::jsonb)
  ) into report
  from public.order_events event_row
  left join public.orders orders_row on orders_row.event_id = event_row.id
  where event_row.is_current
  group by event_row.id, event_row.final_report;
  return report;
end;
$$;

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
  if event_row.permanently_closed_at is not null then return public.get_order_event_report(); end if;

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
    report_status = case when status = 'in_attesa_pagamento' then 'abbandonato' else status end,
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
commit;
