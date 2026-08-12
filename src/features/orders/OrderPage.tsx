import { useEffect, useMemo, useRef, useState } from "react";
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
import type { OrderLine, OrderMenuItem, OrderingCatalog, SubmittedOrder } from "./types";

const SAVED_ORDER_KEY = "lag:last-submitted-order";

function readSavedOrder() {
  try {
    const raw = localStorage.getItem(SAVED_ORDER_KEY);
    return raw ? JSON.parse(raw) as SubmittedOrder : null;
  } catch {
    return null;
  }
}

export function OrderPage() {
  const [catalog, setCatalog] = useState<OrderingCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showIntro, setShowIntro] = useState(() => readSavedOrder() === null);
  const [alias, setAlias] = useState("");
  const [notes, setNotes] = useState("");
  const [cart, setCart] = useState<Record<string, OrderLine>>({});
  const [cartExpanded, setCartExpanded] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submittedOrder, setSubmittedOrder] = useState<SubmittedOrder | null>(() => readSavedOrder());
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [finalTab, setFinalTab] = useState<"qr" | "summary">("qr");
  const [showCopyPrompt, setShowCopyPrompt] = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [botField, setBotField] = useState("");
  const requestIdentityRef = useRef({ requestId: crypto.randomUUID(), qrToken: crypto.randomUUID() });

  async function loadCatalog() {
    setLoading(true);
    setLoadError(null);
    const { data, error } = await supabase.rpc("get_ordering_catalog");
    if (error || !data) {
      setLoadError("Menu ordinazioni non disponibile. Controlla la connessione e riprova.");
      setLoading(false);
      return;
    }
    const nextCatalog = data as OrderingCatalog;
    setCatalog(nextCatalog);
    const saved = readSavedOrder();
    if (saved && saved.event_id !== nextCatalog.event_id) {
      localStorage.removeItem(SAVED_ORDER_KEY);
      setSubmittedOrder(null);
      setShowIntro(true);
    } else if (saved) {
      setSubmittedOrder(saved);
      setShowIntro(false);
    }
    setLoading(false);
  }

  useEffect(() => {
    void loadCatalog();
  }, []);

  useEffect(() => {
    if (!submittedOrder) return;
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
    setCart((current) => {
      const existing = current[item.id];
      if (item.available_portions !== null && (existing?.qty ?? 0) >= item.available_portions) return current;
      return {
        ...current,
        [item.id]: {
          id: item.id,
          category: item.category,
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
      setSubmitError("Inserisci un alias di 2–32 caratteri usando lettere, numeri, spazi, trattino o underscore.");
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
    setSubmitting(true);
    setSubmitError(null);
    const { requestId, qrToken } = requestIdentityRef.current;
    const { data, error } = await supabase.rpc("submit_public_order", {
      p_alias: alias.trim(),
      p_notes: notes.trim(),
      p_items: lines.map((line) => ({ id: line.id, qty: line.qty })),
      p_client_request_id: requestId,
      p_qr_token: qrToken,
      p_bot_field: botField,
    });
    setSubmitting(false);
    setShowConfirmation(false);
    if (error || !data) {
      const message = error?.message ?? "";
      if (message.includes("stock_unavailable:")) {
        setSubmitError(`Disponibilità cambiata: ${message.split("stock_unavailable:")[1]}. Aggiorna il carrello e riprova.`);
        await loadCatalog();
      } else if (message.includes("capacity_reached")) {
        setSubmitError(orderingReasonMessage("capacity_reached"));
      } else if (/ordering_|event_closed|not_open_yet/.test(message)) {
        setSubmitError("Le ordinazioni sono state chiuse prima dell’invio. Rivolgiti alla cassa.");
      } else {
        setSubmitError("Ordine non inviato. Controlla la connessione e riprova.");
      }
      return;
    }
    const order = data as SubmittedOrder;
    localStorage.setItem(SAVED_ORDER_KEY, JSON.stringify(order));
    setSubmittedOrder(order);
    setCart({});
    setShowCopyPrompt(true);
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

  if (submittedOrder) {
    return (
      <main className="mx-auto min-h-full max-w-xl px-4 py-8">
        <a href={import.meta.env.BASE_URL} className="text-xs text-[var(--text-secondary)] hover:underline">← Torna al sito</a>
        <section className="mt-5 text-center">
          <p className="text-sm text-[var(--state-success)]">Ordine inviato. Ora raggiungi la cassa per pagare.</p>
          <h1 className="mt-2 text-4xl">#{submittedOrder.display_number}</h1>
          <p className="mt-1 text-xl font-semibold">{submittedOrder.alias}</p>
          <p className="mt-2 text-xs text-[var(--text-secondary)]">Mostra QR, numero e alias alla cassa.</p>
        </section>

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
            {qrDataUrl ? <img src={qrDataUrl} alt={`QR dell’ordine ${submittedOrder.display_number}`} className="mx-auto w-full max-w-[300px] rounded-xl bg-white" /> : (
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
              <span>Totale da pagare</span>
              <span className="font-mono">{priceFormatter.format(Number(submittedOrder.total))}</span>
            </div>
            {submittedOrder.notes && (
              <div className="mt-2 rounded-[var(--radius-sm)] border border-[var(--state-warning)] p-2 text-sm">
                <strong>Note:</strong> {submittedOrder.notes}
              </div>
            )}
          </Card>
        )}

        <Button
          variant="ghost"
          className="mx-auto mt-5 block"
          onClick={() => void handlePdfDownload()}
          disabled={!qrDataUrl || pdfLoading}
        >
          {pdfLoading ? "Preparo il PDF…" : "Scarica copia PDF"}
        </Button>

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
      </main>
    );
  }

  return (
    <main className="mx-auto min-h-full max-w-3xl px-4 pb-40 pt-8">
      <a href={import.meta.env.BASE_URL} className="text-xs text-[var(--text-secondary)] hover:underline">← Torna al sito</a>
      <h1 className="mt-5 text-3xl">Ordina qui</h1>
      <label className="mt-5 block">
        <span className="mb-1 block text-sm font-semibold">Alias dell’ordine</span>
        <input
          value={alias}
          onChange={(event) => setAlias(event.target.value)}
          maxLength={32}
          placeholder="Es. Girasole"
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
          <section key={category} className="mt-7">
            <h2 className="text-xl">{category === "cibo" ? "Cibo" : "Bevande"}</h2>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {catalog.items.filter((item) => item.category === category).map((item) => {
                const almostFinished = item.available_portions !== null
                  && item.stock_capacity !== null
                  && item.available_portions > 0
                  && item.available_portions <= Math.ceil(item.stock_capacity * 0.2);
                const finished = item.available_portions === 0;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => addItem(item)}
                    disabled={finished}
                    className="surface-solid flex min-h-20 items-start justify-between gap-3 rounded-[var(--radius-md)] p-3 text-left transition-colors hover:bg-[var(--surface-solid-hover)] disabled:cursor-not-allowed disabled:opacity-55"
                  >
                    <span>
                      <span className="block text-sm font-semibold">{item.name}</span>
                      {item.allergens.length > 0 && (
                        <span className="mt-1 block text-xs text-[var(--text-secondary)]">
                          Allergeni: {item.allergens.join(", ")}
                        </span>
                      )}
                      {almostFinished && <span className="mt-1 block text-xs text-[var(--state-warning)]">Quasi terminato</span>}
                      {finished && <span className="mt-1 block text-xs text-[var(--state-error)]">Terminato</span>}
                    </span>
                    <span className="shrink-0 font-mono text-sm text-[var(--accent-primary)]">{priceFormatter.format(Number(item.price))}</span>
                  </button>
                );
              })}
            </div>
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
        <section className="glass-elevated fixed inset-x-3 bottom-3 z-50 mx-auto max-w-xl rounded-[var(--radius-lg)] p-3">
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
            <div className="mt-3 max-h-[60vh] overflow-y-auto border-t border-[var(--surface-border)] pt-3">
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
        <p>Prepara qui il tuo ordine e invialo. Il pagamento avviene esclusivamente in cassa, in contanti o con carta. L’ordine parte verso la cucina solo dopo il pagamento.</p>
      </Modal>

      <Modal
        open={showConfirmation}
        title="Conferma definitiva"
        dismissible={!submitting}
        onClose={() => setShowConfirmation(false)}
        actions={(
          <>
            <Button variant="ghost" onClick={() => setShowConfirmation(false)} disabled={submitting}>Torna al carrello</Button>
            <Button variant="primary" onClick={() => void submitOrder()} disabled={submitting}>
              {submitting ? "Invio…" : "Conferma e ordina"}
            </Button>
          </>
        )}
      >
        <p>Controlla bene prodotti, quantità e note: dopo questo passaggio non potrai più modificare l’ordine.</p>
        <p className="mt-2 font-semibold text-[var(--text-primary)]">Totale da pagare in cassa: {priceFormatter.format(total)}</p>
      </Modal>
    </main>
  );
}
