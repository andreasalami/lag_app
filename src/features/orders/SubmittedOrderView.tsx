import { useEffect, useState, type ReactNode } from "react";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Modal } from "../../components/ui/Modal";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { appHref } from "../../lib/browser";
import { cartItemCount, lineTotal } from "./cart";
import { ORDER_STATUS_LABELS, orderStatusClassName, type PublicOrderStatus, type StoredOrder } from "./orderHistory";
import { readRecoveryToken } from "./orderRecovery";
import { downloadOrderPdf, priceFormatter } from "./orderUtils";
import { PreparationStatus } from "./PreparationChoice";
import { RecoveryCard } from "./RecoveryCard";

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

type Props = {
  order: StoredOrder;
  history: StoredOrder[];
  /** Pannello della richiesta in sospeso, se c'è. */
  banner: ReactNode;
  error: string | null;
  /** Subito dopo l'invio si propone di scaricare la copia PDF. */
  offerCopy: boolean;
  onCopyHandled: () => void;
  onViewOrder: (order: StoredOrder) => void;
  onRefreshStatuses: () => Promise<void>;
  onStartNewOrder: () => void;
  startingNewOrder: boolean;
  newOrderMessage: string | null;
  onDismissNewOrderMessage: () => void;
};

/** Ordine inviato: stato, QR o riepilogo, storico dei miei ordini e copia PDF. */
export function SubmittedOrderView({
  order,
  history,
  banner,
  error,
  offerCopy,
  onCopyHandled,
  onViewOrder,
  onRefreshStatuses,
  onStartNewOrder,
  startingNewOrder,
  newOrderMessage,
  onDismissNewOrderMessage,
}: Props) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrError, setQrError] = useState(false);
  const [tab, setTab] = useState<"qr" | "summary">("qr");
  const [pdfLoading, setPdfLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [showRecovery, setShowRecovery] = useState(false);

  useEffect(() => {
    setQrDataUrl(null);
    setQrError(false);
    let cancelled = false;
    void import("qrcode")
      .then((module) =>
        module.default.toDataURL(`LAGORDER:${order.qr_token}`, { width: 360, margin: 2, errorCorrectionLevel: "M" }),
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
  }, [order.qr_token]);

  async function downloadPdf() {
    if (!qrDataUrl) return;
    setPdfLoading(true);
    try {
      await downloadOrderPdf(order, qrDataUrl);
      onCopyHandled();
    } finally {
      setPdfLoading(false);
    }
  }

  const recoveryToken = readRecoveryToken(order.event_id);
  if (showRecovery && recoveryToken) {
    return <RecoveryCard token={recoveryToken} eventName={order.event_name} onBack={() => setShowRecovery(false)} />;
  }

  return (
    <main className="mx-auto min-h-full max-w-xl px-4 py-8">
      <Button href={appHref("#menu")} variant="back" className="min-h-10 px-4 py-2">
        ← Indietro
      </Button>
      {banner}
      {error && (
        <p
          role="alert"
          className="mt-4 rounded-[var(--radius-sm)] border border-[var(--state-warning)] p-3 text-sm text-[var(--state-warning)]"
        >
          {error}
        </p>
      )}
      <section className="mt-5 text-center">
        <p className={`text-sm ${orderStatusClassName(order.status)}`}>
          {order.event_closed_at
            ? "Evento concluso. Questo ordine resta nello storico; il QR non è più utilizzabile per il ritiro."
            : order.status === "pagato" && (order.kitchen_state === "dormant" || order.kitchen_state === "waiting")
              ? "Pagamento registrato."
              : statusMessage(order.status)}
        </p>
        <h1 className="mt-2 text-4xl">#{order.display_number}</h1>
        {!order.event_closed_at && (order.status === "pagato" || order.status === "ritiro_parziale") && (
          <PreparationStatus state={order.kitchen_state} />
        )}
        {order.status === "in_attesa_pagamento" && order.preparation_mode === "deferred" && (
          <p className="mt-2 text-sm">
            Hai scelto di preparare il cibo più tardi. Paga entro 60 minuti per mantenere le quantità riservate.
          </p>
        )}
        <p className="mt-1 text-xl font-semibold">{order.alias}</p>
        <p className="mt-2 text-xs text-[var(--text-secondary)]">
          {order.status === "in_attesa_pagamento"
            ? "Mostra QR, numero e alias alla cassa. Gli ordini non pagati scadono dopo 60 minuti."
            : order.status === "pagato" || order.status === "ritiro_parziale"
              ? "Mostra lo stesso QR in ogni postazione in cui devi ritirare."
              : "Il QR e il riepilogo restano disponibili per tutta la durata dell’evento."}
        </p>
      </section>

      {order.progress && order.progress.length > 0 && (
        <Card className="mt-5">
          <h2 className="font-semibold">Ritiro per postazione</h2>
          <div className="mt-3 flex flex-col gap-2">
            {order.progress.map((item) => (
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
          <span className="text-xs text-[var(--text-secondary)]">{history.length} totali</span>
        </div>
        <div className="mt-3 max-h-48 space-y-2 overflow-y-auto pr-1">
          {history.map((item) => (
            <button
              key={item.order_id}
              type="button"
              onClick={() => onViewOrder(item)}
              aria-current={item.order_id === order.order_id ? "true" : undefined}
              className={`flex w-full items-center justify-between gap-3 rounded-[var(--radius-sm)] border p-3 text-left ${
                item.order_id === order.order_id
                  ? "border-[var(--accent-primary)] bg-white/5"
                  : "border-[var(--surface-border)]"
              }`}
            >
              <span>
                <strong>
                  #{item.display_number} · {item.alias}
                </strong>
                <span className="mt-0.5 block text-xs text-[var(--text-secondary)]">
                  {item.event_name} · {cartItemCount(item.items)} articoli · {priceFormatter.format(Number(item.total))}
                </span>
              </span>
              <span className={`shrink-0 text-xs font-semibold ${orderStatusClassName(item.status)}`}>
                {item.event_closed_at ? "Evento concluso" : ORDER_STATUS_LABELS[item.status]}
              </span>
            </button>
          ))}
        </div>
      </Card>

      {order.recovery_enabled && recoveryToken && (
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
          setRefreshing(true);
          await onRefreshStatuses();
          setRefreshing(false);
        }}
        disabled={refreshing}
      >
        {refreshing ? "Aggiorno lo stato…" : "Aggiorna stato ordini"}
      </Button>

      <SegmentedControl
        className="mx-auto mt-5 max-w-xs"
        value={tab}
        onChange={setTab}
        options={[
          { value: "qr", label: "QR code" },
          { value: "summary", label: "Riepilogo" },
        ]}
      />

      {tab === "qr" ? (
        <Card className="mx-auto mt-4 max-w-sm text-center">
          {order.event_closed_at ? (
            <p className="py-6 text-sm">Evento concluso: puoi consultare il riepilogo dell’ordine.</p>
          ) : qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt={`QR dell’ordine ${order.display_number}`}
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
          {order.items.map((line) => (
            <div key={line.id} className="flex justify-between gap-3 text-sm">
              <span>
                {line.qty}× {line.name}
              </span>
              <span className="font-mono">{priceFormatter.format(lineTotal(line))}</span>
            </div>
          ))}
          <div className="mt-2 flex justify-between border-t border-[var(--surface-border)] pt-2 font-semibold">
            <span>{order.status === "in_attesa_pagamento" ? "Totale da pagare" : "Totale ordine"}</span>
            <span className="font-mono">{priceFormatter.format(Number(order.total))}</span>
          </div>
          {order.notes && (
            <div className="mt-2 rounded-[var(--radius-sm)] border border-[var(--state-warning)] p-2 text-sm">
              <strong>Note:</strong> {order.notes}
            </div>
          )}
        </Card>
      )}

      <div className="mt-5 grid gap-2 sm:grid-cols-2">
        <Button variant="primary" className="w-full" onClick={onStartNewOrder} disabled={startingNewOrder}>
          {startingNewOrder ? "Verifico…" : "Ordina di nuovo"}
        </Button>
        <Button variant="ghost" className="w-full" href={appHref("#programma")}>
          Torna al programma
        </Button>
        <Button
          variant="ghost"
          className="w-full sm:col-span-2"
          onClick={() => void downloadPdf()}
          disabled={!qrDataUrl || pdfLoading}
        >
          {pdfLoading ? "Preparo il PDF…" : "Scarica copia PDF"}
        </Button>
      </div>

      <Modal
        open={offerCopy}
        title="Vuoi una copia?"
        actions={
          <>
            <Button variant="ghost" onClick={onCopyHandled}>
              No, grazie
            </Button>
            <Button variant="primary" onClick={() => void downloadPdf()} disabled={!qrDataUrl || pdfLoading}>
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
        onClose={onDismissNewOrderMessage}
        actions={
          <Button variant="primary" onClick={onDismissNewOrderMessage}>
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
