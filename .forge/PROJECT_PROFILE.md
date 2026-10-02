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
- Fuori dall'approvazione: migrazioni sul database di produzione, merge su `main`, deploy.

## Architettura in breve

- SPA React 18 + TypeScript + Vite + Tailwind, pubblicata su GitHub Pages (`/lag_app/`).
- Backend Supabase: logica di business in RPC Postgres `security definer` con RLS; gli ordini
  pubblici passano dalla Edge Function `submit-order` dopo la verifica Turnstile.
- Routing a hash in `src/App.tsx`; le pagine riservate passano da `ProtectedOperationalPage`.
- Feature in `src/features/<dominio>/` (auth, program, menu, orders, event, tournament,
  notifications, social, tickets); helper condivisi in `src/lib/`, UI condivisa in `src/components/`.
- Database: `supabase/migrations/` è la storia, `supabase/schema.sql` lo stato finale; la CI
  installa entrambi su PGlite e ne confronta il catalogo.

## Convenzioni osservate

- Testi interfaccia e commenti in italiano; identificatori e commit in inglese (Conventional Commits).
- Logica pura separata e testata con Vitest; verifiche SQL isolate in `scripts/security/` su PGlite.
- Nessun ESLint/Prettier configurato: alcuni file storici sono compressi su poche righe.

## Decisioni aperte

- Bordi semitrasparenti `border-[var(--…)]/NN` mai generati da Tailwind 3 (8 punti in 7 file).
- D16 (preparazione PGlite duplicata negli script più vecchi) e D17 (formatter/ESLint).
- Ambiente per i test di usabilità (progetto Supabase di prova separato oppure solo locale).
- Base della pull request rispetto alla PR #4 ancora aperta.

## Interventi

- [2026-10-02 — Bug, pulizia e Gestione evento](changes/2026-10-02-bug-fixes-and-event-management.md)
