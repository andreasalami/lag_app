import { MENU_SECTIONS, isMenuSectionForCategory, type MenuCategory, type MenuSection } from "../menu/menuSections";

// Dati aggregati restituiti da public.get_order_event_snapshot: nessun alias o nota.
export type SnapshotProduct = { name: string; category: MenuCategory; section: MenuSection; quantity: number; revenue: number };
export type SnapshotHour = { hour: string; orders: number; revenue: number };
export type IncomeSnapshot = {
  event_name: string;
  generated_at: string;
  revenue_total: number;
  orders_paid: number;
  hours: SnapshotHour[];
  products: SnapshotProduct[];
};

export type RankedProduct = { name: string; quantity: number; share: number };
export type SectionSummary = {
  category: MenuCategory;
  label: string;
  total: number;
  top: RankedProduct[];
  least: RankedProduct | null;
};
/** `day` è valorizzato sulla prima ora di ogni serata quando il PDF ne copre più di una. */
export type HourBar = { label: string; revenue: number; orders: number; day: string | null };

const LOCAL_HOUR = /^\d{4}-\d{2}-\d{2}T\d{2}:00:00$/;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Valida la risposta del server: un dato inatteso blocca il PDF invece di stampare numeri sbagliati. */
export function parseIncomeSnapshot(value: unknown): IncomeSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  const numeric = (field: unknown) => (typeof field === "string" ? Number(field) : field);
  const revenueTotal = numeric(data.revenue_total);
  if (typeof data.event_name !== "string" || typeof data.generated_at !== "string"
    || !isFiniteNumber(revenueTotal) || !isFiniteNumber(data.orders_paid)
    || !Array.isArray(data.hours) || !Array.isArray(data.products)) return null;

  const hours: SnapshotHour[] = [];
  for (const row of data.hours as Record<string, unknown>[]) {
    const revenue = numeric(row?.revenue);
    if (typeof row?.hour !== "string" || !LOCAL_HOUR.test(row.hour) || !isFiniteNumber(row.orders) || !isFiniteNumber(revenue)) return null;
    hours.push({ hour: row.hour, orders: row.orders, revenue });
  }

  const products: SnapshotProduct[] = [];
  for (const row of data.products as Record<string, unknown>[]) {
    const revenue = numeric(row?.revenue);
    const category = row?.category;
    if (typeof row?.name !== "string" || (category !== "cibo" && category !== "bevande")
      || typeof row.section !== "string" || !isMenuSectionForCategory(category, row.section as MenuSection)
      || !isFiniteNumber(row.quantity) || !isFiniteNumber(revenue)) return null;
    products.push({ name: row.name, category, section: row.section as MenuSection, quantity: row.quantity, revenue });
  }

  return {
    event_name: data.event_name,
    generated_at: data.generated_at,
    revenue_total: revenueTotal,
    orders_paid: data.orders_paid,
    hours,
    products,
  };
}

/**
 * Per ogni sezione del menu: i due prodotti più venduti e quello venduto meno,
 * con la percentuale sui pezzi venduti nella sezione. Il "meno venduto" include
 * i prodotti a zero pezzi e non ripete i primi due: con due soli prodotti non c'è.
 */
export function summarizeSections(products: SnapshotProduct[], category: MenuCategory): SectionSummary[] {
  return MENU_SECTIONS[category].flatMap(({ key, label }) => {
    const rows = products
      .filter((product) => product.category === category && product.section === key)
      .sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name, "it"));
    if (rows.length === 0) return [];
    const total = rows.reduce((sum, row) => sum + row.quantity, 0);
    const rank = (row: SnapshotProduct): RankedProduct => ({ name: row.name, quantity: row.quantity, share: total > 0 ? row.quantity / total : 0 });
    const least = rows.slice(2).sort((a, b) => a.quantity - b.quantity || a.name.localeCompare(b.name, "it"))[0];
    return [{ category, label, total, top: rows.slice(0, 2).map(rank), least: least ? rank(least) : null }];
  });
}

// Fino a 3 ore senza incassi restano nel grafico come colonne vuote; un buco più
// lungo (per esempio tra venerdì notte e sabato sera) separa due serate.
const MAX_FILLED_GAP_HOURS = 3;
const WEEKDAYS = ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"];

/** Colonne orarie in ordine: riempie i buchi brevi e segna l'inizio di ogni serata. */
export function hourlyBars(hours: SnapshotHour[]): HourBar[] {
  // Le ore arrivano già nel fuso dell'evento: si trattano come orari "da parete", senza conversioni.
  const rows = hours.map((row) => ({ ...row, ms: Date.parse(`${row.hour}Z`) })).sort((a, b) => a.ms - b.ms);
  const bar = (ms: number, revenue: number, orders: number, day: string | null = null): HourBar =>
    ({ label: new Date(ms).toISOString().slice(11, 13), revenue, orders, day });
  const bars: HourBar[] = [];
  let sessions = 0;
  rows.forEach((row, index) => {
    const gapHours = index === 0 ? Infinity : (row.ms - rows[index - 1].ms) / 3_600_000 - 1;
    if (gapHours > MAX_FILLED_GAP_HOURS) {
      sessions += 1;
      bars.push(bar(row.ms, row.revenue, row.orders, WEEKDAYS[new Date(row.ms).getUTCDay()]));
      return;
    }
    for (let missing = 1; missing <= gapHours; missing += 1) bars.push(bar(rows[index - 1].ms + missing * 3_600_000, 0, 0));
    bars.push(bar(row.ms, row.revenue, row.orders));
  });
  // Con una sola serata il giorno non serve: resta solo l'ora.
  return sessions > 1 ? bars : bars.map((item) => ({ ...item, day: null }));
}

export function peakHour(bars: HourBar[]) {
  return bars.reduce<HourBar | null>((best, bar) => (bar.revenue > (best?.revenue ?? 0) ? bar : best), null);
}

// Intl in italiano non separa le migliaia sotto 10.000 ("3482,00 €"): "always" forza "3.482,00 €".
// L'asserzione serve solo perché il tsconfig (lib ES2020) tipizza useGrouping come booleano.
const grouping = { useGrouping: "always" as unknown as boolean };
const euro = new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR", ...grouping });
const wholeEuro = new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR", maximumFractionDigits: 0, ...grouping });
export const formatEuro = (amount: number) => euro.format(amount);
export const formatWholeEuro = (amount: number) => wholeEuro.format(amount);

export function formatShare(share: number) {
  if (share > 0 && share < 0.005) return "meno dell’1%";
  return `${Math.round(share * 100)}%`;
}

export function pieces(quantity: number) {
  return quantity === 1 ? "1 pezzo" : `${quantity} pezzi`;
}

/** Frasi brevi per il riepilogo: chi legge non deve interpretare tabelle. */
export function headlineSentences(snapshot: IncomeSnapshot) {
  if (snapshot.orders_paid === 0) return ["Non ci sono ancora ordini pagati."];
  const orders = snapshot.orders_paid === 1 ? "1 ordine pagato" : `${snapshot.orders_paid} ordini pagati`;
  return [`Da ${orders}. In media ogni ordine vale ${formatEuro(snapshot.revenue_total / snapshot.orders_paid)}.`];
}

export function peakSentence(bars: HourBar[]) {
  const peak = peakHour(bars);
  if (!peak) return "Non ci sono ancora incassi da mostrare ora per ora.";
  const next = String((Number(peak.label) + 1) % 24).padStart(2, "0");
  // Su più serate si dice anche quale: la serata è quella dell'ultima colonna con il giorno.
  const day = bars.slice(0, bars.indexOf(peak) + 1).reverse().find((item) => item.day)?.day;
  return `Il momento più intenso è stato ${day ? `${day} ` : ""}tra le ${peak.label} e le ${next}: ${formatEuro(peak.revenue)}.`;
}

export function leastSentence(least: RankedProduct) {
  return least.quantity === 0
    ? `Meno venduto: ${least.name}, nessun pezzo venduto finora.`
    : `Meno venduto: ${least.name}, ${pieces(least.quantity)} (${formatShare(least.share)}).`;
}
