# Configurazione Web Push

Il frontend registra una sottoscrizione anonima tramite Service Worker. La
tabella Supabase non è leggibile dai client; soltanto la Edge Function può
leggere gli endpoint e inviare il broadcast. Le chiavi private restano nei
segreti Supabase.

## 1. Generare una sola coppia VAPID

```bash
npm run push:keys
```

Conservare entrambi i valori. La chiave privata non deve essere inserita nel
repository, in GitHub Pages o in variabili `VITE_*`.

## 2. Aggiornare il database

Copiare tutto `supabase/schema.sql` nel Supabase SQL Editor ed eseguirlo. Lo
schema crea `push_subscriptions`, lo storico `push_broadcasts` e le RPC
pubbliche protette.

## 3. Configurare la build GitHub Pages

In GitHub, **Settings → Secrets and variables → Actions → Variables**, creare:

```text
VITE_WEB_PUSH_PUBLIC_KEY=<chiave pubblica generata>
```

La stessa chiave pubblica deve essere usata dalla Edge Function.

## 4. Configurare e distribuire la Edge Function

Impostare i segreti del progetto Supabase:

```bash
npx supabase secrets set \
  WEB_PUSH_VAPID_PUBLIC_KEY=<chiave-pubblica> \
  WEB_PUSH_VAPID_PRIVATE_KEY=<chiave-privata> \
  WEB_PUSH_VAPID_SUBJECT=mailto:<email-di-contatto> \
  PUSH_ALLOWED_ORIGINS=https://andreasalami.github.io
```

Quindi collegare il progetto e distribuire:

```bash
npx supabase link --project-ref <project-ref>
npx supabase functions deploy send-push-broadcast
```

Non usare `--no-verify-jwt`: il gateway e la funzione verificano entrambi
l'account del mittente. Solo `tournament_manager` e `admin` possono inviare
avvisi del torneo.

## Comportamento attuale

Concedere il permesso registra il telefono, ma non programma notifiche
automatiche. Al momento un avviso parte soltanto quando un gestore apre
**Gestione torneo** e preme **Invia avviso a tutti**. Il salvataggio di un
risultato o la fine di un turno non inviano ancora notifiche: quel flusso sarà
definito separatamente.

## 5. Collaudo

1. Su iPhone con iOS 16.4 o successivo, aggiungere il sito alla schermata Home
   da Safari e aprirlo dalla nuova icona.
2. Nella Home, aprire il Torneo e attivare le notifiche. Deve comparire subito
   la notifica locale di conferma.
3. Accedere come gestore e verificare che il conteggio dei dispositivi sia
   almeno 1.
4. Inviare un avviso di prova da **Gestione torneo** e verificare che il
   risultato riporti almeno un invio riuscito.
5. Mettere la web app in background e verificare ricezione e apertura diretta
   del riepilogo Torneo.

Se il permesso risulta concesso ma la conferma locale non compare, controllare
**Impostazioni → Notifiche → LAG**. Se la conferma compare ma il broadcast no,
controllare nell'ordine: conteggio iscritti, esito `inviati/non riusciti` del
pannello, deploy della Edge Function e corrispondenza esatta fra la chiave VAPID
pubblica della build e quella configurata nella funzione.

In caso di errore 404/410 dal servizio Push, la Edge Function elimina
automaticamente la sottoscrizione non più valida.
