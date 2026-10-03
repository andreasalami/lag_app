import { useId } from "react";
import type { KitchenState, PreparationMode } from "./types";

export function PreparationChoice({
  value,
  onChange,
  disabled = false,
}: {
  value: PreparationMode;
  onChange: (mode: PreparationMode) => void;
  disabled?: boolean;
}) {
  const group = useId();
  return (
    <fieldset disabled={disabled} className="my-4">
      <legend className="mb-2 font-semibold text-(--text-primary)">Quando prepariamo il cibo?</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {(
          [
            ["immediate", "Prepara appena pago", "Entra in cucina dopo il pagamento."],
            [
              "deferred",
              "Lo prenderò più tardi",
              "Paga adesso. Mostra il QR in cucina quando vuoi iniziare la preparazione.",
            ],
          ] as const
        ).map(([mode, title, description]) => (
          <label
            key={mode}
            className={`cursor-pointer rounded-2xl border p-3 transition-colors focus-within:outline-solid focus-within:outline-2 focus-within:outline-(--accent-primary) ${value === mode ? "border-(--accent-primary) bg-[rgba(242,128,46,0.12)]" : "border-(--surface-border) bg-white/5"} ${disabled ? "opacity-60" : ""}`}
          >
            <input
              className="sr-only"
              type="radio"
              name={group}
              checked={value === mode}
              onChange={() => onChange(mode)}
            />
            <span className="block text-sm font-semibold text-(--text-primary)">
              {value === mode ? "✓ " : ""}
              {title}
            </span>
            <span className="mt-1 block text-xs text-(--text-secondary)">{description}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function kitchenMessage(state: KitchenState | undefined) {
  if (state === "dormant")
    return "Pagato · Cibo da attivare. Mostra il QR in cucina quando vuoi far partire la preparazione, prima della chiusura del servizio.";
  if (state === "waiting")
    return "Cibo attivato · In attesa di un posto in cucina. Non serve scansionare di nuovo il QR.";
  if (state === "active") return "Il cibo è nella coda di preparazione.";
  if (state === "done") return "Il cibo è stato ritirato.";
  return null;
}

export function PreparationStatus({ state }: { state: KitchenState | undefined }) {
  const message = kitchenMessage(state);
  if (!message) return null;
  const title =
    state === "dormant"
      ? "Cibo per più tardi"
      : state === "waiting"
        ? "In attesa di un posto in cucina"
        : state === "active"
          ? "Preparazione avviata"
          : "Cibo ritirato";
  return (
    <section
      role="status"
      className="my-4 rounded-2xl border border-[rgba(242,128,46,0.4)] bg-[rgba(242,128,46,0.08)] p-4 text-left"
    >
      <h2 className="text-lg">{title}</h2>
      <p className="mt-2 text-sm text-(--text-secondary)">{message}</p>
      <p className="mt-3 text-xs text-(--text-secondary)">
        Se hai ordinato bevande, puoi ritirarle separatamente con lo stesso QR.
      </p>
    </section>
  );
}
