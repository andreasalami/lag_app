import { Program } from "../features/program/Program";

export function ProgramManagement() {
  return (
    <main className="pb-16">
      <a href={`${import.meta.env.BASE_URL}#programma`} className="mx-auto block max-w-3xl px-4 pt-6 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
        ← Torna al programma
      </a>
      <Program management />
    </main>
  );
}
