-- Migrazione: tasto "Salva" per Programma e Menu + giorni evento fino a 3.
-- Esegui in Supabase: Database > SQL Editor > New query > Run.
-- Una tantum sul DB già in produzione (schema.sql da solo non basta:
-- "create table if not exists" non tocca le tabelle che esistono già).

-- 1) Il vincolo su program_slots.day era 1-2, ora arriva a 3.
--    Il nome del constraint è quello assegnato di default da Postgres
--    per un CHECK inline su una singola colonna. Se questo ALTER dà
--    errore "constraint does not exist", controlla il nome vero con
--    \d program_slots nell'SQL editor e sostituiscilo qui sotto.
alter table program_slots drop constraint if exists program_slots_day_check;
alter table program_slots add constraint program_slots_day_check check (day between 1 and 3);

-- 2) RPC batch per il Programma: crea/modifica/elimina slot in una
--    transazione unica (o tutto o niente). security invoker: gira con
--    i permessi di chi chiama, le RLS già esistenti (solo staff/admin)
--    si applicano da sole riga per riga, non serve ripetere il check qui.
create or replace function public.bulk_upsert_program_slots(
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
  if p_created is not null and jsonb_array_length(p_created) > 0 then
    insert into program_slots (day, stage, title, start_time, end_time)
    select
      (elem->>'day')::integer,
      (elem->>'stage')::text,
      (elem->>'title')::text,
      (elem->>'start_time')::text,
      (elem->>'end_time')::text
    from jsonb_array_elements(p_created) as elem;
  end if;

  if p_updated is not null and jsonb_array_length(p_updated) > 0 then
    update program_slots as p
    set
      day = (elem->>'day')::integer,
      stage = (elem->>'stage')::text,
      title = (elem->>'title')::text,
      start_time = (elem->>'start_time')::text,
      end_time = (elem->>'end_time')::text
    from jsonb_array_elements(p_updated) as elem
    where p.id = (elem->>'id')::uuid;
  end if;

  if p_deleted is not null and array_length(p_deleted, 1) > 0 then
    delete from program_slots where id = any(p_deleted);
  end if;
end;
$$;

revoke execute on function public.bulk_upsert_program_slots(jsonb, jsonb, uuid[]) from public;
grant execute on function public.bulk_upsert_program_slots(jsonb, jsonb, uuid[]) to authenticated;

-- 3) Stessa cosa per il Menu.
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
  if p_created is not null and jsonb_array_length(p_created) > 0 then
    insert into menu_items (category, name, price, available_portions)
    select
      (elem->>'category')::text,
      (elem->>'name')::text,
      (elem->>'price')::numeric,
      (elem->>'available_portions')::integer
    from jsonb_array_elements(p_created) as elem;
  end if;

  if p_updated is not null and jsonb_array_length(p_updated) > 0 then
    update menu_items as m
    set
      category = (elem->>'category')::text,
      name = (elem->>'name')::text,
      price = (elem->>'price')::numeric,
      available_portions = (elem->>'available_portions')::integer
    from jsonb_array_elements(p_updated) as elem
    where m.id = (elem->>'id')::uuid;
  end if;

  if p_deleted is not null and array_length(p_deleted, 1) > 0 then
    delete from menu_items where id = any(p_deleted);
  end if;
end;
$$;

revoke execute on function public.bulk_upsert_menu_items(jsonb, jsonb, uuid[]) from public;
grant execute on function public.bulk_upsert_menu_items(jsonb, jsonb, uuid[]) to authenticated;
