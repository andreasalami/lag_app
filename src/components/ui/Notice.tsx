import type { ReactNode } from "react";

/** Avviso in pagina, opzionalmente chiudibile. `error` viene annunciato subito dagli screen reader. */
export function Notice({ children, onDismiss, tone = "neutral", className = "" }: {
  children: ReactNode;
  onDismiss?: () => void;
  tone?: "neutral" | "error";
  className?: string;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`flex items-start justify-between gap-3 rounded-[var(--radius-sm)] border p-3 text-sm ${tone === "error" ? "border-[var(--state-error)]/50" : "border-[var(--surface-border)]"} ${className}`}
    >
      <span>{children}</span>
      {onDismiss && <button type="button" onClick={onDismiss} aria-label="Chiudi avviso">×</button>}
    </div>
  );
}
