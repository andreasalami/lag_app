import { useEffect, useId, useState } from "react";
import { Button } from "../../components/ui/Button";
import { loadScriptOnce } from "../../lib/browser";

declare global {
  interface Window {
    EBWidgets?: {
      createWidget: (options: {
        widgetType: "checkout";
        eventId: string;
        iframeContainerId: string;
        iframeContainerHeight?: number;
        onOrderComplete?: () => void;
      }) => void;
    };
  }
}

const WIDGET_SCRIPT_SRC = "https://www.eventbrite.com/static/widgets/eb_widgets.js";
const EVENT_ID = import.meta.env.VITE_EVENTBRITE_EVENT_ID;

/*
  Integrazione biglietti Eventbrite — UN SOLO STEP quando l'evento esiste:
  1. Crea l'evento su Eventbrite
  2. Copia l'Event ID (il numero nell'URL dell'evento)
  3. Mettilo in .env.local: VITE_EVENTBRITE_EVENT_ID=1234567890123
  Il bottone apre il widget di checkout UFFICIALE di Eventbrite (modale
  in-pagina, no redirect): è pubblico, non serve nessuna API key né backend.

  Senza Event ID la sezione Biglietti non esiste: spariscono anche i link
  in Navbar e TabBar. Se lo script di Eventbrite non si carica, la sezione
  si nasconde da sola invece di mostrare un bottone che non funziona.

  L'API key privata di Eventbrite NON deve mai finire nel bundle frontend:
  dati live (posti, prezzi) richiederanno una funzione backend che faccia da proxy.
*/
export const TICKETS_ENABLED = Boolean(EVENT_ID);

export function EventbriteTickets() {
  const [scriptReady, setScriptReady] = useState(false);
  const [scriptError, setScriptError] = useState(false);
  const containerId = `eventbrite-widget-container-${useId().replace(/:/g, "")}`;

  useEffect(() => {
    if (!EVENT_ID) return;
    let cancelled = false;
    loadScriptOnce(WIDGET_SCRIPT_SRC, () => Boolean(window.EBWidgets))
      .then(() => {
        if (!cancelled) setScriptReady(true);
      })
      .catch(() => {
        if (!cancelled) setScriptError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!EVENT_ID || scriptError) return null;

  const openCheckout = () => {
    window.EBWidgets?.createWidget({
      widgetType: "checkout",
      eventId: EVENT_ID,
      iframeContainerId: containerId,
      iframeContainerHeight: 425,
    });
  };

  return (
    <section id="biglietti" className="mx-auto max-w-3xl px-4 py-10">
      <h2 className="mb-1 text-2xl font-semibold">Biglietti</h2>
      <p className="mb-6 text-sm text-(--text-secondary)">
        Prenotazione via Eventbrite — nessuna cassa fisica il giorno dell'evento.
      </p>
      <Button variant="primary" onClick={openCheckout} disabled={!scriptReady}>
        Acquista su Eventbrite
      </Button>
      {/* Punto di aggancio per il modale del widget — Eventbrite lo popola lui */}
      <div id={containerId} />
    </section>
  );
}
