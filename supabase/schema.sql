-- LAG — schema Supabase
-- Esegui questo script in Supabase: Database > SQL Editor > New query > Run
-- Va eseguito UNA volta sola (o quando aggiungiamo nuove tabelle).

-- ============================================================
-- PROFILI: ruolo di ogni utente autenticato.
--   staff              -> può pubblicare annunci
--   tournament_manager -> potrà gestire il torneo (NON gli annunci)
-- ============================================================
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'staff' check (role in ('staff', 'tournament_manager')),
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;

create policy "Un utente legge solo il proprio profilo"
  on profiles for select
  using (auth.uid() = id);

-- Quando crei un utente in Auth (dashboard > Authentication > Add user),
-- questo trigger gli crea automaticamente una riga in profiles col ruolo
-- di default 'staff'. Per renderlo tournament_manager, dopo la creazione
-- vai in Table Editor > profiles e cambia manualmente il valore di role
-- per quella riga.
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, role)
  values (new.id, 'staff');
  return new;
end;
$$ language plpgsql security definer;

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
    exists (select 1 from profiles where id = auth.uid() and role = 'staff')
  );

create policy "Solo lo staff modifica annunci"
  on announcements for update
  using (
    exists (select 1 from profiles where id = auth.uid() and role = 'staff')
  );

create policy "Solo lo staff elimina annunci"
  on announcements for delete
  using (
    exists (select 1 from profiles where id = auth.uid() and role = 'staff')
  );

-- Realtime: serve per far comparire i nuovi annunci a chi ha la pagina
-- aperta, senza refresh. Va abilitato anche dalla dashboard:
-- Database > Replication > tabella "announcements" > Enable.
alter publication supabase_realtime add table announcements;

-- ============================================================
-- PROGRAMMA: scaletta con 2 palchi in contemporanea. Pubblico in
-- lettura, modificabile solo dallo staff (stessa autenticazione
-- degli annunci — stesso ruolo 'staff', nessun ruolo a parte).
-- ============================================================
create table if not exists program_slots (
  id uuid primary key default gen_random_uuid(),
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
  with check (exists (select 1 from profiles where id = auth.uid() and role = 'staff'));

create policy "Solo lo staff modifica il programma"
  on program_slots for update
  using (exists (select 1 from profiles where id = auth.uid() and role = 'staff'));

create policy "Solo lo staff elimina dal programma"
  on program_slots for delete
  using (exists (select 1 from profiles where id = auth.uid() and role = 'staff'));

alter publication supabase_realtime add table program_slots;

-- ============================================================
-- MENU: cibo e bevande. Stesse regole del programma — pubblico in
-- lettura, scrittura solo staff.
-- ============================================================
create table if not exists menu_items (
  id uuid primary key default gen_random_uuid(),
  category text not null check (category in ('cibo', 'bevande')),
  name text not null,
  price numeric(6,2) not null default 0,
  created_at timestamptz not null default now()
);

alter table menu_items enable row level security;

create policy "Chiunque legge il menu"
  on menu_items for select
  using (true);

create policy "Solo lo staff scrive il menu"
  on menu_items for insert
  with check (exists (select 1 from profiles where id = auth.uid() and role = 'staff'));

create policy "Solo lo staff modifica il menu"
  on menu_items for update
  using (exists (select 1 from profiles where id = auth.uid() and role = 'staff'));

create policy "Solo lo staff elimina dal menu"
  on menu_items for delete
  using (exists (select 1 from profiles where id = auth.uid() and role = 'staff'));

alter publication supabase_realtime add table menu_items;
