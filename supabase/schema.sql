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
