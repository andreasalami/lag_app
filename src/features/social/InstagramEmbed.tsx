import { useEffect } from "react";

declare global {
  interface Window {
    instgrm?: {
      Embeds: {
        process: () => void;
      };
    };
  }
}

const EMBED_SCRIPT_SRC = "https://www.instagram.com/embed.js";

function loadInstagramScript(): Promise<void> {
  return new Promise((resolve) => {
    if (window.instgrm) {
      resolve();
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${EMBED_SCRIPT_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve());
      return;
    }
    const script = document.createElement("script");
    script.src = EMBED_SCRIPT_SRC;
    script.async = true;
    script.onload = () => resolve();
    document.body.appendChild(script);
  });
}

interface InstagramEmbedProps {
  url: string;
}

/**
 * Embed ufficiale di un post Instagram — niente Graph API, niente token,
 * niente backend: basta l'URL pubblico del post (oEmbed via embed.js).
 *
 * Lo script Instagram si carica UNA sola volta per pagina (vedi
 * loadInstagramScript). Ma React monta il blockquote DOPO che lo script
 * ha già fatto la sua scansione iniziale del DOM, quindi il processing
 * automatico da solo non basta: ad ogni mount richiamiamo esplicitamente
 * instgrm.Embeds.process(). Se dimentichi questo pezzo, vedi solo il
 * blockquote grezzo (il link di fallback) invece dell'embed vero.
 */
export function InstagramEmbed({ url }: InstagramEmbedProps) {
  useEffect(() => {
    let cancelled = false;
    loadInstagramScript().then(() => {
      if (!cancelled) {
        window.instgrm?.Embeds.process();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  return (
    <blockquote
      className="instagram-media w-full overflow-hidden rounded-[var(--radius-lg)]"
      data-instgrm-permalink={url}
      data-instgrm-version="14"
      style={{ background: "#FFF", margin: 0 }}
    >
      <a href={url} target="_blank" rel="noreferrer">
        Visualizza post su Instagram
      </a>
    </blockquote>
  );
}
