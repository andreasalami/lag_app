import type { Role } from "./AuthContext";

/**
 * Pagine riservate: unica fonte per il routing (App) e per l'area staff (Staff).
 * Decide solo cosa mostrare; il vero controllo resta nel database (RLS e RPC).
 */
export const STAFF_PAGES = [
  { hash: "gestione-programma", title: "Gestione Scaletta", group: "sections", roles: ["staff", "admin"] },
  {
    hash: "gestione-menu",
    title: "Gestione Menu e Scorte",
    group: "sections",
    roles: ["staff", "cucina", "bar", "admin"],
  },
  { hash: "gestione-torneo", title: "Gestione torneo", group: "sections", roles: ["tournament_manager", "admin"] },
  { hash: "gestione-evento", title: "Gestione evento", group: "sections", roles: ["cassa", "admin"] },
  { hash: "cassa", title: "Casse", group: "operations", roles: ["cassa", "admin"] },
  { hash: "cucina", title: "Cucina", group: "operations", roles: ["cucina", "admin"] },
  { hash: "bar", title: "Bar", group: "operations", roles: ["bar", "admin"] },
] as const satisfies readonly {
  hash: string;
  title: string;
  group: "sections" | "operations";
  roles: readonly Role[];
}[];

export type StaffPage = (typeof STAFF_PAGES)[number];
export type StaffPageHash = StaffPage["hash"];

export function canOpen(page: StaffPage, role: Role) {
  return (page.roles as readonly Role[]).includes(role);
}

export function staffPage(hash: string) {
  return STAFF_PAGES.find((page) => page.hash === hash);
}

export function staffPagesFor(role: Role, group: StaffPage["group"]) {
  return STAFF_PAGES.filter((page) => page.group === group && canOpen(page, role));
}
