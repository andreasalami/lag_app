import { useEffect, useState } from "react";
import { Button } from "../../components/ui/Button";

type PermissionState = "unsupported" | "default" | "granted" | "denied";

function getPermissionState(): PermissionState {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission as PermissionState;
}

/*
  Qui chiediamo SOLO il permesso del browser a mostrare notifiche.
  Le notifiche push vere — quelle che arrivano anche ad app chiusa —
  servono un Service Worker + Push API + un backend che le spedisce
  quando pubblichiamo un annuncio: è un pezzo a parte, più corposo,
  non ancora costruito. Questo componente prepara il terreno (il
  permesso va comunque chiesto per primo) e conferma subito che
  funziona mostrando una notifica locale di prova appena l'utente
  lo concede.
*/
export function NotificationPermission() {
  const [state, setState] = useState<PermissionState>("default");

  useEffect(() => {
    setState(getPermissionState());
  }, []);

  const requestPermission = async () => {
    if (!("Notification" in window)) return;
    const result = await Notification.requestPermission();
    setState(result as PermissionState);
    if (result === "granted") {
      new Notification("L'Agro ai Giovani", {
        body: "Notifiche attive: ti avviseremo sugli aggiornamenti importanti.",
      });
    }
  };

  if (state === "unsupported") {
    // Niente banner rotto sui browser che non supportano l'API.
    return null;
  }

  if (state === "granted") {
    return (
      <p className="mb-4 flex items-center gap-2 text-sm text-[var(--state-success)]">
        <span aria-hidden>✓</span> Notifiche attive
      </p>
    );
  }

  if (state === "denied") {
    return (
      <p className="mb-4 text-sm text-[var(--text-secondary)]">
        Notifiche bloccate dal browser — per riattivarle, controlla le impostazioni del sito.
      </p>
    );
  }

  return (
    <Button variant="primary" onClick={requestPermission} className="mb-4">
      Attiva notifiche
    </Button>
  );
}
