export type MenuCategory = "cibo" | "bevande";
export type KitchenSection = "primi" | "secondi" | "contorni" | "dolci" | "furgone";
export type BarSection = "birre" | "vini" | "drinks" | "bevande";
export type MenuSection = KitchenSection | BarSection;

export const MENU_SECTIONS: Record<MenuCategory, { key: MenuSection; label: string }[]> = {
  cibo: [
    { key: "primi", label: "Primi" },
    { key: "secondi", label: "Secondi" },
    { key: "contorni", label: "Contorni" },
    { key: "dolci", label: "Dolci" },
    { key: "furgone", label: "Furgone esterno" },
  ],
  bevande: [
    { key: "birre", label: "Birre" },
    { key: "vini", label: "Vini" },
    { key: "drinks", label: "Drinks" },
    { key: "bevande", label: "Bevande" },
  ],
};

export function isMenuSectionForCategory(category: MenuCategory, section: MenuSection) {
  return MENU_SECTIONS[category].some((candidate) => candidate.key === section);
}

function normalizedName(name: string) {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function includesOneOf(name: string, keywords: string[]) {
  return keywords.some((keyword) => name.includes(keyword));
}

/**
 * Classificazione usata per assegnare una sezione iniziale ai prodotti
 * storici durante la migrazione. Dopo la migrazione la scelta dello staff
 * viene salvata esplicitamente nel campo `subcategory`.
 */
export function menuSectionFor(category: MenuCategory, itemName: string): MenuSection {
  const name = normalizedName(itemName);

  if (category === "cibo") {
    if (includesOneOf(name, ["dolce", "torta", "gelato", "dessert", "crostata", "biscotto", "tiramisù", "tiramisu"])) return "dolci";
    if (includesOneOf(name, ["patatin", "contorno", "insalata", "verdure", "polenta", "fritto misto"])) return "contorni";
    if (includesOneOf(name, ["pasta", "risotto", "lasagn", "gnocc", "raviol", "tortell", "primo"])) return "primi";
    return "secondi";
  }

  if (includesOneOf(name, ["birra", "lager", "ipa", "pils", "weiss", "bionda", "rossa"])) return "birre";
  if (includesOneOf(name, ["vino", "prosecco", "spumante", "rosso", "bianco", "rosé", "rose"])) return "vini";
  if (includesOneOf(name, ["spritz", "cocktail", "drink", "gin", "vodka", "rum", "amaro", "grappa", "mojito", "negroni"])) return "drinks";
  return "bevande";
}
