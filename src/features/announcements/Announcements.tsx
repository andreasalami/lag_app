import { Card } from "../../components/ui/Card";
import { NotificationPermission } from "./NotificationPermission";

/*
  Annunci — placeholder, da sostituire con contenuti reali quando ci
  sarà un modo per pubblicarli (per ora un array statico, stesso
  pattern dei biglietti). Requisito esplicito: ogni annuncio riporta
  SEMPRE data e ora di pubblicazione — chi legge deve capire al volo
  se è un'informazione fresca o vecchia.

  Layout: lista verticale semplice, NON un carosello — tutti e 3 gli
  annunci sono visibili scorrendo la pagina normalmente, senza swipe
  o tap per "aprirli".
*/
type Announcement = {
  id: string;
  title: string;
  message: string;
  publishedAt: string; // ISO 8601
};

const ANNOUNCEMENTS: Announcement[] = [
  {
    id: "1",
    title: "Benvenuti a L'Agro ai Giovani",
    message: "Biglietti e programma in arrivo a breve: resta aggiornato qui.",
    publishedAt: "2026-08-01T10:00:00",
  },
  {
    id: "2",
    title: "Line-up in definizione",
    message: "Stiamo confermando gli ultimi DJ set. Annuncio ufficiale entro fine mese.",
    publishedAt: "2026-08-02T18:30:00",
  },
  {
    id: "3",
    title: "Parcheggio e accessi",
    message: "Info su parcheggio e navette da Cremona saranno pubblicate qui prima dell'evento.",
    publishedAt: "2026-08-03T09:15:00",
  },
];

const dateFormatter = new Intl.DateTimeFormat("it-IT", {
  day: "numeric",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
});

export function Announcements() {
  return (
    <section id="annunci" className="mx-auto max-w-3xl px-4 py-10">
      <h2 className="mb-1 text-2xl font-semibold">Annunci</h2>
      <p className="mb-4 text-sm text-[var(--text-secondary)]">
        Aggiornamenti ufficiali sull'evento, in ordine cronologico.
      </p>

      <NotificationPermission />

      <div className="flex flex-col gap-3">
        {ANNOUNCEMENTS.map((a) => (
          <Card key={a.id} className="p-5">
            <div className="flex items-start justify-between gap-4">
              <h3 className="font-display text-base">{a.title}</h3>
              <time
                dateTime={a.publishedAt}
                className="shrink-0 whitespace-nowrap font-mono text-xs text-[var(--text-secondary)]"
              >
                {dateFormatter.format(new Date(a.publishedAt))}
              </time>
            </div>
            <p className="mt-2 text-sm text-[var(--text-secondary)]">{a.message}</p>
          </Card>
        ))}
      </div>
    </section>
  );
}
