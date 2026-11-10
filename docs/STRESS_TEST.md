# Stress test degli ordini

Il runner `scripts/stress/orders.mjs` verifica le funzioni SQL degli ordini sotto
concorrenza reale: molte connessioni PostgreSQL in parallelo sugli stessi ordini,
scorte ed evento.

## Come funziona

1. Crea un cluster PostgreSQL in una cartella temporanea, raggiungibile solo via
   socket Unix: nessuna porta di rete aperta.
2. Installa i ruoli di Supabase (`anon`, `authenticated`, `service_role`),
   `auth.uid()`, pgcrypto e poi `supabase/schema.sql`.
3. Esegue gli scenari aprendo una connessione `psql` per ogni chiamata, con il
   ruolo che avrebbe nella realtà: browser (`anon`), gateway Turnstile
   (`service_role`) o cassa/admin autenticato.
4. Spegne il cluster e cancella la cartella, anche in caso di errore.

Non si collega mai a Supabase, quindi non può toccare la produzione e non servono
chiavi. Restano fuori il gateway Turnstile, PostgREST e la rete: quelle parti sono
coperte dai test delle Edge Function e dalle verifiche in `scripts/security/`.

## Requisiti ed esecuzione

Serve PostgreSQL (17 o successivo) installato in locale, per esempio con
`brew install postgresql@17`. Se i binari non sono nel `PATH`, indica la cartella
con `LOADTEST_PG_BIN`.

```sh
npm run stress:orders
```

Le opzioni stanno in `.env.stress.example`; copiale in `.env.stress.local` per
cambiarle. Per un solo scenario: `LOADTEST_SCENARIOS=capacity npm run stress:orders`.

## Scenari (valori predefiniti)

| Scenario | Cosa verifica |
|---|---|
| `read` | 200 letture concorrenti dello stato ordinazioni |
| `idempotency` | 25 invii simultanei della stessa richiesta creano un solo ordine; stesso request ID con QR diverso respinto; cassa, pagamento, consegna al bar e stato pubblico; un retry tardivo restituisce lo stesso ordine |
| `stock` | 50 concorrenti sull'ultima porzione: una sola vendita |
| `capacity` | 150 invii contro un limite di 100: esattamente 100 accettati, numeri unici, ordinazioni chiuse per capienza |
| `identities` | postazione o dispositivo non validi respinti; solo il dispositivo che ha preso in carico l'ordine può incassarlo o annullarlo; QR duplicato e request ID NULL respinti senza consumare scorte |
| `close-race` | 10 round da 30 ordini: chiusura evento e pagamenti in parallelo, in ordine alternato; stati, scorte e report coerenti, nessun deadlock |

I tempi riportati includono l'avvio di un processo `psql` per chiamata: servono a
confrontare due esecuzioni, non come latenza dell'app. Un finding produce exit
code `2`, distinto da un crash del runner.

## Casi limite (novembre 2026)

Stessa infrastruttura locale (`scripts/stress/lib.mjs`): nessuna rete e nessun Supabase.
Ogni scenario si ripete con tempi e intrecci casuali, e dopo ogni round controlla gli
invarianti degli ordini. Gli script non correggono nulla: elencano i difetti.

```sh
npm run stress:edge-orders
```

```sh
npm run stress:edge-staff
```

- `edge-orders.mjs`: casse concorrenti, claim che scadono, annullo contro scadenza,
  consegne, capienza cucina, chiusura evento durante tutto il resto, ordini al banco,
  idempotenza, limiti. Variabili: `LOADTEST_ROUNDS`, `LOADTEST_SEED`,
  `LOADTEST_SCENARIOS`, `LOADTEST_MAX_SECONDS`, `LOADTEST_JSON_OUT`.
- `edge-staff.mjs`: modifiche dello staff a menu, scorte, scaletta, torneo e permessi
  durante il servizio. Variabili: `LOADTEST_SCENARIOS`, `LOADTEST_SEED`,
  `LOADTEST_ROUNDS`, `LOADTEST_BUDGET_SECONDS`, `LOADTEST_REPORT`.

## Traffico reale su un progetto di test

`scripts/stress/traffic.mjs` simula 30 dispositivi dello staff e fino a 2.500 telefoni
contro un progetto Supabase **di test**. Rifiuta il progetto di produzione, resta sotto
le 190 richieste al secondo e si ferma al primo segnale di degrado: errori oltre l'1%
in 30 secondi, 95° percentile oltre 10 secondi, un 429 o un 503, budget di traffico
esaurito.

Richiede `.env.stress.local` con le quattro variabili `STRESS_*` di
`.env.stress.example`. I valori sono segreti: restano solo in quel file.

```sh
npm run stress:traffic -- check
```

```sh
npm run stress:traffic -- prepare-gateway
```

```sh
npm run stress:traffic -- setup
```

```sh
npm run stress:traffic -- run evening
```

- `check` verifica la configurazione senza fare richieste di carico.
- `prepare-gateway` prepara in `stress-results.local/gateway` la funzione
  `submit-order` di test (`scripts/stress/gateway/index.ts`), da pubblicare sul progetto
  di test con la Supabase CLI. Turnstile viene simulato con 150 ms di attesa.
- `setup` crea account, menu ed evento di prova nel progetto di test.
- Scenari di `run`: `baseline`, `evening`, `ramp`, `worst`, `open-burst`,
  `tournament-publish`, `realtime-reconnect`, `staff-edits`.

I risultati vanno in `stress-results.local/`, escluso da git. Il controllo automatico
delle regole di stop gira contro un server finto locale, senza rete:

```sh
node scripts/stress/traffic.selftest.mjs
```

Risultati di novembre 2026: [STRESS_TEST_RESULTS_2026-11-07.md](STRESS_TEST_RESULTS_2026-11-07.md).
