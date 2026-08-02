import type { ReactNode } from "react";

interface CardProps {
  children: ReactNode;
  className?: string;
}

/**
 * Card di contenuto: NIENTE vetro qui. Il contenuto vive su una
 * superficie solida e leggibile — il vetro è riservato a navbar,
 * tab bar e bottoni (vedi tokens.css).
 */
export function Card({ children, className = "" }: CardProps) {
  return (
    <div className={`surface-solid rounded-[var(--radius-lg)] p-6 ${className}`}>
      {children}
    </div>
  );
}
