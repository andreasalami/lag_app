import { formatMinutes, toMinutes } from "./timeUtils";

export interface ProgramSlotData {
  id: string;
  day: number;
  stage: string;
  title: string;
  start_time: string;
  end_time: string;
}

interface ProgramGridProps {
  slots: ProgramSlotData[];
  stages: string[];
  days: number;
}

const PX_PER_MIN = 2;
const MIN_BOX_HEIGHT = 32;
const DAY_MINUTES = 24 * 60;

function timelineTimes(slots: ProgramSlotData[]) {
  const starts = slots.map((slot) => toMinutes(slot.start_time)).sort((a, b) => a - b);
  let largestGap = -1;
  let anchor = starts[0];
  starts.forEach((start, index) => {
    const next = starts[(index + 1) % starts.length] + (index === starts.length - 1 ? DAY_MINUTES : 0);
    if (next - start > largestGap) {
      largestGap = next - start;
      anchor = next % DAY_MINUTES;
    }
  });

  return new Map(
    slots.map((slot) => {
      const rawStart = toMinutes(slot.start_time);
      const start = rawStart < anchor ? rawStart + DAY_MINUTES : rawStart;
      let end = toMinutes(slot.end_time);
      while (end <= start) end += DAY_MINUTES;
      return [slot.id, { start, end }];
    })
  );
}

/**
 * Vista "calendario": tempo sull'asse verticale, un palco per colonna.
 * Ogni box è posizionato con top/height calcolati in pixel dai minuti
 * — nessun bucket fisso a 30'/1h, quindi qualsiasi orario (anche non
 * arrotondato) si posiziona correttamente.
 */
export function ProgramGrid({ slots, stages, days }: ProgramGridProps) {
  if (slots.length === 0) {
    return (
      <p className="rounded-[var(--radius-md)] border border-dashed border-[var(--surface-border)] p-4 text-center text-sm text-[var(--text-secondary)]">
        Programma non ancora pubblicato.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {Array.from({ length: days }, (_, dayIndex) => {
        const day = dayIndex + 1;
        const daySlots = slots.filter((slot) => slot.day === day);
        if (daySlots.length === 0) {
          return (
            <div key={day}>
              <h3 className="mb-3 font-display text-lg text-[var(--accent-primary)]">Giorno {day}</h3>
              <p className="rounded-[var(--radius-md)] border border-dashed border-[var(--surface-border)] p-4 text-center text-sm text-[var(--text-secondary)]">
                Programma non ancora pubblicato.
              </p>
            </div>
          );
        }

        const times = timelineTimes(daySlots);
        const allMinutes = daySlots.flatMap((slot) => {
          const time = times.get(slot.id);
          return time ? [time.start, time.end] : [];
        });
        const minMinutes = Math.min(...allMinutes);
        const maxMinutes = Math.max(...allMinutes);
        const totalHeight = Math.max((maxMinutes - minMinutes) * PX_PER_MIN, MIN_BOX_HEIGHT);
        const hourMarks: number[] = [];
        for (let minute = Math.ceil(minMinutes / 60) * 60; minute <= maxMinutes; minute += 60) {
          hourMarks.push(minute);
        }

        return (
          <div key={day}>
            <h3 className="mb-3 font-display text-lg text-[var(--accent-primary)]">Giorno {day}</h3>
            <div className="overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <div className="grid min-w-[420px] grid-cols-[48px_1fr_1fr] gap-3">
                <div />
                {stages.map((stage) => (
                  <h4 key={stage} className="text-center font-display text-sm text-[var(--accent-primary)]">
                    {stage}
                  </h4>
                ))}

                <div className="relative" style={{ height: totalHeight }}>
                  {hourMarks.map((minute) => (
                    <span
                      key={minute}
                      className="absolute -translate-y-1/2 font-mono text-xs text-[var(--text-secondary)]"
                      style={{ top: (minute - minMinutes) * PX_PER_MIN }}
                    >
                      {formatMinutes(minute)}
                    </span>
                  ))}
                </div>

                {stages.map((stage) => (
                  <div
                    key={stage}
                    className="relative rounded-[var(--radius-lg)] border border-[var(--surface-border)]"
                    style={{ height: totalHeight }}
                  >
                    {hourMarks.map((minute) => (
                      <div
                        key={minute}
                        className="absolute left-0 right-0 border-t border-[var(--surface-border)]"
                        style={{ top: (minute - minMinutes) * PX_PER_MIN }}
                      />
                    ))}
                    {daySlots
                      .filter((slot) => slot.stage === stage)
                      .map((slot) => {
                        const time = times.get(slot.id);
                        if (!time) return null;
                        const top = (time.start - minMinutes) * PX_PER_MIN;
                        const height = Math.max(
                          (time.end - time.start) * PX_PER_MIN,
                          MIN_BOX_HEIGHT
                        );
                        return (
                          <div
                            key={slot.id}
                            className="surface-solid absolute left-1 right-1 overflow-hidden rounded-[var(--radius-md)] border-l-2 border-l-[var(--accent-primary)] px-2 py-1"
                            style={{ top, height }}
                          >
                            <p className="truncate text-xs font-semibold text-[var(--text-primary)]">{slot.title}</p>
                            <p className="truncate font-mono text-[10px] text-[var(--text-secondary)]">
                              {slot.start_time}–{slot.end_time}
                            </p>
                          </div>
                        );
                      })}
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
