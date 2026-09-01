export function StaffBackButton() {
  function goBack() {
    if (window.history.length > 1) {
      window.history.back();
      return;
    }
    window.location.hash = "staff";
  }

  return (
    <button type="button" onClick={goBack} className="inline-flex min-h-10 items-center rounded-[var(--radius-pill)] border border-[var(--surface-border)] px-4 text-sm font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
      ← Indietro
    </button>
  );
}
