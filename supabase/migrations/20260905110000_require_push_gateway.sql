begin;
revoke execute on function public.upsert_push_subscription(text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.upsert_push_subscription(text,text,text,text,text) to service_role;
create or replace function public.has_push_subscription(p_endpoint text,p_auth text)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.push_subscriptions where endpoint=p_endpoint and auth=p_auth);
$$;
revoke execute on function public.has_push_subscription(text,text) from public;
grant execute on function public.has_push_subscription(text,text) to anon,authenticated;
commit;
