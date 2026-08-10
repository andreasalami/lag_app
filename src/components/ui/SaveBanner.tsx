interface SaveBannerProps {
  /** Testo mostrato quando non c'è errore — specifico per sezione, es. "Ci sono modifiche al Menu non ancora salvate." */
  message: string;
  saving: boolean;
  error: string | null;
  onSave: () => void;
  /** Etichetta del bottone a riposo, es. "Salvo..." diventa questo durante il salvataggio. Default: "Salva". */
  label?: string;
  savingLabel?: string;
}

/**
 * Barra di salvataggio flottante, unica per tutte le sezioni con
 * pattern "modifica in locale, scrivi solo al tap" (Programma, Menu,
 * Torneo): stessa posizione, stesso stile, stesso bottone — così non
 * è mai un tasto diverso da cercare in punti diversi dello schermo.
 *
 * Il messaggio resta specifico per sezione (passato da fuori) apposta:
 * stessa forma ovunque, ma è sempre chiaro DI COSA hai modifiche non
 * salvate se hai più sezioni aperte in tab diverse.
 */
export function SaveBanner({ message, saving, error, onSave, label = "Salva", savingLabel = "Salvo..." }: SaveBannerProps) {
  return (
    <div className="glass-elevated glass-elevated--strong fixed inset-x-4 bottom-24 z-40 mx-auto flex max-w-3xl items-center justify-between gap-3 rounded-[var(--radius-md)] px-4 py-3">
      <span className="text-xs text-[var(--text-secondary)]">{error ?? message}</span>
      <button
        onClick={onSave}
        disabled={saving}
        className="signature-glow rounded-[var(--radius-pill)] bg-[var(--accent-primary)] px-4 py-2 text-sm font-semibold text-[var(--text-on-accent)] disabled:opacity-50"
      >
        {saving ? savingLabel : label}
      </button>
    </div>
  );
}
