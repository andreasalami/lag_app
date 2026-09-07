# Copie dal SQL Editor

`20260907-untitled-query.sql` è la copia integrale della query **Untitled query** salvata nel SQL Editor del progetto Supabase `lagapp`, esportata il 7 settembre 2026. Non è stata eseguita sul database.

- Dimensione: 70.091 byte, 1.565 righe.
- SHA-256: `96238c087679b9af29463a5163340f10ea0268aea4d2ec3fc6cf894e3cc0368d`.
- Revisione per la pubblicazione: non sono state individuate password, chiavi API, token reali o dati personali incorporati. I nomi di colonne e parametri come `auth`, `qr_token` e il ruolo `service_role` sono definizioni SQL, non credenziali. Nessuna censura applicata.

## Uso della copia

È una copia storica, precedente allo schema locale `../schema.sql` (3.291 righe alla data dell'esportazione). Mancano, per esempio, le sottocategorie del menu e il limite aggiornato a 100 ordini pendenti. Non sostituire lo schema aggiornato con questa copia e non rieseguirla in produzione: potrebbe reintrodurre vecchie funzioni e permessi. La query salvata nell'editor non certifica lo stato attuale del database.

Per conservare il codice insieme al progetto, versionare `schema.sql`, `migrations/` e queste copie in Git e inviare i commit al repository GitHub. Ogni nuova modifica SQL va salvata nel progetto; questa esportazione è una fotografia e non si aggiorna automaticamente.

## Backup dei dati

Questi file conservano il codice SQL, non gli utenti, gli ordini e gli altri dati effettivi, né i file Storage o i segreti delle Edge Functions. Un backup completo richiede esportazioni separate, custodite in uno spazio privato e protetto, con verifica del ripristino. Non aggiungere dump con dati reali o segreti al repository del codice.

Riferimenti: [migrazioni Supabase](https://supabase.com/docs/guides/deployment/database-migrations) e [backup Supabase](https://supabase.com/docs/guides/platform/backups).
