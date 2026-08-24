import { useEffect, useMemo, useState } from "react";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Modal } from "../components/ui/Modal";
import { OrderEditor } from "../features/orders/OrderEditor";
import {
  ALLERGENS,
  downloadCsv,
  downloadOrderPdf,
  priceFormatter,
  type EventReport,
} from "../features/orders/orderUtils";
import type { OrderLine, OrderMenuItem, SubmittedOrder } from "../features/orders/types";

type DemoOrder = SubmittedOrder & {
  status: "in_attesa_pagamento" | "pagato" | "consegnato" | "annullato";
  claimed: boolean;
  created_at: string;
  paid_at: string | null;
};

const INITIAL_MENU: OrderMenuItem[] = [
  { id: "11111111-1111-4111-8111-111111111111", category: "cibo", name: "Panino salamella", price: 5, available_portions: 12, stock_capacity: 60, allergens: [1] },
  { id: "22222222-2222-4222-8222-222222222222", category: "cibo", name: "Patatine fritte", price: 3.5, available_portions: 40, stock_capacity: 100, allergens: [] },
  { id: "33333333-3333-4333-8333-333333333333", category: "bevande", name: "Birra media", price: 4.5, available_portions: 18, stock_capacity: 100, allergens: [1] },
  { id: "44444444-4444-4444-8444-444444444444", category: "bevande", name: "Acqua", price: 1.5, available_portions: 0, stock_capacity: 80, allergens: [] },
];

function cartFromLines(lines: OrderLine[]) {
  return Object.fromEntries(lines.map((line) => [line.id, { ...line }]));
}

function beep() {
  const context = new AudioContext();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.frequency.value = 880;
  gain.gain.value = 0.15;
  oscillator.connect(gain).connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.25);
  oscillator.addEventListener("ended", () => void context.close());
}

export function FeaturePreview() {
  const [view, setView] = useState<"cliente" | "cassa" | "cucina">("cliente");
  const [menu, setMenu] = useState(INITIAL_MENU);
  const [orders, setOrders] = useState<DemoOrder[]>([]);
  const [alias, setAlias] = useState("Girasole");
  const [notes, setNotes] = useState("");
  const [cart, setCart] = useState<Record<string, OrderLine>>({});
  const [intro, setIntro] = useState(true);
  const [confirmOrder, setConfirmOrder] = useState(false);
  const [customerOrder, setCustomerOrder] = useState<DemoOrder | null>(null);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [finalTab, setFinalTab] = useState<"qr" | "summary">("qr");
  const [activeOrder, setActiveOrder] = useState<DemoOrder | null>(null);
  const [cashierAlias, setCashierAlias] = useState("");
  const [cashierNotes, setCashierNotes] = useState("");
  const [cashierCart, setCashierCart] = useState<Record<string, OrderLine>>({});
  const [numberSearch, setNumberSearch] = useState("");
  const [aliasSearch, setAliasSearch] = useState("");
  const [sound, setSound] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const cartLines = Object.values(cart);
  const pendingOrders = orders.filter((order) => order.status === "in_attesa_pagamento");
  const kitchenOrders = orders.filter((order) => order.status === "pagato" && order.items.some((line) => line.category === "cibo"));
  const filteredPending = pendingOrders.filter((order) => (
    (!numberSearch || String(order.display_number).includes(numberSearch))
    && (!aliasSearch || order.alias.toLowerCase().includes(aliasSearch.toLowerCase()))
  ));

  const customerTotal = useMemo(() => cartLines.reduce((sum, line) => sum + line.price * line.qty, 0), [cartLines]);

  useEffect(() => {
    if (!customerOrder) return;
    void import("qrcode").then((module) => module.default.toDataURL(`LAGORDER:${customerOrder.qr_token}`, { width: 320, margin: 2 }))
      .then(setQrUrl);
  }, [customerOrder]);

  useEffect(() => {
    if (!customerOrder) return;
    const updated = orders.find((order) => order.order_id === customerOrder.order_id);
    if (updated && updated !== customerOrder) setCustomerOrder(updated);
  }, [customerOrder, orders]);

  function addToCustomerCart(item: OrderMenuItem) {
    if (item.available_portions === 0) return;
    setCart((current) => {
      const previous = current[item.id];
      if (item.available_portions !== null && (previous?.qty ?? 0) >= item.available_portions) return current;
      return {
        ...current,
        [item.id]: {
          id: item.id,
          category: item.category,
          name: item.name,
          price: item.price,
          qty: (previous?.qty ?? 0) + 1,
          allergens: item.allergens,
        },
      };
    });
  }

  function submitDemoOrder() {
    if (pendingOrders.length >= 3) {
      setMessage("Limite dimostrativo raggiunto: paga o annulla un ordine dalla cassa.");
      setConfirmOrder(false);
      return;
    }
    if (alias.trim().length < 2 || cartLines.length === 0) return;
    const unavailable = cartLines.find((line) => {
      const item = menu.find((candidate) => candidate.id === line.id);
      return item?.available_portions !== null && (item?.available_portions ?? 0) < line.qty;
    });
    if (unavailable) {
      setMessage(`${unavailable.name} non è più disponibile nella quantità richiesta.`);
      setConfirmOrder(false);
      return;
    }
    setMenu((current) => current.map((item) => {
      const line = cart[item.id];
      return line && item.available_portions !== null
        ? { ...item, available_portions: item.available_portions - line.qty }
        : item;
    }));
    const order: DemoOrder = {
      event_id: "preview-event",
      event_name: "Anteprima LAG",
      order_id: crypto.randomUUID(),
      display_number: orders.length + 1,
      alias: alias.trim(),
      notes: notes.trim() || null,
      items: cartLines,
      total: customerTotal,
      qr_token: crypto.randomUUID(),
      status: "in_attesa_pagamento",
      claimed: false,
      created_at: new Date().toISOString(),
      paid_at: null,
    };
    setOrders((current) => [...current, order]);
    setCustomerOrder(order);
    setCart({});
    setConfirmOrder(false);
  }

  function openAtRegister(order: DemoOrder) {
    if (order.claimed) return;
    const claimed = { ...order, claimed: true };
    setOrders((current) => current.map((candidate) => candidate.order_id === order.order_id ? claimed : candidate));
    setActiveOrder(claimed);
    setCashierAlias(order.alias);
    setCashierNotes(order.notes ?? "");
    setCashierCart(cartFromLines(order.items));
  }

  function closeAtRegister() {
    if (!activeOrder) return;
    setOrders((current) => current.map((order) => order.order_id === activeOrder.order_id ? { ...order, claimed: false } : order));
    setActiveOrder(null);
  }

  function payAtRegister() {
    if (!activeOrder) return;
    const lines = Object.values(cashierCart);
    const paid: DemoOrder = {
      ...activeOrder,
      alias: cashierAlias,
      notes: cashierNotes || null,
      items: lines,
      total: lines.reduce((sum, line) => sum + line.price * line.qty, 0),
      status: lines.some((line) => line.category === "cibo") ? "pagato" : "consegnato",
      paid_at: new Date().toISOString(),
      claimed: false,
    };
    setOrders((current) => current.map((order) => order.order_id === paid.order_id ? paid : order));
    setActiveOrder(null);
    setMessage(`Ordine #${paid.display_number} pagato e inviato.`);
    if (sound && paid.status === "pagato") beep();
  }

  function cancelAtRegister() {
    if (!activeOrder) return;
    setMenu((current) => current.map((item) => {
      const line = activeOrder.items.find((candidate) => candidate.id === item.id);
      return line && item.available_portions !== null ? { ...item, available_portions: item.available_portions + line.qty } : item;
    }));
    setOrders((current) => current.map((order) => order.order_id === activeOrder.order_id
      ? { ...order, status: "annullato", claimed: false }
      : order));
    setActiveOrder(null);
  }

  function deliver(order: DemoOrder) {
    setOrders((current) => current.map((candidate) => candidate.order_id === order.order_id
      ? { ...candidate, status: "consegnato" }
      : candidate));
  }

  function startAnotherOrder() {
    setCustomerOrder(null);
    setCart({});
    setNotes("");
    setFinalTab("qr");
    setQrUrl(null);
    setMessage(null);
  }

  function customerStatus(order: DemoOrder) {
    if (order.status === "pagato") return "In preparazione";
    if (order.status === "consegnato") return "Ritirato";
    if (order.status === "annullato") return "Annullato";
    return "Da pagare";
  }

  function closeDemoEvent() {
    const paid = orders.filter((order) => ["pagato", "consegnato"].includes(order.status));
    const productMap = new Map<string, { name: string; category: string; quantity: number; revenue: number }>();
    for (const order of paid) for (const line of order.items) {
      const previous = productMap.get(line.id) ?? { name: line.name, category: line.category, quantity: 0, revenue: 0 };
      previous.quantity += line.qty;
      previous.revenue += line.qty * line.price;
      productMap.set(line.id, previous);
    }
    const report: EventReport = {
      event_name: "Anteprima LAG",
      closed_at: new Date().toISOString(),
      summary: {
        orders_total: orders.length,
        orders_paid: paid.length,
        orders_cancelled: orders.filter((order) => order.status === "annullato").length,
        revenue_total: paid.reduce((sum, order) => sum + order.total, 0),
      },
      products: [...productMap.values()],
      orders: orders.map((order) => ({
        number: order.display_number,
        created_at: order.created_at,
        paid_at: order.paid_at,
        status: order.status,
        items: order.items,
        total: order.total,
      })),
    };
    downloadCsv(report);
  }

  if (activeOrder && view === "cassa") {
    return (
      <main className="mx-auto max-w-4xl px-4 py-8">
        <p className="text-xs uppercase tracking-widest text-[var(--state-warning)]">Anteprima locale · Cassa</p>
        <div className="mt-2 flex items-center justify-between gap-3">
          <h1>#{activeOrder.display_number} · {activeOrder.alias}</h1>
          <Button variant="ghost" onClick={closeAtRegister}>Chiudi senza pagare</Button>
        </div>
        <p className="my-4 rounded-[var(--radius-sm)] border border-[var(--state-warning)] p-3 text-sm text-[var(--state-warning)]">Batti tutte le voci sul registratore, poi conferma il pagamento.</p>
        <OrderEditor menuItems={menu} cart={cashierCart} setCart={setCashierCart} alias={cashierAlias} setAlias={setCashierAlias} notes={cashierNotes} setNotes={setCashierNotes} />
        <div className="mt-4 flex justify-between gap-2">
          <Button variant="ghost" onClick={cancelAtRegister}>Annulla ordine</Button>
          <Button variant="primary" onClick={payAtRegister}>Pagato e invia</Button>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-4xl px-4 pb-36 pt-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-widest text-[var(--state-warning)]">Anteprima locale interattiva</p>
          <h1 className="mt-1">Nuovo flusso ordini</h1>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className="text-[10px] uppercase tracking-widest text-[var(--state-warning)]">Controlli sviluppatore · non pubblicati</span>
          <div className="flex gap-1 rounded-[var(--radius-pill)] border border-[var(--state-warning)] p-1">
          {(["cliente", "cassa", "cucina"] as const).map((value) => (
            <button key={value} type="button" onClick={() => setView(value)} className={`rounded-[var(--radius-pill)] px-3 py-2 text-sm capitalize ${view === value ? "bg-[var(--accent-primary)] text-[var(--text-on-accent)]" : "text-[var(--text-secondary)]"}`}>{value}{value === "cliente" ? "" : " 🔒"}</button>
          ))}
          </div>
        </div>
      </div>
      <p className="mt-3 rounded-[var(--radius-sm)] border border-[var(--state-warning)] p-3 text-xs text-[var(--state-warning)]">
        Questo selettore impersona tre dispositivi solo per il collaudo locale. Nel sito pubblicato il cliente non lo vede e Cassa/Cucina vengono caricate soltanto dopo login e verifica del ruolo.
      </p>
      {message && <div className="mt-4 rounded-[var(--radius-sm)] border border-[var(--surface-border)] p-3 text-sm">{message}</div>}

      {view === "cliente" && !customerOrder && (
        <section className="mt-6">
          <label>
            <span className="mb-1 block text-sm font-semibold">Alias dell’ordine</span>
            <input value={alias} onChange={(event) => setAlias(event.target.value)} className="field w-full max-w-md py-3" />
          </label>
          {(["cibo", "bevande"] as const).map((category) => (
            <div key={category} className="mt-6">
              <h2 className="capitalize">{category}</h2>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {menu.filter((item) => item.category === category).map((item) => {
                  const almost = item.available_portions !== null && item.stock_capacity !== null && item.available_portions > 0 && item.available_portions <= item.stock_capacity * 0.2;
                  return (
                    <button key={item.id} type="button" disabled={item.available_portions === 0} onClick={() => addToCustomerCart(item)} className="surface-solid flex min-h-20 justify-between rounded-[var(--radius-md)] p-3 text-left disabled:opacity-50">
                      <span>{item.name}<small className="mt-1 block text-[var(--text-secondary)]">Allergeni: {item.allergens.join(", ") || "nessuno"}</small>{almost && <small className="block text-[var(--state-warning)]">Quasi terminato</small>}{item.available_portions === 0 && <small className="block text-[var(--state-error)]">Terminato</small>}</span>
                      <span className="font-mono text-[var(--accent-primary)]">{priceFormatter.format(item.price)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          <details className="mt-5 text-xs text-[var(--text-secondary)]"><summary>Legenda allergeni</summary><p className="mt-2">{ALLERGENS.map((item, index) => `${index + 1}. ${item}`).join(" · ")}</p></details>
          {cartLines.length > 0 && (
            <Card className="fixed inset-x-3 bottom-3 z-50 mx-auto max-w-xl">
              {cartLines.map((line) => <p key={line.id} className="text-sm">{line.qty}× {line.name}</p>)}
              <textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Note cucina" className="field mt-2 w-full" />
              <div className="mt-3 flex items-center justify-between"><strong>{priceFormatter.format(customerTotal)}</strong><Button variant="primary" onClick={() => setConfirmOrder(true)}>Invia ordine</Button></div>
            </Card>
          )}
        </section>
      )}

      {view === "cliente" && customerOrder && (
        <section className="mx-auto mt-6 max-w-md text-center">
          <p className={customerOrder.status === "consegnato" ? "text-[var(--state-success)]" : "text-[var(--state-warning)]"}>
            {customerStatus(customerOrder)}
          </p>
          <h2 className="mt-2 text-4xl">#{customerOrder.display_number}</h2>
          <p className="text-xl">{customerOrder.alias}</p>
          <Card className="mt-4 text-left">
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-semibold">I miei ordini</h3>
              <span className="text-xs text-[var(--text-secondary)]">{orders.length} totali</span>
            </div>
            <div className="mt-3 max-h-44 space-y-2 overflow-y-auto">
              {[...orders].reverse().map((order) => (
                <button
                  key={order.order_id}
                  type="button"
                  onClick={() => setCustomerOrder(order)}
                  className={`flex w-full items-center justify-between rounded-[var(--radius-sm)] border p-3 ${order.order_id === customerOrder.order_id ? "border-[var(--accent-primary)]" : "border-[var(--surface-border)]"}`}
                >
                  <strong>#{order.display_number} · {order.alias}</strong>
                  <span className="text-xs">{customerStatus(order)}</span>
                </button>
              ))}
            </div>
          </Card>
          <div className="mt-4 grid grid-cols-2 rounded-[var(--radius-pill)] border border-[var(--surface-border)] p-1"><button onClick={() => setFinalTab("qr")} className="py-2">QR</button><button onClick={() => setFinalTab("summary")} className="py-2">Riepilogo</button></div>
          {finalTab === "qr" ? qrUrl && <img src={qrUrl} alt="QR ordine demo" className="mx-auto mt-4 w-full max-w-xs rounded-xl bg-white" /> : (
            <Card className="mt-4 text-left">{customerOrder.items.map((line) => <p key={line.id}>{line.qty}× {line.name}</p>)}<strong className="mt-3 block">Totale {priceFormatter.format(customerOrder.total)}</strong></Card>
          )}
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <Button variant="primary" onClick={startAnotherOrder}>Ordina di nuovo</Button>
            <Button variant="ghost" onClick={() => qrUrl && void downloadOrderPdf(customerOrder, qrUrl)}>Scarica PDF</Button>
          </div>
        </section>
      )}

      {view === "cassa" && (
        <section className="mt-6">
          <div className="flex flex-wrap gap-3"><input type="number" placeholder="Numero" value={numberSearch} onChange={(event) => setNumberSearch(event.target.value)} className="field" /><input placeholder="Alias" value={aliasSearch} onChange={(event) => setAliasSearch(event.target.value)} className="field" /><Button variant="ghost" onClick={() => customerOrder && openAtRegister(orders.find((order) => order.order_id === customerOrder.order_id) ?? customerOrder)}>Simula scansione QR</Button></div>
          <div className="mt-4 flex flex-col gap-2">{filteredPending.map((order) => <button key={order.order_id} disabled={order.claimed} onClick={() => openAtRegister(order)} className="surface-solid flex justify-between rounded-[var(--radius-md)] p-3 text-left disabled:opacity-40"><span><strong>#{order.display_number} · {order.alias}</strong><small className="block text-[var(--text-secondary)]">{order.claimed ? "Preso in carico" : "Disponibile"}</small></span><span>{priceFormatter.format(order.total)}</span></button>)}</div>
          <Button variant="ghost" className="mt-8" onClick={closeDemoEvent}>Simula chiusura evento e scarica CSV</Button>
        </section>
      )}

      {view === "cucina" && (
        <section className="mt-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button
              variant="primary"
              disabled={!customerOrder || customerOrder.status !== "pagato"}
              onClick={() => {
                if (!customerOrder || customerOrder.status !== "pagato") return;
                deliver(customerOrder);
                setMessage(`Seconda scansione: ordine #${customerOrder.display_number} consegnato.`);
              }}
            >
              Simula seconda scansione QR
            </Button>
            <div className="flex justify-end gap-2"><span className="text-sm">Suono</span><button role="switch" aria-checked={sound} onClick={() => { setSound(!sound); if (!sound) beep(); }} className={`relative h-7 w-12 rounded-full ${sound ? "bg-[var(--state-success)]" : "bg-[var(--surface-solid)]"}`}><span className={`absolute left-1 top-1 h-5 w-5 rounded-full bg-white transition-transform ${sound ? "translate-x-5" : ""}`} /></button></div>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">{kitchenOrders.map((order) => <Card key={order.order_id} className="border-l-4 border-l-[var(--accent-primary)]"><div className="flex justify-between"><h2>#{order.display_number} · {order.alias}</h2><Button variant="ghost" onClick={() => deliver(order)}>Consegnato</Button></div>{order.items.filter((line) => line.category === "cibo").map((line) => <p key={line.id} className="mt-2 font-semibold">{line.qty}× {line.name}</p>)}{order.notes && <p className="mt-3 border-2 border-[var(--state-warning)] p-2 text-[var(--state-warning)]"><strong>NOTE:</strong> {order.notes}</p>}</Card>)}</div>
          {kitchenOrders.length === 0 && <p className="text-sm text-[var(--text-secondary)]">Nessun ordine in cucina. Pagane uno dalla cassa demo.</p>}
        </section>
      )}

      <Modal open={intro} title="Come funziona" actions={<Button variant="primary" onClick={() => setIntro(false)}>OK, ho capito</Button>}><p>Prepara qui l’ordine. Dopo l’invio dovrai raggiungere la cassa e pagare in contanti o con carta.</p></Modal>
      <Modal open={confirmOrder} title="Conferma definitiva" dismissible onClose={() => setConfirmOrder(false)} actions={<><Button variant="ghost" onClick={() => setConfirmOrder(false)}>Torna al carrello</Button><Button variant="primary" onClick={submitDemoOrder}>Conferma e ordina</Button></>}><p>Dopo la conferma il cliente non può più modificare l’ordine.</p></Modal>
    </main>
  );
}
