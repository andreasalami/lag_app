\set ON_ERROR_STOP on

begin;

do $$
begin
  begin
    perform public.upsert_push_subscription(null, null, null, null, null);
    raise exception 'invalid subscription unexpectedly accepted';
  exception
    when others then
      if sqlerrm <> 'invalid_push_subscription' then raise; end if;
  end;
end;
$$;

set local role anon;
select public.upsert_push_subscription(
  'https://push.example.test/device/one',
  repeat('A', 87),
  repeat('B', 22),
  'tournament',
  'Supabase local smoke test'
);
reset role;

do $$
begin
  if (select count(*) from public.push_subscriptions) <> 1 then
    raise exception 'anonymous RPC did not persist exactly one subscription';
  end if;
end;
$$;

set local role anon;
do $$
begin
  begin
    perform 1 from public.push_subscriptions;
    raise exception 'anonymous role can read protected push subscriptions';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform public.get_push_subscription_count();
    raise exception 'anonymous role can read the subscription count';
  exception
    when insufficient_privilege then null;
  end;
end;
$$;
reset role;

rollback;
