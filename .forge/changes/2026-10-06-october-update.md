# Intervento: aggiornamento di ottobre (ordini, postazioni, torneo, Instagram)

- Stato: branch `feat/october-update`, PR aperta; migrazione `20261006120000` **da applicare in
  produzione da Andrea** prima del merge (il client nuovo usa `save_tournament`).
- Data e perimetro: 2026-10-06 — menu mobile, ordini dopo la chiusura, memoria postazioni, area
  riservata, salvataggi del torneo, carosello Instagram.
- Profilo: [PROJECT_PROFILE.md](../PROJECT_PROFILE.md)
- Piano e approvazione: piano in 6 punti presentato in chat; Andrea sceglie "un salvataggio in onda"
  e "immagini statiche", approva con "sì, procedi e ok download" (filtro DB sulla coda cassa escluso,
  merge e SQL in produzione esclusi).

## Problema e risultato

- **Menu mobile**: l'hamburger diventa la pillola "Ordini" con icona scontrino; il menu non contiene
  più "Programma", solo il riepilogo ordini.
- **Ordini dopo la chiusura** (bug): `close_order_event` annulla gli ordini e azzera `qr_token_hash`,
  quindi il telefono non poteva più chiederne lo stato e li mostrava per sempre "Da pagare" (menu
  "I miei ordini" senza filtro per evento, pulsante "I miei ordini (n)", richiesta interrotta).
  `pruneOrderHistory(openEventId(status))` e `clearPendingOrdersOutside` tengono sul telefono solo
  ordini e richieste dell'evento aperto; usati dalla pagina ordini (`loadCatalog`) e dal menu
  (`get_ordering_status`). Senza rete lo storico resta com'è, per non perdere un QR valido.
- **Postazioni**: `useEventStation` (`stationMemory.ts`) salva `{station, eventId}` e la riprende solo
  se l'evento aperto è lo stesso; fuori dall'evento o con un evento nuovo si riparte dalla scelta. Il
  vecchio formato (solo la postazione) viene ignorato. `isCashStation` rimosso (non più usato).
- **Area riservata**: blocco "Gestione"; voci Scaletta, Menu e Scorte, Torneo, Apertura e Chiusura
  Evento. I titoli delle pagine interne non sono cambiati.
- **Torneo**: pannello "Salvataggi" al posto della copia di sicurezza; via la barra flottante, la bozza
  con revisione, il ripristino dell'ultima copia e l'avviso alla chiusura dei nomi. `tournament_snapshots`
  ha `name` e `updated_at`; `tournament_state.live_save_id` indica il salvataggio in onda. RPC unica
  `save_tournament` (nuovo o esistente, protezione dai conflitti su `updated_at`, `p_publish` per
  metterlo in onda); `publish_tournament` eliminata; insert diretto revocato. La migrazione trasforma il
  tabellone pubblicato nel salvataggio "Torneo pubblicato" in onda e dà un nome alle vecchie copie.
- **Instagram**: 8 immagini di anteprima pubblica (640×640, una 410×409; ~230 KB in totale) in
  `public/instagram/`, scaricate con il permesso di Andrea. Le carte sono `<a>` con immagine, tutte nel
  DOM, trascinamento senza render (doppio livello), pallini di posizione, `touch-pan-y` per non bloccare
  lo scroll verticale. Rimossi `InstagramEmbed.tsx` e `instagram.com` dalla CSP di `index.html`.

## Scelte e alternative

- **Pulizia lato client** invece del filtro per evento in `get_cashier_pending_orders`: la causa era il
  telefono; il filtro DB è stato proposto come protezione in più e scartato da Andrea.
- **Evento dalla RPC pubblica** `get_ordering_status`: cucina e bar non leggono `order_events` (RLS).
- **Confronto `sameTournament`** indipendente dall'ordine delle chiavi: jsonb riordina gli oggetti e un
  confronto con `JSON.stringify` segnalerebbe modifiche inesistenti dopo ogni ricarica.
- **`updated_at` come testo esatto** del database: passarlo per `Date` perderebbe i microsecondi e ogni
  salvataggio risulterebbe in conflitto.
- **Immagini statiche** invece degli embed: un iframe Instagram pesa oltre 1 MB e veniva creato solo
  quando la carta saliva in cima. Limite: i post non si aggiornano da soli.
- Non fatti (non richiesti): rinomina ed eliminazione dei salvataggi.

## Verifica

Eseguito il 2026-10-06: `lint` (tsc), 83 test Vitest (nuovi: pulizia storico e richieste, memoria
postazioni, parsing salvataggi, confronto tabelloni), build, `format:check` sui file versionati,
PGlite 0.5.8 isolato: `verify-migrations`, `verify-schema-matches-migrations` (633 voci, 28 versioni),
nuovo `verify-tournament-saves` (seed in onda, pubblicazione, privacy, conflitto, limiti nomi, ruoli,
scritture dirette negate), `verify-workflow-safety`, `verify-event-snapshot`. Browser (Vite locale con
Supabase segnaposto, 375px): pillola "Ordini" e menu senza Programma, 8 immagini caricate, swipe al
post 2 senza aprire Instagram. **Non provati nel browser**: area riservata e gestione torneo (servono
login e database con la migrazione), pulizia dello storico con rete reale.

## Produzione

Da fare da Andrea, prima del merge: eseguire `supabase/schema.sql` di questo branch nell'SQL Editor,
verificando prima l'impronta del testo caricato (lezione dell'incidente del 2026-10-03), oppure la sola
migrazione `20261006120000_tournament_saves.sql`.
