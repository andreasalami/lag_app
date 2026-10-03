# Profilo progetto — lag_app

Indice sintetico e vivo del progetto. I dettagli tecnici per chi usa e configura
l'app restano nel [README](../README.md).

## Stato dello studio

- `main`: `050240c` (merge della PR #6, 2026-10-03), che include anche la PR #4; deploy su GitHub Pages
  avviato al merge.
- Database di produzione (Supabase `lagapp`): aggiornato il 2026-10-03 con `schema.sql`; migrazioni
  registrate fino a `20261003100000`. Il piano gratuito non ha backup automatici.
- Lavoro in corso: branch `chore/tournament-only-push` (notifiche solo per il torneo, migrazione
  `20261003110000`, da applicare in produzione).
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
