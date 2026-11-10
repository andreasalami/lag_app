import { supabase } from "../../lib/supabaseClient";

/** Quanto resta da evadere di un prodotto: porzioni pagate da consegnare e porzioni in ordini non ancora pagati. */
export type Commitment = {
  paid_portions: number;
  paid_orders: number;
  unpaid_portions: number;
  unpaid_orders: number;
};

const count = (n: number, singular: string, plural: string) => `${n} ${n === 1 ? singular : plural}`;

/** I conteggi arrivano dal database: si accettano solo righe con la forma attesa. */
export function parseCommitments(data: unknown) {
  const commitments = new Map<string, Commitment>();
  if (!Array.isArray(data)) return commitments;
  for (const row of data as Array<Record<string, unknown>>) {
    const numbers = [row?.paid_portions, row?.paid_orders, row?.unpaid_portions, row?.unpaid_orders];
    if (typeof row?.id !== "string" || !numbers.every((value) => Number.isInteger(value))) continue;
    const [paid_portions, paid_orders, unpaid_portions, unpaid_orders] = numbers as number[];
    commitments.set(row.id, { paid_portions, paid_orders, unpaid_portions, unpaid_orders });
  }
  return commitments;
}

/** Conteggi per prodotto; null se la rete o i permessi non lo consentono. */
export async function fetchCommitments() {
  const { data, error } = await supabase.rpc("get_menu_item_commitments");
  return error ? null : parseCommitments(data);
}

/** Frase per chi sta per sospendere o eliminare: gli ordini già inviati vanno comunque evasi. */
export function commitmentSummary(commitment: Commitment | undefined) {
  const paid = commitment?.paid_portions
    ? `${count(commitment.paid_portions, "porzione", "porzioni")} in ${count(commitment.paid_orders, "ordine pagato", "ordini pagati")}`
    : null;
  const unpaid = commitment?.unpaid_portions
    ? `${count(commitment.unpaid_portions, "porzione", "porzioni")} in ${count(commitment.unpaid_orders, "ordine non ancora pagato", "ordini non ancora pagati")}`
    : null;
  if (!paid && !unpaid) return "Nessun ordine in corso contiene questo prodotto.";
  return `Ancora da preparare: ${[paid, unpaid].filter(Boolean).join(", più ")}.`;
}

/**
 * Sospende o riattiva subito un prodotto. L'RLS decide chi può: "missing" significa che
 * il prodotto è stato eliminato oppure non è gestibile da questo ruolo.
 */
export async function setSuspended(id: string, suspended: boolean): Promise<"ok" | "missing" | "error"> {
  const { data, error } = await supabase.from("menu_items").update({ suspended }).eq("id", id).select("id");
  if (error) return "error";
  return data.length > 0 ? "ok" : "missing";
}
