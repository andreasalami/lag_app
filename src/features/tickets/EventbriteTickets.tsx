import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";

/*
  NOTA ARCHITETTURALE (da tenere a mente, non ancora deciso in via definitiva):
  --------------------------------------------------------------------------
  L'API key Eventbrite NON deve mai finire nel bundle frontend: va tenuta
  su un backend leggero (es. una funzione serverless) che fa da proxy verso
  https://www.eventbriteapi.com/v3/events/{event_id}/ticket_classes/ e
  restituisce al client solo i dati necessari (nome tipo biglietto, prezzo,
  disponibilità). Qui sotto un placeholder statico: quando avremo il
  backend pronto, questo componente farà una fetch verso /api/tickets
  invece di leggere questo array.
*/
type TicketType = {
  id: string;
  name: string;
  price: string;
  note?: string;
};

const placeholderTickets: TicketType[] = [
  { id: "early-bird", name: "Early Bird", price: "€12", note: "Disponibilità limitata" },
  { id: "standard", name: "Standard", price: "€18" },
  { id: "sostenitore", name: "Sostenitore Agropolis", price: "€30", note: "Ricavato extra devoluto" },
];

export function EventbriteTickets() {
  return (
    <section id="biglietti" className="mx-auto max-w-3xl px-4 py-10">
      <h2 className="mb-1 text-2xl font-semibold">Biglietti</h2>
      <p className="mb-6 text-sm text-[var(--text-secondary)]">
        Prenotazione via Eventbrite — nessuna cassa fisica il giorno dell'evento.
      </p>

      <div className="grid gap-4 sm:grid-cols-3">
        {placeholderTickets.map((t) => (
          <Card key={t.id} className="flex flex-col justify-between">
            <div>
              <h3 className="font-display text-lg">{t.name}</h3>
              {t.note && <p className="mt-1 text-xs text-[var(--accent-gold)]">{t.note}</p>}
            </div>
            <p className="mt-4 font-mono text-2xl text-[var(--text-primary)]">{t.price}</p>
          </Card>
        ))}
      </div>

      <div className="mt-6">
        <Button variant="primary">Acquista su Eventbrite</Button>
      </div>
    </section>
  );
}
