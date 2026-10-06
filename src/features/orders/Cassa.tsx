import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { Notice } from "../../components/ui/Notice";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { StaffPageHeading, StaffPanel } from "../../components/ui/StaffPanel";
import { pollWhileVisible, readStorage, writeStorage } from "../../lib/browser";
import { supabase } from "../../lib/supabaseClient";
import { useSupabaseRows } from "../../lib/useSupabaseRows";
import { lineTotal, type Cart } from "./cart";
import { OrderEditor } from "./OrderEditor";
import { OrderNotes } from "./OrderNotes";
import { parseQrPayload, priceFormatter } from "./orderUtils";
import { PreparationChoice } from "./PreparationChoice";
import { QrScanner } from "./QrScanner";
import { StationPicker } from "./StationPicker";
import { useEventStation } from "./stationMemory";
import type { OrderMenuItem, PreparationMode, StaffOrder } from "./types";
import {
  CASH_STATIONS,
  STATION_STORAGE_KEYS,
  cashStationLabel,
  matchesOrderSearch,
  type CashStation,
} from "./workflow";

type PendingOrder = Pick<
  StaffOrder,
  "id" | "event_id" | "display_number" | "alias" | "total" | "created_at" | "status" | "claim_expires_at"
> & { claimed_station: CashStation | null };

type Tab = "ordini" | "manuale";

const DEVICE_ID_KEY = "lag:cash-device-id";

function orderAge(createdAt: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 60000));
  if (minutes < 1) return "adesso";
  if (minutes < 60) return `${minutes} min fa`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min fa`;
}

export function Cassa() {
  const [tab, setTab] = useState<Tab>("ordini");
  const [pendingOrders, setPendingOrders] = useState<PendingOrder[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [numberSearch, setNumberSearch] = useState("");
  const [aliasSearch, setAliasSearch] = useState("");
  const [scannerOpen, setScannerOpen] = useState(false);
  const [activeOrder, setActiveOrder] = useState<StaffOrder | null>(null);
  const [cashStation, chooseStation, stationChecked] = useEventStation(STATION_STORAGE_KEYS.cassa, CASH_STATIONS);
  const [actionBusy, setActionBusy] = useState(false);
  const [claimValidUntil, setClaimValidUntil] = useState(0);
  const [claimsUnavailable, setClaimsUnavailable] = useState(false);
  const queueRequestRef = useRef(0);
  const [message, setMessage] = useState<string | null>(null);
  const [counterAlias, setCounterAlias] = useState("");
  const [counterNotes, setCounterNotes] = useState("");
  const [counterCart, setCounterCart] = useState<Cart>({});
  const [counterPreparation, setCounterPreparation] = useState<PreparationMode>("immediate");
  const [confirmCounterOrder, setConfirmCounterOrder] = useState(false);
  const [cancelOrderModal, setCancelOrderModal] = useState(false);
  const [unlockTarget, setUnlockTarget] = useState<PendingOrder | null>(null);
  const [, setClockTick] = useState(0);
  const [deviceId] = useState(() => readStorage(DEVICE_ID_KEY) ?? crypto.randomUUID());
  const deviceIdRef = useRef(deviceId);
  const activeOrderRef = useRef<StaffOrder | null>(null);

  const {
    rows: menuItems,
    loading: menuLoading,
    refetch: refetchMenu,
  } = useSupabaseRows<OrderMenuItem>({
    table: "menu_items",
    select: "id, category, subcategory, name, price, available_portions, stock_capacity, allergens",
    orderBy: [{ column: "category" }, { column: "name" }],
    fallback: [],
  });

  const refetchOrders = useCallback(async () => {
    const request = ++queueRequestRef.current;
    const { data, error } = await supabase.rpc("get_cashier_pending_orders");
    if (request !== queueRequestRef.current) return;
    if (error) setMessage("Elenco ordini non disponibile. Riprova.");
    else setPendingOrders((data ?? []) as PendingOrder[]);
    setOrdersLoading(false);
  }, []);

  useEffect(() => {
    if (!writeStorage(DEVICE_ID_KEY, deviceIdRef.current)) {
      setMessage(
        "Il browser non conserva la sessione di cassa. Evita di ricaricare durante un ordine: il controllo sarà rilasciato alla sua scadenza.",
      );
    }
  }, []);

  useEffect(() => {
    void refetchOrders();
    const channel = supabase
      .channel("orders-register")
      .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, () => void refetchOrders())
      .subscribe();
    let stopped = false;
    let claimsBusy = false;
    const refreshClaims = async () => {
      if (document.visibilityState !== "visible" || claimsBusy) return;
      claimsBusy = true;
      const { data, error } = await supabase.rpc("get_cashier_claims");
      claimsBusy = false;
      if (stopped) return;
      setClaimsUnavailable(Boolean(error));
      if (error) return;
      const claims = new Map<string, Pick<PendingOrder, "claimed_station" | "claim_expires_at">>(
        (data ?? []).map((claim: { order_id: string; claimed_station: CashStation; claim_expires_at: string }) => [
          claim.order_id,
          claim,
        ]),
      );
      setPendingOrders((current) =>
        current.map((order) => ({
          ...order,
          ...(claims.get(order.id) ?? { claimed_station: null, claim_expires_at: null }),
        })),
      );
    };
    const stopClaims = pollWhileVisible(() => void refreshClaims(), 10_000);
    const stopQueue = pollWhileVisible(() => void refetchOrders(), 30_000);
    return () => {
      stopped = true;
      queueRequestRef.current += 1;
      stopClaims();
      stopQueue();
      void supabase.removeChannel(channel);
    };
  }, [refetchOrders]);

  useEffect(() => {
    const timer = window.setInterval(() => setClockTick((value) => value + 1), activeOrder ? 1_000 : 30_000);
    return () => window.clearInterval(timer);
  }, [activeOrder]);

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
    let stopped = false;
    let renewing = false;
    const renew = async () => {
      if (renewing || document.visibilityState !== "visible") return;
      renewing = true;
      const { data, error } = await supabase.rpc("claim_order_for_station", {
        p_order_id: activeOrder.id,
        p_station: cashStation,
        p_device_id: deviceIdRef.current,
      });
      renewing = false;
      if (stopped) return;
      if (error || !data) {
        setClaimValidUntil(0);
        setMessage(
          "Controllo dell’ordine non confermato. Attendi la riconnessione prima di incassare; se hai già ricevuto il pagamento, verifica l’ordine prima di ripeterlo.",
        );
      } else {
        setClaimValidUntil(Date.parse(data.claim_expires_at));
        setActiveOrder((current) =>
          current && current.id === data.id
            ? { ...current, kitchen_state: data.kitchen_state, preparation_mode: data.preparation_mode }
            : current,
        );
        setMessage((current) => (current?.startsWith("Controllo dell’ordine non confermato.") ? null : current));
      }
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      setClaimValidUntil(0);
      void renew();
    };
    const onOffline = () => setClaimValidUntil(0);
    const timer = window.setInterval(() => void renew(), 10_000);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onVisible);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onVisible);
    };
  }, [activeOrder?.id, cashStation]);

  const filteredOrders = useMemo(
    () => pendingOrders.filter((order) => matchesOrderSearch(order, numberSearch, aliasSearch)),
    [aliasSearch, numberSearch, pendingOrders],
  );

  function setClaimedOrder(order: StaffOrder) {
    setClaimValidUntil(Date.parse(order.claim_expires_at ?? ""));
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
      setMessage(
        error?.message.includes("already_claimed")
          ? "Ordine già preso in carico da un’altra cassa."
          : "Ordine non più disponibile. Aggiorno l’elenco.",
      );
      void refetchOrders();
      return;
    }
    setClaimedOrder(data as StaffOrder);
  }

  const handleQrDetected = useCallback(
    async (rawValue: string) => {
      const token = parseQrPayload(rawValue);
      if (!token || !cashStation) {
        setScannerOpen(false);
        setMessage(
          token ? "Scegli prima la cassa di questo dispositivo." : "QR non riconosciuto. Cerca l’ordine manualmente.",
        );
        return;
      }
      setActionBusy(true);
      try {
        const { data, error } = await supabase.rpc("claim_order_by_qr_for_station", {
          p_qr_token: token,
          p_station: cashStation,
          p_device_id: deviceIdRef.current,
        });
        if (error || !data) {
          setMessage(
            error?.message.includes("already_claimed")
              ? "Ordine già preso in carico da un’altra cassa."
              : "QR non associato a un ordine in attesa. Usa la ricerca manuale.",
          );
          return;
        }
        setClaimedOrder(data as StaffOrder);
      } finally {
        setActionBusy(false);
        setScannerOpen(false);
      }
    },
    [cashStation],
  );

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

  async function forceReleaseOrder() {
    if (!unlockTarget) return;
    setActionBusy(true);
    const { error } = await supabase.rpc("force_release_order", { p_order_id: unlockTarget.id });
    setActionBusy(false);
    setMessage(
      error
        ? "Sblocco non riuscito. Riprova tra qualche secondo."
        : `Ordine #${unlockTarget.display_number} sbloccato: ora puoi aprirlo da questa cassa.`,
    );
    setUnlockTarget(null);
    void refetchOrders();
  }

  async function payActiveOrder() {
    if (actionBusy || !activeOrder || !cashStation || !(claimValidUntil > Date.now())) return;
    setActionBusy(true);
    const { error } = await supabase.rpc("pay_order_for_station", {
      p_order_id: activeOrder.id,
      p_station: cashStation,
      p_device_id: deviceIdRef.current,
    });
    setActionBusy(false);
    if (error) {
      setMessage(
        error.message.includes("kitchen_capacity_reached")
          ? "Cucina al completo. Attendi un posto oppure, d’accordo con il cliente, scegli ‘Lo prenderò più tardi’. Il pagamento non è stato registrato nell’app."
          : "Pagamento non confermato nell’app. Riprova prima di chiudere l’ordine.",
      );
      return;
    }
    setMessage(
      activeOrder.preparation_mode === "deferred"
        ? `Ordine #${activeOrder.display_number} pagato. Cibo da attivare con il QR; bevande ritirabili.`
        : `Ordine #${activeOrder.display_number} pagato e inviato alle postazioni.`,
    );
    setActiveOrder(null);
    void refetchOrders();
  }

  async function cancelActiveOrder() {
    if (actionBusy || !activeOrder || !cashStation || !(claimValidUntil > Date.now())) return;
    setActionBusy(true);
    const { error } = await supabase.rpc("cancel_order_for_station", {
      p_order_id: activeOrder.id,
      p_station: cashStation,
      p_device_id: deviceIdRef.current,
    });
    setActionBusy(false);
    if (error) {
      setMessage("Ordine non annullato. Riprova.");
      return;
    }
    setCancelOrderModal(false);
    setMessage(`Ordine #${activeOrder.display_number} annullato.`);
    setActiveOrder(null);
    void refetchOrders();
    void refetchMenu();
  }

  function requestCounterOrder() {
    if (counterAlias.trim().length < 2 || Object.keys(counterCart).length === 0) {
      setMessage("Inserisci alias e almeno una voce.");
      return;
    }
    setConfirmCounterOrder(true);
  }

  async function createCounterOrder() {
    const lines = Object.values(counterCart);
    setActionBusy(true);
    const { data, error } = await supabase.rpc("create_counter_order", {
      p_alias: counterAlias.trim(),
      p_notes: counterNotes.trim(),
      p_items: lines.map((line) => ({ id: line.id, qty: line.qty })),
      p_preparation_mode: counterPreparation,
    });
    setActionBusy(false);
    setConfirmCounterOrder(false);
    if (error || !data) {
      setMessage(
        error?.message.includes("stock_unavailable:")
          ? `Scorte insufficienti: ${error.message.split("stock_unavailable:")[1]}`
          : error?.message.includes("kitchen_capacity_reached")
            ? "Cucina al completo: attendi oppure scegli la preparazione successiva con il cliente. Ordine non registrato."
            : "Ordine eccezionale non creato.",
      );
      return;
    }
    const created = data as StaffOrder;
    setMessage(
      `Ordine #${created.display_number} pagato. ${counterPreparation === "deferred" ? "Cibo da attivare successivamente: conserva numero e nome ordine." : "Inviato alle postazioni."}`,
    );
    setCounterAlias("");
    setCounterNotes("");
    setCounterCart({});
    setCounterPreparation("immediate");
    void refetchMenu();
  }

  if (!stationChecked) return <p className="py-16 text-center text-sm text-(--text-secondary)">Carico...</p>;

  if (!cashStation) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-8">
        <StaffPageHeading title="Casse" description="Configura questo dispositivo prima di iniziare il turno." />
        {message && (
          <Notice className="mb-5" onDismiss={() => setMessage(null)}>
            {message}
          </Notice>
        )}
        <StaffPanel
          eyebrow="Configurazione dispositivo"
          title="Scegli la cassa"
          description="Uno o due dispositivi possono lavorare sulla stessa cassa."
        >
          <StationPicker
            options={CASH_STATIONS}
            onPick={chooseStation}
            hint="La scelta resta memorizzata su questo dispositivo fino alla chiusura dell’evento"
          />
        </StaffPanel>
      </main>
    );
  }

  if (activeOrder) {
    const hasFood = activeOrder.items.some((line) => line.category === "cibo");
    const kitchenBlocked =
      hasFood && activeOrder.preparation_mode !== "deferred" && activeOrder.kitchen_state !== "reserved";
    const claimValid = claimValidUntil > Date.now();
    const changePreparation = async (mode: PreparationMode) => {
      if (actionBusy || !cashStation) return;
      setActionBusy(true);
      try {
        const { data, error } = await supabase.rpc("set_order_preparation", {
          p_order_id: activeOrder.id,
          p_station: cashStation,
          p_device_id: deviceIdRef.current,
          p_mode: mode,
        });
        if (error || !data) {
          setMessage("Scelta non confermata. Verifica la connessione prima di incassare.");
          return;
        }
        setActiveOrder((current) => (current?.id === data.id ? { ...current, ...data } : current));
        setMessage(null);
      } finally {
        setActionBusy(false);
      }
    };
    return (
      <main className="mx-auto max-w-3xl px-4 py-8">
        <StaffPageHeading
          title="Gestione ordine"
          description={`${cashStationLabel(cashStation)} · ordine in sola lettura`}
          action={
            <Button variant="staff-secondary" onClick={() => void releaseActiveOrder()} disabled={actionBusy}>
              Chiudi senza pagare
            </Button>
          }
        />
        <StaffPanel
          eyebrow={`Ordine #${activeOrder.display_number}`}
          title={activeOrder.alias ?? "Senza nome"}
          description="Prepara lo scontrino sul registratore. L’ordine non può essere modificato dalla cassa."
        >
          <OrderNotes notes={activeOrder.notes} />
          {hasFood && (
            <PreparationChoice
              value={activeOrder.preparation_mode ?? "immediate"}
              onChange={(mode) => void changePreparation(mode)}
              disabled={actionBusy || !claimValid}
            />
          )}
          {kitchenBlocked && (
            <p role="status" className="mb-4 rounded-xl border border-(--state-warning) p-3 text-sm">
              Cucina al completo · Non incassare per la preparazione immediata. Attendi il prossimo posto oppure
              concorda la preparazione successiva. La disponibilità si aggiorna automaticamente.
            </p>
          )}
          {hasFood && activeOrder.kitchen_state === "reserved" && (
            <p className="mb-4 text-sm text-(--state-success)">
              Posto in cucina riservato a questa cassa. Puoi procedere al pagamento finché il controllo dell’ordine è
              valido.
            </p>
          )}
          <div className="flex flex-col gap-3">
            {activeOrder.items.map((line) => (
              <div
                key={line.id}
                className="flex justify-between gap-3 border-b border-(--surface-border) pb-3 last:border-0 last:pb-0"
              >
                <strong>
                  {line.qty}× {line.name}
                </strong>
                <span className="font-mono">{priceFormatter.format(lineTotal(line))}</span>
              </div>
            ))}
            <div className="flex justify-between border-t border-(--surface-border) pt-4 text-lg font-semibold">
              <span>Totale</span>
              <span className="font-mono text-(--accent-primary)">
                {priceFormatter.format(Number(activeOrder.total))}
              </span>
            </div>
          </div>
        </StaffPanel>
        {!claimValid && (
          <p role="alert" className="mt-3 text-sm text-(--state-warning)">
            Verifico che l’ordine sia ancora assegnato a questa cassa. Non incassare finché la conferma non torna
            disponibile.
          </p>
        )}
        {message && <p className="mt-3 text-sm text-(--state-error)">{message}</p>}
        <div className="mt-5 flex flex-wrap justify-between gap-3">
          <Button variant="staff-danger" onClick={() => setCancelOrderModal(true)} disabled={actionBusy}>
            Annulla ordine
          </Button>
          <Button
            variant="staff-primary"
            onClick={() => void payActiveOrder()}
            disabled={actionBusy || kitchenBlocked || !claimValid}
          >
            {actionBusy
              ? "Attendi…"
              : activeOrder.preparation_mode === "deferred"
                ? "Conferma pagamento · prepara più tardi"
                : "Pagato e invia"}
          </Button>
        </div>
        <Modal
          open={cancelOrderModal}
          title={`Annullare l’ordine #${activeOrder.display_number}?`}
          dismissible={!actionBusy}
          onClose={() => setCancelOrderModal(false)}
          actions={
            <>
              <Button variant="staff-secondary" onClick={() => setCancelOrderModal(false)} disabled={actionBusy}>
                No, torna all’ordine
              </Button>
              <Button
                variant="staff-danger"
                onClick={() => void cancelActiveOrder()}
                disabled={actionBusy || !claimValid}
              >
                {actionBusy ? "Annullamento…" : "Sì, annulla ordine"}
              </Button>
            </>
          }
        >
          <p>
            L’annullamento è definitivo e ripristina le scorte. Usa questa azione solo se l’ordine deve essere
            eliminato.
          </p>
        </Modal>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <StaffPageHeading
        title={cashStationLabel(cashStation)}
        description="Preordini e ordini eccezionali della postazione."
        action={
          <Button variant="staff-secondary" onClick={() => chooseStation(null)}>
            Cambia cassa
          </Button>
        }
      />

      <SegmentedControl
        className="mt-5"
        value={tab}
        onChange={setTab}
        options={[
          { value: "ordini", label: "Ordini" },
          { value: "manuale", label: "Ordine in cassa" },
        ]}
      />

      {message && (
        <Notice className="mt-4" onDismiss={() => setMessage(null)}>
          {message}
        </Notice>
      )}

      {tab === "ordini" && (
        <StaffPanel
          className="mt-6"
          eyebrow="Flusso cassa"
          title="Ordini in attesa"
          description="Scansiona il QR oppure cerca per numero e nome ordine."
        >
          {claimsUnavailable && (
            <p role="status" className="mb-3 text-sm text-(--state-warning)">
              Aggiornamento delle casse non disponibile. Verifico nuovamente tra pochi secondi.
            </p>
          )}
          <div className="flex flex-wrap items-end gap-3">
            <Button variant="staff-primary" onClick={() => setScannerOpen(true)} disabled={actionBusy}>
              Scansiona QR
            </Button>
            <label className="min-w-28 flex-1">
              <span className="mb-1 block text-xs">Numero</span>
              <input
                type="number"
                inputMode="numeric"
                value={numberSearch}
                onChange={(event) => setNumberSearch(event.target.value)}
                className="field w-full py-2"
              />
            </label>
            <label className="min-w-36 flex-2">
              <span className="mb-1 block text-xs">Alias</span>
              <input
                value={aliasSearch}
                onChange={(event) => setAliasSearch(event.target.value)}
                className="field w-full py-2"
              />
            </label>
          </div>
          <p className="mt-3 text-xs text-(--text-secondary)">
            {filteredOrders.length} ordini trovati. Numero e alias possono essere usati insieme.
          </p>
          {ordersLoading ? (
            <p className="mt-4 text-sm text-(--text-secondary)">Carico…</p>
          ) : (
            <div className="mt-3 flex flex-col gap-2">
              {filteredOrders.map((order) => {
                const claimed =
                  order.claimed_station !== null &&
                  order.claim_expires_at !== null &&
                  new Date(order.claim_expires_at).getTime() > Date.now();
                const ours = order.claimed_station === cashStation;
                return (
                  <div
                    key={order.id}
                    className="flex items-center justify-between gap-3 rounded-md border border-(--surface-border) p-3 text-left"
                  >
                    <span>
                      <strong>
                        #{order.display_number} · {order.alias}
                      </strong>
                      <span className="mt-1 block text-xs text-(--text-secondary)">
                        {claimed && order.claimed_station
                          ? `In gestione a ${cashStationLabel(order.claimed_station)}`
                          : orderAge(order.created_at)}
                      </span>
                    </span>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-(--accent-primary)">
                        {priceFormatter.format(Number(order.total))}
                      </span>
                      {!claimed || ours ? (
                        <Button
                          variant="staff-secondary"
                          onClick={() => void claimOrder(order.id)}
                          disabled={actionBusy}
                        >
                          Apri
                        </Button>
                      ) : (
                        <Button variant="staff-secondary" onClick={() => setUnlockTarget(order)} disabled={actionBusy}>
                          Sblocca
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
              {filteredOrders.length === 0 && (
                <p className="text-sm text-(--text-secondary)">Nessun ordine corrispondente.</p>
              )}
            </div>
          )}
        </StaffPanel>
      )}

      {tab === "manuale" && (
        <StaffPanel
          className="mt-6"
          eyebrow="Procedura di emergenza"
          title="Ordine manuale"
          description="L’ordine viene creato già pagato e inviato alle postazioni competenti."
        >
          {menuLoading ? (
            <p className="text-sm text-(--text-secondary)">Carico il menu…</p>
          ) : (
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
          {Object.values(counterCart).some((line) => line.category === "cibo") && (
            <PreparationChoice value={counterPreparation} onChange={setCounterPreparation} disabled={actionBusy} />
          )}
          <Button
            variant="staff-primary"
            className="mt-4 w-full sm:w-auto"
            onClick={requestCounterOrder}
            disabled={actionBusy || menuLoading}
          >
            {actionBusy ? "Invio…" : "Conferma pagamento e invia"}
          </Button>
        </StaffPanel>
      )}

      <Modal
        open={confirmCounterOrder}
        title="Confermi l’ordine in cassa?"
        dismissible={!actionBusy}
        onClose={() => setConfirmCounterOrder(false)}
        actions={
          <>
            <Button variant="staff-secondary" onClick={() => setConfirmCounterOrder(false)} disabled={actionBusy}>
              Torna all’ordine
            </Button>
            <Button variant="staff-primary" onClick={() => void createCounterOrder()} disabled={actionBusy}>
              {actionBusy ? "Invio…" : "Sì, pagato: invia"}
            </Button>
          </>
        }
      >
        <p>Conferma solo se hai già battuto tutte le voci sul registratore e ricevuto il pagamento.</p>
      </Modal>

      <Modal
        open={unlockTarget !== null}
        title={`Sbloccare l’ordine #${unlockTarget?.display_number ?? ""}?`}
        dismissible={!actionBusy}
        onClose={() => setUnlockTarget(null)}
        actions={
          <>
            <Button variant="staff-secondary" onClick={() => setUnlockTarget(null)} disabled={actionBusy}>
              No, lascialo
            </Button>
            <Button variant="staff-danger" onClick={() => void forceReleaseOrder()} disabled={actionBusy}>
              {actionBusy ? "Sblocco…" : "Sì, sblocca"}
            </Button>
          </>
        }
      >
        <p>
          L’ordine è aperto su{" "}
          {unlockTarget?.claimed_station ? cashStationLabel(unlockTarget.claimed_station) : "un’altra cassa"}. Sbloccalo
          solo se quella cassa non lo sta incassando, per esempio se il telefono si è spento o è stato chiuso senza
          pagare.
        </p>
      </Modal>

      {scannerOpen && <QrScanner onDetected={handleQrDetected} onClose={() => setScannerOpen(false)} />}
    </main>
  );
}
