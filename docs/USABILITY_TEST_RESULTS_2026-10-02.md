# Test di usabilità — 2 ottobre 2026

Branch provato: `feat/event-management-and-cleanup` (PR #6). Schermo telefono 375×812, più qualche
controllo a larghezza desktop.

## Ambienti

- **Locale con finto Supabase**: il nuovo codice collegato a un simulatore in memoria (fuori dalla
  repo), con account di prova per ruolo e la chiave di prova pubblica di Cloudflare Turnstile.
  Gli errori del server sono simulati con nomi d'ordine speciali.
- **Sito pubblicato, sola lettura**: `https://andreasalami.github.io/lag_app/` (versione su `main`,
  quindi senza le modifiche della PR). Nessun ordine inviato, nessun login, nessuna notifica attivata.
- **Anteprime** `anteprima.html` per il ritiro parziale.

## Problema trovato e corretto durante i test

- **PDF situazione incassi bloccato nel browser.** Il grafico orario riempiva tutte le ore tra la prima
  e l'ultima vendita: un orario anomalo generava centinaia di migliaia di colonne e il PDF non si
  creava; un weekend avrebbe mostrato tutte le ore del giorno come colonne vuote. Ora si riempiono solo
  buchi fino a 3 ore e ogni serata riparte con il giorno ("ven", "sab"); anche la frase sull'ora di
  punta indica la serata. Commit `1a216e6`, con test.

## Comportamenti inattesi ancora aperti

| # | Gravità | Dove | Cosa succede |
|---|---|---|---|
| 1 | Alta | Programma (sito pubblicato) | Due eventi sullo stesso palco alla stessa ora si coprono a vicenda. Venerdì, Stage 1, 00:30–02:00: "Centokili" è completamente nascosto da "Feet DJ". O è un errore di dati, o la griglia deve affiancare i riquadri; la gestione scaletta non avvisa delle sovrapposizioni. |
| 2 | Media | Ordine cliente | Se una richiesta resta in sospeso (rete caduta durante l'invio), la pagina mostra solo "Ritroviamo il tuo ordine" con "Recupera ordine": non c'è modo di tornare indietro né di aprire il QR degli ordini già creati, che serve in cassa. |
| 3 | Media-bassa | Link di recupero | Con un codice di recupero non valido la schermata ha solo il pulsante che fallisce: nessun collegamento per tornare al sito o agli ordini. |
| 4 | Media-bassa | Gestione evento (telefono) | Dopo "Salva orari e limite" il messaggio compare in cima alla pagina, fuori schermo: chi ha premuto il pulsante non vede la conferma né l'errore. |
| 5 | Bassa | Editor torneo | Un nome squadra vuoto è accettato e pubblicabile. |
| 6 | Bassa | Nome dell'ordine | "-trattino" viene rifiutato perché il nome deve iniziare con lettera o numero, ma il messaggio non lo dice. |
| 7 | Bassa | Testi | "1 totali", "1 ordini trovati", "1 ordini da gestire": manca il singolare. |
| 8 | Bassa | Bar | Il sottotitolo parla di "cibo ordinato dall'attivazione"; le note pensate per la cucina (es. "Senza cipolla") compaiono anche alla postazione birre. |
| 9 | Bassa | Conferma ordine | "Verifica di sicurezza in corso…" appare sopra il testo e lo sposta; mentre la verifica è in corso "Conferma e ordina" è disattivato senza una spiegazione vicino al pulsante. |
| 10 | Bassa | Cucina e Bar | "Annulla consegna" agisce al primo tocco, senza conferma. |
| 11 | Bassa | Menu mobile | Lo sfondo scuro del menu non copre la barra in basso, che resta cliccabile. |

## Verificato e funzionante

- Nessuno scorrimento orizzontale a 375px (Home, ordini, area staff, sito pubblicato).
- Indirizzi anomali (`#%E0%A4%A`, sezioni inesistenti) portano alla Home senza errori.
- Pagine riservate: senza login o con il ruolo sbagliato mostrano "accesso riservato"; un account
  cucina non vede né apre la Gestione evento.
- Menu mobile: Esc chiude e riporta il focus sul pulsante.
- Carrello: blocco sulle porzioni disponibili con avviso sul prodotto, limiti di 25 pezzi per
  prodotto e 60 in totale con messaggio visibile.
- Nome dell'ordine: rifiuta vuoto, un carattere, emoji e codice HTML; accetta lettere accentate.
- Invio, QR, storico, proposta del PDF cliente; errori `event_changed`, `order_total_too_high` e
  `request_id_conflict` mostrano un messaggio chiaro e non lasciano richieste bloccate.
- Cassa: postazione memorizzata dopo il ricaricamento, "Sblocca" e ordine in cassa con conferma,
  incasso con posto in cucina riservato.
- Cucina e Bar: postazione memorizzata, ritiro parziale, annullamento della consegna, coda per postazione.
- Ritiro parziale (anteprima): "+" disattivato al massimo, quantità mai oltre il rimanente.
- Gestione evento: date vuote, chiusura prima dell'apertura, limite fuori intervallo o decimale e nome
  vuoto vengono rifiutati con un messaggio; la chiusura definitiva si abilita solo con `CHIUDI EVENTO`
  esatto; il PDF si scarica.
- Torneo: testo "Max 20 caratteri" nei campi vuoti, avviso e salvataggio bloccato oltre 20, ripescaggio
  con avviso ed Esc che annulla; il tabellone pubblicato si aggiorna per il pubblico.
- Scanner QR: si apre come finestra modale e si chiude con Esc.

## Non coperto

- Fotocamera (bloccata nel pannello di prova): lo scanner è verificato solo come finestra e messaggio di errore.
- Notifiche push, embed Instagram e widget Eventbrite.
- Supabase, Edge Function e Turnstile reali: il simulatore riproduce le risposte, non le regole del database
  (queste sono coperte dalle verifiche PGlite in `scripts/security/`).
- Sul sito pubblicato le ordinazioni erano chiuse: il carrello reale non è stato provato lì.
