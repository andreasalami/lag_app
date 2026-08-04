import { toMinutes, formatMinutes } from "./timeUtils";

export interface ProgramSlotData {
  id: string;
  stage: string;
  title: string;
  start_time: string;
  end_time: string;
}

interface ProgramGridProps {
  slots: ProgramSlotData[];
  stages: string[];
}

const PX_PER_MIN = 2;
const MIN_BOX_HEIGHT = 32;

/**
 * Vista "calendario": tempo sull'asse verticale, un palco per colonna.
 * Ogni box è posizionato con top/height calcolati in pixel dai minuti
 * — nessun bucket fisso a 30'/1h, quindi qualsiasi orario (anche non
 * arrotondato) si posiziona correttamente.
 */
export function ProgramGrid({ slots, stages }: ProgramGridProps) {
  if (slots.length === 0) {
    return (
      <p className="rounded-[var(--radius-md)] border border-dashed border-[var(--surface-border)] p-4 text-center text-sm text-[var(--text-secondary)]">
        Programma non ancora pubblicato.
      </p>
    );
  }

  const allMinutes = slots.flatMap((s) => [toMinutes(s.start_time), toMinutes(s.end_time)]);
  const minMinutes = Math.min(...allMinutes);
  const maxMinutes = Math.max(...allMinutes);
  const totalHeight = Math.max((maxMinutes - minMinutes) * PX_PER_MIN, MIN_BOX_HEIGHT);

  const hourMarks: number[] = [];
  for (let m = Math.ceil(minMinutes / 60) * 60; m <= maxMinutes; m += 60) {
    hourMarks.push(m);
  }

  return (
    <div className="overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div className="grid min-w-[420px] grid-cols-[48px_1fr_1fr] gap-3">
        <div />
        {stages.map((stage) => (
          <h3 key={stage} className="text-center font-display text-sm text-[var(--accent-primary)]">
            {stage}
          </h3>
        ))}

        {/* colonna orari */}
        <div className="relative" style={{ height: totalHeight }}>
          {hourMarks.map((m) => (
            <span
              key={m}
              className="absolute -translate-y-1/2 font-mono text-xs text-[var(--text-secondary)]"
              style={{ top: (m - minMinutes) * PX_PER_MIN }}
            >
              {formatMinutes(m)}
            </span>
          ))}
        </div>

        {stages.map((stage) => (
          <div
            key={stage}
            className="relative rounded-[var(--radius-lg)] border border-[var(--surface-border)]"
            style={{ height: totalHeight }}
          >
            {hourMarks.map((m) => (
              <div
                key={m}
                className="absolute left-0 right-0 border-t border-[var(--surface-border)]"
                style={{ top: (m - minMinutes) * PX_PER_MIN }}
              />
            ))}
            {slots
              .filter((s) => s.stage === stage)
              .map((s) => {
                const top = (toMinutes(s.start_time) - minMinutes) * PX_PER_MIN;
                const height = Math.max(
                  (toMinutes(s.end_time) - toMinutes(s.start_time)) * PX_PER_MIN,
                  MIN_BOX_HEIGHT
                );
                return (
                  <div
                    key={s.id}
                    className="surface-solid absolute left-1 right-1 overflow-hidden rounded-[var(--radius-md)] border-l-2 border-l-[var(--accent-primary)] px-2 py-1"
                    style={{ top, height }}
                  >
                    <p className="truncate text-xs font-semibold text-[var(--text-primary)]">{s.title}</p>
                    <p className="truncate font-mono text-[10px] text-[var(--text-secondary)]">
                      {s.start_time}–{s.end_time}
                    </p>
                  </div>
                );
              })}
          </div>
        ))}
      </div>
    </div>
  );
}
