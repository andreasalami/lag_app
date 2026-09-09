# Rilascio e migrazioni del database

`supabase/migrations` è la fonte ufficiale dello schema. La baseline
`20260901000000` permette a un database vuoto di essere ricostruito, mentre
`supabase/schema.sql` è soltanto uno snapshot leggibile e utilizzabile per un
recupero manuale.

## Verifica locale obbligatoria

```bash
npx supabase start
npx supabase db reset
npx supabase test db
npm run stress:orders
```

Lo stress test accetta soltanto un endpoint HTTP locale e richiede le variabili
descritte in `.env.stress.example`.

## Preflight del progetto remoto esistente

Prima del primo `db push`, collegare la CLI e confrontare la storia senza
modificare il database:

```bash
npx supabase link --project-ref <project-ref>
npx supabase migration list
npx supabase db push --dry-run
```

Se il database esisteva già prima dell'introduzione delle migrazioni, non
eseguire la baseline sopra alle tabelle esistenti. Verificare nello SQL Editor:

```sql
select * from supabase_migrations.schema_migrations order by version;

select
  to_regclass('public.order_fulfillment_items') is not null as fulfillment,
  to_regclass('public.tournament_snapshots') is not null as tournament_snapshots,
  to_regprocedure('public.claim_order_for_station(uuid,text,text)') is not null as station_claim;
```

Quando lo schema storico è già presente ma la baseline manca soltanto dalla
tabella di tracciamento, registrarla senza rieseguirla:

```bash
npx supabase migration repair 20260901000000 --status applied
```

Le versioni `20260901103000`, `20260901113000`, `20260901120000` e
`20260901170000` vanno marcate come applicate soltanto se i relativi oggetti
sono realmente presenti. `migration repair` cambia la cronologia, non lo
schema: prima di usarlo salvare l'output delle query e un backup del database.

Dopo il riallineamento, ripetere `migration list` e `db push --dry-run`. Il dry
run deve proporre esclusivamente `20260902090000_reliability_hardening.sql`.
Solo allora eseguire:

```bash
npx supabase db push
```

Infine verificare login e flussi cassa/cucina/bar su un evento di prova. Il
frontend aggiornato può essere pubblicato dopo la migrazione: le nuove RPC
mantengono parametri di default compatibili durante questa breve finestra, ma
le RPC staff precedenti al flusso a postazioni vengono eliminate.
