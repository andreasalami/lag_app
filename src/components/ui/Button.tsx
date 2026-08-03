import type { ButtonHTMLAttributes, ReactNode } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "ghost";
  children: ReactNode;
}

/**
 * Bottone: è un elemento "elevato" (galleggia sopra il contenuto per
 * invitare all'azione), quindi usa il vetro + il bordo "harvest glow"
 * solo per la variante primaria. La variante ghost resta piatta,
 * per le azioni secondarie.
 */
export function Button({ variant = "primary", className = "", children, ...props }: ButtonProps) {
  const base =
    "inline-flex items-center justify-center gap-2 px-5 py-3 rounded-[var(--radius-pill)] font-semibold text-sm transition-transform active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100";

  if (variant === "ghost") {
    return (
      <button
        className={`${base} border border-[var(--surface-border)] text-[var(--text-primary)] hover:bg-white/5 ${className}`}
        {...props}
      >
        {children}
      </button>
    );
  }

  return (
    <button
      className={`${base} glass-elevated glass-elevated--strong signature-glow text-[var(--text-primary)] hover:brightness-110 ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
