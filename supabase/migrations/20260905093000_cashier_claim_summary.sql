begin;
create or replace function public.get_cashier_claims()
returns jsonb language plpgsql security definer set search_path=public as $$
declare result jsonb;
begin
 if not exists(select 1 from public.profiles where id=auth.uid() and role in ('cassa','admin')) then
  raise exception 'not_authorized' using errcode='42501';
 end if;
 select coalesce(jsonb_agg(to_jsonb(c)),'[]'::jsonb) into result from (
  select claims.order_id, min(claims.station) claimed_station, max(claims.expires_at) claim_expires_at
  from public.order_claim_devices claims join public.orders o on o.id=claims.order_id
  where claims.expires_at>now() and o.status='in_attesa_pagamento' group by claims.order_id
 ) c;
 return result;
end;
$$;
revoke execute on function public.get_cashier_claims() from public,anon;
grant execute on function public.get_cashier_claims() to authenticated;
commit;
