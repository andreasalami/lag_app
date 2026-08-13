# Risultati stress test ordini — 13 agosto 2026

Ambiente isolato: Supabase CLI 2.114.0 su Docker Desktop, PostgreSQL Supabase
17.6.1.158 e Node.js 22.15.1. Nessuna richiesta è stata inviata alla
produzione.

## Difetti riprodotti prima della correzione

1. Un token claim `NULL` poteva sostituire un claim valido e autorizzare un
   pagamento.
2. In 3 round su 3, la chiusura concorrente ai pagamenti rendeva incoerenti
   scorte, stati e report. In un round: 26 pagamenti riusciti, scorta 29 invece
   di 4 e report con soli 3 ordini pagati.
3. Due ordini con lo stesso token QR venivano entrambi accettati.
4. Due invii con `client_request_id NULL` venivano entrambi accettati.

Queste prove costituiscono il controllo negativo: gli assert introdotti non
erano verdi sullo schema precedente.

## Correzioni verificate

- Tutte le RPC di claim rifiutano token nulli o malformati e confrontano gli
  hash senza la semantica SQL a tre valori.
- Le mutazioni rispettano l'ordine di lock
  `evento -> ordini -> prodotti`; la chiusura è una barriera esclusiva.
- L'hash QR ha un indice univoco parziale.
- `client_request_id` è obbligatorio per gli ordini pubblici. Identità della
  richiesta e hash QR restano fino alla chiusura dell'evento, così anche un
  retry tardivo dopo pagamento e consegna non duplica l'ordine.

## Esecuzione completa dopo la correzione

- 200 letture simultanee dello stato: nessun errore; p95 215 ms.
- 25 retry simultanei: una riga e una sola riduzione scorta; p95 25 ms.
- Request ID riutilizzato con QR diverso: respinto.
- Retry identico dopo pagamento e consegna: respinto senza duplicazione.
- 50 richieste sull'ultima porzione: un successo, 49 `stock_unavailable`,
  scorta zero; p95 61 ms.
- 200 invii contro capienza 150: esattamente 150 accettati e 50
  `capacity_reached`; nessun ID o numero duplicato; p95 316 ms.
- Token claim `NULL`: respinto da tutte e sei le RPC provate, senza alterare il
  claim valido. Anche update, annullamento e pagamento di ordini mai claimati
  con un token casuale sono respinti.
- QR duplicato: un successo, un errore univocità, una sola riga e una sola
  porzione consumata.
- Request ID `NULL`: zero successi, zero righe e scorta invariata.
- 10 gare chiusura/pagamento da 30 ordini: zero incoerenze e zero deadlock;
  scorta, stati, ricavi e aggregati del report sempre concordi.

Esito finale del runner: 11 controlli superati, zero finding, exit code 0.
Lo schema è stato applicato due volte sullo stesso database senza errori.

## Profilo di saturazione locale

Con lo schema precedente, a 300 richieste simultanee il gateway Docker locale
aveva iniziato a chiudere alcune socket; a 500 invii il limite di 150 restava
comunque integro, ma 262 client perdevano la connessione. Questo dato misura lo
stack locale e non va interpretato direttamente come capienza di Supabase
cloud. La regressione automatica usa 200 concorrenti, livello rimasto stabile.

Al termine il runner ha eliminato ordini, prodotti e account fittizi e ha
ripristinato l'evento locale iniziale.
