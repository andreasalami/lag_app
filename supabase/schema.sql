-- LAG — schema Supabase
-- Esegui questo script in Supabase: Database > SQL Editor > New query > Run
-- Va eseguito UNA volta sola (o quando aggiungiamo nuove tabelle).

-- ============================================================
-- PROFILI: ruolo di ogni utente autenticato.
--   staff              -> può pubblicare annunci
--   tournament_manager -> potrà gestire il torneo (NON gli annunci)
--   cassa              -> compone e conferma gli ordini
--   cucina             -> vede la coda ordini e la evade
-- ============================================================
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'pending' check (role in ('pending', 'admin', 'staff', 'tournament_manager', 'cassa', 'cucina')),
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;

create policy "Un utente legge solo il proprio profilo"
  on profiles for select
  using (auth.uid() = id);

-- Quando crei un utente in Auth (dashboard > Authentication > Add user),
-- questo trigger gli crea automaticamente una riga in profiles col ruolo
-- 'pending'. Per abilitarlo, dopo la creazione
-- vai in Table Editor > profiles e cambia manualmente il valore di role
-- per quella riga.
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, role)
  values (new.id, 'pending');
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ============================================================
-- ANNUNCI: pubblici in lettura (li vede chiunque apra l'app,
-- senza login), scrivibili solo da chi ha ruolo 'staff'.
-- ============================================================
create table if not exists announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  message text not null,
  published_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

alter table announcements enable row level security;

create policy "Chiunque legge gli annunci"
  on announcements for select
  using (true);

create policy "Solo lo staff pubblica annunci"
  on announcements for insert
  with check (
    exists (select 1 from profiles where id = auth.uid() and role in ('staff', 'admin'))
  );

create policy "Solo lo staff modifica annunci"
  on announcements for update
  using (
    exists (select 1 from profiles where id = auth.uid() and role in ('staff', 'admin'))
  );

create policy "Solo lo staff elimina annunci"
  on announcements for delete
  using (
    exists (select 1 from profiles where id = auth.uid() and role in ('staff', 'admin'))
  );

-- Realtime: serve per far comparire i nuovi annunci a chi ha la pagina
-- aperta, senza refresh. Va abilitato anche dalla dashboard:
-- Database > Replication > tabella "announcements" > Enable.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'announcements'
  ) then
    alter publication supabase_realtime add table announcements;
  end if;
end
$$;

-- ============================================================
-- PROGRAMMA: scaletta con 2 palchi in contemporanea. Pubblico in
-- lettura, modificabile solo dallo staff (stessa autenticazione
-- degli annunci — stesso ruolo 'staff', nessun ruolo a parte).
-- ============================================================
create table if not exists program_slots (
  id uuid primary key default gen_random_uuid(),
  day integer not null default 1 check (day between 1 and 3),
  stage text not null check (stage in ('Stage 1', 'Stage 2')),
  title text not null,
  start_time text not null, -- formato "HH:MM", niente data: evento di un giorno solo
  end_time text not null,
  created_at timestamptz not null default now()
);

alter table program_slots enable row level security;

create policy "Chiunque legge il programma"
  on program_slots for select
  using (true);

create policy "Solo lo staff scrive il programma"
  on program_slots for insert
  with check (exists (select 1 from profiles where id = auth.uid() and role in ('staff', 'admin')));

create policy "Solo lo staff modifica il programma"
  on program_slots for update
  using (exists (select 1 from profiles where id = auth.uid() and role in ('staff', 'admin')));

create policy "Solo lo staff elimina dal programma"
  on program_slots for delete
  using (exists (select 1 from profiles where id = auth.uid() and role in ('staff', 'admin')));

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'program_slots'
  ) then
    alter publication supabase_realtime add table program_slots;
  end if;
end
$$;

-- Salvataggio batch: crea, modifica ed elimina slot in un'unica
-- transazione (o va tutto a buon fine, o non cambia niente). Serve al
-- tasto "Salva" del Programma — chi edita lavora tutto in locale nel
-- browser, questa RPC applica tutto in un colpo solo invece di una
-- chiamata di rete per ogni singola modifica.
-- security invoker: gira con i permessi di chi chiama, quindi le RLS
-- policy già definite sopra (solo staff/admin) si applicano da sole,
-- riga per riga, dentro insert/update/delete — non serve duplicare
-- il controllo qui dentro.
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

-- ============================================================
-- MENU: cibo e bevande. Stesse regole del programma — pubblico in
-- lettura, scrittura solo staff.
-- ============================================================
create table if not exists menu_items (
  id uuid primary key default gen_random_uuid(),
  category text not null check (category in ('cibo', 'bevande')),
  name text not null,
  price numeric(6,2) not null default 0,
    available_portions integer check (available_portions is null or available_portions >= 0),
    created_at timestamptz not null default now()
);

alter table menu_items enable row level security;

create policy "Chiunque legge il menu"
  on menu_items for select
  using (true);

create policy "Solo lo staff scrive il menu"
  on menu_items for insert
  with check (exists (select 1 from profiles where id = auth.uid() and role in ('staff', 'admin')));

create policy "Solo lo staff modifica il menu"
  on menu_items for update
  using (exists (select 1 from profiles where id = auth.uid() and role in ('staff', 'admin')));

create policy "Solo lo staff elimina dal menu"
  on menu_items for delete
  using (exists (select 1 from profiles where id = auth.uid() and role in ('staff', 'admin')));

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'menu_items'
  ) then
    alter publication supabase_realtime add table menu_items;
  end if;
end
$$;

-- Stesso identico pattern di bulk_upsert_program_slots qui sopra: il
-- tasto "Salva" del Menu manda tutte le modifiche in sospeso in un'unica
-- chiamata, atomica, invece di una scrittura di rete per ogni carattere
-- digitato o campo modificato.
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
create policy "Cassa e cucina leggono gli ordini"
  on orders for select
  using (
    exists (select 1 from profiles where id = auth.uid() and role in ('cassa', 'cucina', 'admin'))
  );

create policy "Solo la cassa crea ordini"
  on orders for insert
  with check (
    exists (select 1 from profiles where id = auth.uid() and role in ('cassa', 'admin'))
  );

-- Update copre sia l'eventuale "pronto" sia il completed_at:
-- un solo permesso, la cucina è l'unica che tocca lo stato.
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

-- ============================================================
-- TORNEO: una riga sola (id fisso 'main'), tutto il tabellone dentro.
-- Niente tabella-per-match: a questa scala (max 64 squadre = 63
-- match) il documento intero pesa pochi KB, normalizzare non
-- aggiunge niente e complica solo il codice.
--
-- NIENTE REALTIME QUI DI PROPOSITO: Supabase Realtime ha un tetto di
-- connessioni concorrenti (200 sul piano Free, 500 su Pro) — con
-- centinaia/migliaia di persone che potrebbero avere il tabellone
-- aperto sul telefono, quel tetto si supera facile. Chi guarda fa
-- polling lato client (una select ogni 10-15s, vedi
-- TournamentBracket.tsx) invece di tenere una connessione aperta:
-- una query su una riga sola non pesa, a qualunque numero di persone.
--
-- Chi gestisce il torneo lavora tutto in locale (localStorage, sempre
-- sullo stesso browser finché non cambia device) e pubblica solo
-- quando vuole con un salvataggio esplicito — non ad ogni punteggio
-- segnato, così il DB non viene scritto ad ogni singolo click.
-- ============================================================
create table if not exists tournament_state (
  id text primary key default 'main',
  size integer not null default 8,
  teams jsonb not null default '[]'::jsonb,
  matches jsonb not null default '{}'::jsonb,
  overrides jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

insert into tournament_state (id) values ('main') on conflict (id) do nothing;

alter table tournament_state enable row level security;

create policy "Chiunque legge il torneo"
  on tournament_state for select
  using (true);

create policy "Solo tournament_manager pubblica il torneo"
  on tournament_state for all
  using (exists (select 1 from profiles where id = auth.uid() and role in ('tournament_manager', 'admin')))
  with check (exists (select 1 from profiles where id = auth.uid() and role in ('tournament_manager', 'admin')));
