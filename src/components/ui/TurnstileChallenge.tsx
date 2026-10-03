import { useEffect, useRef, useState } from "react";
import { loadScriptOnce } from "../../lib/browser";

type Turnstile = {
  render: (node: HTMLElement, options: Record<string, unknown>) => string;
  remove: (id: string) => void;
};
declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const UNAVAILABLE = "Verifica non disponibile. Controlla la connessione e riprova.";

export function TurnstileChallenge({
  onToken,
  action = "order",
}: {
  onToken: (token: string) => void;
  action?: "order" | "push";
}) {
  const node = useRef<HTMLDivElement>(null);
  const callback = useRef(onToken);
  callback.current = onToken;
  const [message, setMessage] = useState("Verifica di sicurezza in corso…");
  const [retry, setRetry] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let widget: string | undefined;
    callback.current("");
    const key = import.meta.env.VITE_TURNSTILE_SITE_KEY;
    if (!key) {
      setMessage(
        action === "order"
          ? "Le ordinazioni online non sono ancora configurate. Rivolgiti alla cassa."
          : "Le notifiche non sono ancora configurate.",
      );
      return;
    }
    const fail = (text: string) => {
      if (cancelled) return;
      callback.current("");
      setMessage(text);
      setFailed(true);
    };
    setFailed(false);
    setMessage("Verifica di sicurezza in corso…");
    void loadScriptOnce(TURNSTILE_SRC, () => Boolean(window.turnstile))
      .then(() => {
        if (cancelled || !node.current || !window.turnstile) return;
        widget = window.turnstile.render(node.current, {
          sitekey: key,
          action,
          theme: "dark",
          size: "flexible",
          appearance: "interaction-only",
          callback: (token: string) => {
            if (cancelled) return;
            callback.current(token);
            setMessage("");
            setFailed(false);
          },
          "expired-callback": () => fail("Verifica scaduta. Riprova."),
          "error-callback": () => fail(UNAVAILABLE),
        });
      })
      .catch(() => fail(UNAVAILABLE));
    return () => {
      cancelled = true;
      if (widget !== undefined) window.turnstile?.remove(widget);
      callback.current("");
    };
  }, [retry, action]);

  return (
    <div className="mt-4">
      <div ref={node} />
      <p role="status" className="text-sm text-[var(--text-secondary)]">
        {message}
      </p>
      {failed && (
        <button type="button" className="mt-2 underline" onClick={() => setRetry((value) => value + 1)}>
          Riprova verifica
        </button>
      )}
    </div>
  );
}
