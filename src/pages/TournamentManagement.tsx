import { TournamentBracket } from "../features/tournament/TournamentBracket";

export function TournamentManagement() {
  return (
    <main className="min-h-full pb-24">
      <div className="mx-auto max-w-5xl px-4 pt-6">
        <a href={`${import.meta.env.BASE_URL}#tornei`} className="text-xs text-[var(--text-secondary)] hover:underline">
          ← Torna al riepilogo pubblico
        </a>
      </div>
      <TournamentBracket management />
    </main>
  );
}
