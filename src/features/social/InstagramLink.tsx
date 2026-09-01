import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { InstagramPosts } from "./InstagramPosts";

const INSTAGRAM_HANDLE = (import.meta.env.VITE_INSTAGRAM_HANDLE || "lagroaigiovani").replace(/^@/, "");

export function InstagramLink() {
  return (
    <section id="social" className="mx-auto max-w-3xl px-4 py-10">
      <Card className="overflow-hidden !p-0">
        <div className="border-b border-[var(--surface-border)] bg-[linear-gradient(135deg,rgba(242,128,46,0.16),transparent_65%)] px-5 py-5 sm:px-6">
          <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--accent-primary)]">Instagram</p>
          <h2 className="font-display text-2xl">Segui l'evento</h2>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            Aggiornamenti su line-up, orari e novità dell'ultimo minuto su Instagram.
          </p>
        </div>
        <div className="flex flex-col items-start gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p className="font-mono text-sm text-[var(--accent-primary)]">@{INSTAGRAM_HANDLE}</p>
          <Button
            variant="ghost"
            className="w-full sm:w-auto"
            onClick={() => window.open(`https://instagram.com/${INSTAGRAM_HANDLE}`, "_blank", "noopener,noreferrer")}
          >
            Apri Instagram
          </Button>
        </div>
      </Card>

      <InstagramPosts />
    </section>
  );
}
