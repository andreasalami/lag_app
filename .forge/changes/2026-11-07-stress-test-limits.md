# Intervento: stress test di novembre 2026 (casi limite e traffico reale)

- **Stato:** branch `test/stress-limits-2026-11`, modifiche non committate. Nessuna
  correzione all'app, come deciso.
- **Data e perimetro:** dal 2026-11-03 al 2026-11-07. Casi limite su ordini e modifiche
  dello staff in locale, traffico realistico su un progetto Supabase di test, report
  visivo.
- **Profilo:** [PROJECT_PROFILE.md](../PROJECT_PROFILE.md)
- **Risultati:** [STRESS_TEST_RESULTS_2026-11-07.md](../../docs/STRESS_TEST_RESULTS_2026-11-07.md)
  e [report visivo](../../docs/STRESS_TEST_REPORT_2026-11.html).

## Decisioni di Andrea

- **2026-11-03:** obiettivo, cioè capire i limiti del Free e decidere sul Pro.
  "Modifiche" significa menu, scaletta, torneo e sospensione di un prodotto, senza la
  modifica degli ordini in cassa. Il risultato è un report visivo, senza correzioni.
- **2026-11-04:** non superare i limiti di richiesta di Supabase. Traffico cloud solo
  fino al carico dell'evento, con stop al primo degrado. Progetto di test separato,
  senza comunicazioni a Supabase. Produzione mai in scrittura.
- **2026-11-06:** "Sì, parti" per il traffico cloud. Dopo i due blocchi della serata,
  "Prova le prove brevi".
- **2026-11-07:** accesso alla dashboard per leggere i grafici del progetto di test.
  Poi "Sì, prepara il report".

## Cosa è stato aggiunto

- `scripts/stress/lib.mjs`: Postgres locale usa e getta e controlli di coerenza
  (`invariantSql`), estratti da `orders.mjs`, che ora li importa.
- `scripts/stress/edge-orders.mjs` ed `edge-staff.mjs`: casi limite ripetuti con tempi
  casuali. Riportano i difetti senza correggerli.
- `scripts/stress/traffic.mjs`: traffico verso un progetto di test.
  - Rifiuta il ref di produzione, anche nell'URL del pooler.
  - Tetto di 190 richieste al secondo e 1.500 richieste in corso.
  - Stop per errori oltre l'1%, 95° percentile oltre 10 s, 429 o 503, budget di
    traffico o generatore lento.
  - Le credenziali del database passano solo nelle variabili `PG*` del processo `psql`.
- `scripts/stress/traffic.selftest.mjs`: server finto locale. Verifica il rifiuto della
  produzione, la rampa, lo stop su 429, lo stop su errori e il budget.
- `scripts/stress/gateway/index.ts`: `submit-order` solo per test. Turnstile è simulato
  e la funzione si rifiuta di girare sul progetto di produzione.
- Configurazione:
  - `package.json`: `stress:edge-orders`, `stress:edge-staff`, `stress:traffic`;
  - `.env.stress.example`: nomi delle variabili `STRESS_*`, senza valori.

## Scelte e alternative

- **Progetto di test separato** invece della produzione, come deciso da Andrea il
  2026-11-04.
- **Turnstile simulato con 150 ms di attesa**, perché il token reale richiede un
  browser. Il resto del gateway è il codice vero (`handlePublicRequest`).
- **Stop al primo degrado**, invece di cercare il punto di rottura, per la decisione del
  2026-11-04.
- **Diagnosi dalla dashboard in sola lettura:** grafici della macchina e log del
  gateway, con query `toStartOfInterval` sugli `edge_logs`. È stata scelta invece di
  ripetere prove che avrebbero di nuovo bloccato il progetto.

## Verifica

- `orders.mjs`: 10 controlli su 10 dopo l'estrazione di `lib.mjs`.
- Selftest di `traffic.mjs`: tutti superati.
- Risultati degli agenti sui casi limite: ripetuti con seed indipendenti, 777 per gli
  ordini e 7 per lo staff, e confrontati con le righe di `schema.sql` citate.
- Report HTML aperto nel browser dell'app, a 1.100 px e a 375 px. Nessuno scorrimento
  orizzontale e nessun errore in console.
- **Non verificato:**
  - il tema scuro del report, perché l'anteprima locale resta chiara;
  - la tenuta su macchine Micro e Small;
  - i tempi reali di cassa.

## Aperto

- **Decisione di Andrea:** Pro per un mese sul progetto di test, per ripetere
  `evening` e `tournament-publish` su Micro o Small.
- **Correzioni da pianificare:**
  - eliminazione di prodotti in ordini aperti;
  - sblocco dopo la scadenza;
  - sospensione che si annulla;
  - modifiche perse su menu, scaletta e torneo.
- **Pulizia a carico di Andrea:**
  - `npx supabase logout`;
  - eliminare progetto e organizzazione `lag-stress`;
  - eventuale uscita dalla dashboard nel browser dell'app.
- **Chiave legacy:** il gateway usa `SUPABASE_SERVICE_ROLE_KEY`, che Supabase prevede di
  dismettere entro la fine del 2026. Il gateway di test ricade già su
  `SUPABASE_SECRET_KEYS`.
