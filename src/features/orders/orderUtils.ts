import type { OrderLine, SubmittedOrder } from "./types";
import { lineTotal } from "./cart";

export const priceFormatter = new Intl.NumberFormat("it-IT", {
  style: "currency",
  currency: "EUR",
});

export const ALLERGENS = [
  "Glutine",
  "Crostacei",
  "Uova",
  "Pesce",
  "Arachidi",
  "Soia",
  "Latte",
  "Frutta a guscio",
  "Sedano",
  "Senape",
  "Sesamo",
  "Solfiti",
  "Lupini",
  "Molluschi",
] as const;

export function orderingReasonMessage(reason: string | null, opensAt?: string | null) {
  switch (reason) {
    case "capacity_reached":
      return "In questo momento ci sono molti ordini in attesa. Riprova tra qualche minuto.";
    case "ordering_paused":
      return "Le ordinazioni sono temporaneamente sospese. Riprova più tardi.";
    case "not_open_yet":
      return opensAt
        ? `Le ordinazioni apriranno alle ${new Date(opensAt).toLocaleString("it-IT")}.`
        : "Le ordinazioni non sono ancora aperte.";
    case "ordering_closed":
    case "event_closed":
      return "Le ordinazioni sono chiuse.";
    default:
      return "Le ordinazioni non sono disponibili. Riprova più tardi.";
  }
}

export type SubmitFailure = {
  /** Il server ha rifiutato senza creare l'ordine: la richiesta salvata va scartata. */
  definitive: boolean;
  message: string;
  reloadCatalog?: boolean;
};

type Limits = { maxItem: number; maxOrder: number };

// Errori di submit-order, nell'ordine in cui vanno riconosciuti. Ogni riga dice se il
// rifiuto è definitivo e cosa leggere: le due cose non possono più divergere.
const SUBMIT_FAILURES: {
  match: RegExp;
  definitive: boolean;
  message: (code: string, limits: Limits) => string;
  reloadCatalog?: boolean;
}[] = [
  {
    match: /public_order_rate_limit/,
    definitive: false,
    message: () => "Hai inviato più ordini ravvicinati. Attendi un minuto, poi premi Recupera ordine.",
  },
  {
    match: /challenge_/,
    definitive: false,
    message: () => "Ripeti la verifica di sicurezza e premi Recupera ordine. La richiesta salvata resta la stessa.",
  },
  {
    match: /stock_unavailable/,
    definitive: true,
    reloadCatalog: true,
    message: (code) =>
      `Disponibilità cambiata: ${code.split("stock_unavailable:")[1] ?? "un prodotto è terminato"}. Aggiorna il carrello e riprova.`,
  },
  {
    match: /public_order_quantity_limit/,
    definitive: true,
    message: (_, limits) =>
      `L’ordine supera il limite di ${limits.maxItem} pezzi per prodotto o ${limits.maxOrder} articoli totali. Riduci le quantità o rivolgiti alla cassa.`,
  },
  {
    match: /order_total_too_high/,
    definitive: true,
    message: () => "L’importo dell’ordine è troppo alto per l’app. Riduci le quantità o rivolgiti alla cassa.",
  },
  {
    match: /event_changed/,
    definitive: true,
    reloadCatalog: true,
    message: () =>
      "Nel frattempo è iniziato un nuovo evento: l’ordine non è stato inviato. Controlla il carrello e invialo di nuovo.",
  },
  {
    match: /request_id_conflict/,
    definitive: true,
    message: () => "L’ordine non è stato inviato. Premi di nuovo Invia ordine: verrà creata una richiesta nuova.",
  },
  { match: /capacity_reached/, definitive: true, message: () => orderingReasonMessage("capacity_reached") },
  {
    match: /ordering_|event_closed|not_open_yet|no_event/,
    definitive: true,
    message: () => "Le ordinazioni sono state chiuse prima dell’invio. Rivolgiti alla cassa.",
  },
  {
    match: /invalid_|notes_too_long/,
    definitive: true,
    message: () => "L’ordine non è stato inviato: controlla nome, prodotti e note, poi invialo di nuovo.",
  },
];

/** Traduce l'errore di submit-order; un errore sconosciuto lascia l'esito incerto e la richiesta salvata. */
export function submitFailure(code: string, limits: Limits): SubmitFailure {
  const rule = SUBMIT_FAILURES.find((item) => item.match.test(code));
  if (!rule)
    return {
      definitive: false,
      message:
        "Non riesco a verificare l’esito. Premi Recupera ordine: useremo la stessa richiesta, senza creare un duplicato.",
    };
  return { definitive: rule.definitive, message: rule.message(code, limits), reloadCatalog: rule.reloadCatalog };
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseQrPayload(value: string) {
  const trimmed = value.trim();
  const token = trimmed.startsWith("LAGORDER:") ? trimmed.slice("LAGORDER:".length) : trimmed;
  return UUID_PATTERN.test(token) ? token : null;
}

function csvCell(value: unknown) {
  const raw = String(value ?? "");
  // Quoting CSV syntax alone does not prevent spreadsheet formula evaluation.
  const text = /^[\s\uFEFF]*[=+@-]/.test(raw) ? `'${raw}` : raw;
  return /[";,\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export type EventReport = {
  event_name: string;
  closed_at: string;
  summary: Record<string, string | number>;
  products: Array<{ name: string; category: string; quantity: number; revenue: number }>;
  orders: Array<{
    number: number;
    created_at: string;
    paid_at: string | null;
    status: string;
    items: OrderLine[];
    total: number;
  }>;
};

export function eventReportToCsv(report: EventReport) {
  const rows: string[][] = [
    ["REPORT EVENTO", report.event_name],
    ["Chiuso il", new Date(report.closed_at).toLocaleString("it-IT")],
    [],
    ["RIEPILOGO", "Valore"],
    ...Object.entries(report.summary).map(([key, value]) => [key, String(value)]),
    [],
    ["PRODOTTI", "Categoria", "Quantità", "Totale"],
    ...report.products.map((product) => [
      product.name,
      product.category,
      String(product.quantity),
      Number(product.revenue).toFixed(2),
    ]),
    [],
    ["ORDINI ANONIMI", "Stato", "Creato il", "Pagato il", "Voci", "Totale"],
    ...report.orders.map((order) => [
      String(order.number),
      order.status,
      new Date(order.created_at).toLocaleString("it-IT"),
      order.paid_at ? new Date(order.paid_at).toLocaleString("it-IT") : "",
      order.items.map((line) => `${line.qty}x ${line.name}`).join(" | "),
      Number(order.total).toFixed(2),
    ]),
  ];
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(";")).join("\n")}`;
}

export function downloadCsv(report: EventReport) {
  const blob = new Blob([eventReportToCsv(report)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${report.event_name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-ordini.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function downloadOrderPdf(order: SubmittedOrder, qrDataUrl: string) {
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF();
  pdf.setFontSize(18);
  pdf.text("Riepilogo ordine", 15, 18);
  pdf.setFontSize(10);
  pdf.text("Documento non fiscale - pagamento esclusivamente in cassa", 15, 25);
  pdf.setFontSize(14);
  pdf.text(pdf.splitTextToSize(`Ordine #${order.display_number} - ${order.alias}`, 125), 15, 36);
  pdf.addImage(qrDataUrl, "PNG", 150, 14, 42, 42);

  let y = 65;
  const ensureSpace = (height: number) => {
    if (y + height > 280) {
      pdf.addPage();
      y = 20;
    }
  };
  pdf.setFontSize(11);
  for (const line of order.items) {
    const label = pdf.splitTextToSize(`${line.qty}x ${line.name}`, 130) as string[];
    ensureSpace(label.length * 6 + 4);
    pdf.text(label, 15, y);
    pdf.text(priceFormatter.format(lineTotal(line)), 190, y, { align: "right" });
    y += label.length * 6 + 4;
  }
  ensureSpace(20);
  pdf.line(15, y, 195, y);
  y += 8;
  pdf.setFontSize(13);
  pdf.text("Totale", 15, y);
  pdf.text(priceFormatter.format(Number(order.total)), 190, y, { align: "right" });
  if (order.notes) {
    ensureSpace(25);
    y += 12;
    pdf.setFontSize(11);
    pdf.text("Note:", 15, y);
    y += 6;
    for (const line of pdf.splitTextToSize(order.notes, 175) as string[]) {
      ensureSpace(6);
      pdf.text(line, 15, y);
      y += 6;
    }
  }
  pdf.save(`ordine-${order.display_number}.pdf`);
}
