import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { TurnstileChallenge } from "../../components/ui/TurnstileChallenge";
import { appHref, pollWhileVisible } from "../../lib/browser";
import { supabase } from "../../lib/supabaseClient";
import { addToCart, cartTotal, removeOneFromCart, type Cart } from "./cart";
import { CartPanel } from "./CartPanel";
import {
  addOrderToHistory,
  applyStatusUpdates,
  fetchOrderStatusUpdates,
  isPublicOrderStatus,
  ordersForEvent,
  readOrderHistory,
  saveOrderHistory,
  type PublicOrderStatus,
  type StoredOrder,
} from "./orderHistory";
import { OrderMenu } from "./OrderMenu";
import { getOrCreateRecoveryToken, recoveryOrderQr, saveRecoveryToken } from "./orderRecovery";
import { ALLERGENS, orderingReasonMessage, priceFormatter, submitFailure } from "./orderUtils";
import { clearPendingOrder, readPendingOrder, savePendingOrder, type PendingOrderRequest } from "./pendingOrder";
import { PendingRequestPanel } from "./PendingRequestPanel";
import { PreparationChoice } from "./PreparationChoice";
import { RestoreHistoryScreen } from "./RestoreHistoryScreen";
import { SubmittedOrderView } from "./SubmittedOrderView";
import type { OrderMenuItem, OrderingCatalog, PreparationMode, SubmittedOrder } from "./types";

/*
  Contenitore della pagina ordini: tiene lo stato condiviso (menu, carrello, storico,
  richiesta in sospeso) e la logica di invio. Le viste sono componenti separati:
  RestoreHistoryScreen, SubmittedOrderView, PendingRequestPanel, OrderMenu, CartPanel.
*/
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
  const [cartHeight, setCartHeight] = useState(0);
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
  const [showCopyPrompt, setShowCopyPrompt] = useState(false);
  const [botField, setBotField] = useState("");
  const [startingNewOrder, setStartingNewOrder] = useState(false);
  const [newOrderMessage, setNewOrderMessage] = useState<string | null>(null);
  const requestIdentityRef = useRef({ requestId: crypto.randomUUID(), qrToken: crypto.randomUUID() });
  const historyRef = useRef(orderHistory);
  const [restoreToken, setRestoreToken] = useState(() =>
    new URLSearchParams(location.hash.split("?")[1] ?? "").get("recupero"),
  );
  const [pendingRequest, setPendingRequest] = useState<PendingOrderRequest | null>(readPendingOrder);

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
    requestIdentityRef.current = { requestId: crypto.randomUUID(), qrToken: crypto.randomUUID() };
    setSubmittedOrder(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function mergeRestoredOrders(restored: StoredOrder[]) {
    if (!restoreToken) return;
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
  }

  if (restoreToken) return <RestoreHistoryScreen token={restoreToken} onRestored={mergeRestoredOrders} />;

  function abandonPendingRequest() {
    if (!pendingRequest) return;
    clearPendingOrder(pendingRequest.requestId);
    setPendingRequest(readPendingOrder());
    requestIdentityRef.current = { requestId: crypto.randomUUID(), qrToken: crypto.randomUUID() };
    setSubmitError(null);
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
    <PendingRequestPanel
      request={pendingRequest}
      fromOldEvent={pendingFromOldEvent}
      error={submitError}
      submitting={submitting}
      challengeAttempt={challengeAttempt}
      challengeToken={challengeToken}
      onChallengeToken={setChallengeToken}
      onRecover={() => void submitOrder()}
      onAbandon={abandonPendingRequest}
    />
  );

  if (submittedOrder) {
    return (
      <SubmittedOrderView
        key={submittedOrder.order_id}
        order={submittedOrder}
        history={orderHistory}
        banner={pendingPanel}
        error={pendingRequest ? null : submitError}
        offerCopy={showCopyPrompt}
        onCopyHandled={() => setShowCopyPrompt(false)}
        onViewOrder={viewOrder}
        onRefreshStatuses={() => refreshOrderStatuses()}
        onStartNewOrder={() => void startNewOrder()}
        startingNewOrder={startingNewOrder}
        newOrderMessage={newOrderMessage}
        onDismissNewOrderMessage={() => setNewOrderMessage(null)}
      />
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
        <OrderMenu catalog={catalog} cart={cart} onAdd={addItem} />
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
        <CartPanel
          lines={lines}
          total={total}
          expanded={cartExpanded}
          onToggle={() => setCartExpanded((value) => !value)}
          onDecrement={decrementItem}
          notes={notes}
          onNotesChange={setNotes}
          error={cartError ?? (pendingRequest ? null : submitError)}
          onSubmit={requestSubmit}
          onHeightChange={setCartHeight}
        />
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
