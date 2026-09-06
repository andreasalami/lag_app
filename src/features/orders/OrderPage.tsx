import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Modal } from "../../components/ui/Modal";
import { supabase } from "../../lib/supabaseClient";
import {
  ALLERGENS,
  cartTotal,
  downloadOrderPdf,
  orderingReasonMessage,
  priceFormatter,
} from "./orderUtils";
import {
  addOrderToHistory,
  isPublicOrderStatus,
  orderStatusClassName,
  ordersForEvent,
  readOrderHistory,
  saveOrderHistory,
  type PublicOrderStatus,
  type StoredOrder,
} from "./orderHistory";
import type { OrderLine, OrderMenuItem, OrderingCatalog, SubmittedOrder } from "./types";
import { clearPendingOrder, readPendingOrder, savePendingOrder, type PendingOrderRequest } from "./pendingOrder";
import { getOrCreateRecoveryToken, readRecoveryToken, recoveryOrderQr, saveRecoveryToken, validRecoveryToken } from "./orderRecovery";
import { TurnstileChallenge } from "../../components/ui/TurnstileChallenge";
import { RecoveryCard } from "./RecoveryCard";
import { PreparationChoice, PreparationStatus } from "./PreparationChoice";
import type { PreparationMode, KitchenState } from "./types";
import { MENU_SECTIONS } from "../menu/menuSections";

const STATUS_LABEL: Record<PublicOrderStatus, string> = {
  in_attesa_pagamento: "Da pagare",
  pagato: "In preparazione",
  ritiro_parziale: "Ritiro parziale",
  consegnato: "Ritirato",
  annullato: "Annullato",
};

function statusMessage(status: PublicOrderStatus) {
  switch (status) {
    case "pagato": return "Pagamento registrato. Il tuo ordine è in preparazione.";
    case "ritiro_parziale": return "Hai ritirato una parte dell’ordine. Conserva il QR per le altre postazioni.";
    case "consegnato": return "Ordine consegnato. Grazie!";
    case "annullato": return "Questo ordine è stato annullato.";
    default: return "Ordine inviato. Ora raggiungi la cassa per pagare.";
  }
}

export function OrderPage({ startFresh = false }: { startFresh?: boolean }) {
  const [orderHistory, setOrderHistory] = useState<StoredOrder[]>(readOrderHistory);
  const [catalog, setCatalog] = useState<OrderingCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showIntro, setShowIntro] = useState(() => !startFresh && readOrderHistory().length === 0);
  const [alias, setAlias] = useState(() => startFresh ? readOrderHistory()[0]?.alias ?? "" : "");
  const [notes, setNotes] = useState("");
  const [cart, setCart] = useState<Record<string, OrderLine>>({});
  const [cartExpanded, setCartExpanded] = useState(false);
  const [cartElement, setCartElement] = useState<HTMLElement | null>(null);
  const [cartHeight, setCartHeight] = useState(0);

  useLayoutEffect(() => {
    if (!cartElement) {
      setCartHeight(0);
      return;
    }
    const measure = () => setCartHeight(cartElement.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(cartElement);
    return () => observer.disconnect();
  }, [cartElement]);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [preparationMode, setPreparationMode] = useState<PreparationMode>("immediate");
  const submitBusy = useRef(false);
  const [challengeToken, setChallengeToken] = useState("");
  const [challengeAttempt, setChallengeAttempt] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submittedOrder, setSubmittedOrder] = useState<StoredOrder | null>(() => startFresh || readPendingOrder() ? null : readOrderHistory()[0] ?? null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [finalTab, setFinalTab] = useState<"qr" | "summary">("qr");
  const [showCopyPrompt, setShowCopyPrompt] = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [botField, setBotField] = useState("");
  const [startingNewOrder, setStartingNewOrder] = useState(false);
  const [refreshingStatuses, setRefreshingStatuses] = useState(false);
  const [newOrderMessage, setNewOrderMessage] = useState<string | null>(null);
  const requestIdentityRef = useRef({ requestId: crypto.randomUUID(), qrToken: crypto.randomUUID() });
  const historyRef = useRef(orderHistory);
  const [restoreToken, setRestoreToken] = useState(()=>new URLSearchParams(location.hash.split("?")[1] ?? "").get("recupero"));
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState<string|null>(null);
  const [showRecovery, setShowRecovery] = useState(false);
  const [pendingRequest, setPendingRequest] = useState<PendingOrderRequest | null>(readPendingOrder);

  useEffect(() => {
    historyRef.current = orderHistory;
  }, [orderHistory]);

  const refreshOrderStatuses = useCallback(async (orders = historyRef.current) => {
    if (orders.length === 0) return;
    const batches = Array.from({ length: Math.ceil(orders.length / 50) }, (_, index) =>
      orders.slice(index * 50, (index + 1) * 50));
    const results = await Promise.all(batches.map(async (batch) => {
      const { data, error } = await supabase.rpc("get_public_order_statuses", {
        p_qr_tokens: batch.map((order) => order.qr_token),
      });
      return error ? [] : data as Array<{ order_id?: unknown; status?: unknown; progress?: unknown; kitchen_state?: KitchenState; preparation_mode?: PreparationMode }>;
    }));
    const statuses = new Map<string, PublicOrderStatus>();
    const progress = new Map<string, StoredOrder["progress"]>();
    const kitchen = new Map<string, {kitchen_state?:KitchenState; preparation_mode?:PreparationMode}>();
    results.flat().forEach((result) => {
      if (typeof result.order_id === "string" && isPublicOrderStatus(result.status)) {
        statuses.set(result.order_id, result.status);
        kitchen.set(result.order_id,{kitchen_state:result.kitchen_state,preparation_mode:result.preparation_mode});
        if (Array.isArray(result.progress)) progress.set(result.order_id, result.progress as StoredOrder["progress"]);
      }
    });
    if (statuses.size === 0) return;
    setOrderHistory((current) => {
      const next = current.map((order) => {
        const status = statuses.get(order.order_id);
        return status ? { ...order, ...kitchen.get(order.order_id), status, progress: progress.get(order.order_id) } : order;
      });
      saveOrderHistory(next);
      historyRef.current = next;
      return next;
    });
    setSubmittedOrder((current) => current
      ? { ...current, ...kitchen.get(current.order_id), status: statuses.get(current.order_id) ?? current.status, progress: progress.get(current.order_id) ?? current.progress }
      : null);
  }, []);

  async function loadCatalog(restoreLatestOrder = false) {
    setLoading(true);
    setLoadError(null);
    const { data, error } = await supabase.rpc("get_ordering_catalog");
    if (error || !data) {
      setLoadError("Menu ordinazioni non disponibile. Controlla la connessione e riprova.");
      setLoading(false);
      return null;
    }
    const nextCatalog = data as OrderingCatalog;
    setCatalog(nextCatalog);
    const allHistory = readOrderHistory();
    const currentHistory = ordersForEvent(allHistory, nextCatalog.event_id);
    historyRef.current = allHistory;
    setOrderHistory(allHistory);
    if (restoreLatestOrder) {
      const latest = currentHistory[0] ?? null;
      setSubmittedOrder(readPendingOrder() ? null : latest);
      setShowIntro(!readPendingOrder() && latest === null);
    }
    setLoading(false);
    void refreshOrderStatuses(currentHistory);
    return nextCatalog;
  }

  useEffect(() => {
    if (!restoreToken) void loadCatalog(!startFresh);
  // Il catalogo iniziale e lo storico si caricano una sola volta all'apertura.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startFresh]);

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") void refreshOrderStatuses();
    };
    const timer = window.setInterval(refresh, 30_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [refreshOrderStatuses]);

  useEffect(() => {
    if (!submittedOrder) {
      setQrDataUrl(null);
      return;
    }
    setQrDataUrl(null);
    let cancelled = false;
    void import("qrcode").then((module) => module.default.toDataURL(
      `LAGORDER:${submittedOrder.qr_token}`,
      { width: 360, margin: 2, errorCorrectionLevel: "M" },
    )).then((url) => {
      if (!cancelled) setQrDataUrl(url);
    }).catch(() => {
      if (!cancelled) setSubmitError("QR non generato: usa numero e alias in cassa.");
    });
    return () => { cancelled = true; };
  }, [submittedOrder]);

  const lines = useMemo(() => Object.values(cart), [cart]);
  const total = cartTotal(lines);

  function addItem(item: OrderMenuItem) {
    if (item.available_portions === 0) return;
    const maxItem = catalog?.max_item_quantity ?? 25;
    const maxOrder = catalog?.max_order_quantity ?? 60;
    if ((cart[item.id]?.qty ?? 0) >= maxItem || lines.reduce((sum, line) => sum + line.qty, 0) >= maxOrder) {
      setSubmitError(`Puoi ordinare al massimo ${maxItem} pezzi per prodotto e ${maxOrder} articoli in totale. Per ordini più grandi rivolgiti alla cassa.`);
      return;
    }
    setCart((current) => {
      const existing = current[item.id];
      if ((existing?.qty ?? 0) >= maxItem || Object.values(current).reduce((sum, line) => sum + line.qty, 0) >= maxOrder) return current;
      if (item.available_portions !== null && (existing?.qty ?? 0) >= item.available_portions) return current;
      return {
        ...current,
        [item.id]: {
          id: item.id,
          category: item.category,
          subcategory: item.subcategory,
          name: item.name,
          price: Number(item.price),
          qty: (existing?.qty ?? 0) + 1,
          allergens: item.allergens ?? [],
        },
      };
    });
    setCartExpanded(true);
  }

  function decrementItem(id: string) {
    setCart((current) => {
      const line = current[id];
      if (!line) return current;
      if (line.qty === 1) {
        const { [id]: _removed, ...rest } = current;
        return rest;
      }
      return { ...current, [id]: { ...line, qty: line.qty - 1 } };
    });
  }

  function requestSubmit() {
    setSubmitError(null);
    if (!/^[\p{L}\p{N}][\p{L}\p{N} _-]{1,31}$/u.test(alias.trim())) {
      setSubmitError("Inserisci un nome dell’ordine di 2–32 caratteri usando lettere, numeri, spazi, trattino o underscore.");
      setCartExpanded(true);
      return;
    }
    if (lines.length === 0) {
      setSubmitError("Aggiungi almeno un prodotto.");
      return;
    }
    setShowConfirmation(true);
  }

  async function submitOrder() {
    if (submitBusy.current || !challengeToken) return;
    submitBusy.current = true;
    setSubmitting(true);
    try {
    setSubmitError(null);
    const pending: PendingOrderRequest = pendingRequest ?? {
      ...requestIdentityRef.current, eventId: catalog?.event_id ?? "", alias: alias.trim(), notes: notes.trim(),
      items: lines, createdAt: new Date().toISOString(), preparationMode: lines.some(line=>line.category==='cibo') ? preparationMode : 'immediate',
    };
    const activeCatalog = catalog ?? await loadCatalog();
    if(!activeCatalog) {setSubmitError("Non riesco a verificare l’evento. Controlla la rete e riprova."); return;}
    if(pending.eventId !== activeCatalog.event_id) {
      setSubmitError("Questa richiesta appartiene a un evento precedente. Non verrà inviata al nuovo evento; rivolgiti alla cassa per verificarla."); return;
    }
    if (!pendingRequest) {
      try {
        pending.recoveryToken = getOrCreateRecoveryToken(pending.eventId);
        pending.qrToken = await recoveryOrderQr(pending.recoveryToken,pending.requestId);
      } catch {setSubmitError("Il browser non consente il salvataggio sicuro. Libera spazio o rivolgiti alla cassa: nessun ordine è stato inviato.");return;}
    }
    if(!savePendingOrder(pending)) {
      setSubmitError("Il browser non consente di salvare l’ordine in sicurezza. Libera spazio o rivolgiti alla cassa: nessun nuovo ordine è stato inviato.");
      return;
    }
    setPendingRequest(pending);
    setSubmitting(true);
    const { requestId, qrToken } = pending;
    const { data, error: invocationError } = await supabase.functions.invoke("submit-order", { body: { turnstileToken: challengeToken, order: {
      p_alias: pending.alias,
      p_notes: pending.notes,
      p_items: pending.items.map((line) => ({ id: line.id, qty: line.qty })),
      p_client_request_id: requestId,
      p_qr_token: qrToken,
      p_bot_field: botField,
      p_expected_event_id: pending.eventId,
      p_recovery_token: pending.recoveryToken ?? null,
      p_preparation_mode: pending.preparationMode ?? "immediate",
    } } });
    let error = invocationError;
    if (invocationError?.context instanceof Response) {
      try { const details = await invocationError.context.json(); if (typeof details.error === "string") error = new Error(details.error); } catch { /* Keep uncertain outcome. */ }
    }
    setSubmitting(false);
    setShowConfirmation(false);
    if (error || !data) {
      const message = error?.message ?? "";
      if (/stock_unavailable|capacity_reached|public_order_quantity_limit|invalid_|notes_too_long|ordering_|event_closed|not_open_yet|no_event/.test(message)) {
        clearPendingOrder(requestId); setPendingRequest(null);
      }
      if (message.includes("public_order_rate_limit")) {
        setSubmitError("Hai inviato più ordini ravvicinati. Attendi un minuto, poi premi Recupera ordine.");
      } else if (message.includes("challenge_")) {
        setSubmitError("Ripeti la verifica di sicurezza e premi Recupera ordine. La richiesta salvata resta la stessa.");
      } else if (message.includes("stock_unavailable:")) {
        setSubmitError(`Disponibilità cambiata: ${message.split("stock_unavailable:")[1]}. Aggiorna il carrello e riprova.`);
        await loadCatalog();
      } else if (message.includes("public_order_quantity_limit")) {
        setSubmitError("L’ordine supera il limite di 25 pezzi per prodotto o 60 articoli totali. Riduci le quantità o rivolgiti alla cassa.");
      } else if (message.includes("request_already_processed")) {
        setSubmitError("Questo ordine è già stato elaborato oppure è scaduto. Controlla lo storico o rivolgiti alla cassa.");
      } else if (message.includes("capacity_reached")) {
        setSubmitError(orderingReasonMessage("capacity_reached"));
      } else if (/ordering_|event_closed|not_open_yet/.test(message)) {
        setSubmitError("Le ordinazioni sono state chiuse prima dell’invio. Rivolgiti alla cassa.");
      } else {
        setSubmitError("Non riesco a verificare l’esito. Premi Recupera ordine: useremo la stessa richiesta, senza creare un duplicato.");
      }
      return;
    }
    const order = data as SubmittedOrder;
    const storedOrder: StoredOrder = {
      ...order,
      alias: order.alias ?? pending.alias,
      recovery_enabled: Boolean(pending.recoveryToken),
      status: isPublicOrderStatus((data as {status?:unknown}).status) ? (data as {status:PublicOrderStatus}).status : "in_attesa_pagamento",
      saved_at: new Date().toISOString(),
    };
    const next = addOrderToHistory(historyRef.current, storedOrder);
    if(saveOrderHistory(next)) {
      clearPendingOrder(requestId);
      setPendingRequest(readPendingOrder());
    } else {
      setSubmitError("Ordine registrato. Conserva il QR: il browser non è riuscito ad aggiornare lo storico.");
    }
    historyRef.current = next;
    setOrderHistory(next);
    setSubmittedOrder(storedOrder);
    setCart({});
    setShowCopyPrompt(true);
    } catch {
      setSubmitError("Connessione interrotta. La richiesta resta salvata: premi Recupera ordine per verificarla senza duplicati.");
      setShowConfirmation(false);
    } finally {
      submitBusy.current = false;
      setSubmitting(false);
      setChallengeToken("");
      setChallengeAttempt(value => value + 1);
    }
  }

  function viewOrder(order: StoredOrder) {
    setSubmittedOrder(order);
    setFinalTab("qr");
    setSubmitError(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
    void refreshOrderStatuses();
  }

  async function startNewOrder() {
    setStartingNewOrder(true);
    setNewOrderMessage(null);
    const nextCatalog = await loadCatalog(false);
    setStartingNewOrder(false);
    if (!nextCatalog) {
      setNewOrderMessage("Non riesco a verificare le ordinazioni. Controlla la connessione e riprova.");
      return;
    }
    if (!nextCatalog.accepting) {
      setNewOrderMessage(orderingReasonMessage(nextCatalog.reason, nextCatalog.opens_at));
      return;
    }
    setAlias(historyRef.current[0]?.alias ?? submittedOrder?.alias ?? "");
    setNotes("");
    setCart({});
    setCartExpanded(false);
    setSubmitError(null);
    setBotField("");
    setShowIntro(false);
    setShowCopyPrompt(false);
    setFinalTab("qr");
    requestIdentityRef.current = { requestId: crypto.randomUUID(), qrToken: crypto.randomUUID() };
    setSubmittedOrder(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function handlePdfDownload() {
    if (!submittedOrder || !qrDataUrl) return;
    setPdfLoading(true);
    try {
      await downloadOrderPdf(submittedOrder, qrDataUrl);
      setShowCopyPrompt(false);
    } finally {
      setPdfLoading(false);
    }
  }

  async function restoreHistory() {
    if(!validRecoveryToken(restoreToken)) {setRestoreError("Codice di recupero non valido.");return;}
    setRestoreBusy(true);setRestoreError(null);
    try {
      const restored:StoredOrder[]=[];let cursor:string|null=null;
      while(true) {
        const response=await supabase.rpc("recover_order_history",{p_token:restoreToken,p_before:cursor});
        if(response.error) throw new Error("restore_failed");
        const page=response.data as Array<StoredOrder & {created_at:string}>;
        for(const order of page) restored.push({...order,saved_at:order.created_at,recovery_enabled:true});
        if(page.length<50)break;
        cursor=page[page.length-1].order_id;
      }
      if(!restored.length){setRestoreError("Non ci sono ordini associati a questo codice.");return;}
      const merged=[...restored,...historyRef.current.filter(order=>!restored.some(item=>item.order_id===order.order_id))];
      const saved=saveOrderHistory(merged);
      for(const order of restored)saveRecoveryToken(order.event_id,restoreToken);
      historyRef.current=merged;setOrderHistory(merged);setSubmittedOrder(restored[0]);setShowIntro(false);
      if(!saved)setSubmitError("Ordini recuperati, ma non salvati dal browser. Conserva la scheda di recupero.");
      setRestoreToken(null);
      history.replaceState(null,"",`${location.pathname}${location.search}#ordina`);
      setLoading(false);
    } catch {setRestoreError("Recupero non riuscito. Controlla la connessione e riprova: il codice resta valido.");}
    finally{setRestoreBusy(false);}
  }

  if(restoreToken) return <main className="mx-auto max-w-md px-4 py-8"><h1 className="text-2xl">Ritrova i tuoi ordini</h1><p className="my-4 text-sm text-[var(--text-secondary)]">Il tuo codice permette di recuperare lo storico, senza account.</p>{restoreError && <p role="alert" className="mb-4 text-sm">{restoreError}</p>}<Button className="w-full" disabled={restoreBusy} onClick={()=>void restoreHistory()}>{restoreBusy ? "Recupero gli ordini…" : "Recupera i miei ordini"}</Button></main>;
  const recoveryToken = submittedOrder ? readRecoveryToken(submittedOrder.event_id) : null;
  if(showRecovery && submittedOrder && recoveryToken) return <RecoveryCard token={recoveryToken} eventName={submittedOrder.event_name} onBack={()=>setShowRecovery(false)}/>;

  if (pendingRequest && !submittedOrder) {
    return <main className="mx-auto max-w-xl px-4 py-8">
      <h1 className="text-2xl">Ritroviamo il tuo ordine</h1>
      <p className="mt-3 text-sm text-[var(--text-secondary)]">La richiesta è salvata su questo dispositivo. Verifichiamo se è già stata registrata, senza inviarne una nuova.</p>
      <div className="my-5 space-y-2">{pendingRequest.items.map(line=><p key={line.id}>{line.qty} × {line.name}</p>)}</div>
      {submitError && <p role="alert" className="mb-4 text-sm text-[var(--state-warning)]">{submitError}</p>}
      {catalog?.event_id && pendingRequest.eventId !== catalog.event_id && <Button variant="ghost" className="mb-3 w-full" onClick={()=>{clearPendingOrder(pendingRequest.requestId);setPendingRequest(readPendingOrder());setSubmitError(null);}}>Chiudi la richiesta del vecchio evento</Button>}
      <TurnstileChallenge key={challengeAttempt} onToken={setChallengeToken}/>
      <Button className="mt-4 w-full" disabled={submitting || !challengeToken} onClick={()=>void submitOrder()}>{submitting ? "Verifico l’ordine…" : "Recupera ordine"}</Button>
    </main>;
  }

  if (submittedOrder) {
    return (
      <main className="mx-auto min-h-full max-w-xl px-4 py-8">
        <Button href={`${import.meta.env.BASE_URL}#menu`} variant="back" className="min-h-10 px-4 py-2">← Indietro</Button>
        <section className="mt-5 text-center">
          <p className={`text-sm ${orderStatusClassName(submittedOrder.status)}`}>{submittedOrder.event_closed_at ? "Evento concluso. Questo ordine resta nello storico; il QR non è più utilizzabile per il ritiro." : submittedOrder.status==='pagato' && (submittedOrder.kitchen_state==='dormant' || submittedOrder.kitchen_state==='waiting') ? 'Pagamento registrato.' : statusMessage(submittedOrder.status)}</p>
          <h1 className="mt-2 text-4xl">#{submittedOrder.display_number}</h1>
          {!submittedOrder.event_closed_at && (submittedOrder.status==='pagato' || submittedOrder.status==='ritiro_parziale') && <PreparationStatus state={submittedOrder.kitchen_state}/>}
          {submittedOrder.status==='in_attesa_pagamento' && submittedOrder.preparation_mode==='deferred' && <p className="mt-2 text-sm">Hai scelto di preparare il cibo più tardi. Paga entro 60 minuti per mantenere le quantità riservate.</p>}
          <p className="mt-1 text-xl font-semibold">{submittedOrder.alias}</p>
          <p className="mt-2 text-xs text-[var(--text-secondary)]">
            {submittedOrder.status === "in_attesa_pagamento"
              ? "Mostra QR, numero e alias alla cassa. Gli ordini non pagati scadono dopo 60 minuti."
              : submittedOrder.status === "pagato" || submittedOrder.status === "ritiro_parziale"
                ? "Mostra lo stesso QR in ogni postazione in cui devi ritirare."
                : "Il QR e il riepilogo restano disponibili per tutta la durata dell’evento."}
          </p>
        </section>

        {submittedOrder.progress && submittedOrder.progress.length > 0 && (
          <Card className="mt-5">
            <h2 className="font-semibold">Ritiro per postazione</h2>
            <div className="mt-3 flex flex-col gap-2">
              {submittedOrder.progress.map((item) => (
                <div key={item.station} className="flex items-center justify-between gap-3 text-sm">
                  <span className="capitalize">{item.station}</span>
                  <strong className={item.delivered >= item.quantity ? "text-[var(--state-success)]" : ""}>{item.delivered}/{item.quantity}</strong>
                </div>
              ))}
            </div>
          </Card>
        )}

        <Card className="mt-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-semibold">I miei ordini</h2>
            <span className="text-xs text-[var(--text-secondary)]">{orderHistory.length} totali</span>
          </div>
          <div className="mt-3 max-h-48 space-y-2 overflow-y-auto pr-1">
            {orderHistory.map((order) => (
              <button
                key={order.order_id}
                type="button"
                onClick={() => viewOrder(order)}
                aria-current={order.order_id === submittedOrder.order_id ? "true" : undefined}
                className={`flex w-full items-center justify-between gap-3 rounded-[var(--radius-sm)] border p-3 text-left ${
                  order.order_id === submittedOrder.order_id
                    ? "border-[var(--accent-primary)] bg-white/5"
                    : "border-[var(--surface-border)]"
                }`}
              >
                <span>
                  <strong>#{order.display_number} · {order.alias}</strong>
                  <span className="mt-0.5 block text-xs text-[var(--text-secondary)]">
                    {order.event_name} · {order.items.reduce((sum, line) => sum + line.qty, 0)} articoli · {priceFormatter.format(Number(order.total))}
                  </span>
                </span>
                <span className={`shrink-0 text-xs font-semibold ${orderStatusClassName(order.status)}`}>
                  {order.event_closed_at ? "Evento concluso" : STATUS_LABEL[order.status]}
                </span>
              </button>
            ))}
          </div>
        </Card>

        {submittedOrder.recovery_enabled && recoveryToken && <Button variant="ghost" className="mt-3 w-full" onClick={()=>{setShowRecovery(true);window.scrollTo({top:0});}}>Conserva i miei ordini</Button>}
        <Button variant="ghost" className="mt-3 w-full" onClick={async () => { setRefreshingStatuses(true); await refreshOrderStatuses(); setRefreshingStatuses(false); }} disabled={refreshingStatuses}>
          {refreshingStatuses ? "Aggiorno lo stato…" : "Aggiorna stato ordini"}
        </Button>

        <div className="mx-auto mt-5 grid max-w-xs grid-cols-2 rounded-[var(--radius-pill)] border border-[var(--surface-border)] p-1">
          {(["qr", "summary"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setFinalTab(tab)}
              className={`rounded-[var(--radius-pill)] px-3 py-2 text-sm ${finalTab === tab ? "bg-[var(--accent-primary)] text-[var(--text-on-accent)]" : "text-[var(--text-secondary)]"}`}
            >
              {tab === "qr" ? "QR code" : "Riepilogo"}
            </button>
          ))}
        </div>

        {finalTab === "qr" ? (
          <Card className="mx-auto mt-4 max-w-sm text-center">
            {submittedOrder.event_closed_at ? <p className="py-6 text-sm">Evento concluso: puoi consultare il riepilogo dell’ordine.</p> : qrDataUrl ? <img src={qrDataUrl} alt={`QR dell’ordine ${submittedOrder.display_number}`} className="mx-auto w-full max-w-[300px] rounded-xl bg-white" /> : (
              <p className="py-16 text-sm text-[var(--text-secondary)]">Genero il QR…</p>
            )}
          </Card>
        ) : (
          <Card className="mt-4 flex flex-col gap-2">
            {submittedOrder.items.map((line) => (
              <div key={line.id} className="flex justify-between gap-3 text-sm">
                <span>{line.qty}× {line.name}</span>
                <span className="font-mono">{priceFormatter.format(Number(line.price) * line.qty)}</span>
              </div>
            ))}
            <div className="mt-2 flex justify-between border-t border-[var(--surface-border)] pt-2 font-semibold">
              <span>{submittedOrder.status === "in_attesa_pagamento" ? "Totale da pagare" : "Totale ordine"}</span>
              <span className="font-mono">{priceFormatter.format(Number(submittedOrder.total))}</span>
            </div>
            {submittedOrder.notes && (
              <div className="mt-2 rounded-[var(--radius-sm)] border border-[var(--state-warning)] p-2 text-sm">
                <strong>Note:</strong> {submittedOrder.notes}
              </div>
            )}
          </Card>
        )}

        <div className="mt-5 grid gap-2 sm:grid-cols-2">
          <Button variant="primary" className="w-full" onClick={() => void startNewOrder()} disabled={startingNewOrder}>
            {startingNewOrder ? "Verifico…" : "Ordina di nuovo"}
          </Button>
          <Button variant="ghost" className="w-full" href={`${import.meta.env.BASE_URL}#programma`}>
            Torna al programma
          </Button>
          <Button
            variant="ghost"
            className="w-full sm:col-span-2"
            onClick={() => void handlePdfDownload()}
            disabled={!qrDataUrl || pdfLoading}
          >
            {pdfLoading ? "Preparo il PDF…" : "Scarica copia PDF"}
          </Button>
        </div>

        <Modal
          open={showCopyPrompt}
          title="Vuoi una copia?"
          actions={(
            <>
              <Button variant="ghost" onClick={() => setShowCopyPrompt(false)}>No, grazie</Button>
              <Button variant="primary" onClick={() => void handlePdfDownload()} disabled={!qrDataUrl || pdfLoading}>
                {pdfLoading ? "Preparo…" : "Scarica PDF"}
              </Button>
            </>
          )}
        >
          <p>Puoi scaricare un riepilogo non fiscale dell’ordine. Lo scontrino sarà emesso in cassa.</p>
        </Modal>

        <Modal
          open={newOrderMessage !== null}
          title="Nuovo ordine non disponibile"
          dismissible
          onClose={() => setNewOrderMessage(null)}
          actions={<Button variant="primary" onClick={() => setNewOrderMessage(null)}>Ho capito</Button>}
        >
          <p>{newOrderMessage}</p>
          <p className="mt-2">I tuoi ordini precedenti restano consultabili qui.</p>
        </Modal>
      </main>
    );
  }

  return (
    <main
      className="mx-auto min-h-full max-w-3xl px-4 pt-8"
      style={{ paddingBottom: `calc(${cartHeight + 32}px + env(safe-area-inset-bottom, 0px))` }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button href={`${import.meta.env.BASE_URL}#menu`} variant="back" className="min-h-10 px-4 py-2">← Torna al menu del sito</Button>
        {orderHistory.length > 0 && (
          <Button variant="ghost" onClick={() => viewOrder(orderHistory[0])}>
            I miei ordini ({orderHistory.length})
          </Button>
        )}
      </div>
      <h1 className="mt-5 text-3xl">Ordina qui</h1>
      <label className="mt-5 block rounded-[var(--radius-md)] border-2 border-[var(--accent-primary)] bg-white/5 p-4">
        <span className="mb-2 block text-lg font-semibold">Inserisci qui il nome del tuo ordine</span>
        <input
          value={alias}
          onChange={(event) => setAlias(event.target.value)}
          maxLength={32}
          placeholder="Es. Tavolo Girasole"
          autoComplete="off"
          className="field w-full py-3 text-base"
        />
        <span className="mt-1 block text-xs text-[var(--text-secondary)]">
          Usa uno pseudonimo, non inserire telefono, email o altri dati personali.
        </span>
      </label>

      <input
        value={botField}
        onChange={(event) => setBotField(event.target.value)}
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="absolute left-[-10000px] h-px w-px overflow-hidden"
      />

      {loadError ? (
        <div className="mt-6 text-sm text-[var(--state-error)]">
          <p>{loadError}</p>
          <Button variant="ghost" className="mt-3" onClick={() => void loadCatalog()}>Riprova</Button>
        </div>
      ) : loading ? (
        <p className="mt-6 text-sm text-[var(--text-secondary)]">Carico il menu…</p>
      ) : !catalog?.accepting ? (
        <p className="mt-6 text-sm text-[var(--state-warning)]">
          {orderingReasonMessage(catalog?.reason ?? null, catalog?.opens_at)}
        </p>
      ) : (
        (["cibo", "bevande"] as const).map((category) => (
          <section key={category} className="mt-8">
            <h2 className="text-2xl">{category === "cibo" ? "Cucina" : "Bar"}</h2>
            {category === "bevande" && (
              <div className="mt-4 rounded-[var(--radius-md)] border border-[var(--accent-primary)]/40 bg-[rgba(242,128,46,0.08)] px-4 py-3 text-sm font-semibold text-[var(--accent-primary)]">
                Acqua Gratis
              </div>
            )}
            {MENU_SECTIONS[category].map((section) => {
              const sectionItems = catalog.items.filter((item) => item.category === category && item.subcategory === section.key);
              if (sectionItems.length === 0) return null;
              return (
                <div key={section.key} className="mt-5">
                  <h3 className="mb-2 text-sm font-semibold uppercase tracking-[0.12em] text-[var(--accent-primary)]">{section.label}</h3>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {sectionItems.map((item) => {
                      const almostFinished = item.available_portions !== null
                        && item.stock_capacity !== null
                        && item.available_portions > 0
                        && item.available_portions <= Math.ceil(item.stock_capacity * 0.2);
                      const finished = item.available_portions === 0;
                      return (
                        <button key={item.id} type="button" onClick={() => addItem(item)} disabled={finished} className="surface-solid flex min-h-20 items-start justify-between gap-3 rounded-[var(--radius-md)] p-3 text-left transition-colors hover:bg-[var(--surface-solid-hover)] disabled:cursor-not-allowed disabled:opacity-55">
                          <span>
                            <span className="block text-sm font-semibold">{item.name}</span>
                            {item.allergens.length > 0 && <span className="mt-1 block text-xs text-[var(--text-secondary)]">Allergeni: {item.allergens.join(", ")}</span>}
                            {almostFinished && <span className="mt-1 block text-xs text-[var(--state-warning)]">Quasi terminato</span>}
                            {finished && <span className="mt-1 block text-xs text-[var(--state-error)]">Terminato</span>}
                          </span>
                          <span className="shrink-0 font-mono text-sm text-[var(--accent-primary)]">{priceFormatter.format(Number(item.price))}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </section>
        ))
      )}

      <details className="mt-8 text-xs text-[var(--text-secondary)]">
        <summary className="cursor-pointer">Legenda allergeni 1–14</summary>
        <ol className="mt-2 grid gap-1 sm:grid-cols-2">
          {ALLERGENS.map((allergen, index) => <li key={allergen}>{index + 1}. {allergen}</li>)}
        </ol>
      </details>

      {lines.length > 0 && (
        <section
          ref={setCartElement}
          className="glass-elevated fixed inset-x-3 z-50 mx-auto max-w-xl rounded-[var(--radius-lg)] p-3"
          style={{ bottom: "calc(12px + env(safe-area-inset-bottom, 0px))" }}
        >
          <button
            type="button"
            onClick={() => setCartExpanded((value) => !value)}
            className="flex w-full items-center justify-between text-left"
            aria-expanded={cartExpanded}
          >
            <span className="font-semibold">Carrello · {lines.reduce((sum, line) => sum + line.qty, 0)} articoli</span>
            <span className="font-mono text-[var(--accent-primary)]">{priceFormatter.format(total)} {cartExpanded ? "⌄" : "⌃"}</span>
          </button>
          {cartExpanded && (
            <div className="mt-3 max-h-[50dvh] overflow-y-auto overscroll-contain border-t border-[var(--surface-border)] pt-3">
              <div className="flex flex-col gap-2">
                {lines.map((line) => (
                  <div key={line.id} className="flex items-center justify-between gap-3 text-sm">
                    <span>{line.qty}× {line.name}</span>
                    <div className="flex items-center gap-3">
                      <span className="font-mono">{priceFormatter.format(line.price * line.qty)}</span>
                      <button type="button" onClick={() => decrementItem(line.id)} className="text-lg text-[var(--state-error)]" aria-label={`Rimuovi una unità di ${line.name}`}>−</button>
                    </div>
                  </div>
                ))}
              </div>
              <label className="mt-3 block">
                <span className="text-xs font-semibold">Note per la cucina</span>
                <textarea
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  maxLength={300}
                  rows={2}
                  placeholder="Es. senza cipolla. Non inserire dati personali."
                  className="field mt-1 w-full resize-none"
                />
              </label>
              {submitError && <p className="mt-2 text-xs text-[var(--state-error)]">{submitError}</p>}
              <Button variant="primary" className="mt-3 w-full" onClick={requestSubmit}>Invia ordine</Button>
            </div>
          )}
        </section>
      )}

      <Modal
        open={showIntro}
        title="Come funziona"
        actions={<Button variant="primary" onClick={() => setShowIntro(false)}>OK, ho capito</Button>}
      >
        <p>Prepara qui il tuo ordine e invialo. Il pagamento avviene esclusivamente in cassa, in contanti o con carta, entro 60 minuti dall’invio. Gli ordini non pagati scadono e liberano le disponibilità. Dopo il pagamento potrai ritirare le voci nelle postazioni indicate usando sempre lo stesso QR.</p>
      </Modal>

      <Modal
        open={showConfirmation}
        title="Conferma definitiva"
        dismissible={!submitting}
        onClose={() => setShowConfirmation(false)}
        actions={(
          <>
            <Button variant="ghost" onClick={() => setShowConfirmation(false)} disabled={submitting}>Torna al carrello</Button>
            <Button variant="primary" onClick={() => void submitOrder()} disabled={submitting || !challengeToken}>
              {submitting ? "Invio…" : "Conferma e ordina"}
            </Button>
          </>
        )}
      >
        <TurnstileChallenge key={challengeAttempt} onToken={setChallengeToken}/>
        <p>Controlla bene prodotti, quantità e note: dopo questo passaggio non potrai più modificare l’ordine.</p>
        {lines.some(line=>line.category==='cibo') && <PreparationChoice value={preparationMode} onChange={setPreparationMode} disabled={submitting}/>}
        <p className="mt-2 font-semibold text-[var(--text-primary)]">Totale da pagare in cassa: {priceFormatter.format(total)}</p>
      </Modal>
    </main>
  );
}
