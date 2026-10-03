import type { jsPDF as JsPdf } from "jspdf";
import {
  formatEuro,
  formatShare,
  formatWholeEuro,
  headlineSentences,
  hourlyBars,
  leastSentence,
  peakHour,
  peakSentence,
  pieces,
  summarizeSections,
  type IncomeSnapshot,
  type SectionSummary,
} from "./incomeSnapshot";

// A4 verticale in millimetri. Grafica volutamente semplice: testo scuro su
// bianco, un solo colore (l'arancione LAG) per ciò che conta di più.
const PAGE_BOTTOM = 280;
const LEFT = 16;
const RIGHT = 194;
const WIDTH = RIGHT - LEFT;
const INK: [number, number, number] = [20, 24, 33];
const MUTED: [number, number, number] = [96, 102, 112];
const BAR: [number, number, number] = [196, 198, 204];
const ACCENT: [number, number, number] = [242, 128, 46];
const TIME_ZONE = "Europe/Rome";

function updatedAt(iso: string) {
  const date = new Date(iso);
  const time = date.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", timeZone: TIME_ZONE });
  const day = date.toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long", timeZone: TIME_ZONE });
  return `aggiornata alle ${time} di ${day}`;
}

/** Crea il PDF "Situazione incassi". Separato dal download per poterlo verificare nei test. */
export async function createIncomeSnapshotPdf(snapshot: IncomeSnapshot): Promise<JsPdf> {
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ unit: "mm", format: "a4" });
  let y = 0;

  const text = (
    value: string | string[],
    x: number,
    top: number,
    size: number,
    color = INK,
    bold = false,
    align: "left" | "center" | "right" = "left",
  ) => {
    pdf.setFont("helvetica", bold ? "bold" : "normal");
    pdf.setFontSize(size);
    pdf.setTextColor(...color);
    pdf.text(value, x, top, { align });
  };
  const fitted = (value: string, width: number, size: number) => {
    pdf.setFontSize(size);
    const lines = pdf.splitTextToSize(value, width) as string[];
    return lines.length > 1 ? `${lines[0].replace(/\s+\S*$/, "")}…` : value;
  };
  const ensureSpace = (height: number) => {
    if (y + height <= PAGE_BOTTOM) return;
    pdf.addPage();
    text("Situazione incassi (continua)", LEFT, 18, 10, MUTED);
    y = 28;
  };

  // Intestazione
  text("Situazione incassi", LEFT, 22, 20, INK, true);
  text(fitted(`${snapshot.event_name} · ${updatedAt(snapshot.generated_at)}`, WIDTH, 10), LEFT, 29, 10, MUTED);

  // Numero principale
  pdf.setFillColor(250, 244, 238);
  pdf.rect(LEFT, 36, WIDTH, 32, "F");
  pdf.setFillColor(...ACCENT);
  pdf.rect(LEFT, 36, 1.6, 32, "F");
  text("Finora abbiamo incassato", LEFT + 7, 44, 10, MUTED);
  text(formatEuro(snapshot.revenue_total), LEFT + 7, 56, 26, INK, true);
  text(headlineSentences(snapshot), LEFT + 7, 63.5, 10, MUTED);

  // Andamento orario: una colonna per ora, l'ora di punta in arancione.
  const bars = hourlyBars(snapshot.hours);
  const peak = peakHour(bars);
  text("Quanto abbiamo incassato ora per ora", LEFT, 82, 13, INK, true);
  text(peakSentence(bars), LEFT, 88, 10, MUTED);
  y = 94;
  if (bars.length > 0) {
    const chartHeight = 46;
    const baseline = y + chartHeight + 6;
    const slot = WIDTH / bars.length;
    const barWidth = Math.min(16, slot * 0.68);
    const highest = Math.max(...bars.map((bar) => bar.revenue), 1);
    pdf.setDrawColor(...BAR);
    pdf.setLineWidth(0.2);
    pdf.line(LEFT, baseline, RIGHT, baseline);
    bars.forEach((bar, index) => {
      const center = LEFT + slot * index + slot / 2;
      const height = (bar.revenue / highest) * chartHeight;
      if (height > 0) {
        pdf.setFillColor(...(bar === peak ? ACCENT : BAR));
        pdf.rect(center - barWidth / 2, baseline - height, barWidth, height, "F");
        text(
          formatWholeEuro(bar.revenue),
          center,
          baseline - height - 1.5,
          bars.length > 12 ? 6 : 7.5,
          bar === peak ? INK : MUTED,
          bar === peak,
          "center",
        );
      }
      text(bar.label, center, baseline + 4.5, 8, MUTED, false, "center");
      if (bar.day) {
        // Inizio di una nuova serata: giorno sotto l'ora e linea di separazione dalla precedente.
        text(bar.day.slice(0, 3), center, baseline + 8.5, 7, MUTED, false, "center");
        if (index > 0) {
          pdf.setDrawColor(...BAR);
          pdf.line(center - slot / 2, baseline - chartHeight, center - slot / 2, baseline + 9);
        }
      }
    });
    y = baseline + (bars.some((bar) => bar.day) ? 16 : 12);
  }

  const section = (summary: SectionSummary) => {
    const rows = summary.total === 0 ? 1 : summary.top.length + (summary.least ? 1 : 0);
    ensureSpace(9 + rows * 6.5);
    text(summary.label, LEFT, y, 11, INK, true);
    y += 6;
    if (summary.total === 0) {
      text("Nessun prodotto venduto finora.", LEFT, y, 9.5, MUTED);
      y += 8;
      return;
    }
    summary.top.forEach((product, index) => {
      text(fitted(`${index + 1}. ${product.name}`, 70, 10), LEFT, y, 10);
      const barWidth = Math.max(product.share * 60, product.quantity > 0 ? 1 : 0);
      if (barWidth > 0) {
        pdf.setFillColor(...(index === 0 ? ACCENT : BAR));
        pdf.rect(90, y - 3, barWidth, 3.6, "F");
      }
      text(`${pieces(product.quantity)} · ${formatShare(product.share)}`, RIGHT, y, 10, MUTED, false, "right");
      y += 6.5;
    });
    if (summary.least) {
      text(fitted(leastSentence(summary.least), WIDTH, 9.5), LEFT, y, 9.5, MUTED);
      y += 6.5;
    }
    y += 2.5;
  };

  for (const [category, title] of [
    ["cibo", "Il cibo, sezione per sezione"],
    ["bevande", "Le bevande, sezione per sezione"],
  ] as const) {
    const summaries = summarizeSections(snapshot.products, category);
    if (summaries.length === 0) continue;
    ensureSpace(22);
    y += 4;
    text(title, LEFT, y, 13, INK, true);
    y += 8;
    summaries.forEach(section);
  }

  const pages = pdf.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    pdf.setPage(page);
    text(`Documento interno · non contiene nomi né note dei clienti · pagina ${page} di ${pages}`, LEFT, 290, 8, MUTED);
  }
  return pdf;
}

export async function downloadIncomeSnapshotPdf(snapshot: IncomeSnapshot) {
  const pdf = await createIncomeSnapshotPdf(snapshot);
  const stamp = new Date(snapshot.generated_at)
    .toLocaleString("sv-SE", { timeZone: TIME_ZONE })
    .slice(0, 16)
    .replace(/[^0-9]/g, "");
  pdf.save(`situazione-incassi-${stamp}.pdf`);
}
