import { useEffect, useMemo, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { isSupabaseConfigured, supabase } from "../../lib/supabaseClient";
import { useAuth } from "../auth/AuthContext";
import { NotificationPermission } from "../notifications/NotificationPermission";
import { currentRoundLabel, latestTournamentResults } from "./tournamentOverview";
import {
  EMPTY_TOURNAMENT_SNAPSHOT,
  parseTournamentSnapshot,
  type TournamentSnapshot,
} from "./tournamentState";

const POLL_INTERVAL_MS = 30_000;

export function TournamentPreview() {
  const { role } = useAuth();
  const canManage = role === "tournament_manager" || role === "admin";
  const [snapshot, setSnapshot] = useState<TournamentSnapshot>(EMPTY_TOURNAMENT_SNAPSHOT);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!isSupabaseConfigured || document.visibilityState !== "visible") {
        if (!cancelled) setLoading(false);
        return;
      }
      const { data, error } = await supabase
        .from("tournament_state")
        .select("size, teams, matches, overrides")
        .eq("id", "main")
        .maybeSingle();
      if (cancelled) return;
      const parsed = parseTournamentSnapshot(data);
      if (error || !parsed) {
        setLoadError("Aggiornamenti del torneo non disponibili. Riprova più tardi.");
      } else {
        setSnapshot(parsed);
        setLoadError(null);
      }
      setLoading(false);
    }

    void load();
    const interval = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    const handleVisibility = () => void load();
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  const currentRound = useMemo(() => currentRoundLabel(snapshot), [snapshot]);
  const results = useMemo(() => latestTournamentResults(snapshot), [snapshot]);

  return (
    <section id="tornei" className="mx-auto w-full max-w-3xl px-4 py-10">
      <div className="mb-5 flex items-end justify-between gap-4">
        <div>
          <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--accent-primary)]">Live tournament</p>
          <h2 className="text-2xl font-semibold">Torneo LAG</h2>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">Risultati e avanzamento del torneo, senza uscire dalla serata.</p>
        </div>
        <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-[var(--accent-primary)] shadow-[0_0_14px_var(--accent-primary)]" aria-label="Torneo in aggiornamento" />
      </div>

      <NotificationPermission />

      {canManage && (
        <Button href={`${import.meta.env.BASE_URL}#gestione-torneo`} className="mb-5 w-full justify-start sm:w-64">
          Gestisci torneo
        </Button>
      )}

      <Card className="overflow-hidden !p-0">
        <div className="border-b border-[var(--surface-border)] bg-[linear-gradient(135deg,rgba(242,128,46,0.16),transparent_65%)] px-5 py-5 sm:px-6">
          <p className="text-xs uppercase tracking-[0.16em] text-[var(--text-secondary)]">
            {currentRound === "Torneo concluso" ? "Stato" : "Turno in corso"}
          </p>
          <p className="mt-1 font-display text-2xl text-[var(--accent-primary)]">{currentRound}</p>
        </div>

        <div className="px-4 py-4 sm:px-6">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-base">Ultimi risultati</h3>
            <span className="text-xs text-[var(--text-secondary)]">Ultime 5 partite</span>
          </div>

          {loadError ? (
            <p className="rounded-[var(--radius-md)] border border-dashed border-[var(--surface-border)] p-4 text-sm text-[var(--state-error)]">{loadError}</p>
          ) : loading ? (
            <p className="py-5 text-center text-sm text-[var(--text-secondary)]">Carico i risultati…</p>
          ) : results.length === 0 ? (
            <p className="rounded-[var(--radius-md)] border border-dashed border-[var(--surface-border)] p-4 text-center text-sm text-[var(--text-secondary)]">
              Le partite stanno per cominciare. I risultati compariranno qui.
            </p>
          ) : (
            <ol className="space-y-2">
              {results.map((result) => (
                <li key={result.key} className="rounded-[var(--radius-md)] border border-[var(--surface-border)] px-3 py-3">
                  <div className="mb-2 flex items-center justify-between gap-3 text-[10px] uppercase tracking-wide text-[var(--text-secondary)]">
                    <span>{result.roundLabel}</span>
                    {result.completedAt && (
                      <time dateTime={result.completedAt}>
                        {new Date(result.completedAt).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}
                      </time>
                    )}
                  </div>
                  <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 text-sm">
                    <span className={`truncate ${result.winner === "A" ? "font-semibold text-[var(--text-primary)]" : "text-[var(--text-secondary)]"}`}>{result.teamA}</span>
                    <strong className="rounded-[var(--radius-pill)] bg-white/5 px-3 py-1 font-mono text-[var(--accent-primary)]">
                      {result.scoreA}–{result.scoreB}
                    </strong>
                    <span className={`truncate text-right ${result.winner === "B" ? "font-semibold text-[var(--text-primary)]" : "text-[var(--text-secondary)]"}`}>{result.teamB}</span>
                  </div>
                </li>
              ))}
            </ol>
          )}

          <Button variant="ghost" href={`${import.meta.env.BASE_URL}#tabellone`} className="mt-4 w-full">
            Vedi il tabellone completo
          </Button>
        </div>
      </Card>
    </section>
  );
}
