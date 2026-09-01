import { useEffect, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import {
  isPushSupported,
  subscribeToPushNotifications,
  syncExistingPushSubscription,
} from "../../lib/pushNotifications";

type PermissionState = "unsupported" | "default" | "granted" | "denied";
type MobilePlatform = "ios" | "android";

function getPermissionState(): PermissionState {
  if (typeof window === "undefined" || !isPushSupported()) return "unsupported";
  return Notification.permission as PermissionState;
}

function isStandaloneWebApp() {
  const iosStandalone = "standalone" in navigator
    && (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return window.matchMedia("(display-mode: standalone)").matches || iosStandalone;
}

function activationErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("push_not_configured")) return "Notifiche non ancora configurate sul sito.";
  if (message.includes("push_unsupported")) return "Questo browser non supporta le notifiche Web Push.";
  return "Attivazione non riuscita. Controlla la connessione e riprova.";
}

export function NotificationPermission() {
  const [state, setState] = useState<PermissionState>("default");
  const [subscribed, setSubscribed] = useState(false);
  const [open, setOpen] = useState(false);
  const [platform, setPlatform] = useState<MobilePlatform | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [activationError, setActivationError] = useState<string | null>(null);
  const [testFeedback, setTestFeedback] = useState<string | null>(null);
  const standalone = typeof window !== "undefined" && isStandaloneWebApp();

  useEffect(() => {
    let cancelled = false;

    async function refreshSubscription() {
      const permission = getPermissionState();
      if (cancelled) return;
      setState(permission);
      if (permission !== "granted") {
        setSubscribed(false);
        return;
      }
      try {
        const active = await syncExistingPushSubscription();
        if (!cancelled) setSubscribed(active);
      } catch {
        if (!cancelled) setSubscribed(false);
      }
    }

    void refreshSubscription();
    const handleChange = () => void refreshSubscription();
    window.addEventListener("lag:push-subscription-changed", handleChange);
    return () => {
      cancelled = true;
      window.removeEventListener("lag:push-subscription-changed", handleChange);
    };
  }, []);

  function openInstructions() {
    setActivationError(null);
    setPlatform(null);
    setOpen(true);
  }

  async function activateNotifications() {
    if (!isPushSupported()) {
      setState("unsupported");
      setActivationError("Questo browser non supporta le notifiche Web Push.");
      return;
    }
    setRequesting(true);
    setActivationError(null);
    try {
      let permission = Notification.permission;
      if (permission !== "granted") permission = await Notification.requestPermission();
      setState(permission as PermissionState);
      if (permission !== "granted") return;

      const registration = await subscribeToPushNotifications();
      setSubscribed(true);
      setOpen(false);
      try {
        await registration.showNotification("L'Agro ai Giovani", {
          body: "Notifiche del torneo attive su questo dispositivo.",
          icon: `${import.meta.env.BASE_URL}apple-touch-icon.png`,
          data: { url: `${window.location.origin}${import.meta.env.BASE_URL}#tornei` },
        });
      } catch {
        // L'iscrizione e' gia attiva: la notifica di conferma non deve annullare il flusso.
      }
    } catch (error) {
      setActivationError(activationErrorMessage(error));
    } finally {
      setRequesting(false);
    }
  }

  async function triggerDeviceTest() {
    setActivationError(null);
    setTestFeedback(null);
    try {
      const registration = await navigator.serviceWorker.ready;
      await registration.showNotification("Test notifiche Torneo LAG", {
        body: "Se leggi questo messaggio, le notifiche sono abilitate correttamente su questo dispositivo.",
        icon: `${import.meta.env.BASE_URL}apple-touch-icon.png`,
        tag: `lag-device-test-${Date.now()}`,
        data: { url: `${window.location.origin}${import.meta.env.BASE_URL}#tornei` },
      });
      setTestFeedback("Notifica di prova attivata su questo dispositivo.");
    } catch (error) {
      setActivationError(activationErrorMessage(error));
    }
  }

  const buttonLabel = state === "granted"
    ? "Completa attivazione"
    : "Attiva notifiche del torneo";

  return (
    <>
      {state === "granted" && subscribed ? (
        <div className="mb-4 flex flex-col items-start gap-2">
          <p className="flex items-center gap-2 text-sm text-[var(--state-success)]"><span aria-hidden>✓</span> Notifiche attive su questo dispositivo</p>
          <Button variant="ghost" onClick={() => void triggerDeviceTest()} className="w-full justify-start sm:w-64">Prova notifica su questo dispositivo</Button>
          {testFeedback && <p className="text-xs text-[var(--state-success)]">{testFeedback}</p>}
          {activationError && <p className="text-xs text-[var(--state-error)]">{activationError}</p>}
        </div>
      ) : state === "denied" ? (
        <div className="mb-3 flex flex-col items-start gap-3">
          <p className="text-sm text-[var(--text-secondary)]">
            Notifiche bloccate dal browser — riattivale nelle impostazioni del sito.
          </p>
          <Button variant="ghost" onClick={openInstructions} className="w-full justify-start sm:w-64">Vedi istruzioni</Button>
        </div>
      ) : (
        <div className="mb-3">
          <Button variant="primary" onClick={openInstructions} className="w-full justify-start sm:w-64">{buttonLabel}</Button>
          {activationError && <p className="mt-2 text-xs text-[var(--state-error)]">{activationError}</p>}
        </div>
      )}

      <Modal
        open={open}
        title="Come ricevere le notifiche"
        dismissible
        onClose={() => setOpen(false)}
        actions={(
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>Chiudi</Button>
            {platform === "android" && state !== "denied" && (
              <Button onClick={() => void activateNotifications()} disabled={requesting || state === "unsupported"}>
                {requesting ? "Attendo…" : "Continua e attiva"}
              </Button>
            )}
            {platform === "ios" && standalone && state !== "denied" && (
              <Button onClick={() => void activateNotifications()} disabled={requesting || state === "unsupported"}>
                {requesting ? "Attendo…" : "Attiva notifiche"}
              </Button>
            )}
          </>
        )}
      >
        <p>Scegli il sistema del tuo telefono. Vedrai soltanto i passaggi che ti servono.</p>
        <p className="mt-2 text-xs text-[var(--text-secondary)]">
          Dopo l’attivazione gli avvisi possono arrivare anche con il sito in background; il telefono deve essere online e le notifiche di sistema devono restare abilitate.
        </p>

        <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <button
            type="button"
            aria-pressed={platform === "ios"}
            onClick={() => setPlatform("ios")}
            className={`rounded-[var(--radius-md)] border px-4 py-3 text-sm font-semibold transition-colors ${
              platform === "ios"
                ? "border-[var(--accent-primary)] text-[var(--accent-primary)]"
                : "border-[var(--surface-border)] text-[var(--text-primary)] hover:bg-white/5"
            }`}
          >
            Istruzioni per iOS
          </button>
          <button
            type="button"
            aria-pressed={platform === "android"}
            onClick={() => setPlatform("android")}
            className={`rounded-[var(--radius-md)] border px-4 py-3 text-sm font-semibold transition-colors ${
              platform === "android"
                ? "border-[var(--accent-primary)] text-[var(--accent-primary)]"
                : "border-[var(--surface-border)] text-[var(--text-primary)] hover:bg-white/5"
            }`}
          >
            Istruzioni per Android
          </button>
        </div>

        {platform === "ios" && (
          <div className="mt-4 rounded-[var(--radius-md)] border border-[var(--surface-border)] p-4">
            <p className="font-semibold text-[var(--text-primary)]">Su iPhone</p>
            <ol className="mt-2 list-decimal space-y-2 pl-5">
              <li>Verifica di avere iOS 16.4 o successivo, poi apri questo sito con Safari.</li>
              <li>Tocca <strong>Condividi</strong> e poi <strong>Aggiungi alla schermata Home</strong>.</li>
              <li>Chiudi Safari e apri L&apos;Agro ai Giovani dalla nuova icona nella schermata Home.</li>
              <li>Torna al Torneo, premi di nuovo “Attiva notifiche” e scegli <strong>Consenti</strong>.</li>
            </ol>
            {state === "denied" && (
              <p className="mt-3 text-xs text-[var(--state-warning)]">
                Il permesso è bloccato: apri <strong>Impostazioni → Notifiche → LAG</strong> e attiva “Consenti notifiche”.
              </p>
            )}
            {!standalone && (
              <p className="mt-3 text-xs text-[var(--state-warning)]">
                Sei ancora nel browser: completa i passaggi e riapri il sito dalla schermata Home.
              </p>
            )}
          </div>
        )}

        {platform === "android" && (
          <div className="mt-4 rounded-[var(--radius-md)] border border-[var(--surface-border)] p-4">
            <p className="font-semibold text-[var(--text-primary)]">Su Android</p>
            <ol className="mt-2 list-decimal space-y-2 pl-5">
              <li>Apri il sito con Chrome o con il browser che usi normalmente.</li>
              <li>Premi <strong>Continua e attiva</strong> qui sotto.</li>
              <li>Quando Android chiede il permesso, scegli <strong>Consenti</strong>.</li>
              <li>Lascia abilitate le notifiche per questo sito sia nel browser sia nelle impostazioni Android.</li>
            </ol>
            {state === "denied" && (
              <p className="mt-3 text-xs text-[var(--state-warning)]">
                Il permesso è bloccato: nelle impostazioni di Chrome apri <strong>Impostazioni sito → Notifiche</strong> e riabilita questo sito.
              </p>
            )}
            {state === "unsupported" && (
              <p className="mt-3 text-xs text-[var(--state-warning)]">
                Questo browser non supporta Web Push: aggiorna Chrome oppure prova con un altro browser.
              </p>
            )}
          </div>
        )}

        {activationError && <p className="mt-3 text-xs text-[var(--state-error)]">{activationError}</p>}
      </Modal>
    </>
  );
}
