import { useEffect, useRef, useState } from "react";

type Turnstile = { render: (node: HTMLElement, options: Record<string, unknown>) => string; remove: (id: string) => void };
declare global { interface Window { turnstile?: Turnstile } }
let loader: Promise<Turnstile> | undefined;
function loadWidget() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  return loader ??= new Promise<Turnstile>((resolve, reject) => {
    const script = document.createElement("script");
    const timer = window.setTimeout(() => fail(), 15000);
    const fail = () => { clearTimeout(timer); script.remove(); loader = undefined; reject(new Error("challenge_unavailable")); };
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = () => { clearTimeout(timer); if (window.turnstile) resolve(window.turnstile); else fail(); };
    script.onerror = fail;
    document.head.append(script);
  });
}

export function TurnstileChallenge({ onToken, action = "order" }: { onToken: (token: string) => void; action?: "order" | "push" }) {
  const node = useRef<HTMLDivElement>(null);
  const callback = useRef(onToken);
  callback.current = onToken;
  const [message, setMessage] = useState("Verifica di sicurezza in corso…");
  const [retry, setRetry] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let widget: string | undefined;
    let api: Turnstile | undefined;
    callback.current("");
    const key = import.meta.env.VITE_TURNSTILE_SITE_KEY;
    if (!key) { setMessage(action === "order" ? "Le ordinazioni online non sono ancora configurate. Rivolgiti alla cassa." : "Le notifiche non sono ancora configurate."); return; }
    setFailed(false);
    setMessage("Verifica di sicurezza in corso…");
    void loadWidget().then((loaded) => {
      if (cancelled || !node.current) return;
      api = loaded;
      widget = loaded.render(node.current, {
        sitekey: key, action, theme: "dark", size: "flexible", appearance: "interaction-only",
        callback: (token: string) => { if (!cancelled) { callback.current(token); setMessage(""); setFailed(false); } },
        "expired-callback": () => { if (!cancelled) { callback.current(""); setMessage("Verifica scaduta. Riprova."); setFailed(true); } },
        "error-callback": () => { if (!cancelled) { callback.current(""); setMessage("Verifica non disponibile. Controlla la connessione e riprova."); setFailed(true); } },
      });
    }).catch(() => { if (!cancelled) { setMessage("Verifica non disponibile. Controlla la connessione e riprova."); setFailed(true); } });
    return () => { cancelled = true; if (widget !== undefined) api?.remove(widget); callback.current(""); };
  }, [retry, action]);
  return <div className="mt-4"><div ref={node}/><p role="status" className="text-sm text-[var(--text-secondary)]">{message}</p>{failed && <button type="button" className="mt-2 underline" onClick={() => setRetry(value => value + 1)}>Riprova verifica</button>}</div>;
}
