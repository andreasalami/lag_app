-- Migrazione: tabella tournament_state per pubblicare il torneo su
-- Supabase (finora viveva solo in useState nel browser).
-- Esegui in Supabase: Database > SQL Editor > New query > Run.

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
