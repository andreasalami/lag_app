# Risultati stress test — novembre 2026

Report visivo: [STRESS_TEST_REPORT_2026-11.html](STRESS_TEST_REPORT_2026-11.html).
Come rieseguire le prove: [STRESS_TEST.md](STRESS_TEST.md).

## In breve

- **Fatto:** gli ordini restano coerenti in tutte le prove, sia locali sia cloud, anche
  durante i blocchi.
- **Fatto:** sul piano Free, macchina Nano, il progetto di test si blocca dopo circa 7
  minuti al ritmo di una serata, per due volte su due. Con il risultato del torneo
  aperto da 2.500 telefoni in 30 secondi si blocca in circa 10 secondi.
- **Conclusione, confidenza media-alta:** il collo di bottiglia è la memoria della
  macchina Free, non una protezione per indirizzo IP. All'evento serve il Pro.
- **Non noto:** se basta la macchina Micro inclusa nel Pro, da 1 GB, o serve la Small,
  da 2 GB.
- Nessuna correzione applicata, come deciso da Andrea.

## Ambiente

- **Locale:** PostgreSQL 17 usa e getta, solo socket Unix, con `supabase/schema.sql` e
  Node.js 22.15.1. Prove del 3–4 novembre 2026.
- **Cloud:** progetto Supabase di test `lag-stress`, Free, Nano, Europa centrale, in
  un'organizzazione separata, con dati sintetici. Prove del 6 novembre 2026.
- **Produzione:** mai toccata in scrittura. La verifica in sola lettura non è stata
  fatta.
- **Traffico usato:** 100 MB dei 5 GB del progetto di test.
- **Limite delle prove cloud:** tutte le richieste partivano da un solo Mac.

## Prove cloud

| Prova | Carico | Esito | Richieste | 95° percentile |
|---|---|---|---:|---:|
| `baseline` | 30 dispositivi staff, 5 min | passa, 0 errori | 870 | 179 ms |
| `realtime-reconnect` | staff, 17 ordini/min, riconnessione a 30 s | passa, 0 errori | 3.476 | 211 ms |
| `open-burst` | 500 aperture in 60 s | passa, 0 errori | 2.810 | 126 ms |
| `evening`, prova 1 | 2.500 telefoni, 9 ordini/min | blocco dopo circa 7 min | 40.887 | 153 ms |
| `evening`, prova 2 | uguale | blocco a 7 min 35 s | 48.629 | 157 ms |
| `tournament-publish` | 2.500 letture in 30 s, più i controlli periodici | blocco dopo circa 10 s | 181 | — |

Il 95° percentile è misurato prima del blocco. Gli ordini sul cloud sono stati 152, con
zero incoerenze. Non sono stati eseguiti `ramp`, `worst` e `staff-edits`, perché
avrebbero solo riprodotto il blocco.

### Perché si blocca

Fonte: grafici e log del progetto di test letti dalla dashboard Supabase il
2026-11-07.

- **Gateway:** prima del blocco registra 100–130 richieste al secondo, con circa 20 ms
  di risposta dal progetto. Durante il blocco le poche richieste completate aspettano
  fino a 43 secondi la risposta del progetto (`x_envoy_upstream_service_time`).
  Non c'è nessun 429 o 5xx.
- **Memoria:** la Nano ha fino a 0,5 GB di RAM e lavorava con circa 500 MB di swap.
  Supabase segna l'impegno di memoria, 1,7 GB, come "SEVERE".
- **Disco:** subito dopo ogni blocco l'attesa sul disco (IOwait) sale al 60–72% nella
  serata e al 91% nel torneo.
- **CPU:** impegnata al 15–40% sotto carico.
- **Database:** le query delle API arrivano al massimo a circa 3 s, in media a 3–14 ms
  (`pg_stat_statements`).
- **Log:** durante il blocco non c'è nessun errore in Postgres, nel pooler o nel Realtime.

L'ipotesi iniziale era una protezione per indirizzo IP, perché tutte le richieste
partivano da un solo computer. È poco probabile: le richieste passavano il gateway e
aspettavano il progetto.

## Casi limite in locale

- **Ordini** (`edge-orders.mjs`): seed 101, 202, 303 e 404 più una ripetizione con seed
  777, per 456 round e 43.429 chiamate. Nessuna incoerenza con effetto operativo, nessun
  deadlock, nessuna deriva di scorta. Difetti lievi:
  - modalità di preparazione "dopo" su un ordine di sole bevande: la risposta non
    coincide con quanto salvato;
  - errori tecnici al posto di errori di business in 5 casi: postazione NULL alla presa
    in carico, id malformato o quantità enorme alla consegna, totale fuori scala
    all'ordine al banco, NULL in `update_order_event`.
- **Modifiche dello staff** (`edge-staff.mjs`): seed 1, 2 e 3 più una ripetizione con
  seed 7, per 5.766 chiamate. Aggiunta prodotto, prezzo e spostamento passano.

| Gravità | Difetto | Effetto all'evento |
|---|---|---|
| Grave | Prodotto eliminato mentre è in un ordine non pagato: `cancel_order_for_station` fallisce con `unknown_menu_item` | dopo 60 minuti `expire_unpaid_orders` va in errore, e con lei stato, catalogo, invio ordini e coda cassa, per tutti |
| Grave | Dopo la scadenza l'ordine bloccante non si può prendere in carico; l'unico sblocco è chiudere e riaprire l'evento | gli ordini pagati e non ritirati risultano consegnati |
| Medio | La sospensione (scorta 0) si annulla quando un ordine non pagato viene annullato o scade | il prodotto torna ordinabile |
| Medio | Menu e scaletta: due dispositivi su campi diversi si annullano a vicenda; la modifica di un elemento eliminato risponde ok | modifiche perse senza avviso |
| Medio | Torneo: circa il 74% dei salvataggi respinto con `save_conflict` a intervalli di 30, 10 e 2 s; dopo un'altra pubblicazione la UI mostra "in onda" | circa 3 modifiche su 4 perse seguendo l'invito a ricaricare |
| Medio | Deadlock 40P01 tra eliminazione e `apply_order_stock`: 12 su 960, circa l'1,3%, con coincidenza forzata | l'operazione va ripetuta |
| Lieve | Ruoli senza diritti sul menu ricevono ok senza modifiche; `unknown_menu_item` non mappato in `orderUtils.ts` | messaggi poco chiari |

Sospensione durante le vendite: la riuscita al primo tentativo vale circa
exp(−frequenza di vendita × tempo tra apertura e salvataggio). Per la birra più venduta,
circa 0,07 vendite al secondo, è del 70% circa con 5 s e del 12% circa con 30 s.

## Free o Pro

Valori dal sito Supabase, controllati il 2026-11-07.

| Voce | Free | Pro |
|---|---|---|
| Prezzo | 0 | 25 $ al mese, circa 26–27 € con IVA; tempo non usato restituito come credito se si disdice |
| Macchina | Nano, fino a 0,5 GB | 10 $ di crediti inclusi, pari a una Micro da 1 GB; Small da 2 GB a circa 15 $ al mese |
| Traffico in uscita | 5 GB | 250 GB |
| Connessioni in tempo reale | 200 | 500 |
| Log | 1 giorno | 7 giorni |
| Pausa per inattività | dopo 1 settimana | mai |

- **Traffico, stima:** circa 0,35 GB per ogni ora con 2.500 telefoni attivi, quindi fino
  a circa 4 GB per due serate da 6 ore. È un tetto alto.
- **Connessioni in tempo reale:** le usano solo i dispositivi dello staff, circa 21.

**Decisione aperta (Andrea):** passare `lag-stress` al Pro per un mese e ripetere
`evening` e `tournament-publish`, per scegliere tra Micro e Small.

## Cassa

- **Ipotesi:** 5 casse e circa 20 s per ordine, cioè circa 15 ordini al minuto.
- **Limite:** `max_pending_orders` vale 100 per default ed è modificabile da 10 a 1.000.
- **A 17 ordini al minuto** la coda cresce di circa 2 al minuto e regge.
- **A 50 ordini al minuto** si riempie in circa 3 minuti, poi i nuovi ordini ricevono
  `capacity_reached`.
- **Da verificare:** cronometrare i tempi di cassa a una prova generale.
