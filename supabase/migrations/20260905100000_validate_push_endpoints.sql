begin;
create or replace function public.valid_push_endpoint(p_endpoint text)
returns boolean language sql immutable set search_path=public as $$
 select coalesce(length(p_endpoint) between 28 and 2048
  and p_endpoint ~* '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)/[^[:space:]#]+$'
  and position(chr(92) in p_endpoint)=0,false);
$$;
revoke execute on function public.valid_push_endpoint(text) from public,anon,authenticated;

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
    or p_source is null or p_source not in ('announcements', 'tournament')
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
commit;
