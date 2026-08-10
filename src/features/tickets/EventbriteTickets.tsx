import { EventbriteCheckoutButton } from "./EventbriteCheckoutButton";

/*
  NOTA ARCHITETTURALE (da tenere a mente):
  --------------------------------------------------------------------------
  L'API key privata di Eventbrite NON deve mai finire nel bundle frontend:
  quando vorremo mostrare dati reali (posti disponibili, prezzi live, ecc.)
  ci vorrà una funzione backend che fa da proxy verso l'API Eventbrite.
  Per ora il checkout vero e proprio passa dal widget ufficiale (pubblico,
  nessuna chiave richiesta) — vedi EventbriteCheckoutButton.tsx.

  Tier/fasce di prezzo rimossi su richiesta: non servono per il momento.
  Se torneranno utili, si possono ripescare dalla cronologia git.
*/
export function EventbriteTickets() {
  return (
    <section id="biglietti" className="mx-auto max-w-3xl px-4 py-10">
      <h2 className="mb-1 text-2xl font-semibold">Biglietti</h2>
      <p className="mb-6 text-sm text-[var(--text-secondary)]">
        Prenotazione via Eventbrite — nessuna cassa fisica il giorno dell'evento.
      </p>

      <EventbriteCheckoutButton />
    </section>
  );
}
