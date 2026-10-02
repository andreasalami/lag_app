import { useEffect } from "react";
import { loadScriptOnce } from "../../lib/browser";

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

interface InstagramEmbedProps {
  url: string;
}

/**
 * Embed ufficiale di un post Instagram — niente Graph API, niente token,
 * niente backend: basta l'URL pubblico del post (oEmbed via embed.js).
 *
 * Lo script Instagram si carica UNA sola volta per pagina (vedi
 * loadScriptOnce). Ma React monta il blockquote DOPO che lo script
 * ha già fatto la sua scansione iniziale del DOM, quindi il processing
 * automatico da solo non basta: ad ogni mount richiamiamo esplicitamente
 * instgrm.Embeds.process(). Se dimentichi questo pezzo, vedi solo il
 * blockquote grezzo (il link di fallback) invece dell'embed vero.
 */
export function InstagramEmbed({ url }: InstagramEmbedProps) {
  useEffect(() => {
    let cancelled = false;
    loadScriptOnce(EMBED_SCRIPT_SRC, () => Boolean(window.instgrm)).then(() => {
      if (!cancelled) {
        window.instgrm?.Embeds.process();
      }
    }).catch(() => {
      // Il link nel blockquote resta un fallback pienamente utilizzabile.
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  return (
    <blockquote
      className="instagram-media w-full"
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
