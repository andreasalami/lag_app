# Stress test degli ordini

Il runner `scripts/stress/orders.mjs` verifica automaticamente concorrenza,
capienza, scorte, idempotenza, claim della cassa e chiusura evento.

Per sicurezza accetta esclusivamente un Supabase raggiungibile via HTTP su
`localhost`, `127.0.0.1` o `::1`. Non può essere puntato alla produzione.

1. Avvia Supabase locale e applica `supabase/schema.sql`.
2. Nel solo database locale, abilita il setup e la pulizia del runner:

   ```sql
   grant all privileges on all tables in schema public to service_role;
   grant all privileges on all sequences in schema public to service_role;
   ```

3. Copia `.env.stress.example` in `.env.stress.local` e inserisci le chiavi
   locali stampate da `supabase status`.
4. Esegui `npm run stress:orders`.

Per isolare un caso, imposta ad esempio
`LOADTEST_SCENARIOS=capacity` oppure `LOADTEST_SCENARIOS=read`.

I valori predefiniti costituiscono la regressione ripetibile: 200 letture,
200 invii contro una capienza di 150, 50 concorrenti sull'ultima porzione e
10 round da 30 ordini per la gara chiusura/pagamento. Per cercare il punto di
saturazione del gateway si possono aumentare separatamente i tentativi; oltre
quel punto gli errori di trasporto descrivono anche i limiti dello stack locale,
non soltanto quelli delle funzioni SQL.

Il database locale deve avere un solo evento corrente e nessun ordine. Il
runner crea fixture contrassegnate `[LOADTEST]` e un account admin temporaneo;
il blocco `finally` elimina ordini, fixture e account e ripristina l'evento.
Un finding produce exit code `2`, così può essere rilevato da uno script senza
confonderlo con un crash del runner.
