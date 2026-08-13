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
l'account del mittente. `tournament_manager` e `admin` possono inviare avvisi
del torneo; `staff` e `admin` inviano automaticamente la notifica quando
pubblicano un annuncio.

## 5. Collaudo

1. Aprire l'app su un telefono e attivare le notifiche.
2. Verificare nel pannello Torneo che il conteggio sia almeno 1.
3. Inviare un avviso di prova dal gestore del torneo.
4. Verificare ricezione e apertura diretta della sezione Torneo.
5. Pubblicare un annuncio di prova e verificare l'apertura di Annunci.

Su iOS la web app deve essere aggiunta alla schermata Home prima di concedere
il permesso. In caso di errore 404/410 dal servizio Push, la Edge Function
elimina automaticamente la sottoscrizione non più valida.
