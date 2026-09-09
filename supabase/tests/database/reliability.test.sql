begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(19);

select has_table('public', 'order_operations', 'Esiste il registro delle operazioni idempotenti');
select has_column('public', 'orders', 'pending_expires_at', 'Gli ordini hanno una scadenza di pagamento');
select has_column('public', 'orders', 'expired_at', 'La scadenza viene distinta dall’annullamento manuale');
select has_column('public', 'orders', 'submission_client_hash', 'Il rate limit non conserva l’identificativo client in chiaro');

select is(
  (select string_agg(attribute.attname, ',' order by key_position.ordinality)
   from pg_constraint constraint_row
   cross join lateral unnest(constraint_row.conkey) with ordinality key_position(attnum, ordinality)
   join pg_attribute attribute on attribute.attrelid = constraint_row.conrelid and attribute.attnum = key_position.attnum
   where constraint_row.conrelid = 'public.order_claim_devices'::regclass and constraint_row.contype = 'p'),
  'order_id',
  'La chiave primaria consente un solo claim per ordine'
);

select has_function('public', 'pay_order_for_station', array['uuid', 'text', 'text', 'uuid'], 'Pagamento con operation ID');
select has_function('public', 'cancel_order_for_station', array['uuid', 'text', 'text', 'uuid'], 'Annullamento con operation ID');
select has_function('public', 'deliver_fulfillment_items', array['uuid', 'text', 'jsonb', 'uuid'], 'Consegna con operation ID');
select has_function('public', 'undo_fulfillment_delivery', array['uuid', 'text', 'uuid'], 'Undo con operation ID');
select has_function('public', 'create_counter_order', array['text', 'text', 'jsonb', 'uuid'], 'Ordine cassa con operation ID');
select has_function('public', 'submit_public_order', array['text', 'text', 'jsonb', 'uuid', 'text', 'text', 'text'], 'Invio pubblico con client ID');

select ok(to_regprocedure('public.claim_order(uuid,text)') is null, 'RPC claim legacy eliminata');
select ok(to_regprocedure('public.pay_claimed_order(uuid,text)') is null, 'RPC pagamento legacy eliminata');
select ok(to_regprocedure('public.deliver_order(uuid)') is null, 'RPC consegna legacy eliminata');

select like(
  pg_get_functiondef('public.undo_fulfillment_delivery(uuid,text,uuid)'::regprocedure),
  '%event.permanently_closed_at is not null%',
  'Undo controlla sempre la chiusura definitiva dell’evento'
);
select like(
  pg_get_functiondef('public.claim_order_for_station(uuid,text,text)'::regprocedure),
  '%active_device_hash <> device_hash_value%',
  'Il claim confronta il dispositivo, non soltanto la postazione'
);
select ok(
  exists (select 1 from pg_trigger where tgrelid = 'public.orders'::regclass and tgname = 'set_order_pending_expiry' and not tgisinternal),
  'Il trigger di scadenza è installato'
);
select ok(
  exists (select 1 from pg_trigger where tgrelid = 'public.order_events'::regclass and tgname = 'anonymize_closed_order_event' and not tgisinternal),
  'La chiusura elimina anche l’impronta del dispositivo pubblico'
);
select ok(
  has_function_privilege('anon', 'public.submit_public_order(text,text,jsonb,uuid,text,text,text)', 'EXECUTE')
    and not has_table_privilege('anon', 'public.order_operations', 'SELECT'),
  'Anon può inviare un ordine ma non leggere l’audit'
);

select * from finish();
rollback;
