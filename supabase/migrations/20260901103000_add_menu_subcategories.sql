alter table public.menu_items add column if not exists subcategory text;

update public.menu_items
set subcategory = case
  when category = 'cibo' and lower(name) ~ '(dolce|torta|gelato|dessert|crostata|biscotto|tiramis)' then 'dolci'
  when category = 'cibo' and lower(name) ~ '(patatin|contorno|insalata|verdure|polenta|fritto misto)' then 'contorni'
  when category = 'cibo' and lower(name) ~ '(pasta|risotto|lasagn|gnocc|raviol|tortell|primo)' then 'primi'
  when category = 'cibo' then 'secondi'
  when category = 'bevande' and lower(name) ~ '(birra|lager|ipa|pils|weiss|bionda|rossa)' then 'birre'
  when category = 'bevande' and lower(name) ~ '(vino|prosecco|spumante|rosso|bianco|rosé|rose)' then 'vini'
  when category = 'bevande' and lower(name) ~ '(spritz|cocktail|drink|gin|vodka|rum|amaro|grappa|mojito|negroni)' then 'drinks'
  else 'bevande'
end
where subcategory is null
  or not (
    (category = 'cibo' and subcategory in ('primi', 'secondi', 'contorni', 'dolci'))
    or (category = 'bevande' and subcategory in ('birre', 'vini', 'drinks', 'bevande'))
  );

alter table public.menu_items alter column subcategory set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.menu_items'::regclass
      and conname = 'menu_items_subcategory_valid'
  ) then
    alter table public.menu_items add constraint menu_items_subcategory_valid check (
      (category = 'cibo' and subcategory in ('primi', 'secondi', 'contorni', 'dolci'))
      or (category = 'bevande' and subcategory in ('birre', 'vini', 'drinks', 'bevande'))
    );
  end if;
end
$$;

create or replace function public.bulk_upsert_menu_items(
  p_created jsonb default '[]'::jsonb,
  p_updated jsonb default '[]'::jsonb,
  p_deleted uuid[] default '{}'::uuid[]
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if jsonb_typeof(coalesce(p_created, '[]'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(p_updated, '[]'::jsonb)) <> 'array' then
    raise exception 'created and updated must be arrays';
  end if;

  if jsonb_array_length(coalesce(p_created, '[]'::jsonb)) > 0 then
    insert into public.menu_items (category, subcategory, name, price, available_portions, stock_capacity, allergens)
    select elem->>'category', elem->>'subcategory', btrim(elem->>'name'), (elem->>'price')::numeric,
      (elem->>'available_portions')::integer, (elem->>'available_portions')::integer,
      coalesce((select array_agg(value::smallint order by value::smallint)
        from jsonb_array_elements_text(coalesce(elem->'allergens', '[]'::jsonb))), '{}'::smallint[])
    from jsonb_array_elements(p_created) elem;
  end if;

  if jsonb_array_length(coalesce(p_updated, '[]'::jsonb)) > 0 then
    perform 1
    from public.menu_items menu
    join jsonb_array_elements(p_updated) elem on menu.id = (elem->>'id')::uuid
    order by menu.id
    for update of menu;

    if exists (
      select 1
      from public.menu_items menu
      join jsonb_array_elements(p_updated) elem on menu.id = (elem->>'id')::uuid
      where (elem->>'available_portions')::integer
          is distinct from (elem->>'original_available_portions')::integer
        and menu.available_portions
          is distinct from (elem->>'original_available_portions')::integer
    ) then
      raise exception 'stock_changed_retry';
    end if;

    update public.menu_items menu
    set category = elem->>'category', subcategory = elem->>'subcategory',
      name = btrim(elem->>'name'), price = (elem->>'price')::numeric,
      stock_capacity = case
        when (elem->>'available_portions')::integer
          is distinct from (elem->>'original_available_portions')::integer
          then (elem->>'available_portions')::integer
        else menu.stock_capacity end,
      available_portions = case
        when (elem->>'available_portions')::integer
          is distinct from (elem->>'original_available_portions')::integer
          then (elem->>'available_portions')::integer
        else menu.available_portions end,
      allergens = coalesce((select array_agg(value::smallint order by value::smallint)
        from jsonb_array_elements_text(coalesce(elem->'allergens', '[]'::jsonb))), '{}'::smallint[])
    from jsonb_array_elements(p_updated) elem
    where menu.id = (elem->>'id')::uuid;
  end if;

  if coalesce(array_length(p_deleted, 1), 0) > 0 then
    delete from public.menu_items where id = any(p_deleted);
  end if;
end;
$$;

revoke execute on function public.bulk_upsert_menu_items(jsonb, jsonb, uuid[]) from public;
grant execute on function public.bulk_upsert_menu_items(jsonb, jsonb, uuid[]) to authenticated;
