import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";

interface CommonProps {
  variant?: "primary" | "ghost" | "staff-primary" | "staff-secondary" | "staff-danger";
  children: ReactNode;
  className?: string;
}

type ButtonProps =
  | (CommonProps & ButtonHTMLAttributes<HTMLButtonElement> & { href?: undefined })
  | (CommonProps & AnchorHTMLAttributes<HTMLAnchorElement> & { href: string });

/**
 * Bottone: è un elemento "elevato" (galleggia sopra il contenuto per
 * invitare all'azione), quindi usa il vetro + il bordo "harvest glow"
 * solo per la variante primaria. La variante ghost resta piatta,
 * per le azioni secondarie.
 *
 * Polimorfico: passa `href` e diventa un link (<a>) con lo stesso
 * stile — serve per i bottoni dell'hero che portano ad altre sezioni
 * della pagina (Scopri il programma, Menu), senza duplicare le classi
 * in giro per il codice.
 */
export function Button({ variant = "primary", className = "", children, ...props }: ButtonProps) {
  const base =
    "inline-flex items-center justify-center gap-2 px-5 py-3 rounded-[var(--radius-pill)] font-semibold text-sm transition-transform active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100";

  const variantClasses = {
    primary: "glass-elevated glass-elevated--strong signature-glow text-[var(--text-primary)] hover:brightness-110",
    ghost: "border border-[var(--surface-border)] text-[var(--text-primary)] hover:bg-white/5",
    "staff-primary": "signature-glow border border-[var(--accent-primary)] bg-[var(--accent-primary)] text-[var(--text-on-accent)] hover:brightness-110",
    "staff-secondary": "border border-[var(--accent-primary)]/45 bg-[rgba(242,128,46,0.08)] text-[var(--accent-primary)] hover:bg-[rgba(242,128,46,0.16)]",
    "staff-danger": "border border-[var(--state-error)]/55 bg-[rgba(239,68,68,0.08)] text-[var(--state-error)] hover:bg-[rgba(239,68,68,0.16)]",
  }[variant];

  const classes = `${base} ${variantClasses} ${className}`;

  if (props.href !== undefined) {
    const { href, ...anchorProps } = props;
    return (
      <a href={href} className={classes} {...anchorProps}>
        {children}
      </a>
    );
  }

  return (
    <button className={classes} {...props}>
      {children}
    </button>
  );
}
