-- Copie di sicurezza del tabellone create prima delle operazioni che
-- cambiano la struttura (numero squadre) o ripristinano una copia precedente.
create table if not exists public.tournament_snapshots (
  id uuid primary key default gen_random_uuid(),
  size integer not null,
  teams jsonb not null,
  matches jsonb not null,
  overrides jsonb not null,
  reason text not null,
  target_size integer,
  created_by uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint tournament_snapshots_size_allowed check (size in (8, 16, 32, 64)),
  constraint tournament_snapshots_target_size_allowed check (target_size is null or target_size in (8, 16, 32, 64)),
  constraint tournament_snapshots_reason_allowed check (reason in ('size_change', 'restore')),
  constraint tournament_snapshots_json_valid check (
    jsonb_typeof(teams) = 'array'
    and jsonb_array_length(teams) = size
    and jsonb_typeof(matches) = 'object'
    and jsonb_typeof(overrides) = 'object'
  )
);

create index if not exists tournament_snapshots_created_at_idx
  on public.tournament_snapshots (created_at desc);

alter table public.tournament_snapshots enable row level security;

drop policy if exists "Gestori leggono gli snapshot torneo" on public.tournament_snapshots;
drop policy if exists "Gestori archiviano gli snapshot torneo" on public.tournament_snapshots;

create policy "Gestori leggono gli snapshot torneo"
  on public.tournament_snapshots for select
  using (exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('tournament_manager', 'admin')
  ));

create policy "Gestori archiviano gli snapshot torneo"
  on public.tournament_snapshots for insert
  with check (
    created_by = auth.uid()
    and exists (
      select 1 from public.profiles
      where id = auth.uid() and role in ('tournament_manager', 'admin')
    )
  );

revoke all on public.tournament_snapshots from public, anon, authenticated;
grant select, insert on public.tournament_snapshots to authenticated;
