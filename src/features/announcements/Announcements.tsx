import { Card } from "../../components/ui/Card";
import { NotificationPermission } from "./NotificationPermission";
import { PublishAnnouncementForm } from "./PublishAnnouncementForm";
import { useAuth } from "../auth/AuthContext";
import { useSupabaseRows } from "../../lib/useSupabaseRows";

/*
  Annunci — dati reali da Supabase (fetch + realtime via useSupabaseRows),
  fallback di esempio se non configurato. Layout: lista verticale
  semplice, NON un carosello — tutti gli annunci sono visibili
  scorrendo la pagina normalmente.
*/
type Announcement = {
  id: string;
  title: string;
  message: string;
  published_at: string;
};

const FALLBACK: Announcement[] = [
  {
    id: "fallback-1",
    title: "Benvenuti a L'Agro ai Giovani",
    message: "Esempio — collega Supabase per contenuti reali e pubblicabili dallo staff.",
    published_at: "2026-08-01T10:00:00",
  },
  {
    id: "fallback-2",
    title: "Line-up in definizione",
    message: "Esempio — stiamo confermando gli ultimi DJ set.",
    published_at: "2026-08-02T18:30:00",
  },
  {
    id: "fallback-3",
    title: "Parcheggio e accessi",
    message: "Esempio — info su parcheggio e navette da Cremona.",
    published_at: "2026-08-03T09:15:00",
  },
];

const dateFormatter = new Intl.DateTimeFormat("it-IT", {
  day: "numeric",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
});

export function Announcements() {
  const { role } = useAuth();
  const { rows: announcements, loading, refetch } = useSupabaseRows<Announcement>({
    table: "announcements",
    select: "id, title, message, published_at",
    orderBy: [{ column: "published_at", ascending: false }],
    fallback: FALLBACK,
  });

  return (
    <section id="annunci" className="mx-auto max-w-3xl px-4 py-10">
      <h2 className="mb-1 text-2xl font-semibold">Annunci</h2>
      <p className="mb-4 text-sm text-[var(--text-secondary)]">
        Aggiornamenti ufficiali sull'evento, in ordine cronologico.
      </p>

      <NotificationPermission />
      {(role === "staff" || role === "admin") && <PublishAnnouncementForm onPublished={refetch} />}

      {loading ? (
        <p className="text-sm text-[var(--text-secondary)]">Carico gli annunci...</p>
      ) : (
        <div className="flex flex-col gap-3">
          {announcements.map((a) => (
            <Card key={a.id} className="p-5">
              <div className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                <h3 className="min-w-0 break-words font-display text-base">{a.title}</h3>
                <time
                  dateTime={a.published_at}
                  className="font-mono text-xs text-[var(--text-secondary)] sm:shrink-0 sm:whitespace-nowrap"
                >
                  {dateFormatter.format(new Date(a.published_at))}
                </time>
              </div>
              <p className="mt-2 text-sm text-[var(--text-secondary)]">{a.message}</p>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
