-- Corregge riferimenti ambigui rilevati dal lint PostgreSQL.
create or replace function public.claim_order_for_station(
  p_order_id uuid, p_station text, p_device_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare order_row public.orders%rowtype; device_hash_value text; active_station text;
begin
  if not exists (select 1 from public.profiles profile where profile.id = auth.uid() and profile.role in ('cassa', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_station !~ '^cassa_[1-5]$' then raise exception 'invalid_station'; end if;
  if p_device_id is null or length(p_device_id) not between 32 and 80 then raise exception 'invalid_device'; end if;
  device_hash_value := encode(extensions.digest(p_device_id, 'sha256'), 'hex');
  delete from public.order_claim_devices where expires_at <= now();
  select * into order_row from public.orders where id = p_order_id for update;
  if not found or order_row.status <> 'in_attesa_pagamento' then raise exception 'order_not_available'; end if;
  select claims.station into active_station from public.order_claim_devices claims
    where claims.order_id = p_order_id and claims.expires_at > now() limit 1;
  if active_station is not null and active_station <> p_station then raise exception 'order_already_claimed'; end if;
  insert into public.order_claim_devices (order_id, station, device_hash, expires_at)
    values (p_order_id, p_station, device_hash_value, now() + interval '30 seconds')
    on conflict (order_id, device_hash) do update
      set station = excluded.station, expires_at = excluded.expires_at;
  return (to_jsonb(order_row) - 'qr_token_hash' - 'claimed_token_hash' - 'client_request_id')
    || jsonb_build_object('claimed_station', p_station, 'claim_expires_at', now() + interval '30 seconds');
end;
$$;
revoke execute on function public.claim_order_for_station(uuid, text, text) from public;
grant execute on function public.claim_order_for_station(uuid, text, text) to authenticated;

create or replace function public.get_low_stock_items()
returns table (id uuid, name text, remaining integer, available integer)
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.profiles profile
    where profile.id = auth.uid() and profile.role in ('cucina', 'admin')
  ) then
    raise exception 'not authorized to read stock warnings' using errcode = '42501';
  end if;
  return query
    select menu.id, menu.name, menu.available_portions, menu.stock_capacity
    from public.menu_items menu
    where menu.available_portions is not null and menu.stock_capacity is not null
      and menu.available_portions <= ceil(menu.stock_capacity * 0.2)
    order by menu.available_portions, menu.name;
end;
$$;
revoke execute on function public.get_low_stock_items() from public;
grant execute on function public.get_low_stock_items() to authenticated;
