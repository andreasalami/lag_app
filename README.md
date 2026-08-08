# LAG — L'Agro ai Giovani

App self-service per l'evento "L'Agro ai Giovani" (festival benefico a Cascina
Marasco, Cremona — ricavato devoluto ad Agropolis ONLUS). Obiettivo: zero
casse fisiche, tutto gestibile dal telefono.

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

Staff e gestione tornei sono due ruoli separati e non sovrapposti: chi
pubblica annunci/programma/menu non può toccare il torneo, e viceversa.

## Setup

```bash
npm install
cp .env.example .env.local
```

Poi compila `.env.local`:

1. **Supabase** — crea un progetto su [supabase.com](https://supabase.com),
   esegui `supabase/schema.sql` nell'SQL Editor, copia URL e anon key da
   Project Settings > API in `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`.
   Poi crea gli account staff/gestione-tornei da Authentication > Add user,
   e imposta il ruolo giusto sulla riga corrispondente nella tabella `profiles`.
   Gli account nuovi sono `pending` e non hanno permessi finché non vengono
   promossi manualmente. Disabilita anche il signup pubblico nelle impostazioni
   Supabase Auth.
   Per i test puoi assegnare `admin`: abilita tutte le sezioni dell’app. Non
   usare questo ruolo per account reali.
2. **Eventbrite** — quando l'evento esiste, incolla il suo Event ID in
   `VITE_EVENTBRITE_EVENT_ID`.
3. **Instagram** — l'handle è in `VITE_INSTAGRAM_HANDLE` (i permalink dei
   post da mostrare si aggiungono a mano in
   `src/features/social/InstagramPosts.tsx`).

```bash
npm run dev       # sviluppo, http://localhost:5173
npm run build     # build di produzione in dist/
```

## Limiti noti (onestamente)

- Le notifiche in Annunci chiedono solo il permesso del browser — le push
  vere ad app chiusa servono un Service Worker + backend, non ancora costruiti.
- Il tabellone del torneo vive in `useState` locale: non è ancora
  sincronizzato su Supabase, quindi non condiviso tra dispositivi diversi.
