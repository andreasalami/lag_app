import { useRef, useState, type PointerEvent } from "react";
import { flushSync } from "react-dom";
import { appHref } from "../../lib/browser";

/*
  Post curati a mano, mostrati come mazzo di carte: swipe a sinistra per andare
  avanti, a destra per tornare indietro, tocco per aprire il post su Instagram.

  Le carte sono immagini statiche in public/instagram/ (l'anteprima pubblica di
  ogni post), non più gli embed ufficiali: un iframe Instagram pesa più di un
  megabyte e veniva creato solo quando la carta arrivava in cima, quindi le carte
  sotto erano vuote. Ora tutte le carte stanno sempre nel DOM e le immagini (circa
  30 KB l'una) partono insieme quando la sezione si avvicina allo schermo.

  Per aggiungere un post: salva la sua immagine come public/instagram/<codice>.jpg
  e aggiungi il codice (la parte dopo /p/ nel link) a CURATED_POSTS.

  Ogni carta ha due livelli: l'esterno prende la posizione nel mazzo (gestita da
  React), l'interno segue il dito (gestito direttamente sul DOM, senza render a
  ogni movimento). Così le due trasformazioni non si sovrascrivono.
*/
const CURATED_POSTS = [
  "DZNBnbrjPns",
  "DZKQ_OgDKUd",
  "DWrDeL8DPET",
  "DWi1z2cjMOa",
  "DY9S5ZNMktl",
  "DYUemPXjB46",
  "CrRPN_gLWt-",
  "ChjnmW-LSUy",
];

const VISIBLE_DEPTH = 3;
const SWIPE_THRESHOLD = 70;
const TAP_THRESHOLD = 6;
const FLY_OUT_MS = 220;

const postUrl = (code: string) => `https://www.instagram.com/p/${code}/`;

function deckStyle(depth: number) {
  const hidden = depth >= VISIBLE_DEPTH;
  const d = Math.min(depth, VISIBLE_DEPTH);
  const rotation = depth === 0 ? 0 : (depth % 2 === 0 ? 1 : -1) * (3 + d * 1.5);
  return {
    zIndex: CURATED_POSTS.length - depth,
    opacity: hidden ? 0 : 1 - depth * 0.12,
    transform: `translateY(${d * 16}px) scale(${1 - d * 0.05}) rotate(${rotation}deg)`,
    // Le carte nascoste si riposizionano senza animazione: non devono attraversare il mazzo.
    transition: hidden ? "none" : "transform 0.35s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.35s ease",
  };
}

export function InstagramPosts() {
  const [current, setCurrent] = useState(0);
  const topCard = useRef<HTMLAnchorElement>(null);
  const drag = useRef({ active: false, startX: 0, moved: false, animating: false });
  const total = CURATED_POSTS.length;

  function go(step: 1 | -1) {
    setCurrent((c) => (c + step + total) % total);
  }

  function setOffset(x: number, transition: string) {
    const el = topCard.current;
    if (!el) return;
    el.style.transition = transition;
    el.style.transform = x ? `translateX(${x}px) rotate(${x / 16}deg)` : "";
  }

  function handlePointerDown(e: PointerEvent<HTMLAnchorElement>) {
    if (drag.current.animating) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { active: true, startX: e.clientX, moved: false, animating: false };
    setOffset(0, "none");
  }

  function handlePointerMove(e: PointerEvent<HTMLAnchorElement>) {
    if (!drag.current.active) return;
    const deltaX = e.clientX - drag.current.startX;
    if (Math.abs(deltaX) >= TAP_THRESHOLD) drag.current.moved = true;
    setOffset(deltaX, "none");
  }

  function handlePointerUp(e: PointerEvent<HTMLAnchorElement>) {
    if (!drag.current.active) return;
    drag.current.active = false;
    const deltaX = e.clientX - drag.current.startX;
    if (Math.abs(deltaX) <= SWIPE_THRESHOLD) {
      setOffset(0, "transform 0.25s ease");
      return;
    }
    const step = deltaX < 0 ? 1 : -1; // swipe a sinistra = avanti
    const card = topCard.current;
    drag.current.animating = true;
    setOffset(step === 1 ? -480 : 480, `transform ${FLY_OUT_MS}ms ease-in`);
    window.setTimeout(() => {
      // Prima la carta va in fondo al mazzo (nascosta), poi perde lo spostamento:
      // nello stesso fotogramma, così non ricompare per un istante in cima.
      flushSync(() => go(step));
      if (card) {
        card.style.transition = "none";
        card.style.transform = "";
      }
      drag.current = { active: false, startX: 0, moved: false, animating: false };
    }, FLY_OUT_MS);
  }

  function handlePointerCancel() {
    drag.current.active = false;
    setOffset(0, "transform 0.25s ease");
  }

  return (
    <div className="mt-6">
      <div className="relative isolate mx-auto aspect-square w-full max-w-[300px]">
        {CURATED_POSTS.map((code, idx) => {
          const depth = (idx - current + total) % total;
          const isTop = depth === 0;
          return (
            <div
              key={code}
              className="absolute inset-0 will-change-transform motion-reduce:transition-none!"
              style={deckStyle(depth)}
              aria-hidden={!isTop}
            >
              <a
                ref={isTop ? topCard : undefined}
                href={postUrl(code)}
                target="_blank"
                rel="noopener noreferrer"
                tabIndex={isTop ? 0 : -1}
                aria-label={`Apri il post ${idx + 1} di ${total} su Instagram`}
                draggable={false}
                // Un trascinamento non deve aprire il post.
                onClick={(e) => {
                  if (drag.current.moved) e.preventDefault();
                  drag.current.moved = false;
                }}
                onPointerDown={isTop ? handlePointerDown : undefined}
                onPointerMove={isTop ? handlePointerMove : undefined}
                onPointerUp={isTop ? handlePointerUp : undefined}
                onPointerCancel={isTop ? handlePointerCancel : undefined}
                className={`surface-solid relative block h-full w-full overflow-hidden rounded-lg shadow-xl select-none ${
                  isTop ? "cursor-grab touch-pan-y active:cursor-grabbing" : "pointer-events-none"
                }`}
              >
                <img
                  src={appHref(`instagram/${code}.jpg`)}
                  alt=""
                  width={640}
                  height={640}
                  loading="lazy"
                  decoding="async"
                  draggable={false}
                  className="h-full w-full object-cover"
                />
                {isTop && (
                  <span className="absolute inset-x-0 bottom-0 bg-linear-to-t from-black/70 to-transparent px-4 pt-8 pb-3 text-xs font-semibold text-white">
                    Apri su Instagram ↗
                  </span>
                )}
              </a>
            </div>
          );
        })}
      </div>

      <p className="mt-9 text-center text-xs text-(--text-secondary)">Scorri la carta per esplorare gli altri post</p>

      <div className="mt-2 flex items-center justify-center gap-3">
        <button
          type="button"
          onClick={() => go(-1)}
          aria-label="Post precedente"
          className="flex h-8 w-8 items-center justify-center rounded-full border border-(--surface-border) text-(--text-secondary) hover:text-(--accent-primary)"
        >
          ‹
        </button>
        <div className="flex gap-1.5" aria-label={`Post ${current + 1} di ${total}`} role="status">
          {CURATED_POSTS.map((code, idx) => (
            <span
              key={code}
              className={`h-1.5 rounded-full transition-all duration-300 ${
                idx === current ? "w-4 bg-(--accent-primary)" : "w-1.5 bg-(--surface-border)"
              }`}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={() => go(1)}
          aria-label="Post successivo"
          className="flex h-8 w-8 items-center justify-center rounded-full border border-(--surface-border) text-(--text-secondary) hover:text-(--accent-primary)"
        >
          ›
        </button>
      </div>
    </div>
  );
}
