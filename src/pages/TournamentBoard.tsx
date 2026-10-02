import { TournamentBracket } from "../features/tournament/TournamentBracket";
import { Button } from "../components/ui/Button";
import { appHref } from "../lib/browser";

export function TournamentBoard() {
  return (
    <main className="min-h-full pb-10">
      <div className="mx-auto max-w-5xl px-4 pt-6">
        <Button href={appHref("#tornei")} variant="back" className="min-h-10 px-4 py-2">
          ← Torna al riepilogo del torneo
        </Button>
      </div>
      <TournamentBracket />
    </main>
  );
}
