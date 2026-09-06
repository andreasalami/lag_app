begin;
-- The public Edge function validates a single-use Turnstile proof before this RPC.
revoke execute on function public.submit_public_order(text,text,jsonb,uuid,text,text,uuid,text) from public,anon,authenticated;
grant execute on function public.submit_public_order(text,text,jsonb,uuid,text,text,uuid,text) to service_role;
commit;
