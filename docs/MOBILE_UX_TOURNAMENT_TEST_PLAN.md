# Piano di collaudo — UX mobile e torneo

Questo aggiornamento cambia navigazione, layout del Programma, accesso staff e
flusso Torneo. Va quindi validato sul branch prima del merge in `main`.

## Controlli automatici

- `npm test`: logica tabellone, turno corrente, ordine cronologico dei
  risultati, ordini, orari e Web Push.
- `npm run build`: controllo TypeScript e build Vite di produzione.
- Obiettivo: 100% dei test e build verdi prima di ogni push del branch.

## Matrice responsive

| Vista | Larghezza | Controlli principali |
|---|---:|---|
| iPhone piccolo | 320 px | nessun overflow pagina/Programma; tab bar leggibile |
| iPhone standard | 390 px | menu mobile, calendario a due palchi, anteprima torneo |
| iPhone grande | 430 px | stessi controlli, spaziatura e target touch |
| Desktop | 1280 px | navbar completa, login Staff in alto, CTA mobile nascosta |

## Percorsi critici

1. Aprire il menu in alto a destra, verificare il riepilogo ordini e tornare
   al Programma; il menu deve chiudersi e il Programma arrivare a inizio vista.
2. Usare la tab bar inferiore: la quarta voce deve essere **Menu**, senza alcun
   riferimento ad Annunci.
3. Scorrere il Programma verticalmente: non deve essere possibile trascinare
   la pagina o la griglia in orizzontale.
4. In Home, verificare turno corrente, ultime cinque partite e link al
   tabellone completo; il tabellone può scorrere solo nel proprio riquadro.
5. Da anonimo, aprire direttamente `#gestione-torneo`: deve comparire la
   schermata di accesso riservato.
6. Da `tournament_manager` o `admin`, inserire più risultati in ordine diverso,
   salvarli e verificare che la Home mostri i cinque più recenti per orario di
   inserimento.
7. Verificare che il bottone **Gestisci il torneo** compaia in Home soltanto a
   `tournament_manager` e `admin`.

## Web Push su iOS reale

Questo controllo richiede un iPhone e la build pubblicata in HTTPS.

1. Rimuovere una vecchia installazione LAG dalla Home, reinstallarla da Safari
   e aprirla dall'icona.
2. Attivare le notifiche dal Torneo e verificare la conferma locale.
3. Controllare in Gestione torneo che gli iscritti aumentino.
4. Inviare un broadcast manuale con la web app in background.
5. Verificare consegna, apertura sul riepilogo Torneo e conteggi inviati/falliti.

Il permesso da solo non genera avvisi: oggi soltanto il broadcast manuale li
invia. L'automazione alla fine del turno è intenzionalmente fuori da questo
aggiornamento.

## Stato del collaudo locale

- Test automatici: superati (22/22).
- Build di produzione: superata.
- Browser: superati i controlli anonimi a 320, 390, 430 e 1280 px.
- Da completare prima del merge: percorso autenticato con account di test e
  prova Web Push su iPhone con Edge Function e chiavi VAPID di produzione.
