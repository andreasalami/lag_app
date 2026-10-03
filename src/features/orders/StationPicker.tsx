type StationOption<T extends string> = { key: T; label: string; description?: string };

/** Griglia per scegliere la postazione del dispositivo (cassa, cucina, bar). */
export function StationPicker<T extends string>({
  options,
  onPick,
  hint,
}: {
  options: StationOption<T>[];
  onPick: (key: T) => void;
  hint?: string;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {options.map((option) => (
        <button key={option.key} type="button" onClick={() => onPick(option.key)} className="tile">
          <strong className="font-display text-lg text-[var(--accent-primary)]">{option.label}</strong>
          <span className="mt-1 block text-sm text-[var(--text-secondary)]">{option.description ?? hint}</span>
        </button>
      ))}
    </div>
  );
}
