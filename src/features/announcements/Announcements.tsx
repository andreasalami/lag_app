import { useEffect, useState } from "react";
import { Card } from "../../components/ui/Card";
import { NotificationPermission } from "./NotificationPermission";
import { PublishAnnouncementForm } from "./PublishAnnouncementForm";
import { RoleLogin } from "../auth/RoleLogin";
import { useAuth } from "../auth/AuthContext";
import { supabase, isSupabaseConfigured } from "../../lib/supabaseClient";

/*
  Annunci — dati reali da Supabase quando configurato (fetch iniziale +
  sottoscrizione realtime: un annuncio pubblicato da un membro dello
  staff appare a chiunque abbia la pagina aperta, senza refresh).

  Se Supabase non è ancora configurato (.env.local vuoto), mostriamo
  3 annunci di esempio invece di una sezione vuota — stesso principio
  onesto già usato per Eventbrite: stato chiaro, non finto.

  Layout: lista verticale semplice, NON un carosello — tutti gli
  annunci sono visibili scorrendo la pagina normalmente.
*/
type Announcement = {
  id: string;
  title: string;
  message: string;
  published_at: string;
};

const FALLBACK_ANNOUNCEMENTS: Announcement[] = [
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
  const [announcements, setAnnouncements] = useState<Announcement[]>(FALLBACK_ANNOUNCEMENTS);
  const [loading, setLoading] = useState(isSupabaseConfigured);

  const fetchAnnouncements = async () => {
    const { data, error } = await supabase
      .from("announcements")
      .select("id, title, message, published_at")
      .order("published_at", { ascending: false });

    if (!error && data) setAnnouncements(data);
    setLoading(false);
  };

  useEffect(() => {
    if (!isSupabaseConfigured) return;

    fetchAnnouncements();

    // Realtime: chi ha la pagina aperta vede il nuovo annuncio comparire
    // da solo, senza dover ricaricare.
    const channel = supabase
      .channel("announcements-changes")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "announcements" },
        (payload) => {
          setAnnouncements((prev) => [payload.new as Announcement, ...prev]);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  return (
    <section id="annunci" className="mx-auto max-w-3xl px-4 py-10">
      <h2 className="mb-1 text-2xl font-semibold">Annunci</h2>
      <p className="mb-4 text-sm text-[var(--text-secondary)]">
        Aggiornamenti ufficiali sull'evento, in ordine cronologico.
      </p>

      <NotificationPermission />
      <RoleLogin requiredRole="staff" label="Staff" />
      {role === "staff" && <PublishAnnouncementForm onPublished={fetchAnnouncements} />}

      {loading ? (
        <p className="text-sm text-[var(--text-secondary)]">Carico gli annunci...</p>
      ) : (
        <div className="flex flex-col gap-3">
          {announcements.map((a) => (
            <Card key={a.id} className="p-5">
              <div className="flex items-start justify-between gap-4">
                <h3 className="font-display text-base">{a.title}</h3>
                <time
                  dateTime={a.published_at}
                  className="shrink-0 whitespace-nowrap font-mono text-xs text-[var(--text-secondary)]"
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
