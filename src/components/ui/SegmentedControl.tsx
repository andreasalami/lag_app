type Option<T extends string> = { value: T; label: string };

/** Selettore a pillola con una sola opzione attiva (es. QR / Riepilogo). */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  className = "",
}: {
  options: Option<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div
      className={`grid rounded-(--radius-pill) border border-(--surface-border) p-1 ${className}`}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={`rounded-(--radius-pill) px-3 py-2 text-sm ${value === option.value ? "bg-(--accent-primary) text-(--text-on-accent)" : "text-(--text-secondary)"}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
