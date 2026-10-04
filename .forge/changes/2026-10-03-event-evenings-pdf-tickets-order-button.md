# Intervento: PDF per serata, Biglietti condizionati, bottone "Ordina qui"

- Stato: unito su `main` tramite PR #8; migrazione `20261003120000` applicata in produzione il 2026-10-04.
- Data e perimetro: 2026-10-03 — Gestione evento, sezione Biglietti, bottone "Ordina qui" nel menu.
- Profilo: [PROJECT_PROFILE.md](../PROJECT_PROFILE.md)
- Piano e approvazione: piano e 5 animazioni presentati in chat; Andrea sceglie "4 · Riempimento",
  chiede la durata evento impostabile da 1 a 3 serate e approva con "Sì, procedi" (produzione esclusa).

## Problema e risultato

- **PDF per serata**: la colonna `order_events.evening_count` (1–3, default 1) si imposta in Gestione
  evento. `get_order_event_snapshot` aggiunge `evenings[]` con le stesse statistiche del totale,
  calcolate dalla funzione interna `order_event_snapshot_part` (non eseguibile da anon/authenticated).
  Il PDF ha una parte per serata e poi "Totale evento", ognuna da pagina nuova; con 1 serata resta
  il solo totale (sarebbe identico). Alla chiusura definitiva il PDF si scarica da solo dopo il CSV.
- **Biglietti**: `TICKETS_ENABLED` (Event ID presente) governa sezione, link Navbar e scheda TabBar;
  se lo script Eventbrite non si carica la sezione si nasconde. `EventbriteCheckoutButton.tsx`
  è stato unito in `EventbriteTickets.tsx` (unico utilizzatore).
- **Ordina qui**: subito sotto il titolo del menu, largo quanto la pagina, 60px, arancione pieno.
  Al tap si schiaccia e si riempie (0,5 s minimo) mentre verifica gli orari; con
  `prefers-reduced-motion` niente movimento.

## Scelte e alternative

- **Confine della serata alle 06:00 (Europe/Rome)**: gli ordini dopo mezzanotte restano alla serata
  in corso. Alternativa scartata: la regola "più di 3 ore di pausa" del grafico, che non può dividere
  i prodotti (serve il dato per ordine, quindi lato server). Pagamenti fuori dalla durata vanno nella
  serata più vicina, così la somma delle serate è sempre il totale.
- **`p_evening_count` opzionale in `update_order_event`**: un client non aggiornato non azzera la durata.
- **Animazione in CSS puro** (`orderEntryButton.css`), nessuna libreria; `navigator.vibrate` escluso
  perché assente su iPhone.
- **"Eventbrite attivo"** = Event ID configurato e widget caricato. Sapere se i biglietti sono in
  vendita richiederebbe l'API privata tramite backend: fuori perimetro.

## Verifica

Eseguito il 2026-10-03: `format:check`, `lint` (tsc), 79 test Vitest, build, 10 verifiche PGlite
(nuovo caso a due serate con ordine dopo mezzanotte, durata 4 rifiutata, funzione interna negata).
`verify-public-orders.mjs` ripete una migrazione storica sopra lo schema finale: ora elimina
l'overload a 4 parametri ricreato da quella ripetizione. Browser (Vite locale, Supabase segnaposto,
viewport 375px): niente Biglietti senza Event ID, TabBar a 3 voci, bottone 343×60 prima delle
portate, stato "Verifico…" e modale di errore. Non provati: PDF generato da dati reali, doppio
download su Safari iOS.

## Produzione e incidente (2026-10-03/04)

- L'esecuzione della migrazione da parte di Claude è stata bloccata dal classificatore dei permessi:
  l'SQL è stato eseguito da Andrea nell'SQL Editor.
- **Incidente**: nell'SQL Editor era salvata una query con lo `schema.sql` del 2026-08-13 (`07e8843`,
  1.566 righe, SHA-256 `96238c08…`), aperta di default da Supabase. È stata eseguita due volte al posto
  della migrazione: 105 differenze di catalogo, fra cui le 7 funzioni di cassa ritirate, la tabella
  `announcements` e la `submit_public_order` a 6 parametri eseguibile da `anon` senza Turnstile.
  Dati intatti (32 ordini); nessun ordine creato durante l'esposizione (ultimo: 2026-09-23).
- **Ripristino**: incidente riprodotto su PGlite (catena fino a `20261003110000`, poi schema di agosto,
  poi `schema.sql` attuale: 0 differenze dallo stato finale). Eseguito lo `schema.sql` del commit
  `b159cbd` più la registrazione di `20261003120000` (2.420 righe, SHA-256 `8487bf85…`, verificata
  nell'editor prima del Run). La query salvata ora contiene solo quel testo: lo schema di agosto non
  è più nell'SQL Editor.
- Verifica dopo (sola lettura): migrazioni fino a `20261003120000`, `evening_count` con vincolo 1–3,
  nessuna funzione ritirata, solo la `submit_public_order` attuale (non eseguibile da anon/authenticated),
  niente `announcements`, `order_event_snapshot_part` privata, push solo torneo, 3 policy del bar,
  evento "Prova sett 26" intatto, snapshot funzionante.
- Lezione: prima di ogni Run nell'SQL Editor verificare l'impronta del testo caricato; Supabase
  riapre l'ultima query salvata.
