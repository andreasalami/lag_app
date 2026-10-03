# Profilo progetto — lag_app

Indice sintetico e vivo del progetto. I dettagli tecnici per chi usa e configura
l'app restano nel [README](../README.md).

## Stato dello studio

- Commit analizzato: `9caa4ec0f8f0e068324c3b728634a4c191be6662` (`main`, 2026-10-02), working tree pulito.
- Lavoro in corso: branch `feat/event-management-and-cleanup`, costruito sopra la PR #4
  (`chore/schema-and-dead-code-cleanup`, aperta e non ancora unita a `main`).
- Copertura della disamina: tutto `src/`, Edge Functions (escluso `send-push-broadcast`),
  funzioni SQL recenti per ordini, cassa e torneo, CI, configurazione. Non letti: i documenti
  di audit in `docs/`. Comportamento nel browser verificato solo senza backend.

## Checkpoint

- 2026-10-02 — Comprensione: analisi presentata in sessione; Andrea risponde con le richieste
  del "Capitolo Bug", conferma implicita registrata e dichiarata in chat.
- 2026-10-02 — Piano: approvato con "Sì, procedi" (PR bug + sezione Gestione evento con PDF),
  poi "Prosegue solo questa" per riprendere il lavoro della sessione fork nella stessa cartella.
- 2026-10-03 — Revisione profonda presentata in chat; approvati S1, S2, M1, M2, M3, M5, M8 e la
  verifica di M6. M4 (schema ruoli) e M7 (OrderPage) solo come spiegazione.
- Fuori dall'approvazione: migrazioni sul database di produzione, merge su `main`, deploy.

## Architettura in breve

- SPA React 18 + TypeScript + Vite + Tailwind, pubblicata su GitHub Pages (`/lag_app/`).
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
- Produzione: applicare `schema.sql` del 2026-10-03, ridistribuire `send-push-broadcast`, verificare la
  vecchia `submit_public_order` (vedi l'intervento del 2026-10-03).
- Ruoli e permessi da rivedere con Andrea (M4): `cucina` può modificare prezzi, `cassa` chiude
  l'evento, `staff` legge ancora lo storico notifiche.
- `scripts/stress/orders.mjs` usa le API di cassa eliminate: va riscritto o rimosso.
- `npm audit`: 5 high da `braces` in Tailwind 3 (solo build), risolte da Tailwind 4.
- `docs/RISCRITTURA_DA_ZERO_2026-10-03.md` non versionato, di un'altra sessione: da valutare.
- Lavoro pubblicato nella PR #6 verso `main`, che include anche la PR #4: dopo il merge la #4 si può chiudere.

## Interventi

- [2026-10-02 — Bug, pulizia e Gestione evento](changes/2026-10-02-bug-fixes-and-event-management.md)
- [2026-10-03 — Sicurezza del database e semplificazione](changes/2026-10-03-security-and-simplification.md)
