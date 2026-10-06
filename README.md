# LAG — L'Agro ai Giovani

App self-service per l'evento "L'Agro ai Giovani" (festival benefico a Cascina
Marasco, Cremona — ricavato devoluto ad Agropolis ONLUS). L'app è pensata
mobile-first: il pubblico consulta il programma, il menu, gli ordini, i
biglietti e il torneo; lo staff gestisce i contenuti dal telefono o da desktop.

Produzione:

<https://andreasalami.github.io/lag_app/>

## Stack

- **Frontend**: React + TypeScript + Vite + Tailwind CSS 4 (browser supportati: Safari/iOS 16.4+, Chrome 111+, Firefox 128+)
- **Backend**: [Supabase](https://supabase.com) (Postgres + Auth + Realtime)
- **Biglietti**: widget di checkout ufficiale Eventbrite (nessun backend richiesto per questa parte)

## Funzionalità

| Sezione | Cosa fa | Editabile da |
|---|---|---|
| Biglietti | Checkout Eventbrite (widget ufficiale) | — |
| Programma | Griglia calendario, 2 palchi in contemporanea | staff |
| Menu | Prodotti, prezzi, scorte e allergeni 1–14 | staff / cucina |
| Instagram | Mazzo di carte con le immagini dei post dell'evento; il tocco apre il post | — |
| Torneo | Riepilogo con turno e ultimi 5 risultati, più tabellone completo separato (nomi squadra fino a 20 caratteri); salvataggi multipli, uno in onda | tournament_manager |
| Ordini | Preordine pubblico, QR, cassa, code di cucina e bar | cassa / cucina / bar |
| Apertura e Chiusura Evento | Apertura e chiusura ordinazioni, situazione incassi in PDF, report CSV finale | cassa |

## Ruoli e accesso

Su desktop l'accesso avviene dal pulsante **Staff** nella barra superiore; su
mobile il pulsante **Login staff** si trova in fondo alla Home, dopo il torneo.
Su mobile il pulsante **Ordini** in alto a destra apre il riepilogo degli ordini
salvati sul dispositivo. Dopo il login, l'area Staff mostra i collegamenti in
questo ordine:

1. Scaletta (staff, admin)
2. Menu e Scorte (staff, cucina, bar, admin)
3. Torneo (tournament_manager, admin)
4. Apertura e Chiusura Evento (cassa e admin)
5. Casse
6. Cucina
7. Bar

Il blocco **Gestione** precede le postazioni operative, raccolte in fondo.
Ogni sezione riservata ha in alto **← Area staff**, che riporta sempre al
login o all'elenco delle sezioni, anche se la pagina è stata aperta da un link
diretto; dall'area staff **← Torna al sito** riporta alla Home.

| Ruolo | Permessi |
|---|---|
| `admin` | Accesso a tutte le sezioni e a tutte le operazioni |
| `staff` | Modifica programma e menu |
| `tournament_manager` | Modifica esclusivamente il torneo |
| `cassa` | Gestisce preordini e ordini eccezionali; apre e chiude l'evento, scarica situazione incassi e report |
| `cucina` | Gestisce tutto il menu (prezzi e scorte compresi) e consegna gli ordini alimentari |
| `bar` | Gestisce le bevande del menu (prezzi e scorte) e le consegna nelle postazioni del bar |
| `pending` | Nessun permesso operativo |

Pagine e ruoli dell'interfaccia stanno in un solo punto,
[src/features/auth/staffPages.ts](src/features/auth/staffPages.ts). I permessi sono
verificati da Supabase tramite Row Level Security. Il ruolo
non viene scelto dal browser: viene letto dalla tabella `profiles` dopo il
login. Le pagine Apertura e Chiusura Evento, Cassa, Cucina e Bar sono caricate
dinamicamente soltanto dopo la verifica del ruolo: un visitatore anonimo o un
ruolo diverso riceve la sola schermata di accesso riservato, anche conoscendo
direttamente l'URL.

Cassa, Cucina e Bar ricordano la postazione scelta su quel dispositivo solo per
l'evento in corso, anche dopo un ricaricamento, finché non si preme **Cambia
cassa** o **Cambia postazione**. Fuori dall'evento, o quando ne inizia uno nuovo,
si riparte dalla scelta della postazione. Senza rete vale l'ultima scelta. Se il
browser blocca la memoria locale la pagina funziona lo stesso: la postazione va
solo riscelta al ricaricamento.

Gli ordini salvati sul telefono del cliente valgono solo per l'evento aperto:
alla chiusura il server li annulla e cancella i QR, quindi il telefono li toglie
dallo storico al primo controllo con la rete.

## Flusso ordini

Il cliente non effettua login. Dal fondo del menu pubblico apre **Ordina qui**,
conferma il disclaimer, sceglie uno pseudonimo, compone il carrello e invia
l'ordine dopo una seconda conferma. Carrello e parziale restano nel browser:
il database viene scritto soltanto all'invio definitivo.

L'invio riserva le scorte in una transazione e restituisce numero progressivo,
alias e QR. Tutti gli ordini creati nello stesso browser durante l'evento
restano nello storico locale: il cliente può selezionarli, mostrare il QR
corretto in cassa, scaricare nuovamente il PDF e usare **Ordina di nuovo** per
aprire un carrello vuoto con l'alias precedente già compilato. Ogni nuovo
ordine riceve un'identità e un QR indipendenti, anche quando altri ordini dello
stesso cliente sono ancora in sospeso.

Alla cassa l'ordine può essere aperto tramite QR oppure cercando numero e alias
insieme. Un ordine aperto è temporaneamente non selezionabile dalle altre
casse; **Chiudi senza pagare** lo rende subito disponibile e un blocco
abbandonato scade comunque dopo 10 minuti.

La cassa batte sul registratore tutte le singole voci, riceve il pagamento e
preme **Pagato e invia**. Solo le righe `cibo` arrivano alla cucina; le bevande
restano sullo scontrino per il ritiro alle postazioni dedicate. La cucina vede
numero, alias, prodotti alimentari e note, può attivare il segnale sonoro e
anonimizza l'ordine premendo **Consegnato** oppure scansionando una seconda
volta lo stesso QR già usato in cassa. Il cliente può consultare lo stato del
proprio ordine mediante il token del QR, senza accesso pubblico alla tabella
degli ordini.

La sezione **Apertura e Chiusura Evento** (ruoli `cassa` e `admin`, separata dalle casse) gestisce:

- nome, apertura e chiusura del singolo weekend, e durata in serate (da 1 a 3);
- limite configurabile degli ordini contemporaneamente in attesa di pagamento (default 100); questo conteggio non include gli ordini già pagati in cucina;
- preparazione del cibo immediata al pagamento oppure differita, attivabile dallo staff tramite QR o numero ordine, con scorte già riservate;
- capienza cucina di 100 ordini fra attivi e posti temporaneamente riservati dalle casse; bevande indipendenti e ritiri parziali;
- sospensione e riapertura anticipata delle ordinazioni;
- chiusura definitiva protetta dalla digitazione di `CHIUDI EVENTO`, che scarica
  il CSV finale e il PDF **Situazione incassi**;
- nuovo download del CSV finale senza alias e note;
- in qualsiasi momento, anche a evento aperto, il PDF **Situazione incassi**:
  incasso totale e spesa media, grafico ora per ora con l'ora di punta e, per
  ogni sezione del menu (cibo e bevande), i due prodotti più venduti con la
  percentuale sui pezzi della sezione e quello venduto meno, anche se a zero.
  Con 2 o 3 serate il PDF ha una parte per ogni serata (stesse statistiche) e
  poi il totale dell'evento, ognuna da una pagina nuova. Una serata va dalle
  06:00 alle 05:59 del giorno dopo, ora di Roma: la serata 1 è quella
  dell'apertura ordini. Il PDF usa solo aggregati: nessun alias o nota dei clienti;
- creazione dell'evento successivo con numerazione nuovamente da 1.

Alias e note sono temporanei e vengono eliminati alla consegna,
all'annullamento o alla chiusura definitiva. Del token QR resta nel database
solo l'impronta crittografica: insieme all'identità della richiesta viene
conservata fino alla chiusura dell'evento per impedire duplicati tardivi. Il
PDF cliente viene generato localmente ed è indicato come documento non fiscale.

## Sviluppo locale

Prerequisito: Node.js 20.19+ oppure 22.12+.

```bash
npm install
cp .env.example .env.local
```

Compila `.env.local` con i valori pubblici del progetto:

```dotenv
VITE_SUPABASE_URL=https://tuoprogetto.supabase.co
VITE_SUPABASE_ANON_KEY=la-chiave-anon-public
VITE_TURNSTILE_SITE_KEY=la-site-key-turnstile
VITE_WEB_PUSH_PUBLIC_KEY=la-chiave-vapid-pubblica
VITE_EVENTBRITE_EVENT_ID=
VITE_INSTAGRAM_HANDLE=lagroaigiovani
```

La chiave Supabase deve essere la chiave `anon` / `publishable`, mai la
chiave `service_role`. La chiave anon è destinata al client; la protezione
dei dati è affidata alle policy RLS.

`VITE_TURNSTILE_SITE_KEY` e `VITE_WEB_PUSH_PUBLIC_KEY` sono **obbligatorie in
CI**: senza di loro il workflow di deploy si ferma prima del build. In locale
si può lavorare anche senza — l'ordinazione pubblica mostra "Le ordinazioni
online non sono ancora configurate" e le notifiche restano spente — ma nessuna
delle due strade porta a una build pubblicabile.

### Supabase

1. Crea un progetto su [supabase.com](https://supabase.com).
2. Esegui [supabase/schema.sql](supabase/schema.sql) nell'SQL Editor. Lo script
   è una singola transazione: o si applica tutto, o il database non cambia.
   Funziona sia su un database nuovo sia su quello esistente e non elimina
   account Auth. Se un database precedente contiene già hash QR duplicati, la
   transazione si interrompe senza modificare lo schema: risolvi prima quelle
   righe, quindi ripeti l'esecuzione.

   **Su un database esistente questo esegue anche `drop table announcements`**,
   perché la sezione Annunci è stata rimossa dall'app. Se il testo degli
   annunci serve, esportalo prima nell'SQL Editor:

   ```sql
   select * from public.announcements order by published_at;
   ```
3. In **Authentication → Users**, crea gli account con email e password.
4. In `profiles`, assegna manualmente il ruolo corretto allo stesso `id`
   dell'utente Auth. Gli account nuovi partono come `pending`.
5. Disabilita il signup pubblico se gli account devono essere creati solo
   dall'amministratore.
6. In **Database → Replication**, verifica che le tabelle usate dal realtime
   siano abilitate se il progetto Supabase non le ha già aggiunte tramite SQL.

Per una prima verifica si può assegnare `admin` a un account di test; non è
consigliato usare `admin` per tutti gli account reali.

Dopo l'aggiornamento dello schema, entra una prima volta in **Apertura e Chiusura Evento**:
il nuovo evento nasce intenzionalmente con ordinazioni sospese. Imposta nome e
orari, salva, quindi premi **Riapri ordinazioni** quando il sistema è pronto.

Prima dell'evento reale è consigliato provare almeno questi casi con account di
test: ultima porzione concorrente, ordine annullato, due casse che aprono lo
stesso ordine, ordine composto solo da bevande, consegna cucina e CSV finale.
La suite locale automatizzata e i relativi vincoli di sicurezza sono descritti
in [docs/STRESS_TEST.md](docs/STRESS_TEST.md).
La configurazione completa delle notifiche broadcast è descritta in
[docs/PUSH_NOTIFICATIONS.md](docs/PUSH_NOTIFICATIONS.md).
Il collaudo di questo aggiornamento mobile è tracciato in
[docs/MOBILE_UX_TOURNAMENT_TEST_PLAN.md](docs/MOBILE_UX_TOURNAMENT_TEST_PLAN.md).

### Variabili opzionali

- `VITE_EVENTBRITE_EVENT_ID`: ID numerico dell'evento Eventbrite. Se vuoto,
  la sezione Biglietti e i suoi link in Navbar e TabBar non compaiono; la
  sezione si nasconde anche se il widget di Eventbrite non si carica.
- `VITE_INSTAGRAM_HANDLE`: handle Instagram mostrato nell'app.

I post Instagram sono definiti in `src/features/social/InstagramPosts.tsx`:
per aggiungerne uno salva la sua immagine come `public/instagram/<codice>.jpg`
(il codice è la parte dopo `/p/` nel link) e aggiungi il codice all'elenco.

```bash
npm run dev       # sviluppo, http://localhost:5173
npm run build     # build di produzione in dist/
npm run preview   # anteprima della build di produzione
npm run lint      # controllo TypeScript senza generare la build
npm test          # test unitari
```

## Deploy su GitHub Pages

Il deploy viene eseguito automaticamente da
[.github/workflows/deploy.yml](.github/workflows/deploy.yml) a ogni push su
`main`. Il sito usa il project path GitHub Pages `/lag_app/`; non usare un
dominio custom e non aggiungere un file `public/CNAME`.

Prima del primo deploy, nel repository GitHub apri:

**Settings → Secrets and variables → Actions**

Crea questi **Repository secrets**:

| Nome | Valore |
|---|---|
| `VITE_SUPABASE_URL` | URL del progetto Supabase |
| `VITE_SUPABASE_ANON_KEY` | chiave `anon` / `publishable` Supabase |

Crea poi queste **Repository variables**. Le prime due sono **obbligatorie**:
il workflow si ferma prima del build se mancano.

| Nome | Valore | Obbligatoria |
|---|---|---|
| `VITE_TURNSTILE_SITE_KEY` | site key pubblica Cloudflare Turnstile | sì |
| `VITE_WEB_PUSH_PUBLIC_KEY` | chiave VAPID pubblica (`npm run push:keys`) | sì |
| `VITE_EVENTBRITE_EVENT_ID` | ID numerico dell'evento Eventbrite | no |
| `VITE_INSTAGRAM_HANDLE` | handle Instagram | no |

Il workflow interrompe la build se manca uno dei quattro valori obbligatori
(i due secret Supabase e le due variabili qui sopra).
Dopo il push, controlla **Actions → Deploy to GitHub Pages** e attendi che
gli step di build e deploy risultino verdi.

## Backend e sicurezza

- Le tabelle pubbliche (`program_slots`, `menu_items`, `tournament_state`) sono
   leggibili senza login, ma scrivibili solo dai ruoli autorizzati.
- Gli ordini non sono leggibili pubblicamente: le RPC pubbliche restituiscono
  esclusivamente il risultato dell'ordine appena creato.
- La cassa può leggere soltanto gli ordini `in_attesa_pagamento`; la cucina
  soltanto gli ordini `pagato`. Il passaggio di stato effettuato in cassa è il
  confine tra i due flussi, oltre al controllo dei rispettivi ruoli Auth.
- `submit_public_order`, aggiornamento cassa, annullamento e pagamento
  ricalcolano prezzi e scorte nel database e applicano tutto atomicamente.
- Il QR contiene un token casuale; nel database viene conservata soltanto la
  sua impronta SHA-256, eliminata alla chiusura definitiva dell'evento.
- Il report permanente non duplica il dettaglio ordini: conserva solo
  riepilogo e aggregati prodotto; il CSV viene ricostruito dalle righe già
  anonimizzate quando viene riscaricato.
- Le connessioni realtime sono limitate ai pochi dispositivi cassa/cucina. I
  telefoni del pubblico effettuano solo le letture indispensabili.
- Non inserire mai chiavi `service_role`, password o altri segreti nei file
   `VITE_*`, in `.env.local`, nel repository o nel bundle frontend.
- `supabase/schema.sql` descrive lo stato finale (una definizione per funzione,
   una sola transazione); la storia sta in `supabase/migrations/`. La CI applica
   entrambi su due database PGlite isolati e confronta l'intero catalogo, così i
   due non possono divergere senza far fallire il build.

## Limiti noti

- L'ordinazione pubblica passa da una Edge Function che verifica un token
  Cloudflare Turnstile prima di toccare il database: il browser non ha alcun
  permesso di scrittura sulla tabella ordini. Restano attivi anche honeypot,
  idempotenza e cap di coda. Se `TURNSTILE_SECRET_KEY` o `ORDER_ALLOWED_ORIGINS`
  non sono configurate sulla funzione, l'ordinazione online si spegne invece di
  aprirsi: gli ordini si prendono in cassa.
- Gli ordini non pagati scadono dopo 60 minuti, ma la scadenza è *pigra*: viene
  applicata quando qualcuno legge lo stato delle ordinazioni, non da uno
  scheduler. Se per un'ora nessuno apre l'app, le scorte restano prenotate fino
  alla lettura successiva. È una scelta per non dipendere da infrastruttura a
  pagamento, non una svista.
- Le notifiche Web Push richiedono la chiave VAPID pubblica nella build e la
  Edge Function configurata con i relativi segreti; senza questi valori l'app
  mostra un errore di configurazione senza registrare il dispositivo.
- Il torneo si gestisce con i **Salvataggi**: si sceglie un salvataggio, lo si
  modifica e compare **Salva modifiche**; **Salva come nuovo** crea una copia
  privata. Uno solo è in onda: salvarlo aggiorna il tabellone pubblico, gli
  altri si pubblicano con **Metti in onda**. Le modifiche non ancora salvate
  restano nel browser per sopravvivere a un ricaricamento; il pubblico riceve
  gli aggiornamenti con polling mentre la pagina è visibile.
- Il calendario della Home resta contenuto nella larghezza del viewport anche
  su mobile. Solo il tabellone completo, nella pagina dedicata, usa uno scroll
  orizzontale interno per mantenere leggibili tutti i turni.
