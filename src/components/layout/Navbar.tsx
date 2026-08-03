export function Navbar() {
  return (
    <header className="sticky top-0 z-50 px-4 pt-4">
      <div className="glass-elevated mx-auto flex max-w-3xl items-center justify-between rounded-[var(--radius-pill)] px-5 py-3">
        <a href="#home" className="flex items-center gap-2">
          <img src="/logo-lag.png" alt="L'Agro ai Giovani" className="h-9 w-auto" />
        </a>
        <nav className="hidden gap-6 text-sm text-[var(--text-secondary)] sm:flex">
          <a href="#biglietti" className="hover:text-[var(--text-primary)]">Biglietti</a>
          <a href="#social" className="hover:text-[var(--text-primary)]">Instagram</a>
          <a href="#tornei" className="hover:text-[var(--text-primary)]">Tornei</a>
        </nav>
      </div>
    </header>
  );
}
