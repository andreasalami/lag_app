import type { OperationalSyncState } from "../../lib/useOperationalSync";

export function OperationalSyncStatus({ sync }: { sync: OperationalSyncState }) {
  if (!sync.stale) return null;
  const detail = !sync.online
    ? "Il dispositivo è offline. Non confermare operazioni finché la connessione non torna."
    : "I dati non vengono aggiornati da almeno 45 secondi. Controlla la connessione prima di procedere.";
  return (
    <div role="alert" className="mb-4 rounded-[var(--radius-sm)] border-2 border-[var(--state-error)] p-3 text-sm text-[var(--state-error)]">
      <strong>Dati operativi non aggiornati.</strong> {detail}
    </div>
  );
}
