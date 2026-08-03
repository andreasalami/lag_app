import { Navbar } from "../components/layout/Navbar";
import { TabBar } from "../components/layout/TabBar";
import { EventbriteTickets } from "../features/tickets/EventbriteTickets";
import { EventbriteCheckoutButton } from "../features/tickets/EventbriteCheckoutButton";
import { InstagramLink } from "../features/social/InstagramLink";
import { Announcements } from "../features/announcements/Announcements";
import { Button } from "../components/ui/Button";

export function Home() {
  return (
    <div className="pb-28">
      <Navbar />

      <section id="home" className="mx-auto max-w-3xl px-4 pb-6 pt-16 text-center sm:pt-24">
        <p className="mb-3 font-mono text-xs uppercase tracking-[0.2em] text-[var(--text-secondary)]">
          Cascina Marasco · Cremona
        </p>
        <h1 className="font-display text-4xl font-semibold leading-tight sm:text-6xl">
          L'Agro ai Giovani
        </h1>
        <p className="mx-auto mt-4 max-w-md text-[var(--text-secondary)]">
          Festival benefico — DJ set e musica live. Il ricavato sostiene Agropolis ONLUS.
        </p>
        <div className="mt-8 flex justify-center gap-3">
          <EventbriteCheckoutButton label="Acquista biglietti" />
          <Button variant="ghost">Scopri il programma</Button>
        </div>
      </section>

      <EventbriteTickets />
      <InstagramLink />
      <Announcements />

      <section id="tornei" className="mx-auto max-w-3xl px-4 py-10">
        <div className="surface-solid rounded-[var(--radius-lg)] border-dashed p-6 text-center text-sm text-[var(--text-secondary)]">
          Tornei in tempo reale — in arrivo in una prossima iterazione.
        </div>
      </section>

      <TabBar />
    </div>
  );
}
