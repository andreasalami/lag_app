-- ============================================================
-- DA AGGIUNGERE A supabase/schema.sql (o eseguire a parte una
-- volta sola nel SQL Editor di Supabase).
-- ============================================================

-- Aggiungiamo i ruoli 'cassa' e 'cucina' a quelli già esistenti
-- (staff, tournament_manager). Stesso meccanismo, stessa tabella
-- profiles: si crea l'account in Auth, poi si cambia manualmente
-- il campo role su quella riga.
alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check
  check (role in ('staff', 'tournament_manager', 'cassa', 'cucina'));

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
    exists (select 1 from profiles where id = auth.uid() and role in ('cassa', 'cucina'))
  );

create policy "Solo la cassa crea ordini"
  on orders for insert
  with check (
    exists (select 1 from profiles where id = auth.uid() and role = 'cassa')
  );

-- Update copre sia l'eventuale "pronto" sia il completed_at:
-- un solo permesso, la cucina è l'unica che tocca lo stato.
create policy "Solo la cucina aggiorna gli ordini"
  on orders for update
  using (
    exists (select 1 from profiles where id = auth.uid() and role = 'cucina')
  );

-- Nessuna policy DELETE: non si cancella mai davvero una riga,
-- solo soft-delete via completed_at. I dati restano per le stats.

alter publication supabase_realtime add table orders;
