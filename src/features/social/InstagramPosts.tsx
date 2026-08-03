import { InstagramEmbed } from "./InstagramEmbed";

/*
  Post curati a mano — niente Graph API, niente token, niente backend.

  Per aggiungere/togliere un post:
  1. Apri il post su instagram.com
  2. Copia l'URL del permalink, es. https://www.instagram.com/p/XXXXXXXXXXX/
  3. Aggiungilo/rimuovilo dall'array qui sotto

  Va aggiornato a mano, quindi tienilo corto (3-6 post) e a rotazione:
  non è pensato per essere uno storico completo, solo gli ultimi/i
  migliori momenti da mettere in vetrina.
*/
const CURATED_POSTS: string[] = [
  // "https://www.instagram.com/p/ESEMPIO_1/",
  // "https://www.instagram.com/p/ESEMPIO_2/",
  // "https://www.instagram.com/p/ESEMPIO_3/",
];

export function InstagramPosts() {
  if (CURATED_POSTS.length === 0) {
    return (
      <p className="mt-6 rounded-[var(--radius-md)] border border-dashed border-[var(--surface-border)] p-4 text-center text-sm text-[var(--text-secondary)]">
        Nessun post selezionato ancora — aggiungi gli URL in{" "}
        <code className="font-mono text-[var(--accent-primary)]">src/features/social/InstagramPosts.tsx</code>.
      </p>
    );
  }

  return (
    <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {CURATED_POSTS.map((url) => (
        <InstagramEmbed key={url} url={url} />
      ))}
    </div>
  );
}
