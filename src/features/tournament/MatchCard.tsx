import { useState } from "react";
import { Card } from "../../components/ui/Card";
import type { Side } from "./bracketUtils";

interface SlotRowProps {
  name: string | null;
  isWinner: boolean;
  score: number | null;
  editable: boolean;
  onClick: () => void;
  onScoreChange: (value: number | null) => void;
  onOverride: (name: string) => void;
}

function SlotRow({ name, isWinner, score, editable, onClick, onScoreChange, onOverride }: SlotRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name ?? "");

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          onOverride(draft);
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            onOverride(draft);
            setEditing(false);
          }
        }}
        className="field w-full"
      />
    );
  }

  return (
    <div className="flex items-center gap-2 py-1">
      <button
        type="button"
        onClick={onClick}
        disabled={!editable || !name}
        className={`flex-1 truncate rounded-[var(--radius-sm)] px-2 py-1 text-left text-sm transition-colors ${
          isWinner
            ? "font-semibold text-[var(--accent-primary)]"
            : name
              ? "text-[var(--text-primary)]"
              : "text-[var(--text-secondary)]"
        } ${editable && name ? "hover:bg-white/5" : ""}`}
      >
        {name ?? "In attesa"}
      </button>
      {editable && (
        <>
          <input
            type="number"
            value={score ?? ""}
            onChange={(e) => onScoreChange(e.target.value === "" ? null : Number(e.target.value))}
            className="field w-12 px-1 text-center font-mono text-xs"
            placeholder="-"
          />
          <button
            type="button"
            onClick={() => {
              setDraft(name ?? "");
              setEditing(true);
            }}
            title="Modifica / ripesca squadra in questo slot"
            className="text-xs text-[var(--text-secondary)] hover:text-[var(--accent-primary)]"
          >
            ✎
          </button>
        </>
      )}
    </div>
  );
}

interface MatchCardProps {
  nameA: string | null;
  nameB: string | null;
  scoreA: number | null;
  scoreB: number | null;
  winner: Side | null;
  editable: boolean;
  onSetWinner: (side: Side) => void;
  onSetScore: (side: Side, value: number | null) => void;
  onOverride: (side: Side, name: string) => void;
}

export function MatchCard({
  nameA,
  nameB,
  scoreA,
  scoreB,
  winner,
  editable,
  onSetWinner,
  onSetScore,
  onOverride,
}: MatchCardProps) {
  return (
    <Card className="p-3">
      <SlotRow
        name={nameA}
        isWinner={winner === "A"}
        score={scoreA}
        editable={editable}
        onClick={() => onSetWinner("A")}
        onScoreChange={(v) => onSetScore("A", v)}
        onOverride={(name) => onOverride("A", name)}
      />
      <div className="my-1 h-px bg-[var(--surface-border)]" />
      <SlotRow
        name={nameB}
        isWinner={winner === "B"}
        score={scoreB}
        editable={editable}
        onClick={() => onSetWinner("B")}
        onScoreChange={(v) => onSetScore("B", v)}
        onOverride={(name) => onOverride("B", name)}
      />
    </Card>
  );
}
