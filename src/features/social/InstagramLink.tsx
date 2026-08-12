import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { InstagramPosts } from "./InstagramPosts";

const INSTAGRAM_HANDLE = (import.meta.env.VITE_INSTAGRAM_HANDLE || "lagroaigiovani").replace(/^@/, "");

export function InstagramLink() {
  return (
    <section id="social" className="mx-auto max-w-3xl px-4 py-10">
      <Card className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-display text-xl">Segui l'evento</h2>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            Aggiornamenti su line-up, orari e novità dell'ultimo minuto su Instagram.
          </p>
          <p className="mt-1 font-mono text-sm text-[var(--accent-primary)]">@{INSTAGRAM_HANDLE}</p>
        </div>
        <Button
          variant="ghost"
          onClick={() => window.open(`https://instagram.com/${INSTAGRAM_HANDLE}`, "_blank", "noopener,noreferrer")}
        >
          Apri Instagram
        </Button>
      </Card>

      <InstagramPosts />
    </section>
  );
}
