# Analisi del progetto LAG — sicurezza, affidabilità e gratuità

Data: 5 settembre 2026. Revisione del codice: `f34058f`.

**Valutazione: base valida, ma da correggere prima di affidarle gli ordini di un evento reale.** Ho trovato difetti riproducibili nel backend, oltre a rischi di abuso e di esaurimento delle risorse gratuite. Non emerge la necessità di introdurre servizi a pagamento per correggerli. La gratuità economica è un obiettivo realistico entro limiti definiti; disponibilità illimitata e manutenzione senza lavoro umano non sono garantibili.

## Perimetro e verifiche

Revisione dei 101 file versionati: frontend React, autenticazione, ordini e ritiri, programma, menu, torneo, notifiche, schema SQL e migrazioni, dipendenze, workflow di pubblicazione e documentazione. Sono state considerate le ultime definizioni delle funzioni SQL, che in diversi casi sostituiscono quelle precedenti nello stesso file.

Verifiche svolte:

- `npm test`: **31 test superati, 9 file**.
- `npm run build`: **superata**, inclusa compilazione TypeScript.
- `npm audit`: **1 segnalazione high**, su `nanoid@3.3.17`, dipendenza di sviluppo transitiva di PostCSS.
- `npm audit --omit=dev`: **nessuna vulnerabilità segnalata**. Questo controllo non comprende automaticamente le dipendenze Deno della Edge Function.
- Scansione mirata dei file versionati per chiavi private e credenziali privilegiate: nessun candidato trovato dai pattern utilizzati. La chiave frontend locale ha ruolo `anon`, non `service_role`. Non è una scansione completa della storia Git o dei segreti configurati sul cloud.
- Riproduzioni SQL in **PGlite 0.5.8, PostgreSQL in memoria**, con ruoli anon/authenticated e RLS. Il simulatore crea un piccolo schema Auth e sostituisce esclusivamente `extensions.digest(text,text)` con SHA-256 equivalente per i test. Non emula gateway, Realtime o infrastruttura Supabase.
- Il servizio Docker locale non era attivo: non ho rieseguito la suite Supabase/Docker né prove di concorrenza sull'intero stack. Il rapporto di stress test del 13 agosto è una prova storica, non una verifica delle nuove RPC.

Nessuna richiesta di scrittura, prova di carico, invio push o modifica è stata eseguita sulla produzione. Codice applicativo, schema e dipendenze del progetto sono rimasti invariati; sono stati aggiunti questo rapporto e le prove riproducibili.

Le prove sono in [reproduce.mjs](audit-2026-09-05/reproduce.mjs) e gli esiti in [results.txt](audit-2026-09-05/results.txt). Il programma mostra il comportamento attuale: non è una suite che certifica la sicurezza in caso di uscita con codice zero.

## Problemi prioritari

### 1. P1 — Gli ordini anonimi consentono di bloccare scorte e coda

**Riferimenti:** `supabase/schema.sql:786` (`submit_public_order`), `:1793` (`normalize_order_items`), `:871` (esecuzione anonima).

Il campo honeypot può essere lasciato vuoto da chi invoca direttamente l'API. UUID e token possono essere generati a piacere; non esistono una verifica anti-bot server-side, un limite di frequenza applicativo o una scadenza degli ordini non pagati. Il limite predefinito di 150 riguarda il numero di ordini, non le porzioni impegnate.

**Riprodotto:** un solo ordine anonimo di 999 porzioni porta la disponibilità di un prodotto da 5.000 a 4.001, senza pagamento. Inoltre il limite di 999 è applicato alla singola riga prima dell'aggregazione: ripetere lo stesso prodotto può superare tale quantità complessiva. Gli ordini abbandonati restano prenotati sino all'annullamento o alla chiusura definitiva.

**Impatto:** anche senza rubare dati, un utente può impedire ai clienti di ordinare. Il cap globale contiene la crescita, ma rende raggiungibile una condizione di blocco per tutti.

**Correzione a costo zero:** limiti ragionevoli per prodotto e ordine dopo aggregazione; scadenza delle prenotazioni con rilascio atomico delle scorte; Turnstile e limiti di frequenza verificati in una Edge Function. Quando si introduce la funzione, va revocato l'accesso diretto alla RPC di scrittura per `anon` e `authenticated`, riservandolo al percorso server autorizzato: altrimenti il CAPTCHA resta aggirabile. Evitare soglie IP troppo strette, perché molti partecipanti potrebbero condividere Wi-Fi o NAT mobile. Turnstile dispone di un [piano gratuito](https://developers.cloudflare.com/turnstile/plans/) e richiede [validazione server-side](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/).

### 2. P1 — Le iscrizioni push accettano destinazioni arbitrarie

**Riferimenti:** `supabase/schema.sql:1511–1556`; `supabase/functions/send-push-broadcast/index.ts:133–147`.

La RPC pubblica accetta qualsiasi stringa HTTPS che superi i controlli formali; non verifica che il dominio appartenga a un servizio Web Push. Il broadcaster passa poi l'endpoint salvato a `webpush.sendNotification`.

**Riprodotto:** un anonimo registra `https://arbitrary.example.test/path` con stringhe formalmente valide al posto delle chiavi. Non ho effettuato richieste a questa destinazione. Il rischio di richiesta server-side a una destinazione controllata dall'attaccante deriva dal percorso del codice: un'iscrizione con vere chiavi P-256 può raggiungere il ramo d'invio. Non è stata dimostrata raggiungibilità della rete interna o sottrazione di segreti.

**Impatto:** rischio SSRF differito al successivo broadcast autorizzato; iscrizioni fasulle possono inoltre occupare tutti i 5.000 posti e far fallire o rallentare gli invii. Le iscrizioni che producono errori diversi da 404/410 non vengono eliminate.

**Correzione:** convalida strutturale delle chiavi, lista esplicita e mantenuta dei provider push supportati, rifiuto di IP letterali/credenziali/porte inattese, controllo di eventuali redirect, limiti di frequenza e scadenza delle iscrizioni inattive. In mancanza di una protezione completa, disabilitare temporaneamente le nuove iscrizioni è una misura gratuita che preserva gli ordini.

### 3. P1 — Le vecchie RPC aggirano il nuovo flusso di cassa e ritiro

**Riferimenti:** `supabase/schema.sql:909`, `:1080`, `:1156`, `:1181`; nuove funzioni da `:1869` in avanti.

`claim_order`, `pay_claimed_order`, `deliver_order` e `deliver_order_by_qr` restano eseguibili dagli utenti autenticati con i relativi ruoli. Usano campi e regole del vecchio flusso e non sono semplici alias delle nuove funzioni.

**Riprodotto:** dopo un claim della nuova cassa, il vecchio claim e il vecchio pagamento riescono comunque: l'ordine risulta `pagato`, ma ha **zero righe di evasione**, quindi manca nelle nuove code di ritiro. In un altro caso, `deliver_order` con ruolo cucina imposta `consegnato` mentre il dettaglio resta `quantity=1, delivered_quantity=0`.

**Impatto:** ordini invisibili o falsamente consegnati; il vecchio comando cucina può chiudere anche ordini misti senza rispettare le postazioni bar. Occorre un ruolo operativo, non basta essere visitatore anonimo.

**Correzione:** rimuovere/revocare le RPC obsolete oppure trasformarle in adattatori che rispettino tutti gli invarianti del nuovo flusso. Aggiornare prima gli script di collaudo che ancora le usano.

### 4. P1 — Un addetto può riaprire un ordine dopo la chiusura definitiva

**Riferimenti:** `supabase/schema.sql:2187–2217`, `:2290`.

In `undo_fulfillment_delivery` il controllo sull'evento chiuso è applicato soltanto a `user_role = 'admin'`. Un addetto cucina/bar nella propria finestra di cinque minuti passa gli altri controlli. Inoltre la funzione non prende per primo il lock sull'evento, come previsto dal protocollo delle vecchie mutazioni.

**Riprodotto:** consegna → chiusura evento da admin → annullamento della consegna da cucina. Risultato: `status=pagato` con `event_closed=true`.

**Impatto:** la chiusura non è definitiva, il report congelato può divergere dagli stati e un ordine può ricomparire nelle code anche durante l'evento successivo, perché le query di evasione non filtrano l'evento corrente.

**Correzione:** controllare l'evento chiuso per tutti i ruoli, bloccare evento e ordine prima dei dettagli con un ordine uniforme dei lock; collaudare consegna, annullamento e chiusura concorrenti. La gara concorrente non è stata misurata in questo audit: il difetto sequenziale è già riprodotto.

### 5. P1 — Lo schema non è riapplicabile come documentato

**Riferimenti:** `supabase/schema.sql:2279–2284`; `README.md`, istruzioni Supabase; `supabase/migrations/`.

**Riprodotto:** prima applicazione riuscita, seconda applicazione fallita con `policy "Le postazioni leggono gli ordini in preparazione" for table "orders" already exists`. Manca il `DROP POLICY IF EXISTS` per quella policy. La transazione annulla l'aggiornamento: non è prova di cancellazione dei dati, ma impedisce la procedura documentata.

Il bootstrap completo è nello schema, mentre le migrazioni iniziano con modifiche a tabelle preesistenti: il solo percorso standard delle migrazioni non ricrea un database vuoto. Il file schema include più definizioni di diverse funzioni, con rischio concreto di correggere la versione sbagliata. La normalizzazione iniziale delle sottocategorie non considera inoltre `furgone`: va rivista prima di rendere nuovamente riapplicabile tutto il file.

**Correzione:** una migrazione iniziale completa, migrazioni successive ordinate e test di installazione pulita/aggiornamento. Rendere esplicito un unico percorso di deploy del database, evitando che il frontend e lo schema vengano aggiornati separatamente senza verifica di compatibilità.

### 6. P2 — Alias e note non vengono eliminati alla consegna o all'annullamento

**Riferimenti:** `supabase/schema.sql:2020–2041`, `:2149–2160`, `:2280–2284`; `README.md`, flusso e conservazione dei dati.

Le nuove RPC modificano lo stato ma conservano alias e note; la cancellazione avviene soltanto con la chiusura definitiva manuale. Il passaggio dell'orario di fine evento non la attiva automaticamente.

**Riprodotto:** entrambi i campi restano valorizzati su ordini annullati e consegnati. La policy consente a bar e cucina di leggere direttamente tutti gli ordini pagati, parziali e consegnati, comprese le righe dell'altra area. Un utente bar ha letto alias e note di un ordine alimentare già consegnato.

**Impatto:** conservazione più lunga di quanto documentato e accesso più ampio di quello mostrato dalle RPC filtrate. I dati del browser e i PDF sono copie ulteriori, non cancellate dal database.

**Correzione:** definire una conservazione reale coerente con l'annullamento del ritiro entro cinque minuti; cancellazione automatica a fine finestra/evento; minimizzazione delle note; accesso mediante RPC o policy/proiezioni più strette. Il bisogno di Realtime va risolto senza esporre l'intera riga a tutti gli addetti. Allineare informativa e README al comportamento effettivo.

### 7. P2 — La cassa non sincronizza i claim e ignora il rinnovo fallito

**Riferimenti:** `src/features/orders/Cassa.tsx:109–155`; `supabase/schema.sql:2388–2419`.

La lista ascolta modifiche di `orders`; i nuovi claim sono scritti in `order_claim_devices`. Il timer di 30 secondi aggiorna solo l'età mostrata a schermo, non ricarica la lista. Non vengono gestiti lo stato della sottoscrizione Realtime e gli errori del rinnovo ogni dieci secondi. Il claim dura trenta secondi.

**Scenario:** la cassa A apre un ordine, la cassa B continua a vederlo libero fino a un altro aggiornamento. Un telefono che perde rete o va in background può perdere il claim mantenendo aperta la schermata: l'addetto scopre il problema quando conferma un pagamento già ricevuto materialmente. Le RPC proteggono comunque il pagamento concorrente: questo rilievo riguarda sincronizzazione e recupero operativo.

**Correzione:** aggiornamento leggero delle informazioni di claim, polling di recupero visibile e limitato, rinnovi controllati e avviso immediato di claim perso. Gestire timeout/reconnect senza moltiplicare il download dell'intera coda.

### 8. P2 — Un invio riuscito può perdere QR e identità sul dispositivo

**Riferimenti:** `src/features/orders/OrderPage.tsx:67`, `:217–263`; `src/features/orders/orderHistory.ts:72`.

Request ID e token nascono in un `useRef` e vengono salvati nello storico solo dopo la risposta. Se il database accetta l'ordine ma si perde la risposta, un reload genera una nuova identità: il successivo invio può duplicare la prenotazione e il cliente non recupera il primo QR. `saveOrderHistory` non intercetta gli errori di scrittura del browser; una quota piena o lo storage disabilitato può interrompere la visualizzazione dopo la creazione dell'ordine.

**Correzione:** salvare durevolmente identità e contenuto della richiesta prima dell'invio, recuperare le richieste dall'esito incerto e riutilizzare lo stesso ID. Gestire l'errore di storage conservando comunque QR e riepilogo in memoria e offrendo il download. L'idempotenza SQL esistente è utile, ma funziona solo se il client conserva l'identità.

### 9. P2 — La notifica a 5.000 utenti non ha un'esecuzione robusta

**Riferimenti:** `supabase/functions/send-push-broadcast/index.ts:20–21`, `:126–174`.

Un'unica invocazione cifra e invia fino a 5.000 notifiche, con venti invii paralleli, senza timeout esplicito per destinatario, checkpoint o idempotenza del broadcast. Il log viene scritto alla fine. Un'interruzione può lasciare invii parziali senza rendiconto; un retry genera un nuovo broadcast e duplica le notifiche già inviate.

Il piano Free impone **150 secondi di durata e 2 secondi di CPU per richiesta**. La cifratura per migliaia di destinatari è un rischio concreto da misurare: non ho provato un broadcast reale né affermo una soglia massima già misurata. [Limiti Edge Functions](https://supabase.com/docs/guides/functions/limits).

**Correzione:** piccoli lotti misurati, timeout, identificativo di broadcast persistente prima dell'invio, registrazione dell'avanzamento e limiti di frequenza per gli operatori. Non serve un fornitore push a pagamento; se l'affidabilità richiesta eccede le risorse disponibili, mantenere le notifiche accessorie e usare il tabellone come canale principale.

### 10. P2 — Il torneo può sovrascrivere aggiornamenti fatti da un altro dispositivo

**Riferimenti:** `src/features/tournament/TournamentBracket.tsx:123–129`, `:192–199`, `:219–234`.

La bozza locale viene preferita al dato pubblicato senza data/versione di origine e resta nel browser anche dopo il salvataggio. La pubblicazione sostituisce l'intero stato con `upsert`, senza confronto di versione.

**Scenario verificabile dal codice:** A pubblica; B aggiorna dal proprio telefono; A rientra, ricarica la vecchia bozza, cambia un risultato e pubblica: perde gli aggiornamenti di B. Gli snapshot proteggono cambio dimensione e ripristino, non ogni pubblicazione ordinaria.

**Correzione:** revisioni server e aggiornamento condizionato alla revisione letta; avviso di conflitto; bozze identificate per evento/utente/versione; eliminare la bozza già pubblicata o conservarne esplicitamente la revisione.

### 11. P2 — Ripetere la chiusura restituisce un report incompleto per il client

**Riferimenti:** `supabase/schema.sql:2303–2304`, `:2368`; `src/features/orders/Cassa.tsx:318–329`; `src/features/orders/orderUtils.ts:94`.

La prima chiusura restituisce anche gli ordini; il report salvato li esclude intenzionalmente. La seconda chiamata restituisce direttamente quel report senza ricostruirli. Il client chiama sempre `report.orders.map` durante l'esportazione.

**Riprodotto:** `REPEATED_CLOSE_HAS_ORDERS: false`. Una seconda cassa o un retry dopo risposta persa può quindi provocare un errore JavaScript anziché scaricare il CSV. Il pulsante separato di download usa una RPC che ricostruisce gli ordini, quindi esiste un percorso di recupero.

**Correzione:** garantire lo stesso contratto della risposta in tutte le chiamate; riutilizzare la ricostruzione del report e stabilizzare anche la rappresentazione di ordini abbandonati e chiusi.

### 12. P2 — I collaudi automatici non coprono il flusso attuale

**Riferimenti:** `.github/workflows/deploy.yml`; `scripts/stress/orders.mjs:241–244`; `supabase/tests/push_notifications.sql`.

La CI esegue test frontend e build, ma non applica schema/migrazioni, non verifica le policy né compila e collauda la Edge Function. Il runner stress chiama ancora `claim_order` e `pay_claimed_order`: non prova le nuove RPC per postazioni, ritiri parziali e annullamento consegne. I test push SQL non vengono eseguiti dal workflow.

**Correzione:** test backend su database temporaneo nella CI, matrice anon/pending/staff/cassa/cucina/bar/admin, migrazione da zero e upgrade, casi 1–6 e 11, concorrenza tra pagamenti/ritiri/chiusura. Aggiungere un controllo Deno con lockfile. Evitare stress test sul servizio cloud gratuito di produzione.

## Altre debolezze da pianificare

- **Dipendenza vulnerabile di sviluppo:** aggiornare `nanoid` almeno a 3.3.18 mediante un aggiornamento compatibile del lockfile. Il registro la classifica high per un possibile ciclo infinito nei generatori custom a dimensione zero; PostCSS qui usa `nanoid/non-secure` con dimensione 6. Non ho individuato un percorso di sfruttamento nell'app pubblicata. [Advisory GHSA-2v37-7h3g-55p8](https://github.com/advisories/GHSA-2v37-7h3g-55p8).
- **CSV e PDF:** `csvCell` fa escaping sintattico ma non neutralizza formule che iniziano con `=`, `+`, `-` o `@` nei nomi di eventi/prodotti controllati dagli operatori. Il PDF non aggiunge pagine o va a capo sui nomi prodotto: carrelli lunghi possono perdere righe visibili. Servono escaping per fogli di calcolo e impaginazione con limite pagina.
- **Connettività:** il service worker gestisce push, non cache offline. Ordini, cassa e cucina dipendono dalla rete e da Supabase. Prevedere menu/programma statici disponibili offline e una procedura manuale; non accettare silenziosamente ordini offline senza un sistema di riconciliazione.
- **Accessibilità:** il componente Modal ha semantica dialog, ma non sposta/intrappola/ripristina il focus; la tastiera può raggiungere il contenuto dietro una conferma. Da completare insieme al collaudo dei dispositivi reali.
- **Account e privilegi:** la RLS protegge il backend, ma una password staff compromessa resta sufficiente per le azioni del ruolo. Valutare TOTP per admin e ruoli critici, account individuali, revoca a fine evento. Signup pubblico, MFA, SMTP e criteri password effettivi richiedono una verifica delle impostazioni cloud, non deducibili da `config.toml`.
- **Riservatezza e terze parti:** non risulta una pagina informativa dedicata nel frontend. Le note libere possono contenere informazioni più identificative dello pseudonimo. Font Google e widget Eventbrite sono dipendenze esterne; caricarli solo quando necessari o usare font locali/link esterni riduce richieste, manutenzione e superficie di fiducia. Il codice Instagram embed esiste ma la Home corrente usa un semplice link: non va confusa la presenza del file con un caricamento effettivo.
- **Hosting e isolamento:** la CSP è già presente e non permette script inline generici: è una protezione utile. Le sessioni e i QR sono nello storage dell'origine, condiviso tra percorsi dello stesso dominio GitHub Pages; un sottodominio dedicato all'app limita questa condivisione. Questo è hardening, non prova di una compromissione.

## Sostenibilità economica

### Servizi attuali e vincoli verificati

| Componente | Può costare zero? | Vincolo da gestire |
|---|---|---|
| React, Vite, QR e PDF locali | Sì | Aggiornamenti e test richiedono tempo, non servizi per singola operazione |
| GitHub Pages | Sì, repository pubblico su GitHub Free | 1 GB sito e 100 GB/mese di banda come limite soft; soprattutto idoneità d'uso |
| Supabase Free | Sì, entro quote | 500 MB database; 5 GB egress non cached; 200 connessioni Realtime; 2 milioni messaggi/mese; 500.000 invocazioni Edge/mese |
| Backup Supabase automatici | Non inclusi nel Free | Esportazioni proprie e prova di ripristino |
| Web Push | Nessun costo per messaggio introdotto da questo codice | Invio consuma CPU, durata ed egress della funzione; resta servizio accessorio |
| Eventbrite | Sì per biglietti gratuiti | I biglietti a pagamento hanno commissioni, anche se sostenute dal partecipante |
| Dominio personalizzato | Non necessario | Utilizzare il sottodominio gratuito del provider evita rinnovi |

Supabase Free sospende i progetti dopo una settimana di inattività; non include backup automatici e SLA di disponibilità. I 5 GB di cached egress non sono un ulteriore budget indistinto per le query del database. Fonti: [piani Supabase](https://supabase.com/pricing), [backup e opzioni per il Free](https://supabase.com/docs/guides/platform/backups).

**GitHub Pages merita una decisione prima dell'evento.** Le condizioni escludono siti principalmente destinati a facilitare transazioni commerciali e sconsigliano transazioni sensibili come l'invio di password. La webapp gestisce login, preordini e biglietteria: è un rischio di idoneità dell'hosting da chiarire, non una dichiarazione che GitHub abbia già stabilito una violazione per questo evento benefico. [Limiti e condizioni GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits).

Il widget Eventbrite non elimina le commissioni di biglietteria: gratuità dell'integrazione, costo per l'organizzatore e costo complessivo della transazione sono cose distinte. Se il vincolo è zero costi anche per il pubblico, usare biglietti gratuiti oppure un flusso senza pagamento online. [Commissioni ufficiali Eventbrite](https://www.eventbrite.it/help/it/articles/755615/quanto-costa-agli-organizzatori-utilizzare-eventbrite/).

### Dove il codice consuma risorse inutilmente

`TournamentPreview.tsx:15–48` scarica il tabellone completo ogni trenta secondi su ogni Home visibile. Non controlla se la sezione torneo sia effettivamente a schermo. Anche `TournamentBracket` usa polling. `OrderPage` aggiorna lo storico e `Fulfillment` rilegge code e consegne recenti sia su eventi sia ogni quindici secondi. Una coda può crescere negli ordini pagati anche se il limite dei non pagati è rispettato. Storico ordini, righe di evasione, consegne e snapshot non hanno una politica generale di eliminazione.

Esempio puramente dimensionale: **1.000 telefoni × 6 ore × 120 letture/ora = 720.000 risposte**. Se ciascuna trasferisse 8 kB contabilizzati, sarebbero circa **5,76 GB** per il solo torneo. Gli 8 kB sono un'ipotesi, non una misura del payload pubblicato. Anche payload inferiori non rendono gratuito il lavoro del database in termini di capacità.

Ridurre prima le richieste: polling solo per sezioni visibili e dati attivi, intervalli progressivi, revisione leggera prima del dettaglio, risposte compatte, raggruppamento dei refetch, limite delle code/storici. Per contenuti pubblici condivisi, una cache server/CDN con breve scadenza evita che tutti interroghino PostgreSQL per lo stesso dato. Non memorizzare in cache pubblica risposte con QR, note, alias o sessioni. Il cache locale di ogni telefono, da solo, non elimina il carico aggregato sul backend.

### Assetto consigliato senza canoni

1. Conservare React/Vite e Supabase Free: una riscrittura totale aggiungerebbe lavoro e rischio.
2. Valutare il frontend statico su **Cloudflare Pages Free**, con sottodominio gratuito dedicato. Le richieste agli asset statici sono gratuite e illimitate secondo il listino; le Functions hanno quote separate. Il piano Pages Free include 500 build al mese. Non ho creato account né avviato trasferimenti. Fonti: [prezzi](https://developers.cloudflare.com/pages/functions/pricing/), [limiti](https://developers.cloudflare.com/pages/platform/limits/).
3. Inserire Turnstile sul percorso pubblico di scrittura, mantenendo controlli applicativi e revoca delle RPC aggirabili. Non è necessario acquistare un WAF o un servizio Redis.
4. Tenere Realtime sui pochi dispositivi operativi, ottimizzare letture pubbliche e rendere notifiche/social opzionali quando le risorse scarseggiano.
5. Usare pagamenti in cassa, PDF generati localmente e nessun SMS o API AI: il flusso attuale non richiede servizi a consumo di questo tipo.
6. Esportare database/configurazione prima dell'evento, dopo cambiamenti sostanziali e a fine evento; conservare backup cifrati fuori dal repository pubblico. Provare il ripristino. Il solo CSV aggregato non ricostruisce utenti, permessi e intero stato operativo.
7. Restare esplicitamente nell'organizzazione Supabase Free, controllare quote e disponibilità prima dell'evento e definire una procedura manuale quando il servizio non è disponibile. Non usare un piano a pagamento con spend cap come sinonimo di costo zero: il canone resta dovuto.

Un cambio di dominio richiede aggiornamento di `vite.config.ts`, manifest, origini autorizzate push e configurazione Auth. Storage, sessioni e sottoscrizioni push sono legati all'origine: migrare tra eventi, non a evento aperto.

## Ordine di intervento

**Prima del prossimo uso operativo:** proteggere gli ordini pubblici, validare le iscrizioni push o sospenderle, eliminare il doppio flusso di RPC, correggere chiusura/annullamento e riapplicazione dello schema; fissare la conservazione dei dati e collaudare tutto sul backend isolato.

**Subito dopo:** recupero degli invii incerti, sincronizzazione casse, invio push a lotti, conflitti del torneo, report ripetibile, aggiornamento della dipendenza di sviluppo e CI backend.

**Prima dell'apertura al pubblico:** risolvere l'idoneità dell'hosting, misurare banda e tempi con volumi attesi, verificare impostazioni Auth e piano effettivo, ripristino backup e procedura senza connessione. Il numero di partecipanti, dispositivi operativi e ore di utilizzo effettive servirà per dimensionare le soglie: non è stato assunto come dato reale nell'audit.

## Ripetere le prove senza coinvolgere la produzione

Installazione temporanea fuori dal progetto e senza script di installazione:

```sh
npm install --prefix /private/tmp/lag-security-review --no-save --ignore-scripts --no-audit --no-fund @electric-sql/pglite@0.5.8
LAG_AUDIT_PGLITE_MODULE=/private/tmp/lag-security-review/node_modules/@electric-sql/pglite/dist/index.js node docs/audit-2026-09-05/reproduce.mjs
```

Eseguire il secondo comando dalla cartella `lag_app`. Il programma legge lo schema locale, crea solo dati sintetici in memoria e chiude il database alla fine. Le future correzioni possono cambiare intenzionalmente l'output o fermare le vecchie riproduzioni: i casi andranno convertiti in test di regressione con risultati attesi sicuri.
