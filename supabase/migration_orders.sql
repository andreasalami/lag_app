-- ============================================================
-- DA AGGIUNGERE A supabase/schema.sql (o eseguire a parte una
-- volta sola nel SQL Editor di Supabase).
-- ============================================================

-- Aggiungiamo i ruoli 'admin', 'cassa' e 'cucina' a quelli già esistenti
-- (staff, tournament_manager). Stesso meccanismo, stessa tabella
-- profiles: si crea l'account in Auth, poi si cambia manualmente
-- il campo role su quella riga.
alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check
  check (role in ('pending', 'admin', 'staff', 'tournament_manager', 'cassa', 'cucina'));

-- Gli utenti creati tramite Auth non ricevono permessi operativi
-- finché un amministratore non assegna esplicitamente il ruolo.
alter table profiles alter column role set default 'pending';

alter table menu_items add column if not exists available_portions integer check (available_portions is null or available_portions >= 0);

alter table program_slots add column if not exists day integer not null default 1;
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'program_slots_day_check'
      and conrelid = 'program_slots'::regclass
  ) then
    alter table program_slots add constraint program_slots_day_check check (day between 1 and 2);
  end if;
end
$$;

create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, role)
  values (new.id, 'pending');
  return new;
end;
$$ language plpgsql security definer set search_path = public;

alter policy "Solo lo staff pubblica annunci" on announcements
  with check (exists (select 1 from profiles where id = auth.uid() and role in ('staff', 'admin')));
alter policy "Solo lo staff modifica annunci" on announcements
  using (exists (select 1 from profiles where id = auth.uid() and role in ('staff', 'admin')));
alter policy "Solo lo staff elimina annunci" on announcements
  using (exists (select 1 from profiles where id = auth.uid() and role in ('staff', 'admin')));

alter policy "Solo lo staff scrive il programma" on program_slots
  with check (exists (select 1 from profiles where id = auth.uid() and role in ('staff', 'admin')));
alter policy "Solo lo staff modifica il programma" on program_slots
  using (exists (select 1 from profiles where id = auth.uid() and role in ('staff', 'admin')));
alter policy "Solo lo staff elimina dal programma" on program_slots
  using (exists (select 1 from profiles where id = auth.uid() and role in ('staff', 'admin')));

alter policy "Solo lo staff scrive il menu" on menu_items
  with check (exists (select 1 from profiles where id = auth.uid() and role in ('staff', 'admin')));
alter policy "Solo lo staff modifica il menu" on menu_items
  using (exists (select 1 from profiles where id = auth.uid() and role in ('staff', 'admin')));
alter policy "Solo lo staff elimina dal menu" on menu_items
  using (exists (select 1 from profiles where id = auth.uid() and role in ('staff', 'admin')));

-- ============================================================
-- ORDINI
-- Nessun dato personale: solo articoli, prezzo, timestamp.
-- queue_number è auto-incrementale e cronologico, gratis via
-- Postgres (nessuna race condition da gestire a mano).
-- completed_at NULL      = ordine attivo, visibile in cucina
-- completed_at valorizzato = "rimosso" dalla coda, ma la riga
--                            resta per le statistiche interne
-- ============================================================
create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  queue_number bigint generated always as identity,
  items jsonb not null,          -- [{ "name": "Panino", "qty": 2, "price": 5 }, ...]
  total numeric(7,2) not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table orders enable row level security;

-- Cassa e cucina leggono entrambe (la cassa per conferma, la
-- cucina per la coda). Nessun accesso pubblico: niente RLS "true".
drop policy if exists "Cassa e cucina leggono gli ordini" on orders;
create policy "Cassa e cucina leggono gli ordini"
  on orders for select
  using (
    exists (select 1 from profiles where id = auth.uid() and role in ('cassa', 'cucina', 'admin'))
  );

drop policy if exists "Solo la cassa crea ordini" on orders;
create policy "Solo la cassa crea ordini"
  on orders for insert
  with check (
    exists (select 1 from profiles where id = auth.uid() and role in ('cassa', 'admin'))
  );

-- Update copre sia l'eventuale "pronto" sia il completed_at:
-- un solo permesso, la cucina è l'unica che tocca lo stato.
drop policy if exists "Solo la cucina aggiorna gli ordini" on orders;
create policy "Solo la cucina aggiorna gli ordini"
  on orders for update
  using (
    exists (select 1 from profiles where id = auth.uid() and role in ('cucina', 'admin'))
  )
  with check (
    completed_at is not null
    or exists (select 1 from profiles where id = auth.uid() and role = 'admin')
  );

-- La cucina può aggiornare solo il timestamp; admin può aggiornare tutto.
create or replace function public.protect_order_updates()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from profiles where id = auth.uid() and role = 'admin') then
    return new;
  end if;
  if new.id is distinct from old.id
    or new.queue_number is distinct from old.queue_number
    or new.items is distinct from old.items
    or new.total is distinct from old.total
    or new.created_at is distinct from old.created_at then
    raise exception 'only admin can modify order data';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_order_updates on orders;
create trigger protect_order_updates
  before update on orders
  for each row execute function public.protect_order_updates();

grant update on orders to authenticated;

-- Crea l'ordine usando prezzi e nomi letti dal menu, mai dai valori
-- forniti dal browser.
drop function if exists public.create_order(jsonb);
create function public.create_order(p_items jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  normalized_items jsonb;
  calculated_total numeric(7,2);
  created_queue_number bigint;
  warning_messages jsonb := '[]'::jsonb;
  item_id uuid;
  requested_qty integer;
  original_available integer;
  remaining integer;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'items must be a non-empty array';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_items) as line
    where jsonb_typeof(line) <> 'object'
      or (line->>'id') is null
      or (line->>'qty') !~ '^[1-9][0-9]*$'
  ) then
    raise exception 'invalid order items';
  end if;

  select
    jsonb_agg(jsonb_build_object(
      'id', menu.id,
      'name', menu.name,
      'qty', (line->>'qty')::integer,
      'price', menu.price
    )),
    sum(menu.price * (line->>'qty')::integer)::numeric(7,2)
  into normalized_items, calculated_total
  from jsonb_array_elements(p_items) as line
  join menu_items as menu on menu.id = (line->>'id')::uuid;

  if normalized_items is null or jsonb_array_length(normalized_items) <> jsonb_array_length(p_items) then
    raise exception 'unknown menu item';
  end if;

  for item_id, requested_qty in
    select (line->>'id')::uuid, sum((line->>'qty')::integer)::integer
    from jsonb_array_elements(p_items) as line
    group by (line->>'id')::uuid
    order by (line->>'id')::uuid
  loop
    select available_portions
    into original_available
    from menu_items
    where id = item_id;

    update menu_items
    set available_portions = available_portions - requested_qty
    where id = item_id
      and (available_portions is null or available_portions >= requested_qty)
    returning available_portions into remaining;

    if not found then
      raise exception 'porzioni insufficienti';
    end if;

    if original_available is not null
      and remaining <= ceil(original_available * 0.2) then
      warning_messages := warning_messages || jsonb_build_array(
        format('%s: rimangono %s porzioni', (select name from menu_items where id = item_id), remaining)
      );
    end if;
  end loop;

  insert into orders (items, total)
  values (normalized_items, calculated_total)
  returning queue_number into created_queue_number;

  return jsonb_build_object('queue_number', created_queue_number, 'warnings', warning_messages);
end;
$$;

revoke execute on function public.create_order(jsonb) from public;
grant execute on function public.create_order(jsonb) to authenticated;

create or replace function public.get_low_stock_items()
returns table (id uuid, name text, remaining integer, available integer)
language sql
security invoker
set search_path = public
as $$
  select menu.id, menu.name,
    menu.available_portions::integer,
    menu.available_portions
  from menu_items as menu
  where menu.available_portions is not null
    and menu.available_portions <= ceil(menu.available_portions * 0.2);
$$;

revoke execute on function public.get_low_stock_items() from public;
grant execute on function public.get_low_stock_items() to authenticated;

-- Nessuna policy DELETE: non si cancella mai davvero una riga,
-- solo soft-delete via completed_at. I dati restano per le stats.

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'orders'
  ) then
    alter publication supabase_realtime add table orders;
  end if;
end
$$;
