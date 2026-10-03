begin;

-- Le notifiche push servono solo per gli avvisi del torneo: via gli ultimi valori
-- degli annunci rimossi. In produzione non ci sono righe con quei valori (verificato
-- il 2026-10-03: 2 iscrizioni e 1 invio, tutti "tournament").
alter table public.push_subscriptions drop constraint if exists push_subscriptions_values_valid;
alter table public.push_subscriptions add constraint push_subscriptions_values_valid check (
  endpoint ~ '^https://[^[:space:]]+$'
  and length(endpoint) between 28 and 2048
  and p256dh ~ '^[A-Za-z0-9_-]{80,120}$'
  and auth ~ '^[A-Za-z0-9_-]{16,64}$'
  and source = 'tournament'
  and (user_agent is null or length(user_agent) <= 500)
) not valid;
alter table public.push_broadcasts drop constraint if exists push_broadcasts_kind_check;
alter table public.push_broadcasts add constraint push_broadcasts_kind_check check (kind = 'tournament');

create or replace function public.upsert_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_source text,
  p_user_agent text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare subscription_id uuid; subscription_count integer;
begin
  if not public.valid_push_endpoint(p_endpoint)
    or length(p_endpoint) not between 28 and 2048
    or p_p256dh is null or p_p256dh !~ '^[A-Za-z0-9_-]{87}$'
    or p_auth is null or p_auth !~ '^[A-Za-z0-9_-]{22}$'
    or p_source is distinct from 'tournament'
    or length(coalesce(p_user_agent, '')) > 500 then
    raise exception 'invalid_push_subscription';
  end if;

  if octet_length(decode(translate(p_p256dh,'-_','+/') || '=', 'base64')) <> 65
    or get_byte(decode(translate(p_p256dh,'-_','+/') || '=', 'base64'),0) <> 4
    or octet_length(decode(translate(p_auth,'-_','+/') || '==','base64')) <> 16 then
    raise exception 'invalid_push_subscription';
  end if;
  -- Mantiene atomico il limite anche se molti telefoni si registrano nello
  -- stesso istante; non interferisce con gli altri lock applicativi.
  perform pg_advisory_xact_lock(hashtext('lag_push_subscriptions_capacity'));
  if not exists (select 1 from public.push_subscriptions where endpoint = p_endpoint) then
    select count(*) into subscription_count from public.push_subscriptions;
    if subscription_count >= 5000 then raise exception 'push_capacity_reached'; end if;
  end if;

  insert into public.push_subscriptions (endpoint, p256dh, auth, source, user_agent)
  values (p_endpoint, p_p256dh, p_auth, p_source, nullif(p_user_agent, ''))
  on conflict (endpoint) do update set
    p256dh = excluded.p256dh,
    auth = excluded.auth,
    source = excluded.source,
    user_agent = excluded.user_agent,
    updated_at = now()
  returning id into subscription_id;
  return subscription_id;
end;
$$;
revoke execute on function public.upsert_push_subscription(text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.upsert_push_subscription(text,text,text,text,text) to service_role;

commit;
