-- Rimuove la sezione Annunci, non più presente nell'app.
--
-- Il componente React è stato eliminato tempo fa, ma la tabella era rimasta:
-- con RLS, quattro policy, un indice e — soprattutto — il fanout realtime
-- attivo, che continuava a spedire eventi per una tabella che nessun client
-- ascolta più.
--
-- ATTENZIONE: questa migration ELIMINA definitivamente gli annunci pubblicati.
-- Se il testo serve, esportarlo PRIMA di applicarla (istruzioni nel README).
--
-- Il valore 'announcements' resta ammesso in push_subscriptions.source e in
-- push_broadcasts.kind: è una costante di quelle tabelle, non un riferimento a
-- questa, e toglierla richiederebbe di validare le righe già esistenti.

begin;

do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'announcements'
  ) then
    alter publication supabase_realtime drop table public.announcements;
  end if;
end
$$;

-- Policy, indice, constraint e grant se ne vanno insieme alla tabella.
drop table if exists public.announcements;

commit;
