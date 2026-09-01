import { useEffect, useRef, useState } from "react";
import { InstagramEmbed } from "./InstagramEmbed";

/*
  Post curati a mano, stessi permalink di prima — solo la presentazione
  cambia: da riga scorrevole a mazzo di carte sovrapposte, swipe a
  sinistra per andare avanti, a destra per tornare indietro.

  Perché un overlay trasparente sopra ogni carta: l'embed Instagram è
  un iframe cross-origin, e un iframe NON inoltra gli eventi di
  puntamento al documento che lo contiene — se attacchi il drag
  direttamente sul wrapper, appena il dito/mouse è sopra l'iframe lo
  swipe si blocca. L'overlay cattura sempre lui il gesto, sopra tutto.
  Come bonus: un tap secco (senza trascinamento) sull'overlay apre il
  post vero su Instagram, altrimenti l'embed sotto sarebbe irraggiungibile.
  L'overlay è montato SOLO sulla carta in cima: le carte dietro devono
  restare visibili ma non devono intercettare gesti.

  Tutte le carte visibili nel mazzo (non solo quella in cima) montano
  l'embed vero: quando fai swipe la prossima è già pronta, non c'è un
  buco vuoto sotto. La key di ogni carta è l'indice del post (idx), non
  la sua posizione nel mazzo: così quando una carta viene promossa da
  "dietro" a "in cima" resta lo STESSO nodo React/DOM, non viene
  smontata e rimontata da capo (niente ricaricamento, niente flash).
  Le carte che escono dalla finestra visibile (VISIBLE_DEPTH) vengono
  smontate per davvero — l'iframe non resta a consumare risorse quando
  non è a portata di swipe.

  La carta mostra soltanto il viewport quadrato del contenuto: header,
  didascalia e CTA dell'embed restano fuori dalla maschera. È il
  compromesso necessario per uniformare embed di dimensione variabile,
  il cui DOM interno è fuori dal nostro controllo.
*/
const CURATED_POSTS: string[] = [
  "https://www.instagram.com/p/DZNBnbrjPns/",
  "https://www.instagram.com/p/DZKQ_OgDKUd/",
  "https://www.instagram.com/p/DWrDeL8DPET/",
  "https://www.instagram.com/p/DWi1z2cjMOa/",
  "https://www.instagram.com/p/DY9S5ZNMktl/",
  "https://www.instagram.com/p/DYUemPXjB46/",
  "https://www.instagram.com/p/DWrDeL8DPET/",
  "https://www.instagram.com/p/C6x-hghIBZN/",
  "https://www.instagram.com/p/C6vs2QWIpYb/",
  "https://www.instagram.com/p/CicrKc7Ih-U/?img_index=1",
];

const VISIBLE_DEPTH = 3;
const SWIPE_THRESHOLD = 80;
const TAP_THRESHOLD = 6;

export function InstagramPosts() {
  const [current, setCurrent] = useState(0);
  const cardRef = useRef<HTMLDivElement>(null);
  const dragStartX = useRef(0);
  const dragging = useRef(false);
  const animationTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (animationTimer.current !== null) window.clearTimeout(animationTimer.current);
  }, []);

  const total = CURATED_POSTS.length;

  if (total === 0) {
    return (
      <p className="mt-6 rounded-[var(--radius-md)] border border-dashed border-[var(--surface-border)] p-4 text-center text-sm text-[var(--text-secondary)]">
        Nessun post selezionato ancora — aggiungi un permalink in{" "}
        <code className="font-mono text-[var(--accent-primary)]">src/features/social/InstagramPosts.tsx</code>.
      </p>
    );
  }

  function goNext() {
    setCurrent((c) => (c + 1) % total);
  }
  function goPrev() {
    setCurrent((c) => (c - 1 + total) % total);
  }

  function snapBack() {
    const el = cardRef.current;
    if (!el) return;
    el.style.transition = "transform 0.25s ease";
    el.style.transform = "translateX(0) rotate(0deg)";
  }

  function handlePointerDown(e: React.PointerEvent) {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = true;
    dragStartX.current = e.clientX;
    const el = cardRef.current;
    if (el) el.style.transition = "none";
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!dragging.current) return;
    const el = cardRef.current;
    if (!el) return;
    const deltaX = e.clientX - dragStartX.current;
    el.style.transform = `translateX(${deltaX}px) rotate(${deltaX / 14}deg)`;
  }

  function handlePointerUp(e: React.PointerEvent) {
    if (!dragging.current) return;
    dragging.current = false;

    const deltaX = e.clientX - dragStartX.current;
    const el = cardRef.current;

    if (Math.abs(deltaX) < TAP_THRESHOLD) {
      window.open(CURATED_POSTS[current], "_blank", "noopener,noreferrer");
      snapBack();
      return;
    }

    if (Math.abs(deltaX) > SWIPE_THRESHOLD) {
      const goingNext = deltaX < 0; // swipe a sinistra = avanti
      if (el) {
        el.style.transition = "transform 0.22s ease";
        el.style.transform = `translateX(${goingNext ? -600 : 600}px) rotate(${goingNext ? -25 : 25}deg)`;
      }
      animationTimer.current = window.setTimeout(() => {
        if (goingNext) goNext();
        else goPrev();
        if (el) {
          el.style.transition = "none";
          el.style.transform = "translateX(0) rotate(0deg)";
        }
      }, 200);
    } else {
      snapBack();
    }
  }

  function handlePointerCancel() {
    dragging.current = false;
    snapBack();
  }

  const depthCount = Math.min(VISIBLE_DEPTH, total);

  return (
    <div className="mt-6">
      <div className="relative isolate mx-auto aspect-square w-full max-w-[300px]">
        {Array.from({ length: depthCount }, (_, d) => depthCount - 1 - d).map((depth) => {
          const idx = (current + depth) % total;
          const isTop = depth === 0;
          const rotation = isTop ? 0 : (depth % 2 === 0 ? 1 : -1) * (4 + depth * 2);

          return (
            <div
              key={idx}
              ref={isTop ? cardRef : undefined}
              className="surface-solid absolute inset-0 overflow-hidden rounded-[var(--radius-lg)]"
              style={{
                zIndex: depthCount - depth,
                transform: `translateY(${depth * 10}px) scale(${1 - depth * 0.06}) rotate(${rotation}deg)`,
                opacity: isTop ? 1 : 0.85 - depth * 0.2,
              }}
            >
              {/* L'header bianco con profilo e CTA appartiene all'iframe
                  cross-origin di Instagram e non è stilizzabile. Lo spostiamo
                  sotto il bordo superiore della carta: il viewport quadrato
                  mostra così soltanto il contenuto visuale del post. */}
              <div className="-translate-y-[54px]">
                <InstagramEmbed url={CURATED_POSTS[idx]} />
              </div>
              {isTop && (
                <div
                  className="absolute inset-0 cursor-grab touch-none active:cursor-grabbing"
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerCancel={handlePointerCancel}
                />
              )}
            </div>
          );
        })}
      </div>

      <p className="mt-3 text-center text-xs text-[var(--text-secondary)]">
        Scorri la carta per esplorare gli altri post
      </p>

      <div className="mt-2 flex items-center justify-center gap-4">
        <button
          type="button"
          onClick={goPrev}
          aria-label="Post precedente"
          className="flex h-8 w-8 items-center justify-center rounded-full border border-[var(--surface-border)] text-[var(--text-secondary)] hover:text-[var(--accent-primary)]"
        >
          ‹
        </button>
        <span className="font-mono text-xs text-[var(--text-secondary)]">
          {current + 1} / {total}
        </span>
        <button
          type="button"
          onClick={goNext}
          aria-label="Post successivo"
          className="flex h-8 w-8 items-center justify-center rounded-full border border-[var(--surface-border)] text-[var(--text-secondary)] hover:text-[var(--accent-primary)]"
        >
          ›
        </button>
      </div>
    </div>
  );
}
