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
| Menu | Prodotti cibo/bevande con prezzo | staff |
| Instagram | Embed ufficiali dei post dell'evento | — |
| Annunci | Lista con notifiche browser (solo permesso, non push vere) | staff |
| Torneo | Tabellone a eliminazione diretta (8/16/32/64 squadre), ripescaggio | tournament_manager |
| Ordini | Cassa, coda cucina, disponibilità porzioni e statistiche di base | cassa / cucina |

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
| `cassa` | Crea ordini dalla cassa |
| `cucina` | Visualizza e completa gli ordini |
| `pending` | Nessun permesso operativo |

I permessi sono verificati da Supabase tramite Row Level Security. Il ruolo
non viene scelto dal browser: viene letto dalla tabella `profiles` dopo il
login.

## Sviluppo locale

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
2. Esegui [supabase/schema.sql](supabase/schema.sql) una volta nell'SQL Editor.
3. Esegui [supabase/migration_orders.sql](supabase/migration_orders.sql) per
   aggiungere ordini, ruoli operativi, porzioni e funzioni SQL.
4. In **Authentication → Users**, crea gli account con email e password.
5. In `profiles`, assegna manualmente il ruolo corretto allo stesso `id`
   dell'utente Auth. Gli account nuovi partono come `pending`.
6. Disabilita il signup pubblico se gli account devono essere creati solo
   dall'amministratore.
7. In **Database → Replication**, verifica che le tabelle usate dal realtime
   siano abilitate se il progetto Supabase non le ha già aggiunte tramite SQL.

Per una prima verifica si può assegnare `admin` a un account di test; non è
consigliato usare `admin` per tutti gli account reali.

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
- Gli ordini non sono pubblici: cassa, cucina e admin hanno permessi distinti.
- `create_order` ricalcola nomi e prezzi leggendo il menu dal database, invece
   di fidarsi dei valori inviati dal browser.
- Gli ordini vengono completati tramite `completed_at`; non vengono cancellati
   fisicamente.
- Non inserire mai chiavi `service_role`, password o altri segreti nei file
   `VITE_*`, in `.env.local`, nel repository o nel bundle frontend.

## Limiti noti

- Le notifiche in Annunci chiedono solo il permesso del browser — le push
  vere ad app chiusa servono un Service Worker + backend, non ancora costruiti.
- Il tabellone del torneo vive in `useState` locale: non è ancora
  sincronizzato su Supabase, quindi non condiviso tra dispositivi diversi.
- Il layout del calendario e del tabellone può usare uno scroll orizzontale
   interno su schermi molto stretti; la pagina principale e i moduli di
   modifica restano contenuti nella larghezza del viewport.
