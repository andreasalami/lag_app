# Correzioni progressive — 5 settembre 2026

Questa revisione raccoglie il lavoro del branch `codex/order-usability-preview`,
autorizzato dall'utente per il push su `main`. Il push del codice non applica
automaticamente le migrazioni o le funzioni al Supabase remoto.
L'audit iniziale e i suoi risultati descrivono lo stato precedente alle correzioni.

## Stato delle criticità

| Rilievo | Intervento locale e limiti residui |
| --- | --- |
| Ordini anonimi abusabili | Massimo 25 per prodotto e 60 totali, dopo aggregazione; prenotazioni non pagate scadono a 60 minuti. Creazione riservata al gateway con verifica Turnstile server, hostname/action e token monouso. Tre nuovi ordini/minuto per chiave di recupero; retry già registrati esclusi. Una nuova chiave aggira il limite per chiave, ma richiede ancora una nuova verifica anti-bot. |
| Destinazioni push arbitrarie | Allowlist dei provider, chiavi validate, redirect vietati e timeout totale per invio. Registrazione riservata al gateway con prova Turnstile `push`; stato delle iscrizioni esistenti controllato in sola lettura tramite endpoint e segreto auth. |
| RPC obsolete | Revocati gli otto endpoint che aggiravano postazioni e quantità, anche per service_role. |
| Modifiche dopo chiusura | Lock evento prima dell'ordine; consegna, cancellazione e annullamento ritiro negati dopo chiusura definitiva. |
| Schema e migrazioni | Corretta riapplicazione, aggiunto bootstrap storico per database vuoto; catena completa e aggiornamento dalla base auditata provati in memoria. |
| Dati personali | Alias/note cancellati all'annullamento e dopo 5 minuti dalla consegna; letture staff ristrette. La pulizia è applicata alle letture, non da un processo a orario fisso. Restano conservazione a lungo termine e ordini pagati mai completati quando la chiusura manuale viene dimenticata. |
| Claim di cassa | Sincronizzazione compatta, scadenza locale, rinnovi controllati, blocco operazioni offline/con claim non valido e verifica al ritorno in primo piano. |
| Invio incerto e perdita QR | Richiesta persistita prima dell'invio, ID riutilizzato dopo errori, nessun nuovo ordine se lo storage fallisce. Chiave anonima per evento, server conserva solo hash, recupero paginato degli stessi QR e storico dopo chiusura. Vecchi ordini non associati alla chiave restano fuori dal nuovo recupero. |
| Push in massa | Lotti da 25, massimo 5 invii paralleli, avanzamento server e ripresa. Tentativi dall'esito incerto dopo interruzione non vengono reinviati automaticamente, evitando duplicati; possibile notifica non ricevuta. |
| Concorrenza torneo | Pubblicazione con revisione attesa, scritture dirette revocate, bozze per utente con export e conflitto esplicito. |
| Report chiusura | Stato precedente alla chiusura conservato; la ripetizione restituisce lo stesso report completo. |
| Test | Test frontend e SQL su migrazioni, ordini, ruoli, ritiri, report, recupero, push e capienza cucina; test Edge con richieste esterne simulate. CI aggiunge SQL e Deno. Non equivalgono a collaudo cloud o PostgreSQL con connessioni concorrenti reali. |

Ulteriori interventi: neutralizzazione formule nei CSV, impaginazione PDF lunga,
modali nativi con focus confinato e ripristinato, aggiornamento dipendenza di sviluppo.
Il torneo pubblico interroga solo la revisione e scarica i dati quando cambiano;
la scheda nella home sospende il polling quando è fuori schermo.

La scadenza a 60 minuti viene applicata alla successiva lettura di menu/stati/cassa
o invio ordine. Le scorte vengono liberate una volta sola prima di calcolare la
disponibilità. Gli ordini pagati non scadono; un claim di cassa valido protegge
l'ordine in lavorazione. Non occorre un cron.

Il limite predefinito delle prenotazioni non pagate è ora **100**, anche per i
nuovi eventi. La migrazione `20260905120000_pending_orders_limit_100.sql` imposta
100 sull'evento attuale ancora aperto senza cancellare eventuali ordini eccedenti:
blocca soltanto i nuovi invii fino al rientro nella soglia. I retry già registrati
rimangono recuperabili anche a capienza raggiunta. Questo limite non conta gli
ordini pagati in cucina, che hanno una soglia separata di 100.

## Preparazione immediata o differita

La migrazione `20260905130000_deferred_kitchen_orders.sql` aggiunge la scelta nel
riepilogo del cliente e la rende modificabile dalla cassa prima del pagamento.
Il cibo differito mantiene le scorte ma non compare nella coda attiva. Bevande e
ritiri parziali restano indipendenti. La scansione QR (o ricerca per numero per
gli ordini manuali) apre il riepilogo; un pulsante staff attiva tutto il cibo
residuo dell'ordine. Le quantità da consegnare restano selezionabili separatamente.

La soglia di cucina è **100 ordini**, non 100 porzioni. Include le prenotazioni
temporanee delle casse e gli ordini pagati attivi. Il posto è riservato quando
la cassa prende in carico un ordine immediato, prima di incassare, e resta valido
soltanto con il claim di cassa. Rilasciarlo o lasciarlo scadere libera il posto.
A cucina piena l'interfaccia impedisce il pagamento immediato e propone l'attesa
o la preparazione successiva concordata col cliente. Anche gli ordini manuali
sono sottoposti al controllo server; il pagamento esterno rimane un'operazione
manuale dell'addetto, non una transazione gestita dall'app.

Gli ordini dormienti attivati a cucina piena attendono senza duplicazioni. I posti
liberi vengono assegnati in ordine di attivazione, prima delle nuove ammissioni,
alle consegne successive o all'aggiornamento della coda. Un ordine libera il
posto quando tutto il suo cibo è consegnato, anche se restano bevande. Per questa
versione non c'è una fase separata «preparato ma non consegnato». Un annullamento
di consegna ripristina le quantità e, a capienza piena, rimette il cibo in attesa.
Gli ordini già attivi oltre soglia durante un aggiornamento vengono conservati:
non se ne ammettono altri finché si rientra sotto 100.

Le prove SQL verificano i cinque claim delle casse sugli ultimi cinque posti,
il rifiuto oltre soglia, la scelta differita, scorte invariate al pagamento e al
risveglio, accesso per ruolo, QR ripetuti, promozione delle attese, annullamenti,
scadenza dei claim e chiusura evento. Sono prove sequenziali su PostgreSQL in
memoria, non una misura di carico simultaneo dei 18 telefoni dello staff.

Verifica GitHub pre-push: `VITE_TURNSTILE_SITE_KEY` non è presente nelle variabili
del repository. Il controllo obbligatorio della build impedisce la pubblicazione
del nuovo frontend finché manca la configurazione; non va aggirato inserendo una
chiave di test. Non è stata verificata né modificata la configurazione Supabase
remota. Un push del codice non applica le migrazioni né distribuisce le Edge Functions.

## Configurazione necessaria prima della pubblicazione

1. Creare un widget Cloudflare Turnstile **Managed**, autorizzando i domini del sito.
   Configurare `VITE_TURNSTILE_SITE_KEY` nel frontend e nelle variabili GitHub Actions.
2. Nei secret Supabase impostare `TURNSTILE_SECRET_KEY` e `ORDER_ALLOWED_ORIGINS`:
   origini HTTPS esatte, separate da virgola, senza slash finale o percorso.
   Esempio: `https://associazione.github.io,https://www.esempio.it`.
   Le chiavi private restano soltanto nei secret server; mai in variabili `VITE_*`.
3. Preparare le funzioni `submit-order` e `register-push` con `verify_jwt = false`:
   la prova anti-bot viene verificata nel loro codice. `send-push-broadcast` resta
   autenticata e controlla il ruolo. Applicare le migrazioni con ordine cronologico
   durante una finestra di manutenzione, coordinando funzioni, database e frontend.
   Le revoche interrompono intenzionalmente i vecchi frontend.
4. Prima del remoto: esportazione di backup e prova di ripristino su copia, verifica
   delle configurazioni auth/RLS/secret reali e collaudo dei flussi su staging.

Il bootstrap `20260801000000_initial_schema.sql` è destinato alla catena di un
**database vuoto**. Per un database esistente va prima riconciliata la cronologia
con lo schema effettivamente installato: non applicare alla cieca tutto lo storico.
Non sono stati aggiunti servizi a pagamento. Turnstile offre un piano gratuito
con verifiche illimitate e può essere usato senza spostare l'hosting su Cloudflare:
[documentazione ufficiale](https://developers.cloudflare.com/turnstile/plans/), verificata il 5 settembre 2026.
Restano i limiti di invocazioni, traffico e storage dell'infrastruttura esistente;
un attacco può consumare quote anche quando le richieste vengono respinte.

## Verifiche riproducibili

Installare PGlite 0.5.8 in una directory temporanea e impostare
`LAG_AUDIT_PGLITE_MODULE` sul relativo `dist/index.js`. Poi:

```sh
node scripts/security/verify-migrations.mjs
node scripts/security/verify-public-orders.mjs
node scripts/security/verify-workflow-safety.mjs
node scripts/security/verify-push.mjs
node scripts/security/verify-recovery.mjs
node scripts/security/verify-kitchen-capacity.mjs
node docs/anteprime-ordini/verify-partial-pickup.mjs
npm test
npm run build
deno test --frozen --allow-env --config supabase/functions/submit-order/deno.json supabase/functions/submit-order/index.deno.ts
```

I test SQL di creazione rappresentano il gateway autorizzato tramite service_role;
verificano separatamente il rifiuto delle chiamate anon/authenticated. Non usano
chiavi reali né inviano notifiche o ordini remoti. Le chiamate HTTP del test Edge
sono simulate; prove reali Turnstile e Web Push su dispositivi restano necessarie.

## Ancora da chiudere

- Aggiornare il vecchio runner stress e fare prove di gara fra connessioni PostgreSQL
  indipendenti; il runner precedente usa API ritirate ed è disabilitato.
- Collaudare su dispositivi reali cassa, ripristino dello storage, accessibilità
  tastiera dei modali, PDF lunghi, Turnstile e push (incluso iOS).
- Definire conservazione/archiviazione e pulizia degli invii push conclusi e dello
  storico remoto, senza eliminare dati recuperabili in modo inatteso.
- Verificare hosting, configurazione remota, quote effettive e ripristino backup.
- Completare informativa e dati organizzativi, oltre alla procedura operativa offline.

Anteprima locale dei componenti reali, con soli dati dimostrativi:
`http://127.0.0.1:5173/anteprima.html?vista=salvataggio`.

Anteprima interattiva della scelta e dell'attivazione con dati dimostrativi:
`http://127.0.0.1:5173/anteprima.html?vista=preparazione`.
