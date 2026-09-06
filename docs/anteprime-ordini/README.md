> Aggiornamento 5 settembre: l’app ora integra recupero anonimo reale e correzioni
> di sicurezza in locale. La vista `salvataggio` mostra RecoveryCard e Modal reali
> con dati sintetici; le quattro viste originali sotto restano prototipi isolati.
> Stato attuale e verifiche: [SECURITY_REMEDIATION.md](../SECURITY_REMEDIATION.md).
> Le note e i conteggi sotto descrivono il precedente collaudo delle anteprime.

# Anteprime ordini e ritiri

Branch locale: `codex/order-usability-preview`. Nessun push effettuato.

Avviare `npm run dev -- --host 127.0.0.1` e aprire
`http://127.0.0.1:5173/anteprima.html?vista=ritiro`.
Le altre viste sono `ordine`, `qr` e `recupero`.

## Ambito

- **App operativa:** nuovo selettore delle quantità per gli addetti, condiviso con
  l'anteprima. Selezione iniziale zero, scorciatoie 1/2/tutti, +/−, riepilogo e
  conferma. Usa la RPC esistente e mantiene i permessi per postazione.
- **Prototipo:** nuovo menu, QR cliente e recupero senza account. L'anteprima
  non importa Supabase e non crea ordini reali. Il carrello dimostrativo salva
  quantità e soprannome in una chiave localStorage separata.
- **Recupero:** immagine scaricabile e scheda fotografabile, con QR esplicitamente
  non valido. La credenziale anonima, la sua registrazione sul server e il ripristino
  dello storico devono ancora essere implementati. Nessuna promessa di recupero
  dati può essere fatta sulla base di questo prototipo.
- Nessuna modifica allo schema, nessuna dipendenza aggiunta e nessun servizio a
  pagamento introdotto. Rimangono i limiti dell'infrastruttura gratuita già usata.
- `anteprima.html` è un ingresso Vite separato: la build ordinaria dell'app non
  pubblica questo prototipo.

## Verifiche

- `npm test`: 35 test superati, inclusi quantità non valide e selezione divenuta
  obsoleta dopo un aggiornamento da un'altra postazione.
- `npm run build` e `git diff --check`: superati.
- Browser: menu e selettore a 320 e 390 pixel senza overflow orizzontale;
  ritiro di 2 birre seguito dal QR con 8 rimaste e importo invariato;
  scheda di recupero interamente visibile a 390×844 per uno screenshot.
- `verify-partial-pickup.mjs`: schema reale caricato in PostgreSQL isolato in
  memoria (PGlite). Verifica ritiri 2+2+6 birre e 1+1 panini, totale invariato,
  completamento soltanto dopo tutti gli articoli, limiti delle quantità e ruoli.
  Nessun collegamento al database remoto. Il test non simula una gara tra
  connessioni concorrenti né i servizi ospitati Supabase.

Per ripetere la verifica SQL, con PGlite disponibile in un'installazione separata:

```sh
LAG_AUDIT_PGLITE_MODULE=/percorso/pglite/dist/index.js node docs/anteprime-ordini/verify-partial-pickup.mjs
```

Le immagini PNG nella cartella sono schermate reali del prototipo a 390×844.
L'audit di sicurezza generale è in `../AUDIT_SICUREZZA_GRATUITA_2026-09-05.md`;
questa modifica non risolve tutte le criticità descritte nell'audit.
