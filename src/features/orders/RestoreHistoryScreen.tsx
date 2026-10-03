import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { appHref } from "../../lib/browser";
import { supabase } from "../../lib/supabaseClient";
import type { StoredOrder } from "./orderHistory";
import { validRecoveryToken } from "./orderRecovery";

/** Schermata del link di recupero: scarica dal server lo storico legato al codice, a pagine da 50. */
export function RestoreHistoryScreen({
  token,
  onRestored,
}: {
  token: string;
  onRestored: (orders: StoredOrder[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function restore() {
    if (!validRecoveryToken(token)) {
      setError("Codice di recupero non valido.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const restored: StoredOrder[] = [];
      let cursor: string | null = null;
      while (true) {
        const response = await supabase.rpc("recover_order_history", { p_token: token, p_before: cursor });
        if (response.error) throw new Error("restore_failed");
        const page = response.data as Array<StoredOrder & { created_at: string }>;
        for (const order of page) restored.push({ ...order, saved_at: order.created_at, recovery_enabled: true });
        if (page.length < 50) break;
        cursor = page[page.length - 1].order_id;
      }
      if (!restored.length) {
        setError("Non ci sono ordini associati a questo codice.");
        return;
      }
      onRestored(restored);
    } catch {
      setError("Recupero non riuscito. Controlla la connessione e riprova: il codice resta valido.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-md px-4 py-8">
      <h1 className="text-2xl">Ritrova i tuoi ordini</h1>
      <p className="my-4 text-sm text-[var(--text-secondary)]">
        Il tuo codice permette di recuperare lo storico, senza account.
      </p>
      {error && (
        <p role="alert" className="mb-4 text-sm">
          {error}
        </p>
      )}
      <Button className="w-full" disabled={busy} onClick={() => void restore()}>
        {busy ? "Recupero gli ordini…" : "Recupera i miei ordini"}
      </Button>
      {/* Un link rovinato non deve lasciare il cliente senza via d'uscita. */}
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <Button variant="ghost" href={appHref("#ordina")}>
          Torna agli ordini
        </Button>
        <Button variant="ghost" href={appHref()}>
          Vai alla Home
        </Button>
      </div>
    </main>
  );
}
