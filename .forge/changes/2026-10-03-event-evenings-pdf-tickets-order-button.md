# Intervento: PDF per serata, Biglietti condizionati, bottone "Ordina qui"

- Stato: branch `feat/event-evenings-pdf`, non unito; migrazione `20261003120000` **non** applicata in produzione.
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

## Produzione (da fare, con conferma separata)

1. Applicare `schema.sql` (o la migrazione `20261003120000`) **prima** del deploy del frontend:
   il nuovo client invia `p_evening_count` e richiede `evenings` nello snapshot.
2. Impostare la durata in Gestione evento.
