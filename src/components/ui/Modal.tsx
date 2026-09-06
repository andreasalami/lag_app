import { useEffect, useId, useRef, type ReactNode } from "react";

type ModalProps = {
  open: boolean;
  title: string;
  children: ReactNode;
  actions: ReactNode;
  dismissible?: boolean;
  onClose?: () => void;
};

export function Modal({ open, title, children, actions, dismissible = false, onClose }: ModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open || !dialogRef.current) return;
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Native modal dialogs make the background inert and contain keyboard focus.
    dialog.showModal();
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      className="glass-elevated glass-elevated--strong fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-md overflow-y-auto rounded-[var(--radius-lg)] border-0 p-5 text-[var(--text-primary)] backdrop:bg-black/70"
      onCancel={(event) => {
        event.preventDefault();
        if (dismissible) onClose?.();
      }}
      onClick={(event) => {
        if (!dismissible || event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose?.();
      }}
    >
      <h2 id={titleId} className="text-xl font-semibold">{title}</h2>
      <div className="mt-3 text-sm text-[var(--text-secondary)]">{children}</div>
      <div className="mt-5 flex flex-wrap justify-end gap-2">{actions}</div>
    </dialog>
  );
}
