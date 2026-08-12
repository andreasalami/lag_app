import type { OrderLine, SubmittedOrder } from "./types";

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

export function parseQrPayload(value: string) {
  const trimmed = value.trim();
  const token = trimmed.startsWith("LAGORDER:") ? trimmed.slice("LAGORDER:".length) : trimmed;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)
    ? token
    : null;
}

export function cartTotal(lines: OrderLine[]) {
  return lines.reduce((sum, line) => sum + Number(line.price) * line.qty, 0);
}

function csvCell(value: unknown) {
  const text = String(value ?? "");
  return /[";,\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
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
  pdf.text(`Ordine #${order.display_number} - ${order.alias}`, 15, 36);
  pdf.addImage(qrDataUrl, "PNG", 150, 14, 42, 42);

  let y = 50;
  pdf.setFontSize(11);
  for (const line of order.items) {
    pdf.text(`${line.qty}x ${line.name}`, 15, y);
    pdf.text(priceFormatter.format(Number(line.price) * line.qty), 190, y, { align: "right" });
    y += 7;
  }
  pdf.line(15, y, 195, y);
  y += 8;
  pdf.setFontSize(13);
  pdf.text("Totale", 15, y);
  pdf.text(priceFormatter.format(Number(order.total)), 190, y, { align: "right" });
  if (order.notes) {
    y += 12;
    pdf.setFontSize(11);
    pdf.text("Note:", 15, y);
    y += 6;
    pdf.text(pdf.splitTextToSize(order.notes, 175), 15, y);
  }
  pdf.save(`ordine-${order.display_number}.pdf`);
}
