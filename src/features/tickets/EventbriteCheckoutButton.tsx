import { useEffect, useId, useState } from "react";
import { Button } from "../../components/ui/Button";

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
let eventbriteScriptPromise: Promise<void> | null = null;

function loadEventbriteScript(): Promise<void> {
  if (window.EBWidgets) return Promise.resolve();
  if (eventbriteScriptPromise) return eventbriteScriptPromise;

  eventbriteScriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${WIDGET_SCRIPT_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Widget Eventbrite non disponibile")));
      return;
    }
    const script = document.createElement("script");
    script.src = WIDGET_SCRIPT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Widget Eventbrite non disponibile"));
    document.body.appendChild(script);
  });
  return eventbriteScriptPromise;
}

/*
  Integrazione biglietti Eventbrite — UN SOLO STEP quando l'evento esiste:
  1. Crea l'evento su Eventbrite
  2. Copia l'Event ID (il numero nell'URL dell'evento)
  3. Mettilo in .env.local: VITE_EVENTBRITE_EVENT_ID=1234567890123
  Nessun'altra modifica al codice. Il bottone apre il widget di checkout
  UFFICIALE di Eventbrite (modale in-pagina, no redirect) — è pubblico,
  non serve nessuna API key né backend per questa parte.

  Finché VITE_EVENTBRITE_EVENT_ID non è impostato, il bottone resta
  disabilitato con un messaggio onesto invece di fingere che funzioni:
  un bottone che non fa nulla quando ci clicchi è un bug silenzioso,
  uno disattivato con una spiegazione è solo... vero.
*/
export function EventbriteCheckoutButton({ label = "Acquista su Eventbrite" }: { label?: string }) {
  const [scriptReady, setScriptReady] = useState(false);
  const [scriptError, setScriptError] = useState(false);
  const reactId = useId().replace(/:/g, "");
  const containerId = `eventbrite-widget-container-${reactId}`;

  useEffect(() => {
    if (!EVENT_ID) return;
    let cancelled = false;
    loadEventbriteScript().then(() => {
      if (!cancelled) setScriptReady(true);
    }).catch(() => {
      if (!cancelled) setScriptError(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!EVENT_ID) {
    return (
      <Button variant="primary" disabled title="Evento non ancora pubblicato su Eventbrite">
        Biglietti in arrivo
      </Button>
    );
  }

  const openCheckout = () => {
    window.EBWidgets?.createWidget({
      widgetType: "checkout",
      eventId: EVENT_ID,
      iframeContainerId: containerId,
      iframeContainerHeight: 425,
    });
  };

  return (
    <>
      <Button variant="primary" onClick={openCheckout} disabled={!scriptReady || scriptError}>
        {scriptError ? "Biglietti non disponibili" : label}
      </Button>
      {/* Punto di aggancio per il modale del widget — Eventbrite lo popola lui */}
      <div id={containerId} />
    </>
  );
}
