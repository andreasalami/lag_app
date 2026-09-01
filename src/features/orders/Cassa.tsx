import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Modal } from "../../components/ui/Modal";
import { supabase } from "../../lib/supabaseClient";
import { useSupabaseRows } from "../../lib/useSupabaseRows";
import { useAuth } from "../auth/AuthContext";
import { downloadCsv, parseQrPayload, priceFormatter, type EventReport } from "./orderUtils";
import { OrderEditor } from "./OrderEditor";
import { QrScanner } from "./QrScanner";
import type { OrderLine, OrderMenuItem, StaffOrder } from "./types";
import { CASH_STATIONS, cashStationLabel, isCashStation, type CashStation } from "./workflow";

type PendingOrder = Pick<StaffOrder,
  "id" | "event_id" | "display_number" | "alias" | "total" | "created_at" | "status" | "claim_expires_at"
> & { claimed_station: CashStation | null };

type EventState = {
  id: string;
  name: string;
  opens_at: string;
  closes_at: string;
  manual_closed: boolean;
  permanently_closed_at: string | null;
  max_pending_orders: number;
  pending_count: number;
  final_report: EventReport | null;
};

type Tab = "ordini" | "manuale" | "evento";

function toLocalDateTime(iso: string) {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function orderAge(createdAt: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 60000));
  if (minutes < 1) return "adesso";
  if (minutes < 60) return `${minutes} min fa`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min fa`;
}

export function Cassa() {
  const { role, loading: authLoading } = useAuth();
  const [tab, setTab] = useState<Tab>("ordini");
  const [pendingOrders, setPendingOrders] = useState<PendingOrder[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [numberSearch, setNumberSearch] = useState("");
  const [aliasSearch, setAliasSearch] = useState("");
  const [scannerOpen, setScannerOpen] = useState(false);
  const [activeOrder, setActiveOrder] = useState<StaffOrder | null>(null);
  const [cashStation, setCashStation] = useState<CashStation | null>(() => {
    const saved = localStorage.getItem("lag:cash-station");
    return isCashStation(saved) ? saved : null;
  });
  const [actionBusy, setActionBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [counterAlias, setCounterAlias] = useState("");
  const [counterNotes, setCounterNotes] = useState("");
  const [counterCart, setCounterCart] = useState<Record<string, OrderLine>>({});
  const [eventState, setEventState] = useState<EventState | null>(null);
  const [eventName, setEventName] = useState("");
  const [eventOpens, setEventOpens] = useState("");
  const [eventCloses, setEventCloses] = useState("");
  const [eventLimit, setEventLimit] = useState(150);
  const [closeEventModal, setCloseEventModal] = useState(false);
  const [cancelOrderModal, setCancelOrderModal] = useState(false);
  const [closeEventText, setCloseEventText] = useState("");
  const [, setClockTick] = useState(0);
  const deviceIdRef = useRef(localStorage.getItem("lag:cash-device-id") ?? crypto.randomUUID());
  const activeOrderRef = useRef<StaffOrder | null>(null);

  const { rows: menuItems, loading: menuLoading, refetch: refetchMenu } = useSupabaseRows<OrderMenuItem>({
    table: "menu_items",
    select: "id, category, subcategory, name, price, available_portions, stock_capacity, allergens",
    orderBy: [{ column: "category" }, { column: "name" }],
    fallback: [],
  });

  const authorized = role === "cassa" || role === "admin";

  const refetchOrders = useCallback(async () => {
    if (!authorized) return;
    const { data, error } = await supabase.rpc("get_cashier_pending_orders");
    if (error) setMessage("Elenco ordini non disponibile. Riprova.");
    else setPendingOrders((data ?? []) as PendingOrder[]);
    setOrdersLoading(false);
  }, [authorized]);

  const loadEventState = useCallback(async () => {
    if (!authorized) return;
    const { data, error } = await supabase.rpc("get_order_event_admin_state");
    if (error || !data) {
      setMessage("Impostazioni evento non disponibili.");
      return;
    }
    const next = data as EventState;
    setEventState(next);
    setEventName(next.name);
    setEventOpens(toLocalDateTime(next.opens_at));
    setEventCloses(toLocalDateTime(next.closes_at));
    setEventLimit(next.max_pending_orders);
  }, [authorized]);

  useEffect(() => {
    localStorage.setItem("lag:cash-device-id", deviceIdRef.current);
  }, []);

  useEffect(() => {
    if (!authorized) return;
    void refetchOrders();
    void loadEventState();
    const channel = supabase
      .channel("orders-register")
      .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, () => void refetchOrders())
      .subscribe();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refetchOrders();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      void supabase.removeChannel(channel);
    };
  }, [authorized, loadEventState, refetchOrders]);

  useEffect(() => {
    const timer = window.setInterval(() => setClockTick((value) => value + 1), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    activeOrderRef.current = activeOrder;
  }, [activeOrder]);

  useEffect(() => {
    return () => {
      if (activeOrderRef.current) {
        void supabase.rpc("release_order_for_station", {
          p_order_id: activeOrderRef.current.id,
          p_station: cashStation,
          p_device_id: deviceIdRef.current,
        });
      }
    };
  }, [cashStation]);

  useEffect(() => {
    if (!activeOrder || !cashStation) return;
    const timer = window.setInterval(() => {
      void supabase.rpc("claim_order_for_station", {
        p_order_id: activeOrder.id,
        p_station: cashStation,
        p_device_id: deviceIdRef.current,
      });
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [activeOrder, cashStation]);

  const filteredOrders = useMemo(() => pendingOrders.filter((order) => {
    const numberMatches = !numberSearch.trim() || String(order.display_number).includes(numberSearch.trim());
    const aliasMatches = !aliasSearch.trim() || (order.alias ?? "").toLocaleLowerCase("it").includes(aliasSearch.trim().toLocaleLowerCase("it"));
    return numberMatches && aliasMatches;
  }), [aliasSearch, numberSearch, pendingOrders]);

  function setClaimedOrder(order: StaffOrder) {
    setActiveOrder(order);
    setScannerOpen(false);
  }

  async function claimOrder(id: string) {
    if (!cashStation) return;
    setActionBusy(true);
    setMessage(null);
    const { data, error } = await supabase.rpc("claim_order_for_station", {
      p_order_id: id,
      p_station: cashStation,
      p_device_id: deviceIdRef.current,
    });
    setActionBusy(false);
    if (error || !data) {
      setMessage(error?.message.includes("already_claimed")
        ? "Ordine già preso in carico da un’altra cassa."
        : "Ordine non più disponibile. Aggiorno l’elenco.");
      void refetchOrders();
      return;
    }
    setClaimedOrder(data as StaffOrder);
  }

  const handleQrDetected = useCallback(async (rawValue: string) => {
    const token = parseQrPayload(rawValue);
    if (!token) {
      setScannerOpen(false);
      setMessage("QR non riconosciuto. Cerca l’ordine manualmente.");
      return;
    }
    setActionBusy(true);
    if (!cashStation) return;
    const { data, error } = await supabase.rpc("claim_order_by_qr_for_station", {
      p_qr_token: token,
      p_station: cashStation,
      p_device_id: deviceIdRef.current,
    });
    setActionBusy(false);
    setScannerOpen(false);
    if (error || !data) {
      setMessage(error?.message.includes("already_claimed")
        ? "Ordine già preso in carico da un’altra cassa."
        : "QR non associato a un ordine in attesa. Usa la ricerca manuale.");
      return;
    }
    setClaimedOrder(data as StaffOrder);
  }, [cashStation]);

  async function releaseActiveOrder() {
    if (!activeOrder) return;
    setActionBusy(true);
    await supabase.rpc("release_order_for_station", {
      p_order_id: activeOrder.id,
      p_station: cashStation,
      p_device_id: deviceIdRef.current,
    });
    setActionBusy(false);
    setActiveOrder(null);
    void refetchOrders();
  }

  async function payActiveOrder() {
    if (!activeOrder || !cashStation) return;
    setActionBusy(true);
    const { error } = await supabase.rpc("pay_order_for_station", {
      p_order_id: activeOrder.id,
      p_station: cashStation,
      p_device_id: deviceIdRef.current,
    });
    setActionBusy(false);
    if (error) {
      setMessage("Pagamento non confermato nell’app. Riprova prima di chiudere l’ordine.");
      return;
    }
    setMessage(`Ordine #${activeOrder.display_number} pagato e inviato alle postazioni.`);
    setActiveOrder(null);
    void refetchOrders();
  }

  async function cancelActiveOrder() {
    if (!activeOrder || !cashStation) return;
    setActionBusy(true);
    const { error } = await supabase.rpc("cancel_order_for_station", {
      p_order_id: activeOrder.id,
      p_station: cashStation,
      p_device_id: deviceIdRef.current,
    });
    setActionBusy(false);
    if (error) setMessage("Ordine non annullato. Riprova.");
    else {
      setCancelOrderModal(false);
      setMessage(`Ordine #${activeOrder.display_number} annullato.`);
      setActiveOrder(null);
      void refetchOrders();
      void refetchMenu();
    }
  }

  async function createCounterOrder() {
    const lines = Object.values(counterCart);
    if (counterAlias.trim().length < 2 || lines.length === 0) {
      setMessage("Inserisci alias e almeno una voce.");
      return;
    }
    if (!window.confirm("Confermi che le voci sono state battute e il pagamento è stato ricevuto?")) return;
    setActionBusy(true);
    const { data, error } = await supabase.rpc("create_counter_order", {
      p_alias: counterAlias.trim(),
      p_notes: counterNotes.trim(),
      p_items: lines.map((line) => ({ id: line.id, qty: line.qty })),
    });
    setActionBusy(false);
    if (error || !data) {
      setMessage(error?.message.includes("stock_unavailable:")
        ? `Scorte insufficienti: ${error.message.split("stock_unavailable:")[1]}`
        : "Ordine eccezionale non creato.");
      return;
    }
    const created = data as StaffOrder;
    setMessage(`Ordine #${created.display_number} creato, pagato e inviato.`);
    setCounterAlias("");
    setCounterNotes("");
    setCounterCart({});
    void refetchMenu();
  }

  async function saveEventSettings() {
    setActionBusy(true);
    const { error } = await supabase.rpc("update_order_event", {
      p_name: eventName.trim(),
      p_opens_at: new Date(eventOpens).toISOString(),
      p_closes_at: new Date(eventCloses).toISOString(),
      p_max_pending_orders: eventLimit,
    });
    setActionBusy(false);
    if (error) setMessage("Impostazioni evento non salvate. Controlla date e limite.");
    else {
      setMessage("Impostazioni evento salvate.");
      void loadEventState();
    }
  }

  async function toggleOrderingPaused() {
    if (!eventState) return;
    setActionBusy(true);
    const { error } = await supabase.rpc("set_ordering_paused", { p_paused: !eventState.manual_closed });
    setActionBusy(false);
    if (error) setMessage("Stato ordinazioni non aggiornato.");
    else void loadEventState();
  }

  async function closeEventPermanently() {
    setActionBusy(true);
    const { data, error } = await supabase.rpc("close_order_event");
    setActionBusy(false);
    setCloseEventModal(false);
    setCloseEventText("");
    if (error || !data) {
      setMessage("Evento non chiuso. Riprova.");
      return;
    }
    downloadCsv(data as EventReport);
    setMessage("Evento chiuso e report anonimo scaricato.");
    void loadEventState();
    void refetchOrders();
  }

  async function downloadExistingReport() {
    const { data, error } = await supabase.rpc("get_order_event_report");
    if (error || !data) setMessage("Report non disponibile.");
    else downloadCsv(data as EventReport);
  }

  async function createNextEvent() {
    setActionBusy(true);
    const { error } = await supabase.rpc("create_next_order_event", {
      p_name: eventName.trim(),
      p_opens_at: new Date(eventOpens).toISOString(),
      p_closes_at: new Date(eventCloses).toISOString(),
      p_max_pending_orders: eventLimit,
    });
    setActionBusy(false);
    if (error) setMessage("Nuovo evento non creato. Controlla nome e date future.");
    else {
      setMessage("Nuovo evento creato: la numerazione ripartirà da 1.");
      void loadEventState();
    }
  }

  if (authLoading) return <section className="mx-auto max-w-4xl px-4 py-10 text-sm text-[var(--text-secondary)]">Carico…</section>;
  if (!authorized) {
    return (
      <section className="mx-auto max-w-4xl px-4 py-10">
        <h1 className="text-2xl">Cassa</h1>
        <p className="mt-3 text-sm text-[var(--text-secondary)]">Accedi dall’area Staff con un account cassa.</p>
      </section>
    );
  }

  if (!cashStation) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="text-3xl">Scegli la cassa</h1>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">Puoi collegare uno o due dispositivi alla stessa cassa. La scelta resta memorizzata su questo dispositivo.</p>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {CASH_STATIONS.map((station) => (
            <button key={station.key} type="button" onClick={() => { localStorage.setItem("lag:cash-station", station.key); setCashStation(station.key); }} className="surface-solid rounded-[var(--radius-md)] p-4 text-left font-semibold">
              {station.label}
            </button>
          ))}
        </div>
      </main>
    );
  }

  if (activeOrder) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs text-[var(--state-warning)]">{cashStationLabel(cashStation)} · ordine in sola lettura</p>
            <h1 className="text-3xl">#{activeOrder.display_number} · {activeOrder.alias}</h1>
          </div>
          <Button variant="ghost" onClick={() => void releaseActiveOrder()} disabled={actionBusy}>Chiudi senza pagare</Button>
        </div>
        <p className="mt-3 rounded-[var(--radius-sm)] border border-[var(--state-warning)] p-3 text-sm text-[var(--state-warning)]">Prepara lo scontrino sul registratore. Questo ordine non può essere modificato dalla cassa.</p>
        {activeOrder.notes && <div className="mt-4 rounded-[var(--radius-sm)] border-2 border-[var(--state-warning)] p-3"><strong>NOTE:</strong> {activeOrder.notes}</div>}
        <Card className="mt-5 flex flex-col gap-2">
          {activeOrder.items.map((line) => <div key={line.id} className="flex justify-between gap-3"><strong>{line.qty}× {line.name}</strong><span className="font-mono">{priceFormatter.format(Number(line.price) * line.qty)}</span></div>)}
          <div className="mt-2 flex justify-between border-t border-[var(--surface-border)] pt-3 text-lg font-semibold"><span>Totale</span><span className="font-mono">{priceFormatter.format(Number(activeOrder.total))}</span></div>
        </Card>
        {message && <p className="mt-3 text-sm text-[var(--state-error)]">{message}</p>}
        <div className="mt-5 flex flex-wrap justify-between gap-3">
          <Button variant="ghost" onClick={() => setCancelOrderModal(true)} disabled={actionBusy}>Annulla ordine</Button>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => void payActiveOrder()} disabled={actionBusy}>
              {actionBusy ? "Attendi…" : "Pagato e invia"}
            </Button>
          </div>
        </div>
        <Modal
          open={cancelOrderModal}
          title={`Annullare l’ordine #${activeOrder.display_number}?`}
          dismissible={!actionBusy}
          onClose={() => setCancelOrderModal(false)}
          actions={(
            <>
              <Button variant="ghost" onClick={() => setCancelOrderModal(false)} disabled={actionBusy}>No, torna all’ordine</Button>
              <Button variant="primary" onClick={() => void cancelActiveOrder()} disabled={actionBusy}>{actionBusy ? "Annullamento…" : "Sì, annulla ordine"}</Button>
            </>
          )}
        >
          <p>L’annullamento è definitivo e ripristina le scorte. Usa questa azione solo se l’ordine deve essere eliminato.</p>
        </Modal>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl">{cashStationLabel(cashStation)}</h1>
          <p className="text-sm text-[var(--text-secondary)]">Preordini, ordine eccezionale ed evento.</p>
        </div>
        <div className="flex flex-col items-end gap-1"><a href={`${import.meta.env.BASE_URL}#staff`} className="text-xs text-[var(--text-secondary)] hover:underline">Area staff</a><button type="button" onClick={() => setCashStation(null)} className="text-xs text-[var(--text-secondary)] hover:underline">Cambia cassa</button></div>
      </div>

      <div className="mt-5 grid grid-cols-3 rounded-[var(--radius-pill)] border border-[var(--surface-border)] p-1">
        {(["ordini", "manuale", "evento"] as Tab[]).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={`rounded-[var(--radius-pill)] px-2 py-2 text-xs sm:text-sm ${tab === value ? "bg-[var(--accent-primary)] text-[var(--text-on-accent)]" : "text-[var(--text-secondary)]"}`}
          >
            {value === "ordini" ? "Ordini" : value === "manuale" ? "Ordine in cassa" : "Evento"}
          </button>
        ))}
      </div>

      {message && (
        <div className="mt-4 flex items-start justify-between gap-3 rounded-[var(--radius-sm)] border border-[var(--surface-border)] p-3 text-sm">
          <span>{message}</span>
          <button type="button" onClick={() => setMessage(null)} aria-label="Chiudi">×</button>
        </div>
      )}

      {tab === "ordini" && (
        <section className="mt-6">
          <div className="flex flex-wrap items-end gap-3">
            <Button variant="primary" onClick={() => setScannerOpen(true)} disabled={actionBusy}>Scansiona QR</Button>
            <label className="min-w-28 flex-1">
              <span className="mb-1 block text-xs">Numero</span>
              <input type="number" inputMode="numeric" value={numberSearch} onChange={(event) => setNumberSearch(event.target.value)} className="field w-full py-2" />
            </label>
            <label className="min-w-36 flex-[2]">
              <span className="mb-1 block text-xs">Alias</span>
              <input value={aliasSearch} onChange={(event) => setAliasSearch(event.target.value)} className="field w-full py-2" />
            </label>
          </div>
          <p className="mt-3 text-xs text-[var(--text-secondary)]">
            {filteredOrders.length} ordini trovati. Numero e alias possono essere usati insieme.
          </p>
          {ordersLoading ? <p className="mt-4 text-sm text-[var(--text-secondary)]">Carico…</p> : (
            <div className="mt-3 flex flex-col gap-2">
              {filteredOrders.map((order) => {
                const claimed = order.claimed_station !== null && order.claim_expires_at !== null && new Date(order.claim_expires_at).getTime() > Date.now();
                const ours = order.claimed_station === cashStation;
                return (
                  <div key={order.id} className="surface-solid flex items-center justify-between gap-3 rounded-[var(--radius-md)] p-3 text-left">
                    <span>
                      <strong>#{order.display_number} · {order.alias}</strong>
                      <span className="mt-1 block text-xs text-[var(--text-secondary)]">
                        {claimed ? `In gestione a ${cashStationLabel(order.claimed_station!)}` : orderAge(order.created_at)}
                      </span>
                    </span>
                    <div className="flex items-center gap-2"><span className="font-mono text-[var(--accent-primary)]">{priceFormatter.format(Number(order.total))}</span>{(!claimed || ours) ? <Button variant="ghost" onClick={() => void claimOrder(order.id)} disabled={actionBusy}>Apri</Button> : <Button variant="ghost" onClick={async () => { await supabase.rpc("force_release_order", { p_order_id: order.id }); void refetchOrders(); }} disabled={actionBusy}>Sblocca</Button>}</div>
                  </div>
                );
              })}
              {filteredOrders.length === 0 && <p className="text-sm text-[var(--text-secondary)]">Nessun ordine corrispondente.</p>}
            </div>
          )}
        </section>
      )}

      {tab === "manuale" && (
        <section className="mt-6">
          <h2 className="text-xl">Ordine eccezionale dalla cassa</h2>
          <p className="mb-4 mt-1 text-sm text-[var(--text-secondary)]">
            Solo per emergenze. L’ordine viene creato già pagato e inviato direttamente alle postazioni competenti.
          </p>
          {menuLoading ? <p className="text-sm text-[var(--text-secondary)]">Carico il menu…</p> : (
            <OrderEditor
              menuItems={menuItems}
              cart={counterCart}
              setCart={setCounterCart}
              alias={counterAlias}
              setAlias={setCounterAlias}
              notes={counterNotes}
              setNotes={setCounterNotes}
            />
          )}
          <Button variant="primary" className="mt-4 w-full sm:w-auto" onClick={() => void createCounterOrder()} disabled={actionBusy || menuLoading}>
            {actionBusy ? "Invio…" : "Conferma pagamento e invia"}
          </Button>
        </section>
      )}

      {tab === "evento" && eventState && (
        <section className="mt-6">
          <Card className="flex flex-col gap-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-xl">{eventState.name}</h2>
                <p className="text-xs text-[var(--text-secondary)]">{eventState.pending_count} ordini in attesa su {eventState.max_pending_orders}</p>
              </div>
              {eventState.permanently_closed_at ? (
                <span className="text-sm text-[var(--state-error)]">Evento chiuso definitivamente</span>
              ) : (
                <span className={`text-sm ${eventState.manual_closed ? "text-[var(--state-warning)]" : "text-[var(--state-success)]"}`}>
                  {eventState.manual_closed ? "Ordinazioni sospese" : "Gestione automatica attiva"}
                </span>
              )}
            </div>

            <label>
              <span className="mb-1 block text-xs">Nome evento</span>
              <input value={eventName} onChange={(event) => setEventName(event.target.value)} className="field w-full py-2" />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label>
                <span className="mb-1 block text-xs">Apertura ordini</span>
                <input type="datetime-local" value={eventOpens} onChange={(event) => setEventOpens(event.target.value)} className="field w-full py-2" />
              </label>
              <label>
                <span className="mb-1 block text-xs">Chiusura ordini</span>
                <input type="datetime-local" value={eventCloses} onChange={(event) => setEventCloses(event.target.value)} className="field w-full py-2" />
              </label>
            </div>
            <label>
              <span className="mb-1 block text-xs">Massimo ordini contemporaneamente in attesa</span>
              <input type="number" min={10} max={1000} value={eventLimit} onChange={(event) => setEventLimit(Number(event.target.value))} className="field w-full py-2 sm:w-40" />
            </label>

            {eventState.permanently_closed_at ? (
              <div className="flex flex-wrap gap-2">
                <Button variant="ghost" onClick={() => void downloadExistingReport()}>Scarica di nuovo il CSV</Button>
                <Button variant="primary" onClick={() => void createNextEvent()} disabled={actionBusy}>Crea nuovo evento</Button>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  <Button variant="ghost" onClick={() => void saveEventSettings()} disabled={actionBusy}>Salva orari e limite</Button>
                  <Button variant={eventState.manual_closed ? "primary" : "ghost"} onClick={() => void toggleOrderingPaused()} disabled={actionBusy}>
                    {eventState.manual_closed ? "Riapri ordinazioni" : "Chiudi ordinazioni ora"}
                  </Button>
                </div>
                <div className="mt-3 border-t border-[var(--surface-border)] pt-3">
                  <p className="text-xs text-[var(--state-error)]">La chiusura definitiva annulla gli ordini non pagati, anonimizza i dati e produce il CSV finale.</p>
                  <Button variant="ghost" className="mt-2" onClick={() => setCloseEventModal(true)}>Chiudi definitivamente l’evento</Button>
                </div>
              </>
            )}
          </Card>
        </section>
      )}

      {scannerOpen && <QrScanner onDetected={handleQrDetected} onClose={() => setScannerOpen(false)} />}

      <Modal
        open={closeEventModal}
        title="Chiusura definitiva evento"
        dismissible={!actionBusy}
        onClose={() => setCloseEventModal(false)}
        actions={(
          <>
            <Button variant="ghost" onClick={() => setCloseEventModal(false)} disabled={actionBusy}>Annulla</Button>
            <Button variant="primary" onClick={() => void closeEventPermanently()} disabled={closeEventText !== "CHIUDI EVENTO" || actionBusy}>
              Chiudi e scarica CSV
            </Button>
          </>
        )}
      >
        <p>L’operazione è irreversibile. Digita <strong className="text-[var(--text-primary)]">CHIUDI EVENTO</strong> per confermare.</p>
        <input value={closeEventText} onChange={(event) => setCloseEventText(event.target.value)} className="field mt-3 w-full py-2" />
      </Modal>
    </main>
  );
}
