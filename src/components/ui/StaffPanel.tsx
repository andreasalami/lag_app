import type { ReactNode } from "react";
import { Card } from "./Card";

type StaffPanelProps = {
  eyebrow: string;
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
};

export function StaffPanel({ eyebrow, title, description, action, children, className = "", contentClassName = "" }: StaffPanelProps) {
  return (
    <Card className={`overflow-hidden !p-0 ${className}`}>
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--surface-border)] bg-[linear-gradient(135deg,rgba(242,128,46,0.16),transparent_65%)] px-5 py-5 sm:px-6">
        <div>
          <p className="text-xs uppercase tracking-[0.16em] text-[var(--text-secondary)]">{eyebrow}</p>
          <h2 className="mt-1 font-display text-2xl text-[var(--accent-primary)]">{title}</h2>
          {description && <p className="mt-1 text-sm text-[var(--text-secondary)]">{description}</p>}
        </div>
        {action}
      </div>
      <div className={`px-4 py-5 sm:px-6 ${contentClassName}`}>{children}</div>
    </Card>
  );
}

type StaffPageHeadingProps = {
  eyebrow?: string;
  title: string;
  description: string;
  action?: ReactNode;
};

export function StaffPageHeading({ eyebrow = "Area riservata", title, description, action }: StaffPageHeadingProps) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
      <div>
        <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--accent-primary)]">{eyebrow}</p>
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">{description}</p>
      </div>
      {action}
    </div>
  );
}
