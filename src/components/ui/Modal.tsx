import { useEffect, type ReactNode } from "react";

type ModalProps = {
  open: boolean;
  title: string;
  children: ReactNode;
  actions: ReactNode;
  dismissible?: boolean;
  onClose?: () => void;
};

export function Modal({ open, title, children, actions, dismissible = false, onClose }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (dismissible && event.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [dismissible, onClose, open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 px-4 py-8"
      role="presentation"
      onMouseDown={(event) => {
        if (dismissible && event.target === event.currentTarget) onClose?.();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        className="glass-elevated glass-elevated--strong w-full max-w-md rounded-[var(--radius-lg)] p-5"
      >
        <h2 id="modal-title" className="text-xl font-semibold">{title}</h2>
        <div className="mt-3 text-sm text-[var(--text-secondary)]">{children}</div>
        <div className="mt-5 flex flex-wrap justify-end gap-2">{actions}</div>
      </section>
    </div>
  );
}
