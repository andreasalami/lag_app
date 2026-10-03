# Intervento: sicurezza del database e semplificazione

- Stato: commit sul branch `feat/event-management-and-cleanup` (PR #6), non ancora applicato in produzione.
- Data e perimetro: 2026-10-03 — punti S1, S2, M1, M2, M3, M5, M8 della revisione; M6 verificato e non eseguito.
- Profilo: [PROJECT_PROFILE.md](../PROJECT_PROFILE.md)
- Piano e approvazione: revisione presentata in chat, Andrea approva "correggi s1 e s2, poi m1, m2, m3; m5 aggiungi Prettier; m6 elimina solo se inutili al 100%; m8 risolvi".

## Problema e risultato

- **S1** (`8d3f793`): le notifiche "annuncio" erano ancora accettate da un account `staff`, che poteva inviare un testo qualsiasi a tutti gli iscritti chiamando l'API. Ora solo notifiche del torneo, da admin o tournament_manager.
- **S2** (`94f8a45`): `schema.sql`, usato anche per aggiornare il database esistente, su un database creato prima del 2026-09-05 lasciava attiva la vecchia `submit_public_order` a 6 parametri, eseguibile da anon senza Turnstile. Ora elimina ogni versione superata e la CI lo applica sopra **ogni** versione storica (24) richiedendo lo stesso catalogo finale. Eliminate anche le 8 funzioni di cassa ritirate e le concessioni poi revocate; i vincoli sono definiti accanto alle tabelle.
- **M1** (`4edf4e4`): un solo harness PGlite per tutti gli script di verifica del database.
- **M2** (`3fc9f30`): gli errori di `submit-order` stanno in una tabella testata (`submitFailure`). Corregge tre codici che scartavano la richiesta ma invitavano a recuperarla.
- **Regressione corretta** (`dad1192`): una richiesta in sospeso rifiutata in modo definitivo restituisce i suoi prodotti al carrello.
- **M3** (`4b8999d`): `pollWhileVisible` sostituisce cinque copie di intervallo + `visibilitychange`.
- **M8** (`13b2d55`): `verify.yml` riutilizzabile per CI e deploy; il deploy ora esegue anche il type check, che prima mancava.
- **M5** (`c28fa40`, `572c373`, `c207684`): Prettier 3.9.9, riformattazione separata e ignorata da `git blame`, controllo in CI.
- **Ruoli** (`53090f5`, `5fadab6`): il bar gestisce le bevande (RLS su `category = 'bevande'`), lo staff non legge più lo storico notifiche; pagine e ruoli dell'interfaccia in `staffPages.ts`; test `verify-roles.mjs`.
- **M7** (`6aba2a3`): `OrderPage` da 1.058 a 553 righe, con cinque viste in file propri; provato nel browser contro un finto backend locale.
- **Stress** (`faffd3f`): il runner usa un PostgreSQL usa-e-getta via socket Unix e le API attuali; 10 controlli su 10 superati.
- **Tailwind 4** (`403a909`): migrazione verificata confrontando gli stili calcolati di ogni elemento su 9 schermate; tre regressioni trovate e corrette.
- **M6**: le anteprime (`anteprima.html`, `src/previews/`) sono documentate e usate nei test di usabilità del 2026-10-02: restano.

## Scelte e alternative

- **S2 senza riscrivere tutto `schema.sql`**: il file aggiorna anche database esistenti, quindi molti `alter` servono. Riscriverlo come puro stato finale avrebbe rotto quell'aggiornamento; la verifica da ogni versione rende sicura ogni pulizia futura.
- **`pollWhileVisible` come funzione, non come hook**: si inserisce negli effetti esistenti senza spostarne lo stato locale (`cancelled`, `busy`, revisione vista). Il rinnovo del controllo in cassa resta a parte perché reagisce anche a online/offline.
- **Prettier con `printWidth` 120, Markdown e SQL esclusi**: meno rumore; ESLint resta fuori (decisione aperta).

## Verifica

Eseguito il 2026-10-03: `format:check`, `lint` (tsc), 76 test Vitest, build, tutte le 9 verifiche PGlite (`@electric-sql/pglite@0.5.8` in cartella temporanea). Deno non è installato in locale: `deno check`/`deno test` delle Edge Function girano solo in CI. Nessuna prova nel browser con Supabase.

## Azioni manuali in produzione (non eseguite)

1. Applicare `schema.sql` (o le migrazioni `20261003090000`, `20261003091000` e `20261003100000`).
2. Ridistribuire la Edge Function `send-push-broadcast`.
3. Prima, in sola lettura, controllare se la vecchia funzione esiste:
   `select oid::regprocedure from pg_proc where proname = 'submit_public_order';`
