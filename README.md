# LAG — L'Agro ai Giovani

App self-service per l'evento "L'Agro ai Giovani" (festival benefico a Cascina
Marasco, Cremona — ricavato devoluto ad Agropolis ONLUS). L'app è pensata
mobile-first: il pubblico consulta il programma, il menu, gli annunci, i
biglietti e il torneo; lo staff gestisce i contenuti dal telefono o da desktop.

Produzione:

<https://andreasalami.github.io/lag_app/>

## Stack

- **Frontend**: React + TypeScript + Vite + Tailwind CSS
- **Backend**: [Supabase](https://supabase.com) (Postgres + Auth + Realtime)
- **Biglietti**: widget di checkout ufficiale Eventbrite (nessun backend richiesto per questa parte)

## Funzionalità

| Sezione | Cosa fa | Editabile da |
|---|---|---|
| Biglietti | Checkout Eventbrite (widget ufficiale) | — |
| Programma | Griglia calendario, 2 palchi in contemporanea | staff |
| Menu | Prodotti, prezzi, scorte e allergeni 1–14 | staff / cucina |
| Instagram | Embed ufficiali dei post dell'evento | — |
| Annunci | Lista con notifiche browser (solo permesso, non push vere) | staff |
| Torneo | Tabellone a eliminazione diretta (8/16/32/64 squadre), ripescaggio | tournament_manager |
| Ordini | Preordine pubblico, QR, cassa, coda cucina e report anonimo | cassa / cucina |

## Ruoli e accesso

L'accesso avviene esclusivamente dal pulsante **Staff** nella barra superiore.
La Home è pubblica e non contiene più login o logout inline. Dopo il login,
l'area Staff mostra i collegamenti in questo ordine:

1. Programma
2. Annunci
3. Menu
4. Torneo
5. Cassa
6. Cucina

Le prime quattro voci seguono l'ordine delle sezioni pubbliche della Home;
Cassa e Cucina sono raccolte in fondo come strumenti operativi.

| Ruolo | Permessi |
|---|---|
| `admin` | Accesso a tutte le sezioni e a tutte le operazioni |
| `staff` | Modifica programma, menu e annunci |
| `tournament_manager` | Modifica esclusivamente il torneo |
| `cassa` | Gestisce preordini, ordini eccezionali, apertura evento e report |
| `cucina` | Gestisce menu/scorte e consegna gli ordini alimentari |
| `pending` | Nessun permesso operativo |

I permessi sono verificati da Supabase tramite Row Level Security. Il ruolo
non viene scelto dal browser: viene letto dalla tabella `profiles` dopo il
login. Le pagine Cassa e Cucina sono caricate dinamicamente soltanto dopo la
verifica del ruolo: un visitatore anonimo o un ruolo diverso riceve la sola
schermata di accesso riservato, anche conoscendo direttamente l'URL.

## Flusso ordini

Il cliente non effettua login. Dal fondo del menu pubblico apre **Ordina qui**,
conferma il disclaimer, sceglie uno pseudonimo, compone il carrello e invia
l'ordine dopo una seconda conferma. Carrello e parziale restano nel browser:
il database viene scritto soltanto all'invio definitivo.

L'invio riserva le scorte in una transazione e restituisce numero progressivo,
alias e QR. Alla cassa l'ordine può essere aperto tramite QR oppure cercando
numero e alias insieme. Un ordine aperto è temporaneamente non selezionabile
dalle altre casse; **Chiudi senza pagare** lo rende subito disponibile e un
blocco abbandonato scade comunque dopo 10 minuti.

La cassa batte sul registratore tutte le singole voci, riceve il pagamento e
preme **Pagato e invia**. Solo le righe `cibo` arrivano alla cucina; le bevande
restano sullo scontrino per il ritiro alle postazioni dedicate. La cucina vede
numero, alias, prodotti alimentari e note, può attivare il segnale sonoro e
anonimizza l'ordine premendo **Consegnato**.

La sezione Evento della cassa gestisce:

- nome, apertura e chiusura del singolo weekend;
- limite configurabile degli ordini contemporaneamente in attesa (default 150);
- sospensione e riapertura anticipata delle ordinazioni;
- chiusura definitiva protetta dalla digitazione di `CHIUDI EVENTO`;
- download del CSV finale senza alias e note;
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
VITE_EVENTBRITE_EVENT_ID=
VITE_INSTAGRAM_HANDLE=lagroaigiovani
```

La chiave Supabase deve essere la chiave `anon` / `publishable`, mai la
chiave `service_role`. La chiave anon è destinata al client; la protezione
dei dati è affidata alle policy RLS.

### Supabase

1. Crea un progetto su [supabase.com](https://supabase.com).
2. Esegui [supabase/schema.sql](supabase/schema.sql) nell'SQL Editor. Lo script
   funziona sia su un database nuovo sia su quello esistente e non elimina dati
   o account Auth. Se un database precedente contiene già hash QR duplicati, la
   transazione si interrompe senza modificare lo schema: risolvi prima quelle
   righe, quindi ripeti l'esecuzione.
3. In **Authentication → Users**, crea gli account con email e password.
4. In `profiles`, assegna manualmente il ruolo corretto allo stesso `id`
   dell'utente Auth. Gli account nuovi partono come `pending`.
5. Disabilita il signup pubblico se gli account devono essere creati solo
   dall'amministratore.
6. In **Database → Replication**, verifica che le tabelle usate dal realtime
   siano abilitate se il progetto Supabase non le ha già aggiunte tramite SQL.

Per una prima verifica si può assegnare `admin` a un account di test; non è
consigliato usare `admin` per tutti gli account reali.

Dopo l'aggiornamento dello schema, entra una prima volta in **Cassa → Evento**:
il nuovo evento nasce intenzionalmente con ordinazioni sospese. Imposta nome e
orari, salva, quindi premi **Riapri ordinazioni** quando il sistema è pronto.

Prima dell'evento reale è consigliato provare almeno questi casi con account di
test: ultima porzione concorrente, ordine annullato, due casse che aprono lo
stesso ordine, ordine composto solo da bevande, consegna cucina e CSV finale.
La suite locale automatizzata e i relativi vincoli di sicurezza sono descritti
in [docs/STRESS_TEST.md](docs/STRESS_TEST.md).

### Variabili opzionali

- `VITE_EVENTBRITE_EVENT_ID`: ID numerico dell'evento Eventbrite. Se vuoto,
  il checkout resta nello stato "Biglietti in arrivo".
- `VITE_INSTAGRAM_HANDLE`: handle Instagram mostrato nell'app.

I permalink dei post Instagram sono definiti in
`src/features/social/InstagramPosts.tsx`.

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

Le variabili opzionali possono essere aggiunte come **Repository variables**:

| Nome | Valore |
|---|---|
| `VITE_EVENTBRITE_EVENT_ID` | ID numerico dell'evento Eventbrite |
| `VITE_INSTAGRAM_HANDLE` | handle Instagram |

Il workflow interrompe la build se mancano i due valori Supabase obbligatori.
Dopo il push, controlla **Actions → Deploy to GitHub Pages** e attendi che
gli step di build e deploy risultino verdi.

## Backend e sicurezza

- Le tabelle pubbliche (`announcements`, `program_slots`, `menu_items`) sono
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

## Limiti noti

- La protezione pubblica è volutamente leggera (honeypot, idempotenza, un
  riepilogo attivo per browser e cap di coda). Per contrastare un attacco
  intenzionale servirebbe aggiungere Turnstile/CAPTCHA tramite una funzione
  server-side.
- Gli ordini non pagati non scadono automaticamente: restano prenotati finché
  una cassa li annulla oppure chiude definitivamente l'evento.

- Le notifiche in Annunci chiedono solo il permesso del browser — le push
  vere ad app chiusa servono un Service Worker + backend, non ancora costruiti.
- Le modifiche non ancora pubblicate al torneo restano una bozza nel browser;
  dopo il salvataggio il tabellone è condiviso tramite Supabase e aggiornato
  per il pubblico con polling mentre la pagina è visibile.
- Il layout del calendario e del tabellone può usare uno scroll orizzontale
   interno su schermi molto stretti; la pagina principale e i moduli di
   modifica restano contenuti nella larghezza del viewport.
