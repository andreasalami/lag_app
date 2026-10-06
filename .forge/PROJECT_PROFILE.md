# Profilo progetto — lag_app

Indice sintetico e vivo del progetto. I dettagli tecnici per chi usa e configura
l'app restano nel [README](../README.md).

## Stato dello studio

- `main`: `e37e14d` (merge della PR #8, 2026-10-04); deploy su GitHub Pages avviato al merge.
- Branch aperto: `feat/october-update` (2026-10-06), richiede la migrazione `20261006120000` in produzione.
- Database di produzione (Supabase `lagapp`): ripristinato e aggiornato il 2026-10-04 con `schema.sql`
  (commit `b159cbd`); migrazioni registrate fino a `20261003120000`. Il piano gratuito non ha backup
  automatici.
- Copertura della disamina: tutto `src/`, tutte le Edge Functions, `schema.sql` e migrazioni, CI,
  configurazione. Non letti: i documenti di audit in `docs/`. Comportamento nel browser verificato
  con un finto backend locale (ordini) e confronto degli stili calcolati (Tailwind 4).

## Checkpoint

- 2026-10-02 — Comprensione: analisi presentata in sessione; Andrea risponde con le richieste
  del "Capitolo Bug", conferma implicita registrata e dichiarata in chat.
- 2026-10-02 — Piano: approvato con "Sì, procedi" (PR bug + sezione Gestione evento con PDF),
  poi "Prosegue solo questa" per riprendere il lavoro della sessione fork nella stessa cartella.
- 2026-10-03 — Produzione: Andrea conferma l'esecuzione di `schema.sql` su `lagapp` (controllo in sola
  lettura prima, verifica dopo) e il merge della PR #6 su `main`. Notifiche push: "serve solo
  l'avviso nella sezione torneo, il resto si può rimuovere".
- 2026-10-03 — Decisioni ruoli: cucina gestisce tutto il menu, bar le bevande, chiusura evento a
  cassa e admin, staff senza storico notifiche. Approvati anche M7, script di stress e Tailwind 4.
- 2026-10-03 — Revisione profonda presentata in chat; approvati S1, S2, M1, M2, M3, M5, M8 e la
  verifica di M6. M4 (schema ruoli) e M7 (OrderPage) solo come spiegazione.
- 2026-10-03 — PDF per serata (durata 1–3 serate), Biglietti solo con Eventbrite, "Ordina qui" con
  animazione "Riempimento": approvato con "Sì, procedi", produzione esclusa.
- 2026-10-04 — Produzione: Andrea chiede di aggiornare lo schema e unire la PR #8 su `main`; SQL eseguito
  da Andrea (incidente schema di agosto e ripristino nel registro dell'intervento).
- 2026-10-06 — Aggiornamento di ottobre: piano in 6 punti approvato con "sì, procedi e ok download";
  scelte "un salvataggio in onda" e "immagini statiche"; filtro DB sulla coda cassa escluso.
- Fuori dall'approvazione: migrazioni sul database di produzione, merge su `main`, deploy.

## Architettura in breve

- SPA React 18 + TypeScript + Vite + Tailwind CSS 4 (plugin Vite), pubblicata su GitHub Pages (`/lag_app/`).
- Backend Supabase: logica di business in RPC Postgres `security definer` con RLS; gli ordini
  pubblici passano dalla Edge Function `submit-order` dopo la verifica Turnstile.
- Routing a hash in `src/App.tsx`; le pagine riservate passano da `ProtectedOperationalPage`.
- Feature in `src/features/<dominio>/` (auth, program, menu, orders, event, tournament,
  notifications, social, tickets); helper condivisi in `src/lib/`, UI condivisa in `src/components/`.
- Database: `supabase/migrations/` è la storia, `supabase/schema.sql` lo stato finale e anche lo
  script di aggiornamento manuale; la CI (`.github/workflows/verify.yml`, usato da CI e deploy)
  confronta su PGlite il catalogo delle migrazioni con `schema.sql` installato da zero e sopra
  ogni versione storica.

## Convenzioni osservate

- Testi interfaccia e commenti in italiano; identificatori e commit in inglese (Conventional Commits).
- Logica pura separata e testata con Vitest; verifiche SQL isolate in `scripts/security/` su PGlite.
- Formattazione con Prettier (`npm run format`), controllata in CI; ESLint non configurato.

## Decisioni aperte

- Comportamenti inattesi dei test di usabilità (docs/USABILITY_TEST_RESULTS_2026-10-02.md).
- D17: ESLint (Prettier aggiunto il 2026-10-03).
- Produzione: ridistribuire la Edge Function `send-push-broadcast` (il database rifiuta già gli annunci).
- `npm audit`: restano 2 moderate (vitest) e 1 bassa (dompurify, via jsPDF).
- `docs/RISCRITTURA_DA_ZERO_2026-10-03.md` non versionato, di un'altra sessione: da valutare.

## Interventi

- [2026-10-02 — Bug, pulizia e Gestione evento](changes/2026-10-02-bug-fixes-and-event-management.md)
- [2026-10-03 — Sicurezza del database e semplificazione](changes/2026-10-03-security-and-simplification.md)
- [2026-10-03 — PDF per serata, Biglietti, Ordina qui](changes/2026-10-03-event-evenings-pdf-tickets-order-button.md)
- [2026-10-06 — Ordini, postazioni, salvataggi torneo, Instagram](changes/2026-10-06-october-update.md)
