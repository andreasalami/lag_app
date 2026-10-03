begin;

-- Le vecchie API di cassa (prima delle postazioni) erano già revocate a tutti, ma
-- restavano nel database: circa 250 righe di codice morto che sembravano ancora
-- concesse agli utenti autenticati. La cassa usa solo le RPC per postazione.
drop function if exists public.claim_order(uuid, text);
drop function if exists public.claim_order_by_qr(text, text);
drop function if exists public.release_order_claim(uuid, text);
drop function if exists public.update_claimed_order(uuid, text, text, text, jsonb);
drop function if exists public.cancel_claimed_order(uuid, text);
drop function if exists public.pay_claimed_order(uuid, text);
drop function if exists public.deliver_order(uuid);
drop function if exists public.deliver_order_by_qr(text);

commit;
