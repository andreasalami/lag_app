begin;
alter table public.tournament_state add column if not exists revision bigint not null default 0;
create or replace function public.publish_tournament(p_expected_revision bigint,p_size integer,p_teams jsonb,p_matches jsonb,p_overrides jsonb)
returns bigint language plpgsql security definer set search_path=public as $$
declare next_revision bigint;
begin
 if not exists(select 1 from public.profiles where id=auth.uid() and role in ('admin','tournament_manager')) then
  raise exception 'not_authorized' using errcode='42501';
 end if;
 if p_expected_revision is null then raise exception 'revision_required'; end if;
 update public.tournament_state set size=p_size,teams=p_teams,matches=p_matches,overrides=p_overrides,
  revision=revision+1,updated_at=now() where id='main' and revision=p_expected_revision returning revision into next_revision;
 if not found then raise exception 'tournament_conflict'; end if;
 return next_revision;
end;
$$;
revoke execute on function public.publish_tournament(bigint,integer,jsonb,jsonb,jsonb) from public,anon;
grant execute on function public.publish_tournament(bigint,integer,jsonb,jsonb,jsonb) to authenticated;
revoke insert,update,delete on public.tournament_state from anon,authenticated;
commit;
