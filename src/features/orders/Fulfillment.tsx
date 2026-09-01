import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { StaffPageHeading, StaffPanel } from "../../components/ui/StaffPanel";
import { supabase } from "../../lib/supabaseClient";
import { useAuth } from "../auth/AuthContext";
import { parseQrPayload } from "./orderUtils";
import { QrScanner } from "./QrScanner";
import { BAR_STATIONS, KITCHEN_STATIONS, type FulfillmentStation } from "./workflow";

type FulfillmentItem = {
  id: string;
  name: string;
  subcategory: string;
  station: string;
  quantity: number;
  delivered_quantity: number;
};

type FulfillmentOrder = {
  id: string;
  display_number: number;
  alias: string | null;
  notes: string | null;
  paid_at: string;
  status: "pagato" | "ritiro_parziale";
  items: FulfillmentItem[];
};

type RecentDelivery = {
  id: string;
  display_number: number;
  alias: string | null;
  created_at: string;
  can_undo: boolean;
};

const AREA_STORAGE = { cucina: "lag:kitchen-station", bar: "lag:bar-station" } as const;
const KITCHEN_ORDER_SOUND_URL = `${import.meta.env.BASE_URL}sounds/line-simple-bell.mp3`;
let kitchenOrderAudio: HTMLAudioElement | null = null;

function playNewKitchenOrderSound() {
  kitchenOrderAudio ??= new Audio(KITCHEN_ORDER_SOUND_URL);
  kitchenOrderAudio.currentTime = 0;
  void kitchenOrderAudio.play().catch(() => {
    // Safari e Chrome richiedono un primo gesto dell’utente: il pulsante Suono lo abilita e lo prova.
  });
}

export function Fulfillment({ area }: { area: "cucina" | "bar" }) {
  const { role, loading: authLoading } = useAuth();
  const options = area === "cucina" ? KITCHEN_STATIONS : BAR_STATIONS;
  const areaLabel = area === "cucina" ? "Cucina" : "Bar";
  const authorized = role === area || role === "admin";
  const [station, setStation] = useState<FulfillmentStation | null>(null);
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
  const [soundEnabled, setSoundEnabled] = useState(() => localStorage.getItem("lag:kitchen-sound") === "on");
  const knownKitchenOrderIds = useRef<Set<string> | null>(null);

  const stationLabel = options.find((item) => item.key === station)?.label ?? areaLabel;

  const selectOrder = useCallback((order: FulfillmentOrder) => {
    setActiveOrder(order);
    setQuantities(Object.fromEntries(order.items.map((item) => [
      item.id,
      Math.max(0, item.quantity - item.delivered_quantity),
    ])));
  }, []);

  const refetch = useCallback(async () => {
    if (!authorized || !station) return;
    setLoading(true);
    const { data, error } = await supabase.rpc("get_fulfillment_queue", { p_station: station });
    setLoading(false);
    if (error) {
      setMessage("Coda non disponibile. Controlla la connessione e riprova.");
      return;
    }
    const next = (data ?? []) as FulfillmentOrder[];
    if (station === "cucina") {
      const nextIds = new Set(next.map((order) => order.id));
      if (knownKitchenOrderIds.current && soundEnabled
        && next.some((order) => !knownKitchenOrderIds.current?.has(order.id))) {
        playNewKitchenOrderSound();
      }
      knownKitchenOrderIds.current = nextIds;
    }
    setOrders(next);
    setActiveOrder((current) => current ? next.find((order) => order.id === current.id) ?? null : null);
    if (station !== "cucina") {
      const result = await supabase.rpc("get_recent_fulfillment_deliveries", { p_station: station });
      if (!result.error) setRecent((result.data ?? []) as RecentDelivery[]);
    } else {
      setRecent([]);
    }
  }, [authorized, soundEnabled, station]);

  useEffect(() => {
    void refetch();
    if (!authorized || !station) return;
    const channel = supabase.channel(`fulfillment-${area}-${station}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, () => void refetch())
      .on("postgres_changes", { event: "*", schema: "public", table: "order_fulfillment_items" }, () => void refetch())
      .subscribe();
    const timer = window.setInterval(() => void refetch(), 15_000);
    return () => {
      window.clearInterval(timer);
      void supabase.removeChannel(channel);
    };
  }, [area, authorized, refetch, station]);

  const filtered = useMemo(() => orders.filter((order) => (
    (!numberSearch.trim() || String(order.display_number).includes(numberSearch.trim()))
    && (!aliasSearch.trim() || (order.alias ?? "").toLocaleLowerCase("it").includes(aliasSearch.trim().toLocaleLowerCase("it")))
  )), [aliasSearch, numberSearch, orders]);

  function chooseStation(next: FulfillmentStation) {
    localStorage.setItem(AREA_STORAGE[area], next);
    knownKitchenOrderIds.current = null;
    setStation(next);
    setActiveOrder(null);
    setMessage(null);
  }

  function toggleKitchenSound() {
    const next = !soundEnabled;
    setSoundEnabled(next);
    localStorage.setItem("lag:kitchen-sound", next ? "on" : "off");
    if (next) playNewKitchenOrderSound();
  }

  const handleQrDetected = useCallback(async (rawValue: string) => {
    setScannerOpen(false);
    const token = parseQrPayload(rawValue);
    if (!token || !station) {
      setMessage("QR non riconosciuto. Cerca l’ordine con numero o alias.");
      return;
    }
    setBusy(true);
    const { data, error } = await supabase.rpc("get_fulfillment_order_by_qr", {
      p_qr_token: token,
      p_station: station,
    });
    setBusy(false);
    if (error || !data) {
      setMessage("Questo ordine non ha articoli ancora da ritirare in questa postazione.");
      return;
    }
    selectOrder(data as FulfillmentOrder);
  }, [selectOrder, station]);

  async function confirmDelivery() {
    if (!activeOrder || !station || station === "cucina") return;
    const items = activeOrder.items.flatMap((item) => (
      (quantities[item.id] ?? 0) > 0 ? [{ id: item.id, qty: quantities[item.id] }] : []
    ));
    if (items.length === 0) {
      setMessage("Seleziona almeno una quantità da consegnare.");
      return;
    }
    setBusy(true);
    const { error } = await supabase.rpc("deliver_fulfillment_items", {
      p_order_id: activeOrder.id,
      p_station: station,
      p_items: items,
    });
    setBusy(false);
    if (error) {
      setMessage("Consegna non registrata: la coda potrebbe essere cambiata. Riprova.");
      await refetch();
      return;
    }
    setMessage(`Consegna dell’ordine #${activeOrder.display_number} registrata.`);
    setActiveOrder(null);
    await refetch();
  }

  async function undoDelivery(id: string) {
    if (!station) return;
    setBusy(true);
    const { error } = await supabase.rpc("undo_fulfillment_delivery", {
      p_delivery_id: id,
      p_station: station,
    });
    setBusy(false);
    setMessage(error ? "Ripristino non riuscito o finestra di 5 minuti scaduta." : "Consegna ripristinata nella coda.");
    await refetch();
  }

  if (authLoading) return <main className="mx-auto max-w-3xl px-4 py-10 text-sm text-[var(--text-secondary)]">Carico…</main>;
  if (!authorized) return <main className="mx-auto max-w-3xl px-4 py-10"><StaffPageHeading title={areaLabel} description="Accesso riservato al personale autorizzato." /></main>;

  if (!station) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-8">
        <StaffPageHeading title={areaLabel} description="Configura la postazione di lavoro su questo dispositivo." />
        <StaffPanel eyebrow="Configurazione dispositivo" title="Scegli la postazione" description="La scelta resta memorizzata e può essere cambiata in seguito.">
          <div className="grid gap-3 sm:grid-cols-2">
            {options.map((option) => (
              <button key={option.key} type="button" onClick={() => chooseStation(option.key)} className="rounded-[var(--radius-md)] border border-[var(--accent-primary)]/45 bg-[rgba(242,128,46,0.08)] p-4 text-left transition-colors hover:bg-[rgba(242,128,46,0.16)]">
                <strong className="font-display text-lg text-[var(--accent-primary)]">{option.label}</strong>
                <span className="mt-1 block text-sm text-[var(--text-secondary)]">{option.description}</span>
              </button>
            ))}
          </div>
        </StaffPanel>
      </main>
    );
  }

  if (activeOrder) {
    const overview = station === "cucina";
    return (
      <main className="mx-auto max-w-3xl px-4 py-8">
        <StaffPageHeading title="Gestione ritiro" description={`${areaLabel} · ${stationLabel}`} action={<Button variant="staff-secondary" onClick={() => setActiveOrder(null)}>Torna alla coda</Button>} />
        <StaffPanel eyebrow={`Ordine #${activeOrder.display_number}`} title={activeOrder.alias ?? "Senza nome"} description={overview ? "Vista generale di preparazione" : "Seleziona le quantità effettivamente consegnate"}>
          {activeOrder.notes && <div className="mb-4 rounded-[var(--radius-sm)] border-2 border-[var(--state-warning)] p-3 text-sm"><strong>NOTE:</strong> {activeOrder.notes}</div>}
          <div className="flex flex-col gap-3">
            {activeOrder.items.map((item) => {
              const remaining = item.quantity - item.delivered_quantity;
              return (
                <div key={item.id} className="flex items-center justify-between gap-3 border-b border-[var(--surface-border)] pb-3 last:border-0 last:pb-0">
                  <div>
                    <strong>{item.name}</strong>
                    <span className="block text-xs text-[var(--text-secondary)]">Da ritirare: {remaining} su {item.quantity}</span>
                  </div>
                  {!overview && (
                    <input aria-label={`Quantità ${item.name}`} type="number" min={0} max={remaining} value={quantities[item.id] ?? 0} onChange={(event) => setQuantities((current) => ({ ...current, [item.id]: Math.max(0, Math.min(remaining, Number(event.target.value))) }))} className="field w-20 py-2 text-center" />
                  )}
                </div>
              );
            })}
          </div>
          {overview ? (
            <p className="mt-4 border-t border-[var(--surface-border)] pt-4 text-sm text-[var(--text-secondary)]">La consegna viene registrata dalle singole postazioni.</p>
          ) : (
            <Button variant="staff-primary" className="mt-5 w-full" onClick={() => void confirmDelivery()} disabled={busy}>{busy ? "Registro…" : "Conferma consegna selezionata"}</Button>
          )}
        </StaffPanel>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <StaffPageHeading title={stationLabel} description={`${areaLabel} · coda ordinata dall’orario di pagamento`} action={<Button variant="staff-secondary" onClick={() => setStation(null)}>Cambia postazione</Button>} />
      {message && <div className="mb-4 rounded-[var(--radius-sm)] border border-[var(--surface-border)] p-3 text-sm">{message}</div>}
      <StaffPanel
        eyebrow="Ritiro ordini"
        title="Coda della postazione"
        description={loading ? "Aggiornamento in corso…" : `${filtered.length} ordini da gestire`}
        action={station === "cucina" ? (
          <Button
            type="button"
            variant={soundEnabled ? "staff-primary" : "staff-secondary"}
            className="px-4 py-2 text-xs"
            onClick={toggleKitchenSound}
            aria-pressed={soundEnabled}
          >
            {soundEnabled ? "Suono attivo" : "Attiva suono"}
          </Button>
        ) : undefined}
      >
        <div className="flex flex-wrap items-end gap-3">
          {station !== "cucina" && <Button variant="staff-primary" onClick={() => setScannerOpen(true)} disabled={busy}>Scansiona QR</Button>}
          <label className="min-w-24 flex-1"><span className="mb-1 block text-xs">Numero</span><input type="number" value={numberSearch} onChange={(event) => setNumberSearch(event.target.value)} className="field w-full py-2" /></label>
          <label className="min-w-36 flex-[2]"><span className="mb-1 block text-xs">Nome ordine</span><input value={aliasSearch} onChange={(event) => setAliasSearch(event.target.value)} className="field w-full py-2" /></label>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {filtered.map((order) => (
            <button key={order.id} type="button" onClick={() => selectOrder(order)} className="rounded-[var(--radius-md)] border border-[var(--accent-primary)]/45 bg-[rgba(242,128,46,0.08)] p-4 text-left transition-colors hover:bg-[rgba(242,128,46,0.16)]">
              <strong className="font-display text-xl text-[var(--accent-primary)]">#{order.display_number} · {order.alias}</strong>
              <span className="mt-2 block text-sm">{order.items.map((item) => `${item.quantity - item.delivered_quantity}× ${item.name}`).join(" · ")}</span>
              {order.notes && <span className="mt-2 block text-sm font-semibold text-[var(--state-warning)]">NOTE: {order.notes}</span>}
            </button>
          ))}
          {!loading && filtered.length === 0 && <p className="text-sm text-[var(--text-secondary)]">Nessun ordine in questa postazione.</p>}
        </div>
      </StaffPanel>

      {recent.length > 0 && (
        <StaffPanel className="mt-6" eyebrow="Controllo operativo" title="Consegne recenti" description="Puoi ripristinare una consegna registrata per errore.">
          <div className="flex flex-col gap-2">
            {recent.map((delivery) => (
              <div key={delivery.id} className="flex items-center justify-between gap-3 border-b border-[var(--surface-border)] py-2 last:border-0">
                <span>#{delivery.display_number} · {delivery.alias}</span>
                <Button variant="staff-secondary" onClick={() => void undoDelivery(delivery.id)} disabled={busy || (!delivery.can_undo && role !== "admin")}>Annulla consegna</Button>
              </div>
            ))}
          </div>
        </StaffPanel>
      )}

      {scannerOpen && <QrScanner title={`Ritiro ${stationLabel}`} description="Scansiona il QR e conferma poi le quantità effettivamente consegnate." onDetected={handleQrDetected} onClose={() => setScannerOpen(false)} />}
    </main>
  );
}
