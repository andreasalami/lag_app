import { useEffect, useRef } from "react";
import { InstagramEmbed } from "./InstagramEmbed";

/*
  Post Instagram di default (embed ufficiale via embed.js): mostrano
  la card intera (header, foto, eventuale didascalia, link "Visualizza
  su Instagram"). Non possiamo ritagliare solo la foto — è dentro un
  iframe cross-origin, non stilizzabile dal nostro CSS — ma bordo e
  angoli del CONTENITORE restano coerenti col resto della home, quello
  lo controlliamo noi.

  Per aggiungere/togliere un post: aggiungi/rimuovi un permalink qui
  sotto. Corto e a rotazione: 3-6 post.
*/
const CURATED_POSTS: string[] = [
  "https://www.instagram.com/p/DZNBnbrjPns/",
  "https://www.instagram.com/p/DZKQ_OgDKUd/",
  "https://www.instagram.com/p/DYuNjU5jDtV/",
  "https://www.instagram.com/p/DWrDeL8DPET/",
  "https://www.instagram.com/p/DWi1z2cjMOa/",
];

const AUTO_SCROLL_INTERVAL_MS = 4000;

export function InstagramPosts() {
  const trackRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(false);

  // Auto-scroll orizzontale: avanza di uno "schermo" alla volta, torna
  // all'inizio quando arriva in fondo. In pausa mentre l'utente ci
  // passa sopra il mouse o lo tocca. Niente auto-scroll con animazioni
  // ridotte a livello di sistema.
  useEffect(() => {
    const track = trackRef.current;
    if (!track || CURATED_POSTS.length < 2) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const id = window.setInterval(() => {
      if (pausedRef.current) return;
      const atEnd = track.scrollLeft + track.clientWidth >= track.scrollWidth - 8;
      track.scrollTo({
        left: atEnd ? 0 : track.scrollLeft + track.clientWidth * 0.8,
        behavior: "smooth",
      });
    }, AUTO_SCROLL_INTERVAL_MS);

    return () => window.clearInterval(id);
  }, []);

  if (CURATED_POSTS.length === 0) {
    return (
      <p className="mt-6 rounded-[var(--radius-md)] border border-dashed border-[var(--surface-border)] p-4 text-center text-sm text-[var(--text-secondary)]">
        Nessun post selezionato ancora — aggiungi un permalink in{" "}
        <code className="font-mono text-[var(--accent-primary)]">src/features/social/InstagramPosts.tsx</code>.
      </p>
    );
  }

  return (
    <div
      ref={trackRef}
      onPointerEnter={() => (pausedRef.current = true)}
      onPointerLeave={() => (pausedRef.current = false)}
      onTouchStart={() => (pausedRef.current = true)}
      onTouchEnd={() => (pausedRef.current = false)}
      className="mt-6 flex snap-x snap-mandatory gap-4 overflow-x-auto scroll-smooth pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {CURATED_POSTS.map((permalink) => (
        <div
          key={permalink}
          className="w-80 flex-shrink-0 snap-start overflow-hidden rounded-[var(--radius-lg)] border border-[var(--surface-border)] sm:w-96"
        >
          <InstagramEmbed url={permalink} />
        </div>
      ))}
    </div>
  );
}
