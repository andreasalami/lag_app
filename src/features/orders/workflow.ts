export type CashStation = "cassa_1" | "cassa_2" | "cassa_3" | "cassa_4" | "cassa_5";
export type KitchenStation = "cucina" | "primi" | "secondi" | "contorni" | "dolci" | "furgone";
export type BarStation = "birre" | "drinks" | "bar";
export type FulfillmentStation = KitchenStation | BarStation;

export const CASH_STATIONS: { key: CashStation; label: string }[] = [
  { key: "cassa_1", label: "Cassa 1" },
  { key: "cassa_2", label: "Cassa 2" },
  { key: "cassa_3", label: "Cassa 3" },
  { key: "cassa_4", label: "Cassa 4" },
  { key: "cassa_5", label: "Cassa Esterna" },
];

export const KITCHEN_STATIONS: { key: KitchenStation; label: string; description: string }[] = [
  { key: "cucina", label: "Cucina generale", description: "Tutti gli ordini alimentari in preparazione" },
  { key: "primi", label: "Primi", description: "Consegna dei primi" },
  { key: "secondi", label: "Secondi", description: "Consegna dei secondi" },
  { key: "contorni", label: "Contorni", description: "Consegna dei contorni" },
  { key: "dolci", label: "Dolci", description: "Consegna dei dolci" },
  { key: "furgone", label: "Furgone esterno", description: "Consegna dei prodotti del furgone" },
];

export const BAR_STATIONS: { key: BarStation; label: string; description: string }[] = [
  { key: "birre", label: "Birre", description: "I due punti birra condividono questa coda" },
  { key: "drinks", label: "Drinks", description: "Consegna dei drink" },
  { key: "bar", label: "Bar", description: "Bevande, caffè e vini" },
];

// La postazione scelta resta sul dispositivo finché non si preme "Cambia".
export const STATION_STORAGE_KEYS = {
  cassa: "lag:cash-station",
  cucina: "lag:kitchen-station",
  bar: "lag:bar-station",
} as const;

export function isCashStation(value: unknown): value is CashStation {
  return typeof value === "string" && CASH_STATIONS.some((station) => station.key === value);
}

export function cashStationLabel(station: CashStation) {
  return CASH_STATIONS.find((candidate) => candidate.key === station)?.label ?? station;
}

/** Ricerca di cassa e postazioni: numero e nome ordine si possono combinare. */
export function matchesOrderSearch(order: { display_number: number; alias: string | null }, number: string, alias: string) {
  const wantedNumber = number.trim();
  const wantedAlias = alias.trim().toLocaleLowerCase("it");
  return (!wantedNumber || String(order.display_number).includes(wantedNumber))
    && (!wantedAlias || (order.alias ?? "").toLocaleLowerCase("it").includes(wantedAlias));
}

export type FulfillmentProgress = {
  station: Exclude<FulfillmentStation, "cucina">;
  quantity: number;
  delivered: number;
};
