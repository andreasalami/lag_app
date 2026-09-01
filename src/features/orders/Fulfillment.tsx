import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { supabase } from "../../lib/supabaseClient";
import { useAuth } from "../auth/AuthContext";
import { parseQrPayload } from "./orderUtils";
import { QrScanner } from "./QrScanner";
import { BAR_STATIONS, KITCHEN_STATIONS, isFulfillmentStation, type FulfillmentStation } from "./workflow";

type FulfillmentItem = { id: string; name: string; subcategory: string; station: string; quantity: number; delivered_quantity: number };
type FulfillmentOrder = { id: string; display_number: number; alias: string | null; notes: string | null; paid_at: string; status: "pagato" | "ritiro_parziale"; items: FulfillmentItem[] };
type RecentDelivery = { id: string; display_number: number; alias: string | null; created_at: string; can_undo: boolean };

const AREA_STORAGE = { cucina: "lag:kitchen-station", bar: "lag:bar-station" } as const;

export function Fulfillment({ area }: { area: "cucina" | "bar" }) {
  const { role, loading: authLoading } = useAuth();
  const options = area === "cucina" ? KITCHEN_STATIONS : BAR_STATIONS;
  const authorized = role === area || role === "admin";
  const [station, setStation] = useState<FulfillmentStation | null>(() => {
    const saved = localStorage.getItem(AREA_STORAGE[area]);
    return isFulfillmentStation(saved) && options.some((option) => option.key === saved) ? saved : null;
  });
  const [orders, setOrders] = useState<FulfillmentOrder[]>([]);
  const [activeOrder, setActiveOrder] = useState<FulfillmentOrder | null>(null);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [recent, setRecent] = useState<RecentDelivery[]>([]);
  const [numberSearch, setNumberSearch] = useState("");
  const [aliasSearch, setAliasSearch] = useState("");
  const [scannerOpen, setScannerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const selectOrder = useCallback((order: FulfillmentOrder) => {
    setActiveOrder(order);
    setQuantities(Object.fromEntries(order.items.map((item) => [item.id, Math.max(0, item.quantity - item.delivered_quantity)])));
  }, []);

  const refetch = useCallback(async () => {
    if (!authorized || !station) return;
    setLoading(true);
    const { data, error } = await supabase.rpc("get_fulfillment_queue", { p_station: station });
    setLoading(false);
    if (error) { setMessage("Coda non disponibile. Controlla la connessione e riprova."); return; }
    const next = (data ?? []) as FulfillmentOrder[];
    setOrders(next);
    setActiveOrder((current) => current ? next.find((order) => order.id === current.id) ?? null : null);
    if (station !== "cucina") {
      const result = await supabase.rpc("get_recent_fulfillment_deliveries", { p_station: station });
      if (!result.error) setRecent((result.data ?? []) as RecentDelivery[]);
    } else setRecent([]);
  }, [authorized, station]);

  useEffect(() => {
    void refetch();
    if (!authorized || !station) return;
    const channel = supabase.channel(`fulfillment-${area}-${station}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, () => void refetch())
      .on("postgres_changes", { event: "*", schema: "public", table: "order_fulfillment_items" }, () => void refetch())
      .subscribe();
    const timer = window.setInterval(() => void refetch(), 15_000);
    return () => { window.clearInterval(timer); void supabase.removeChannel(channel); };
  }, [area, authorized, refetch, station]);

  const filtered = useMemo(() => orders.filter((order) => (
    (!numberSearch.trim() || String(order.display_number).includes(numberSearch.trim()))
    && (!aliasSearch.trim() || (order.alias ?? "").toLocaleLowerCase("it").includes(aliasSearch.trim().toLocaleLowerCase("it")))
  )), [aliasSearch, numberSearch, orders]);

  function chooseStation(next: FulfillmentStation) {
    localStorage.setItem(AREA_STORAGE[area], next);
    setStation(next); setActiveOrder(null); setMessage(null);
  }

  const handleQrDetected = useCallback(async (rawValue: string) => {
    setScannerOpen(false);
    const token = parseQrPayload(rawValue);
    if (!token || !station) { setMessage("QR non riconosciuto. Cerca l’ordine con numero o alias."); return; }
    setBusy(true);
    const { data, error } = await supabase.rpc("get_fulfillment_order_by_qr", { p_qr_token: token, p_station: station });
    setBusy(false);
    if (error || !data) { setMessage("Questo ordine non ha articoli ancora da ritirare in questa postazione."); return; }
    selectOrder(data as FulfillmentOrder);
  }, [selectOrder, station]);

  async function confirmDelivery() {
    if (!activeOrder || !station || station === "cucina") return;
    const items = activeOrder.items.flatMap((item) => (quantities[item.id] ?? 0) > 0 ? [{ id: item.id, qty: quantities[item.id] }] : []);
    if (items.length === 0) { setMessage("Seleziona almeno una quantità da consegnare."); return; }
    setBusy(true);
    const { error } = await supabase.rpc("deliver_fulfillment_items", { p_order_id: activeOrder.id, p_station: station, p_items: items });
    setBusy(false);
    if (error) { setMessage("Consegna non registrata: la coda potrebbe essere cambiata. Riprova."); await refetch(); return; }
    setMessage(`Consegna dell’ordine #${activeOrder.display_number} registrata.`);
    setActiveOrder(null); await refetch();
  }

  async function undoDelivery(id: string) {
    if (!station) return;
    setBusy(true);
    const { error } = await supabase.rpc("undo_fulfillment_delivery", { p_delivery_id: id, p_station: station });
    setBusy(false);
    setMessage(error ? "Ripristino non riuscito o finestra di 5 minuti scaduta." : "Consegna ripristinata nella coda.");
    await refetch();
  }

  if (authLoading) return <main className="mx-auto max-w-4xl px-4 py-10 text-sm">Carico…</main>;
  if (!authorized) return <main className="mx-auto max-w-4xl px-4 py-10"><h1 className="text-3xl">{area === "cucina" ? "Cucina" : "Bar"}</h1><p className="mt-2">Accesso riservato.</p></main>;
  if (!station) return <main className="mx-auto max-w-3xl px-4 py-8"><h1 className="text-3xl">Scegli la postazione {area}</h1><p className="mt-2 text-sm text-[var(--text-secondary)]">La scelta resta memorizzata su questo dispositivo e può essere cambiata.</p><div className="mt-5 grid gap-3 sm:grid-cols-2">{options.map((option) => <button key={option.key} type="button" onClick={() => chooseStation(option.key)} className="surface-solid rounded-[var(--radius-md)] p-4 text-left"><strong>{option.label}</strong><span className="mt-1 block text-sm text-[var(--text-secondary)]">{option.description}</span></button>)}</div></main>;

  if (activeOrder) {
    const overview = station === "cucina";
    return <main className="mx-auto max-w-3xl px-4 py-8"><div className="flex items-start justify-between gap-3"><div><p className="text-xs text-[var(--accent-primary)]">{options.find((item) => item.key === station)?.label}</p><h1 className="text-3xl">#{activeOrder.display_number} · {activeOrder.alias}</h1></div><Button variant="ghost" onClick={() => setActiveOrder(null)}>Torna alla coda</Button></div>{activeOrder.notes && <div className="mt-4 rounded-[var(--radius-sm)] border-2 border-[var(--state-warning)] p-3"><strong>NOTE:</strong> {activeOrder.notes}</div>}<Card className="mt-5 flex flex-col gap-3">{activeOrder.items.map((item) => { const remaining = item.quantity - item.delivered_quantity; return <div key={item.id} className="flex items-center justify-between gap-3 border-b border-[var(--surface-border)] pb-3 last:border-0 last:pb-0"><div><strong>{item.name}</strong><span className="block text-xs text-[var(--text-secondary)]">Da ritirare: {remaining} su {item.quantity}</span></div>{!overview && <input aria-label={`Quantità ${item.name}`} type="number" min={0} max={remaining} value={quantities[item.id] ?? 0} onChange={(event) => setQuantities((current) => ({ ...current, [item.id]: Math.max(0, Math.min(remaining, Number(event.target.value))) }))} className="field w-20 text-center" />}</div>; })}</Card>{overview ? <p className="mt-4 text-sm text-[var(--text-secondary)]">Vista di preparazione: la consegna viene registrata dalle singole postazioni.</p> : <Button variant="primary" className="mt-5 w-full" onClick={() => void confirmDelivery()} disabled={busy}>{busy ? "Registro…" : "Conferma consegna selezionata"}</Button>}</main>;
  }

  return <main className="mx-auto max-w-4xl px-4 py-8"><div className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-3xl">{options.find((item) => item.key === station)?.label}</h1><p className="text-sm text-[var(--text-secondary)]">{area === "cucina" ? "Cucina" : "Bar"} · coda ordinata dall’orario di pagamento</p></div><Button variant="ghost" onClick={() => setStation(null)}>Cambia postazione</Button></div>{message && <p className="mt-4 rounded-[var(--radius-sm)] border border-[var(--surface-border)] p-3 text-sm">{message}</p>}<div className="mt-5 flex flex-wrap items-end gap-3">{station !== "cucina" && <Button variant="primary" onClick={() => setScannerOpen(true)} disabled={busy}>Scansiona QR</Button>}<label className="min-w-24 flex-1"><span className="mb-1 block text-xs">Numero</span><input type="number" value={numberSearch} onChange={(event) => setNumberSearch(event.target.value)} className="field w-full" /></label><label className="min-w-36 flex-[2]"><span className="mb-1 block text-xs">Nome ordine</span><input value={aliasSearch} onChange={(event) => setAliasSearch(event.target.value)} className="field w-full" /></label></div><p className="mt-3 text-xs text-[var(--text-secondary)]">{loading ? "Aggiorno…" : `${filtered.length} ordini in coda`}</p><div className="mt-3 grid gap-3 sm:grid-cols-2">{filtered.map((order) => <button key={order.id} type="button" onClick={() => selectOrder(order)} className="surface-solid rounded-[var(--radius-md)] p-4 text-left"><strong className="text-xl">#{order.display_number} · {order.alias}</strong><span className="mt-2 block">{order.items.map((item) => `${item.quantity - item.delivered_quantity}× ${item.name}`).join(" · ")}</span>{order.notes && <span className="mt-2 block font-semibold text-[var(--state-warning)]">NOTE: {order.notes}</span>}</button>)}</div>{recent.length > 0 && <section className="mt-8"><h2 className="text-xl">Consegne recenti</h2><div className="mt-3 flex flex-col gap-2">{recent.map((delivery) => <div key={delivery.id} className="surface-solid flex items-center justify-between gap-3 rounded-[var(--radius-md)] p-3"><span>#{delivery.display_number} · {delivery.alias}</span><Button variant="ghost" onClick={() => void undoDelivery(delivery.id)} disabled={busy || (!delivery.can_undo && role !== "admin")}>Annulla consegna</Button></div>)}</div></section>}{scannerOpen && <QrScanner title={`Ritiro ${options.find((item) => item.key === station)?.label}`} description="Scansiona il QR e conferma poi le quantità effettivamente consegnate." onDetected={handleQrDetected} onClose={() => setScannerOpen(false)} />}</main>;
}
