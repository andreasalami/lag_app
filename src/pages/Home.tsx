import { useEffect } from "react";
import { Navbar } from "../components/layout/Navbar";
import { TabBar } from "../components/layout/TabBar";
import { EventbriteTickets } from "../features/tickets/EventbriteTickets";
import { EventbriteCheckoutButton } from "../features/tickets/EventbriteCheckoutButton";
import { Program } from "../features/program/Program";
import { Menu } from "../features/menu/Menu";
import { InstagramLink } from "../features/social/InstagramLink";
import { Announcements } from "../features/announcements/Announcements";
import { TournamentBracket } from "../features/tournament/TournamentBracket";
import { Button } from "../components/ui/Button";

export function Home() {
  // Chi arriva da /staff con un link tipo "/#menu" fa una navigazione
  // vera (pagina diversa), non un salto d'ancora nella stessa pagina:
  // il browser prova a scrollare PRIMA che React abbia montato le
  // sezioni, quindi fallisce silenziosamente. Rifacciamo lo scroll
  // a mano una volta che il DOM è pronto.
  useEffect(() => {
    if (!window.location.hash) return;
    try {
      const id = decodeURIComponent(window.location.hash.slice(1));
      document.getElementById(id)?.scrollIntoView();
    } catch {
      // Hash malformato: mostra semplicemente la Home senza interrompere React.
    }
  }, []);

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
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <EventbriteCheckoutButton label="Acquista biglietti" />
          <Button variant="ghost" href="#programma">Scopri il programma</Button>
          <Button variant="ghost" href="#menu">Menu</Button>
        </div>
      </section>

      <EventbriteTickets />
      <Program />
      <Menu />
      <InstagramLink />
      <Announcements />

      <TournamentBracket />

      <TabBar />
    </div>
  );
}
