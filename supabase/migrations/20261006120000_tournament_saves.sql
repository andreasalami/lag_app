begin;

-- Salvataggi del torneo: chi gestisce crea, riprende, modifica e risalva più versioni
-- del tabellone. Uno solo è "in onda": salvarlo aggiorna anche il tabellone pubblico.
-- Le vecchie copie di sicurezza diventano salvataggi con la data nel nome.
alter table public.tournament_snapshots add column if not exists name text;
alter table public.tournament_snapshots add column if not exists updated_at timestamptz not null default now();
update public.tournament_snapshots
  set name = 'Copia del ' || to_char(created_at at time zone 'Europe/Rome', 'DD/MM/YYYY HH24:MI'),
    updated_at = created_at
  where name is null;
alter table public.tournament_snapshots alter column name set not null;
alter table public.tournament_snapshots drop constraint if exists tournament_snapshots_reason_allowed;
alter table public.tournament_snapshots add constraint tournament_snapshots_reason_allowed
  check (reason in ('size_change', 'restore', 'manual'));
alter table public.tournament_snapshots drop constraint if exists tournament_snapshots_name_valid;
alter table public.tournament_snapshots add constraint tournament_snapshots_name_valid
  check (length(btrim(name)) between 1 and 60);
create index if not exists tournament_snapshots_updated_at_idx
  on public.tournament_snapshots (updated_at desc);

alter table public.tournament_state add column if not exists live_save_id uuid
  references public.tournament_snapshots(id) on delete set null;

-- Il tabellone già pubblicato diventa il primo salvataggio in onda.
with seeded as (
  insert into public.tournament_snapshots (size, teams, matches, overrides, reason, name, created_by)
  select size, teams, matches, overrides, 'manual', 'Torneo pubblicato', null
  from public.tournament_state
  where id = 'main' and live_save_id is null and jsonb_array_length(teams) = size
  returning id
)
update public.tournament_state set live_save_id = seeded.id from seeded where tournament_state.id = 'main';

-- Da ora si scrive soltanto tramite save_tournament.
drop policy if exists "Gestori archiviano gli snapshot torneo" on public.tournament_snapshots;
revoke insert on public.tournament_snapshots from authenticated;
drop function if exists public.publish_tournament(bigint, integer, jsonb, jsonb, jsonb);

create or replace function public.save_tournament(
  p_id uuid, p_name text, p_expected_updated_at timestamptz,
  p_size integer, p_teams jsonb, p_matches jsonb, p_overrides jsonb, p_publish boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare saved public.tournament_snapshots%rowtype; live_id uuid;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role in ('admin', 'tournament_manager')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if jsonb_typeof(p_teams) is distinct from 'array' or jsonb_typeof(p_matches) is distinct from 'object'
    or jsonb_typeof(p_overrides) is distinct from 'object' then
    raise exception 'invalid_tournament';
  end if;
  if coalesce(p_size, 0) not in (8, 16, 32, 64) or jsonb_array_length(p_teams) <> p_size
    or length(btrim(coalesce(p_name, ''))) not between 1 and 60
    or exists (select 1 from jsonb_array_elements(p_teams) team where jsonb_typeof(team) <> 'string')
    or exists (select 1 from jsonb_each(p_overrides) entry where jsonb_typeof(entry.value) <> 'string') then
    raise exception 'invalid_tournament';
  end if;
  if exists (select 1 from jsonb_array_elements_text(p_teams) team where length(team) > 20)
    or exists (select 1 from jsonb_each_text(p_overrides) entry where length(entry.value) > 20) then
    raise exception 'team_name_too_long';
  end if;

  -- Il lock sul tabellone pubblico mette in fila i salvataggi: due "in onda" non si incrociano.
  select live_save_id into live_id from public.tournament_state where id = 'main' for update;
  if p_id is null then
    insert into public.tournament_snapshots (size, teams, matches, overrides, reason, name, created_by)
    values (p_size, p_teams, p_matches, p_overrides, 'manual', btrim(p_name), auth.uid())
    returning * into saved;
  else
    -- Se un'altra postazione ha salvato nel frattempo, nessuno sovrascrive il lavoro altrui.
    update public.tournament_snapshots set size = p_size, teams = p_teams, matches = p_matches,
      overrides = p_overrides, name = btrim(p_name), updated_at = now()
    where id = p_id and updated_at = p_expected_updated_at
    returning * into saved;
    if not found then raise exception 'save_conflict'; end if;
  end if;

  if coalesce(p_publish, false) or saved.id = live_id then
    update public.tournament_state set size = p_size, teams = p_teams, matches = p_matches,
      overrides = p_overrides, live_save_id = saved.id, revision = revision + 1, updated_at = now()
    where id = 'main';
    live_id := saved.id;
  end if;
  return to_jsonb(saved) || jsonb_build_object('live', saved.id = live_id);
end;
$$;

revoke execute on function public.save_tournament(uuid, text, timestamptz, integer, jsonb, jsonb, jsonb, boolean)
  from public, anon;
grant execute on function public.save_tournament(uuid, text, timestamptz, integer, jsonb, jsonb, jsonb, boolean)
  to authenticated;

commit;
