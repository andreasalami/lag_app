/*
  Post curati a mano — mostriamo solo la foto, niente iframe di Instagram.
  Un iframe cross-origin non si può "ritagliare" con CSS: dentro c'è
  header, didascalia e link di attribuzione di Instagram, e non c'è modo
  di nasconderli selettivamente (è anche il motivo per cui prima si
  sovrapponevano — l'iframe cambia altezza in modo asincrono dopo il
  caricamento). Qui invece è una <img> normale: pieno controllo, zero
  sorprese.

  Per aggiungere un post:
  1. Salva la foto del post (screenshot o download) in public/instagram/
  2. Aggiungi una riga qui sotto con permalink (per il link cliccabile),
     percorso immagine e un alt text breve

  Corto e a rotazione: 3-6 post, non è pensato per essere uno storico
  completo.
*/
type CuratedPost = {
  permalink: string;
  image: string; // percorso in /public, es. "/instagram/post-1.jpg"
  alt: string;
};

const CURATED_POSTS: CuratedPost[] = [
  // {
  //   permalink: "https://www.instagram.com/p/ESEMPIO/",
  //   image: "/instagram/post-1.jpg",
  //   alt: "Descrizione breve della foto",
  // },
];

export function InstagramPosts() {
  if (CURATED_POSTS.length === 0) {
    return (
      <p className="mt-6 rounded-[var(--radius-md)] border border-dashed border-[var(--surface-border)] p-4 text-center text-sm text-[var(--text-secondary)]">
        Nessun post selezionato ancora — aggiungi foto + permalink in{" "}
        <code className="font-mono text-[var(--accent-primary)]">src/features/social/InstagramPosts.tsx</code>.
      </p>
    );
  }

  return (
    <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
      {CURATED_POSTS.map((post) => (
        <a
          key={post.permalink}
          href={post.permalink}
          target="_blank"
          rel="noreferrer"
          className="group block aspect-square overflow-hidden rounded-[var(--radius-lg)] border border-[var(--surface-border)]"
        >
          <img
            src={post.image}
            alt={post.alt}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        </a>
      ))}
    </div>
  );
}
