# Intervento: menu modificabile durante l'evento e caccia ai bug

- **Stato:** branch `fix/live-menu-and-bug-hunt`, partito da `test/stress-limits-2026-11`.
  Produzione non toccata.
- **Data:** 2026-11-10 e 2026-11-11.
- **Profilo:** [PROJECT_PROFILE.md](../PROJECT_PROFILE.md)
- **Origine:** difetti di [STRESS_TEST_RESULTS_2026-11-07.md](../../docs/STRESS_TEST_RESULTS_2026-11-07.md)
  e analisi completa del codice.

## Decisioni di Andrea (2026-11-10)

- Il menu deve essere modificabile nel mezzo dell'evento, senza danni né errori sugli
  ordini.
- **Ordini già inviati:** ricevono comunque gli articoli; sospensione ed eliminazione
  valgono solo per gli ordini successivi. Chi sospende vede quanti ordini restano da
  evadere con quel prodotto: sta alla cucina sospendere quando ha margine. Questa scelta
  sostituisce la prima proposta (avviso al cliente e modifica dell'ordine).
- **Pannello in cucina:** pietanze divise per sezione, con lo stato di sospensione.
- **Sospensione:** interruttore applicato subito.
- **Scorte:** per differenza.
- **Prodotto sospeso per il cliente:** grigio, non ordinabile.
- **Prezzo cambiato nel carrello:** si chiede conferma al cliente.
- **Ordini pagati con un prodotto non più disponibile:** gestione a mano.
- **Prove:** solo in locale.
- **Perimetro:** correggere tutto ciò che è grave o medio.

## Difetti corretti

| Gravità | Difetto | Causa | Correzione |
|---|---|---|---|
| Grave | Eliminare un prodotto in un ordine non pagato blocca annullamento, scadenza e quindi stato, catalogo, invio e coda cassa per tutti | `apply_order_stock` falliva con `unknown_menu_item` anche restituendo scorte | Restituire scorte a un prodotto eliminato lo salta |
| Grave | Dopo la scadenza l'ordine bloccante non si sbloccava; l'unica via era chiudere l'evento, che segnava consegnati gli ordini pagati | Stessa causa | Risolto alla radice: l'interruzione non nasce più |
| Medio | La sospensione si annullava quando un ordine scadeva o veniva annullato | Sospendere significava scorta 0 | Colonna `suspended` separata dalla scorta |
| Medio | Scorte rifiutate con "ricarica e ripeti" fino a 9 volte su 10 | Controllo `stock_changed_retry` | Scorte per differenza, mai rifiutate |
| Medio | Due dispositivi su campi diversi dello stesso prodotto o evento si annullavano | Il salvataggio riscriveva tutta la riga | Si inviano e si applicano solo i campi cambiati |
| Medio | Modificare una voce eliminata da un altro dispositivo rispondeva ok | Nessun controllo | Le righe mancanti tornano in `missing` e l'app lo dice |
| Medio | Un dispositivo rimasto indietro riportava i giorni della scaletta al valore vecchio; riducendo i giorni restavano eventi fuori | `save_program` scriveva sempre i giorni | I giorni si inviano solo se cambiati; ridurli con eventi oltre viene rifiutato (`slots_beyond_days`) |
| Medio | Torneo: circa 3 salvataggi su 4 respinti con `save_conflict`, modifiche perse seguendo l'invito a ricaricare | Confronto sull'intero salvataggio | Al conflitto l'app rilegge, fonde squadre, partite e ripescaggi uno per uno e riprova |
| Medio | Torneo: dopo un'altra pubblicazione l'app mostrava ancora "in onda" | `liveId` mai azzerato | Si azzera e si rilegge |
| Medio | Deadlock tra eliminazione e ordini (circa 1,3% con coincidenza forzata) | Eliminazione senza ordine di blocco | Blocco per id, come gli ordini |
| Medio | Doppioni nel menu e nella scaletta se la rilettura dopo il salvataggio falliva | Le righe nuove restavano "da creare" | Id scelto dal dispositivo e `on conflict do nothing` |
| Medio | Pagamento con risposta persa: la cassa leggeva "non confermato" e non sapeva se aveva incassato | Il secondo tentativo dava `claim_lost` | Nuovo errore `already_paid`, messaggio "già pagato" |
| Medio | Prezzo cambiato tra carrello e invio: il cliente pagava il nuovo prezzo senza saperlo | Nessun totale atteso | `p_expected_total`, errore `price_changed`, carrello riallineato |
| Medio | Prodotto eliminato nel carrello: "Recupera ordine" senza uscita e carrello perso | `unknown_menu_item` non riconosciuto dal client | Errore definitivo e carrello riallineato con messaggio |
| Medio | Pagine staff azzerate al rientro nella scheda (bozza menu, ordine in cassa, ordine manuale) | Il ruolo si rileggeva a ogni nuova sessione dello stesso utente | Rilettura solo al cambio di utente. Dedotto dal codice: nel browser non riprodotto |
| Medio | Cucina e bar: realtime aperto senza ricevere eventi | Permessi di lettura revocati in ottobre | Tolto il realtime, polling da 15 a 8 secondi |
| Lieve | Ruoli senza diritti ricevevano ok senza modifiche | L'RLS scarta in silenzio | Errore `not_authorized` |
| Lieve | Errori tecnici al posto di errori di business | Input non controllati | Totale troppo alto nell'ordine manuale, postazione nulla, id e quantità di consegna, date nulle nell'evento, modalità "dopo" senza cibo |

## Cosa è stato aggiunto o cambiato

- **Database:** `supabase/migrations/20261110120000_live_menu_edits.sql`, con
  `schema.sql` allineato.
  - Nuove funzioni: `get_menu_item_commitments`, che restituisce solo conteggi, e
    `menu_stock_after_edit`.
  - Firme cambiate: `submit_public_order` riceve `p_expected_total`; `bulk_upsert_menu_items`
    e `save_program` restituiscono `jsonb` invece di `void`.
- **Gateway:** `supabase/functions/_shared/publicGateway.ts` inoltra `p_expected_total`.
- **Gestione menu:** `Menu.tsx`, con i nuovi `SuspendButton.tsx` e `menuAvailability.ts`.
  `useDraftRows.ts` aggiunge `changedFields` e `mergeServerRows`.
- **Cucina e bar:** nuovo `DishesPanel.tsx`, mostrato sotto la coda in `Fulfillment.tsx`.
- **Pagina ordini:** `cart.ts` con `reconcileCart`, `OrderMenu.tsx`, `OrderPage.tsx`,
  `orderUtils.ts`.
- **Cassa:** `Cassa.tsx`.
- **Torneo:** `tournamentState.ts` con `mergeTournament`, e `TournamentBracket.tsx`.
- **Scaletta:** `Program.tsx`.
- **Accesso:** `AuthContext.tsx`.
- **Prove:**
  - nuovo `scripts/security/verify-live-menu.mjs` (16 scenari), aggiunto alla CI;
  - aggiornati gli script `edge-staff.mjs` ed `edge-orders.mjs` al nuovo comportamento;
  - nuovi test unitari su carrello, bozze, conteggi e fusione del torneo.

## Scelte e alternative

- **Sospensione come colonna**, non come scorta a 0: la scorta resta un conteggio e la
  sospensione una decisione dello staff. Alternativa scartata: impedire alle scadenze di
  restituire porzioni ai prodotti a 0, che però confonde "finito" con "sospeso".
- **Scorte per differenza nel database** (`menu_stock_after_edit`), non nel browser:
  solo il database conosce le vendite avvenute nel frattempo. Un risultato sotto zero
  si ferma a zero.
- **Fusione del torneo nel browser**, non nel database: `save_tournament` resta com'era.
  La fusione a tre vie (base, mia, loro) ha bisogno della versione da cui si è partiti,
  che ha solo il browser. Sulla stessa partita vale l'ultima postazione che salva; se è
  cambiato il numero di squadre la fusione non si fa e si chiede di ricaricare.
- **Id delle righe nuove scelto dal dispositivo**: rende ripetibile un salvataggio
  senza una tabella di richieste.
- **Polling al posto del realtime per cucina e bar:** riaprire la lettura diretta degli
  ordini avrebbe annullato la scelta di ottobre di usare solo RPC filtrate.

## Verifica

- **Database:** `verify-live-menu.mjs` passa 16 scenari su 16, che fallivano tutti prima
  della migrazione. `verify-schema-matches-migrations.mjs` e le altre 10 verifiche di
  `scripts/security/` passano.
- **Test unitari:** 100 su 100. Controllo dei tipi pulito.
- **Stress test locali:** `edge-staff` (seed 1) 0 difetti e 0 deadlock; torneo con 161
  conflitti fusi e nessuna modifica persa. `edge-orders` (seed 101) passa tutti gli
  scenari. Gli altri seed sono riportati nella pull request.
- **Browser**, contro un finto backend locale con le migrazioni del progetto:
  - carrello con prezzo cambiato, prodotto sospeso ed eliminato;
  - pannello Pietanze con conteggi e sospensione;
  - consegna di un ordine pagato con il prodotto sospeso;
  - prodotto in grigio per il cliente;
  - etichetta "sospeso" e pagamento in cassa;
  - ordine manuale che blocca il prodotto sospeso;
  - scorte per differenza da due dispositivi (97 + 20 = 117) con rinomina conservata;
  - torneo fuso tra due postazioni;
  - scaletta con titolo e orario da due dispositivi.

## Limiti e punti aperti

- **Accesso staff:** la correzione è dedotta dal codice e non riprodotta nel browser.
- **Prezzi come testo:** il finto backend li restituiva come testo, a differenza di
  PostgREST. La validazione del menu li scarta; con Supabase vero non succede.
- **Worker bloccato dalla CSP:** nel browser locale la CSP blocca un worker creato da
  `blob:`. Non viene dal client Supabase; da indagare a parte.
- **Accessibilità:** i campi punteggio del torneo non hanno un'etichetta accessibile.
- **Ordini pagati e mai ritirati:** occupano i posti cucina fino alla chiusura
  dell'evento. Non corretto, solo segnalato.

## Produzione (fuori da questa approvazione)

L'ordine è obbligato:

1. Eseguire `supabase/schema.sql` sul database `lagapp`. Il frontend in produzione
   continua a funzionare con il database nuovo.
2. Ripubblicare la Edge Function `submit-order`. Se la si pubblica prima del database,
   le ordinazioni si fermano: la funzione invierebbe un parametro che il database
   vecchio non conosce.
3. Unire la pull request su `main`: il deploy del frontend parte da lì. Prima del passo
   1 il nuovo frontend non caricherebbe il menu, perché legge la colonna `suspended`.
