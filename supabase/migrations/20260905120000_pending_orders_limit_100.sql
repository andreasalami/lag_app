begin;

alter table public.order_events alter column max_pending_orders set default 100;
-- Preserve every existing order: above the new limit, only new submissions wait.
update public.order_events set max_pending_orders = 100
where is_current and permanently_closed_at is null;

create or replace function public.create_next_order_event(
  p_name text, p_opens_at timestamptz, p_closes_at timestamptz, p_max_pending_orders integer default 100
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare event_row public.order_events%rowtype;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role in ('cassa', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if exists (select 1 from public.order_events where is_current and permanently_closed_at is null) then
    raise exception 'current_event_not_closed';
  end if;
  if btrim(coalesce(p_name, '')) = '' or p_closes_at <= p_opens_at
    or p_max_pending_orders not between 10 and 1000 then raise exception 'invalid_event_settings'; end if;
  update public.order_events set is_current = false where is_current;
  insert into public.order_events (name, opens_at, closes_at, max_pending_orders, is_current)
  values (btrim(p_name), p_opens_at, p_closes_at, p_max_pending_orders, true)
  returning * into event_row;
  return to_jsonb(event_row);
end;
$$;
revoke execute on function public.create_next_order_event(text,timestamptz,timestamptz,integer) from public;
grant execute on function public.create_next_order_event(text,timestamptz,timestamptz,integer) to authenticated;

commit;
