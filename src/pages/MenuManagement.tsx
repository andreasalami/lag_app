import { Menu } from "../features/menu/Menu";

export function MenuManagement() {
  return (
    <main className="pb-16">
      <a href={`${import.meta.env.BASE_URL}#menu`} className="mx-auto block max-w-3xl px-4 pt-6 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
        ← Torna al menu
      </a>
      <Menu management />
    </main>
  );
}
