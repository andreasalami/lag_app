begin;

-- Nomi squadra e ripescaggi: massimo 20 caratteri, lo stesso limite dell'editor
-- del torneo. Le card del tabellone sono strette e un nome molto lungo rendeva
-- illeggibile il tabellone pubblico.
create or replace function public.publish_tournament(p_expected_revision bigint,p_size integer,p_teams jsonb,p_matches jsonb,p_overrides jsonb)
returns bigint language plpgsql security definer set search_path=public as $$
declare next_revision bigint;
begin
 if not exists(select 1 from public.profiles where id=auth.uid() and role in ('admin','tournament_manager')) then
  raise exception 'not_authorized' using errcode='42501';
 end if;
 if p_expected_revision is null then raise exception 'revision_required'; end if;
 if jsonb_typeof(p_teams)<>'array' or jsonb_typeof(p_overrides)<>'object'
  or exists(select 1 from jsonb_array_elements(p_teams) team where jsonb_typeof(team)<>'string')
  or exists(select 1 from jsonb_each(p_overrides) entry where jsonb_typeof(entry.value)<>'string') then
  raise exception 'invalid_tournament';
 end if;
 if exists(select 1 from jsonb_array_elements_text(p_teams) team where length(team)>20)
  or exists(select 1 from jsonb_each_text(p_overrides) entry where length(entry.value)>20) then
  raise exception 'team_name_too_long';
 end if;
 update public.tournament_state set size=p_size,teams=p_teams,matches=p_matches,overrides=p_overrides,
  revision=revision+1,updated_at=now() where id='main' and revision=p_expected_revision returning revision into next_revision;
 if not found then raise exception 'tournament_conflict'; end if;
 return next_revision;
end;
$$;

commit;
