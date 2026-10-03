import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Modal } from "../../components/ui/Modal";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { supabase } from "../../lib/supabaseClient";
import { ALLERGENS, downloadOrderPdf, orderingReasonMessage, priceFormatter, submitFailure } from "./orderUtils";
import { addToCart, cartItemCount, cartTotal, lineTotal, remainingStock, removeOneFromCart, type Cart } from "./cart";
import {
  ORDER_STATUS_LABELS,
  addOrderToHistory,
  applyStatusUpdates,
  fetchOrderStatusUpdates,
  isPublicOrderStatus,
  orderStatusClassName,
  ordersForEvent,
  readOrderHistory,
  saveOrderHistory,
  type PublicOrderStatus,
  type StoredOrder,
} from "./orderHistory";
import type { OrderMenuItem, OrderingCatalog, SubmittedOrder } from "./types";
import { clearPendingOrder, readPendingOrder, savePendingOrder, type PendingOrderRequest } from "./pendingOrder";
import {
  getOrCreateRecoveryToken,
  readRecoveryToken,
  recoveryOrderQr,
  saveRecoveryToken,
  validRecoveryToken,
} from "./orderRecovery";
import { TurnstileChallenge } from "../../components/ui/TurnstileChallenge";
import { RecoveryCard } from "./RecoveryCard";
import { PreparationChoice, PreparationStatus } from "./PreparationChoice";
import type { PreparationMode } from "./types";
import { MENU_SECTIONS } from "../menu/menuSections";
import { FreeWaterNotice } from "../menu/FreeWaterNotice";
import { appHref, pollWhileVisible } from "../../lib/browser";

function statusMessage(status: PublicOrderStatus) {
  switch (status) {
    case "pagato":
      return "Pagamento registrato. Il tuo ordine è in preparazione.";
    case "ritiro_parziale":
      return "Hai ritirato una parte dell’ordine. Conserva il QR per le altre postazioni.";
    case "consegnato":
      return "Ordine consegnato. Grazie!";
    case "annullato":
      return "Questo ordine è stato annullato.";
    default:
      return "Ordine inviato. Ora raggiungi la cassa per pagare.";
  }
}

export function OrderPage({ startFresh = false }: { startFresh?: boolean }) {
  const [orderHistory, setOrderHistory] = useState<StoredOrder[]>(readOrderHistory);
  const [catalog, setCatalog] = useState<OrderingCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showIntro, setShowIntro] = useState(() => !startFresh && readOrderHistory().length === 0);
  const [alias, setAlias] = useState(() => (startFresh ? (readOrderHistory()[0]?.alias ?? "") : ""));
  const [notes, setNotes] = useState("");
  const [cart, setCart] = useState<Cart>({});
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
  // Limiti del carrello: restano vicino al carrello, separati dagli errori di invio
  // che con una richiesta in sospeso compaiono nel pannello in cima.
  const [cartError, setCartError] = useState<string | null>(null);
  const [submittedOrder, setSubmittedOrder] = useState<StoredOrder | null>(() =>
    startFresh ? null : (readOrderHistory()[0] ?? null),
  );
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrError, setQrError] = useState(false);
  const [finalTab, setFinalTab] = useState<"qr" | "summary">("qr");
  const [showCopyPrompt, setShowCopyPrompt] = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [botField, setBotField] = useState("");
  const [startingNewOrder, setStartingNewOrder] = useState(false);
  const [refreshingStatuses, setRefreshingStatuses] = useState(false);
  const [newOrderMessage, setNewOrderMessage] = useState<string | null>(null);
  const requestIdentityRef = useRef({ requestId: crypto.randomUUID(), qrToken: crypto.randomUUID() });
  const historyRef = useRef(orderHistory);
  const [restoreToken, setRestoreToken] = useState(() =>
    new URLSearchParams(location.hash.split("?")[1] ?? "").get("recupero"),
  );
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [showRecovery, setShowRecovery] = useState(false);
  const [pendingRequest, setPendingRequest] = useState<PendingOrderRequest | null>(readPendingOrder);
  const [showAbandonConfirmation, setShowAbandonConfirmation] = useState(false);

  useEffect(() => {
    historyRef.current = orderHistory;
  }, [orderHistory]);

  const refreshOrderStatuses = useCallback(async (orders = historyRef.current) => {
    if (orders.length === 0) return;
    const updates = await fetchOrderStatusUpdates(orders);
    if (updates.size === 0) return;
    setOrderHistory((current) => {
      const next = applyStatusUpdates(current, updates);
      saveOrderHistory(next);
      historyRef.current = next;
      return next;
    });
    setSubmittedOrder((current) => (current ? applyStatusUpdates([current], updates)[0] : null));
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
      setSubmittedOrder(latest);
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

  useEffect(() => pollWhileVisible(() => void refreshOrderStatuses(), 30_000), [refreshOrderStatuses]);

  useEffect(() => {
    if (!submittedOrder) {
      setQrDataUrl(null);
      return;
    }
    setQrDataUrl(null);
    setQrError(false);
    let cancelled = false;
    void import("qrcode")
      .then((module) =>
        module.default.toDataURL(`LAGORDER:${submittedOrder.qr_token}`, {
          width: 360,
          margin: 2,
          errorCorrectionLevel: "M",
        }),
      )
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [submittedOrder]);

  const lines = useMemo(() => Object.values(cart), [cart]);
  const total = cartTotal(lines);

  function addItem(item: OrderMenuItem) {
    const maxItem = catalog?.max_item_quantity ?? 25;
    const maxOrder = catalog?.max_order_quantity ?? 60;
    const result = addToCart(cart, item, { maxItem, maxOrder });
    setCartExpanded(true);
    if (result.blocked === "stock") {
      setCartError(`Hai già nel carrello tutte le porzioni rimaste di ${item.name}.`);
      return;
    }
    if (result.blocked) {
      setCartError(
        `Puoi ordinare al massimo ${maxItem} pezzi per prodotto e ${maxOrder} articoli in totale. Per ordini più grandi rivolgiti alla cassa.`,
      );
      return;
    }
    setCartError(null);
    setCart(result.cart);
  }

  function decrementItem(id: string) {
    setCartError(null);
    setCart((current) => removeOneFromCart(current, id));
  }

  function requestSubmit() {
    setSubmitError(null);
    setCartError(null);
    // L'invio riprenderebbe la richiesta in sospeso, non il carrello attuale.
    if (pendingRequest) {
      setSubmitError(
        "C’è una richiesta in sospeso in cima alla pagina: recuperala o rinunciaci prima di inviare un nuovo ordine.",
      );
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    if (!/^[\p{L}\p{N}][\p{L}\p{N} _-]{1,31}$/u.test(alias.trim())) {
      setSubmitError(
        "Inserisci un nome dell’ordine di 2–32 caratteri usando lettere, numeri, spazi, trattino o underscore.",
      );
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
    let sentCart = false;
    const releaseCart = () => {
      if (!sentCart) return;
      setCart({});
      setNotes("");
    };
    try {
      setSubmitError(null);
      const pending: PendingOrderRequest = pendingRequest ?? {
        ...requestIdentityRef.current,
        eventId: catalog?.event_id ?? "",
        alias: alias.trim(),
        notes: notes.trim(),
        items: lines,
        createdAt: new Date().toISOString(),
        preparationMode: lines.some((line) => line.category === "cibo") ? preparationMode : "immediate",
      };
      const activeCatalog = catalog ?? (await loadCatalog());
      if (!activeCatalog) {
        setSubmitError("Non riesco a verificare l’evento. Controlla la rete e riprova.");
        return;
      }
      if (pending.eventId !== activeCatalog.event_id) {
        setSubmitError(
          "Questa richiesta è di un evento precedente e non può più essere inviata. Non hai pagato nulla: puoi eliminarla.",
        );
        return;
      }
      if (!pendingRequest) {
        try {
          pending.recoveryToken = getOrCreateRecoveryToken(pending.eventId);
          pending.qrToken = await recoveryOrderQr(pending.recoveryToken, pending.requestId);
        } catch {
          setSubmitError(
            "Il browser non consente il salvataggio sicuro. Libera spazio o rivolgiti alla cassa: nessun ordine è stato inviato.",
          );
          return;
        }
      }
      if (!savePendingOrder(pending)) {
        setSubmitError(
          "Il browser non consente di salvare l’ordine in sicurezza. Libera spazio o rivolgiti alla cassa: nessun nuovo ordine è stato inviato.",
        );
        return;
      }
      // Se si sta inviando il carrello, da qui il suo contenuto vive nella richiesta salvata:
      // va svuotato quando l'ordine è registrato o resta in sospeso, così non può essere
      // reinviato come doppione. Un recupero dal pannello invece non tocca il carrello in corso.
      sentCart = !pendingRequest;
      setPendingRequest(pending);
      setSubmitting(true);
      const { requestId, qrToken } = pending;
      const { data, error: invocationError } = await supabase.functions.invoke("submit-order", {
        body: {
          turnstileToken: challengeToken,
          order: {
            p_alias: pending.alias,
            p_notes: pending.notes,
            p_items: pending.items.map((line) => ({ id: line.id, qty: line.qty })),
            p_client_request_id: requestId,
            p_qr_token: qrToken,
            p_bot_field: botField,
            p_expected_event_id: pending.eventId,
            p_recovery_token: pending.recoveryToken ?? null,
            p_preparation_mode: pending.preparationMode ?? "immediate",
          },
        },
      });
      let error = invocationError;
      if (invocationError?.context instanceof Response) {
        try {
          const details = await invocationError.context.json();
          if (typeof details.error === "string") error = new Error(details.error);
        } catch {
          /* Keep uncertain outcome. */
        }
      }
      setSubmitting(false);
      setShowConfirmation(false);
      if (error || !data) {
        const failure = submitFailure(error?.message ?? "", {
          maxItem: catalog?.max_item_quantity ?? 25,
          maxOrder: catalog?.max_order_quantity ?? 60,
        });
        if (failure.definitive) {
          // Il server non ha creato l'ordine: "Recupera ordine" darebbe sempre lo stesso errore.
          // Si libera la richiesta salvata e il prossimo invio usa una richiesta nuova.
          clearPendingOrder(requestId);
          setPendingRequest(null);
          requestIdentityRef.current = { requestId: crypto.randomUUID(), qrToken: crypto.randomUUID() };
          if (!sentCart) {
            // Era una richiesta in sospeso, il cui carrello è già stato svuotato: i prodotti
            // tornano nel carrello (se è vuoto) per poterla correggere e reinviare.
            setCart((current) =>
              Object.keys(current).length > 0
                ? current
                : Object.fromEntries(pending.items.map((line) => [line.id, line])),
            );
            setNotes((current) => current || pending.notes);
            setAlias((current) => current || pending.alias);
          }
        } else {
          // Esito incerto: il contenuto resta nella richiesta in sospeso mostrata in cima.
          releaseCart();
        }
        setSubmitError(failure.message);
        if (failure.reloadCatalog) await loadCatalog();
        return;
      }
      const order = data as SubmittedOrder;
      const storedOrder: StoredOrder = {
        ...order,
        alias: order.alias ?? pending.alias,
        recovery_enabled: Boolean(pending.recoveryToken),
        status: isPublicOrderStatus((data as { status?: unknown }).status)
          ? (data as { status: PublicOrderStatus }).status
          : "in_attesa_pagamento",
        saved_at: new Date().toISOString(),
      };
      const next = addOrderToHistory(historyRef.current, storedOrder);
      if (saveOrderHistory(next)) {
        clearPendingOrder(requestId);
        setPendingRequest(readPendingOrder());
      } else {
        setSubmitError("Ordine registrato. Conserva il QR: il browser non è riuscito ad aggiornare lo storico.");
      }
      historyRef.current = next;
      setOrderHistory(next);
      setSubmittedOrder(storedOrder);
      releaseCart();
      setShowCopyPrompt(true);
    } catch {
      setSubmitError(
        "Connessione interrotta. La richiesta resta salvata: premi Recupera ordine per verificarla senza duplicati.",
      );
      setShowConfirmation(false);
      releaseCart();
    } finally {
      submitBusy.current = false;
      setSubmitting(false);
      setChallengeToken("");
      setChallengeAttempt((value) => value + 1);
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
    // Carrello e note non si toccano: dopo un invio sono già vuoti, mentre un carrello
    // lasciato a metà (per vedere un ordine o recuperarne uno) resta com'era.
    setCartExpanded(false);
    setSubmitError(null);
    setCartError(null);
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
    if (!validRecoveryToken(restoreToken)) {
      setRestoreError("Codice di recupero non valido.");
      return;
    }
    setRestoreBusy(true);
    setRestoreError(null);
    try {
      const restored: StoredOrder[] = [];
      let cursor: string | null = null;
      while (true) {
        const response = await supabase.rpc("recover_order_history", { p_token: restoreToken, p_before: cursor });
        if (response.error) throw new Error("restore_failed");
        const page = response.data as Array<StoredOrder & { created_at: string }>;
        for (const order of page) restored.push({ ...order, saved_at: order.created_at, recovery_enabled: true });
        if (page.length < 50) break;
        cursor = page[page.length - 1].order_id;
      }
      if (!restored.length) {
        setRestoreError("Non ci sono ordini associati a questo codice.");
        return;
      }
      const merged = [
        ...restored,
        ...historyRef.current.filter((order) => !restored.some((item) => item.order_id === order.order_id)),
      ];
      const saved = saveOrderHistory(merged);
      for (const order of restored) saveRecoveryToken(order.event_id, restoreToken);
      historyRef.current = merged;
      setOrderHistory(merged);
      setSubmittedOrder(restored[0]);
      setShowIntro(false);
      if (!saved) setSubmitError("Ordini recuperati, ma non salvati dal browser. Conserva la scheda di recupero.");
      setRestoreToken(null);
      history.replaceState(null, "", `${location.pathname}${location.search}#ordina`);
      setLoading(false);
    } catch {
      setRestoreError("Recupero non riuscito. Controlla la connessione e riprova: il codice resta valido.");
    } finally {
      setRestoreBusy(false);
    }
  }

  if (restoreToken)
    return (
      <main className="mx-auto max-w-md px-4 py-8">
        <h1 className="text-2xl">Ritrova i tuoi ordini</h1>
        <p className="my-4 text-sm text-[var(--text-secondary)]">
          Il tuo codice permette di recuperare lo storico, senza account.
        </p>
        {restoreError && (
          <p role="alert" className="mb-4 text-sm">
            {restoreError}
          </p>
        )}
        <Button className="w-full" disabled={restoreBusy} onClick={() => void restoreHistory()}>
          {restoreBusy ? "Recupero gli ordini…" : "Recupera i miei ordini"}
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
  const recoveryToken = submittedOrder ? readRecoveryToken(submittedOrder.event_id) : null;
  if (showRecovery && submittedOrder && recoveryToken)
    return (
      <RecoveryCard token={recoveryToken} eventName={submittedOrder.event_name} onBack={() => setShowRecovery(false)} />
    );

  function abandonPendingRequest() {
    if (!pendingRequest) return;
    clearPendingOrder(pendingRequest.requestId);
    setPendingRequest(readPendingOrder());
    requestIdentityRef.current = { requestId: crypto.randomUUID(), qrToken: crypto.randomUUID() };
    setSubmitError(null);
    setShowAbandonConfirmation(false);
  }

  // Una richiesta interrotta (per esempio rete caduta) non blocca più la pagina: resta in
  // evidenza in cima, mentre ordini già fatti, QR e carrello restano utilizzabili.
  // Durante la conferma resta nascosto: la richiesta viene salvata prima dell'invio e il
  // pannello avvierebbe una seconda verifica di sicurezza dietro la finestra.
  // Una richiesta di un evento precedente non si può più recuperare: l'invio la rifiuta sempre
  // e, se era arrivata, non è stata pagata ed è scaduta. Resta solo da eliminarla.
  const pendingFromOldEvent = Boolean(
    pendingRequest && catalog?.event_id && pendingRequest.eventId !== catalog.event_id,
  );
  const pendingPanel = pendingRequest && !showConfirmation && (
    <section
      role="region"
      aria-labelledby="pending-request-title"
      className="mt-4 rounded-[var(--radius-md)] border-2 border-[var(--state-warning)] p-4 text-left"
    >
      <h2 id="pending-request-title" className="text-lg">
        Un ordine non è stato confermato
      </h2>
      <p className="mt-1 text-sm text-[var(--text-secondary)]">
        {pendingFromOldEvent
          ? "Questa richiesta è di un evento precedente e non può più essere inviata. Non hai pagato nulla: puoi eliminarla."
          : "La connessione si è interrotta durante l’invio. Verifichiamo se è arrivato in cassa, senza crearne un doppione."}
      </p>
      <ul className="my-3 space-y-1 text-sm">
        {pendingRequest.items.map((line) => (
          <li key={line.id}>
            {line.qty} × {line.name}
          </li>
        ))}
      </ul>
      {submitError && !pendingFromOldEvent && (
        <p role="alert" className="mb-3 text-sm text-[var(--state-warning)]">
          {submitError}
        </p>
      )}
      {pendingFromOldEvent ? (
        <Button variant="ghost" className="w-full" onClick={abandonPendingRequest}>
          Elimina questa richiesta
        </Button>
      ) : (
        <>
          <TurnstileChallenge key={challengeAttempt} onToken={setChallengeToken} />
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <Button className="w-full" disabled={submitting || !challengeToken} onClick={() => void submitOrder()}>
              {submitting ? "Verifico l’ordine…" : "Recupera ordine"}
            </Button>
            <Button
              variant="ghost"
              className="w-full"
              disabled={submitting}
              onClick={() => setShowAbandonConfirmation(true)}
            >
              Rinuncia a questa richiesta
            </Button>
          </div>
        </>
      )}
      <Modal
        open={showAbandonConfirmation}
        title="Rinunciare alla richiesta?"
        dismissible
        onClose={() => setShowAbandonConfirmation(false)}
        actions={
          <>
            <Button variant="ghost" onClick={() => setShowAbandonConfirmation(false)}>
              No, riprovo
            </Button>
            <Button variant="primary" onClick={abandonPendingRequest}>
              Sì, rinuncio
            </Button>
          </>
        }
      >
        <p>
          Se l’ordine era comunque arrivato in cassa, resterà in attesa di pagamento per 60 minuti e poi scadrà da solo:
          non paghi nulla finché non passi in cassa.
        </p>
      </Modal>
    </section>
  );

  if (submittedOrder) {
    return (
      <main className="mx-auto min-h-full max-w-xl px-4 py-8">
        <Button href={appHref("#menu")} variant="back" className="min-h-10 px-4 py-2">
          ← Indietro
        </Button>
        {pendingPanel}
        {submitError && !pendingRequest && (
          <p
            role="alert"
            className="mt-4 rounded-[var(--radius-sm)] border border-[var(--state-warning)] p-3 text-sm text-[var(--state-warning)]"
          >
            {submitError}
          </p>
        )}
        <section className="mt-5 text-center">
          <p className={`text-sm ${orderStatusClassName(submittedOrder.status)}`}>
            {submittedOrder.event_closed_at
              ? "Evento concluso. Questo ordine resta nello storico; il QR non è più utilizzabile per il ritiro."
              : submittedOrder.status === "pagato" &&
                  (submittedOrder.kitchen_state === "dormant" || submittedOrder.kitchen_state === "waiting")
                ? "Pagamento registrato."
                : statusMessage(submittedOrder.status)}
          </p>
          <h1 className="mt-2 text-4xl">#{submittedOrder.display_number}</h1>
          {!submittedOrder.event_closed_at &&
            (submittedOrder.status === "pagato" || submittedOrder.status === "ritiro_parziale") && (
              <PreparationStatus state={submittedOrder.kitchen_state} />
            )}
          {submittedOrder.status === "in_attesa_pagamento" && submittedOrder.preparation_mode === "deferred" && (
            <p className="mt-2 text-sm">
              Hai scelto di preparare il cibo più tardi. Paga entro 60 minuti per mantenere le quantità riservate.
            </p>
          )}
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
                  <strong className={item.delivered >= item.quantity ? "text-[var(--state-success)]" : ""}>
                    {item.delivered}/{item.quantity}
                  </strong>
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
                  <strong>
                    #{order.display_number} · {order.alias}
                  </strong>
                  <span className="mt-0.5 block text-xs text-[var(--text-secondary)]">
                    {order.event_name} · {cartItemCount(order.items)} articoli ·{" "}
                    {priceFormatter.format(Number(order.total))}
                  </span>
                </span>
                <span className={`shrink-0 text-xs font-semibold ${orderStatusClassName(order.status)}`}>
                  {order.event_closed_at ? "Evento concluso" : ORDER_STATUS_LABELS[order.status]}
                </span>
              </button>
            ))}
          </div>
        </Card>

        {submittedOrder.recovery_enabled && recoveryToken && (
          <Button
            variant="ghost"
            className="mt-3 w-full"
            onClick={() => {
              setShowRecovery(true);
              window.scrollTo({ top: 0 });
            }}
          >
            Conserva i miei ordini
          </Button>
        )}
        <Button
          variant="ghost"
          className="mt-3 w-full"
          onClick={async () => {
            setRefreshingStatuses(true);
            await refreshOrderStatuses();
            setRefreshingStatuses(false);
          }}
          disabled={refreshingStatuses}
        >
          {refreshingStatuses ? "Aggiorno lo stato…" : "Aggiorna stato ordini"}
        </Button>

        <SegmentedControl
          className="mx-auto mt-5 max-w-xs"
          value={finalTab}
          onChange={setFinalTab}
          options={[
            { value: "qr", label: "QR code" },
            { value: "summary", label: "Riepilogo" },
          ]}
        />

        {finalTab === "qr" ? (
          <Card className="mx-auto mt-4 max-w-sm text-center">
            {submittedOrder.event_closed_at ? (
              <p className="py-6 text-sm">Evento concluso: puoi consultare il riepilogo dell’ordine.</p>
            ) : qrDataUrl ? (
              <img
                src={qrDataUrl}
                alt={`QR dell’ordine ${submittedOrder.display_number}`}
                className="mx-auto w-full max-w-[300px] rounded-xl bg-white"
              />
            ) : qrError ? (
              <p role="alert" className="py-10 text-sm text-[var(--state-warning)]">
                QR non generato. In cassa comunica numero e nome dell’ordine.
              </p>
            ) : (
              <p className="py-16 text-sm text-[var(--text-secondary)]">Genero il QR…</p>
            )}
          </Card>
        ) : (
          <Card className="mt-4 flex flex-col gap-2">
            {submittedOrder.items.map((line) => (
              <div key={line.id} className="flex justify-between gap-3 text-sm">
                <span>
                  {line.qty}× {line.name}
                </span>
                <span className="font-mono">{priceFormatter.format(lineTotal(line))}</span>
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
          <Button variant="ghost" className="w-full" href={appHref("#programma")}>
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
          actions={
            <>
              <Button variant="ghost" onClick={() => setShowCopyPrompt(false)}>
                No, grazie
              </Button>
              <Button variant="primary" onClick={() => void handlePdfDownload()} disabled={!qrDataUrl || pdfLoading}>
                {pdfLoading ? "Preparo…" : "Scarica PDF"}
              </Button>
            </>
          }
        >
          <p>Puoi scaricare un riepilogo non fiscale dell’ordine. Lo scontrino sarà emesso in cassa.</p>
        </Modal>

        <Modal
          open={newOrderMessage !== null}
          title="Nuovo ordine non disponibile"
          dismissible
          onClose={() => setNewOrderMessage(null)}
          actions={
            <Button variant="primary" onClick={() => setNewOrderMessage(null)}>
              Ho capito
            </Button>
          }
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
        <Button href={appHref("#menu")} variant="back" className="min-h-10 px-4 py-2">
          ← Torna al menu del sito
        </Button>
        {orderHistory.length > 0 && (
          <Button variant="ghost" onClick={() => viewOrder(orderHistory[0])}>
            I miei ordini ({orderHistory.length})
          </Button>
        )}
      </div>
      {pendingPanel}
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
          <Button variant="ghost" className="mt-3" onClick={() => void loadCatalog()}>
            Riprova
          </Button>
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
            {category === "bevande" && <FreeWaterNotice />}
            {MENU_SECTIONS[category].map((section) => {
              const sectionItems = catalog.items.filter(
                (item) => item.category === category && item.subcategory === section.key,
              );
              if (sectionItems.length === 0) return null;
              return (
                <div key={section.key} className="mt-5">
                  <h3 className="mb-2 text-sm font-semibold uppercase tracking-[0.12em] text-[var(--accent-primary)]">
                    {section.label}
                  </h3>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {sectionItems.map((item) => {
                      const almostFinished =
                        item.available_portions !== null &&
                        item.stock_capacity !== null &&
                        item.available_portions > 0 &&
                        item.available_portions <= Math.ceil(item.stock_capacity * 0.2);
                      const finished = item.available_portions === 0;
                      // Le scorte compaiono solo qui: il menu pubblico resta fisso per la serata.
                      const allInCart = !finished && remainingStock(cart, item) === 0;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => addItem(item)}
                          disabled={finished || allInCart}
                          className="surface-solid flex min-h-20 items-start justify-between gap-3 rounded-[var(--radius-md)] p-3 text-left transition-colors hover:bg-[var(--surface-solid-hover)] disabled:cursor-not-allowed disabled:opacity-55"
                        >
                          <span>
                            <span className="block text-sm font-semibold">{item.name}</span>
                            {item.allergens.length > 0 && (
                              <span className="mt-1 block text-xs text-[var(--text-secondary)]">
                                Allergeni: {item.allergens.join(", ")}
                              </span>
                            )}
                            {almostFinished && (
                              <span className="mt-1 block text-xs text-[var(--state-warning)]">Quasi terminato</span>
                            )}
                            {finished && (
                              <span className="mt-1 block text-xs text-[var(--state-error)]">Terminato</span>
                            )}
                            {allInCart && (
                              <span className="mt-1 block text-xs text-[var(--state-warning)]">
                                Hai nel carrello tutte le porzioni rimaste
                              </span>
                            )}
                          </span>
                          <span className="shrink-0 font-mono text-sm text-[var(--accent-primary)]">
                            {priceFormatter.format(Number(item.price))}
                          </span>
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
          {ALLERGENS.map((allergen, index) => (
            <li key={allergen}>
              {index + 1}. {allergen}
            </li>
          ))}
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
            <span className="font-semibold">Carrello · {cartItemCount(lines)} articoli</span>
            <span className="font-mono text-[var(--accent-primary)]">
              {priceFormatter.format(total)} {cartExpanded ? "⌄" : "⌃"}
            </span>
          </button>
          {cartExpanded && (
            <div className="mt-3 max-h-[50dvh] overflow-y-auto overscroll-contain border-t border-[var(--surface-border)] pt-3">
              <div className="flex flex-col gap-2">
                {lines.map((line) => (
                  <div key={line.id} className="flex items-center justify-between gap-3 text-sm">
                    <span>
                      {line.qty}× {line.name}
                    </span>
                    <div className="flex items-center gap-3">
                      <span className="font-mono">{priceFormatter.format(lineTotal(line))}</span>
                      <button
                        type="button"
                        onClick={() => decrementItem(line.id)}
                        className="text-lg text-[var(--state-error)]"
                        aria-label={`Rimuovi una unità di ${line.name}`}
                      >
                        −
                      </button>
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
              {(cartError ?? (pendingRequest ? null : submitError)) && (
                <p className="mt-2 text-xs text-[var(--state-error)]">{cartError ?? submitError}</p>
              )}
              <Button variant="primary" className="mt-3 w-full" onClick={requestSubmit}>
                Invia ordine
              </Button>
            </div>
          )}
        </section>
      )}

      <Modal
        open={showIntro}
        title="Come funziona"
        actions={
          <Button variant="primary" onClick={() => setShowIntro(false)}>
            OK, ho capito
          </Button>
        }
      >
        <p>
          Prepara qui il tuo ordine e invialo. Il pagamento avviene esclusivamente in cassa, in contanti o con carta,
          entro 60 minuti dall’invio. Gli ordini non pagati scadono e liberano le disponibilità. Dopo il pagamento
          potrai ritirare le voci nelle postazioni indicate usando sempre lo stesso QR.
        </p>
      </Modal>

      <Modal
        open={showConfirmation}
        title="Conferma definitiva"
        dismissible={!submitting}
        onClose={() => setShowConfirmation(false)}
        actions={
          <>
            <Button variant="ghost" onClick={() => setShowConfirmation(false)} disabled={submitting}>
              Torna al carrello
            </Button>
            <Button variant="primary" onClick={() => void submitOrder()} disabled={submitting || !challengeToken}>
              {submitting ? "Invio…" : "Conferma e ordina"}
            </Button>
          </>
        }
      >
        <TurnstileChallenge key={challengeAttempt} onToken={setChallengeToken} />
        <p>Controlla bene prodotti, quantità e note: dopo questo passaggio non potrai più modificare l’ordine.</p>
        {lines.some((line) => line.category === "cibo") && (
          <PreparationChoice value={preparationMode} onChange={setPreparationMode} disabled={submitting} />
        )}
        <p className="mt-2 font-semibold text-[var(--text-primary)]">
          Totale da pagare in cassa: {priceFormatter.format(total)}
        </p>
      </Modal>
    </main>
  );
}
