import { useEffect, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";

type PermissionState = "unsupported" | "default" | "granted" | "denied";
type MobilePlatform = "ios" | "android";

type NotificationPermissionProps = {
  context?: "announcements" | "tournament";
};

function getPermissionState(): PermissionState {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission as PermissionState;
}

function isStandaloneWebApp() {
  const iosStandalone = "standalone" in navigator
    && (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return window.matchMedia("(display-mode: standalone)").matches || iosStandalone;
}

async function showPermissionConfirmation(body: string) {
  const registration = "serviceWorker" in navigator
    ? await navigator.serviceWorker.getRegistration()
    : undefined;
  if (registration) {
    await registration.showNotification("L'Agro ai Giovani", {
      body,
      icon: `${import.meta.env.BASE_URL}apple-touch-icon.png`,
    });
    return;
  }

  try {
    new Notification("L'Agro ai Giovani", { body });
  } catch {
    // Quasi tutti i browser mobili richiedono il Service Worker per mostrare
    // una notifica persistente. Il permesso resta comunque correttamente dato.
  }
}

export function NotificationPermission({ context = "announcements" }: NotificationPermissionProps) {
  const [state, setState] = useState<PermissionState>("default");
  const [open, setOpen] = useState(false);
  const [platform, setPlatform] = useState<MobilePlatform | null>(null);
  const [requesting, setRequesting] = useState(false);
  const standalone = typeof window !== "undefined" && isStandaloneWebApp();
  const isTournament = context === "tournament";

  useEffect(() => {
    setState(getPermissionState());
  }, []);

  function openInstructions() {
    setPlatform(null);
    setOpen(true);
  }

  async function requestPermission() {
    if (!("Notification" in window)) {
      setState("unsupported");
      return;
    }
    setRequesting(true);
    try {
      const result = await Notification.requestPermission();
      setState(result as PermissionState);
      if (result === "granted") {
        await showPermissionConfirmation(
          isTournament
            ? "Notifiche del torneo consentite su questo dispositivo."
            : "Notifiche degli aggiornamenti consentite su questo dispositivo.",
        );
        setOpen(false);
      }
    } catch {
      setState("unsupported");
    } finally {
      setRequesting(false);
    }
  }

  const buttonLabel = isTournament ? "Attiva notifiche del torneo" : "Attiva notifiche";

  return (
    <>
      {state === "granted" ? (
        <p className="mb-4 flex items-center gap-2 text-sm text-[var(--state-success)]">
          <span aria-hidden>✓</span> Notifiche consentite su questo dispositivo
        </p>
      ) : state === "denied" ? (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <p className="text-sm text-[var(--text-secondary)]">
            Notifiche bloccate dal browser — riattivale nelle impostazioni del sito.
          </p>
          <Button variant="ghost" onClick={openInstructions}>Vedi istruzioni</Button>
        </div>
      ) : (
        <Button variant="primary" onClick={openInstructions} className="mb-4">
          {buttonLabel}
        </Button>
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
              <Button onClick={() => void requestPermission()} disabled={requesting || state === "unsupported"}>
                {requesting ? "Attendo…" : "Continua e consenti"}
              </Button>
            )}
            {platform === "ios" && standalone && state !== "denied" && (
              <Button onClick={() => void requestPermission()} disabled={requesting || state === "unsupported"}>
                {requesting ? "Attendo…" : "Consenti notifiche"}
              </Button>
            )}
          </>
        )}
      >
        <p>
          Scegli il sistema del tuo telefono. Vedrai soltanto i passaggi che ti servono.
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
              <li>Apri questo sito con Safari.</li>
              <li>Tocca <strong>Condividi</strong> e poi <strong>Aggiungi alla schermata Home</strong>.</li>
              <li>Chiudi Safari e apri L&apos;Agro ai Giovani dalla nuova icona nella schermata Home.</li>
              <li>Torna alla sezione Torneo, premi di nuovo “Attiva notifiche” e scegli <strong>Consenti</strong>.</li>
            </ol>
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
              <li>Premi <strong>Continua e consenti</strong> qui sotto.</li>
              <li>Quando Android chiede il permesso, scegli <strong>Consenti</strong>.</li>
              <li>Lascia abilitate le notifiche per questo sito nelle impostazioni del browser.</li>
            </ol>
            {state === "unsupported" && (
              <p className="mt-3 text-xs text-[var(--state-warning)]">
                Questo browser non supporta le notifiche: aggiorna Chrome oppure prova con un altro browser.
              </p>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}
