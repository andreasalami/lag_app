interface Tab {
  label: string;
  href: string;
  icon: JSX.Element;
}

const iconProps = {
  width: 20,
  height: 20,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const tabs: Tab[] = [
  {
    label: "Home",
    href: "#home",
    icon: (
      <svg {...iconProps}>
        <path d="M3 11.5 12 4l9 7.5" />
        <path d="M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9" />
      </svg>
    ),
  },
  {
    label: "Biglietti",
    href: "#biglietti",
    icon: (
      <svg {...iconProps}>
        <path d="M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4Z" />
        <path d="M10 6v12" strokeDasharray="2 3" />
      </svg>
    ),
  },
  {
    label: "Instagram",
    href: "#social",
    icon: (
      <svg {...iconProps}>
        <rect x="3" y="3" width="18" height="18" rx="5" />
        <circle cx="12" cy="12" r="4" />
        <circle cx="17.2" cy="6.8" r="0.6" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  {
    label: "Annunci",
    href: "#annunci",
    icon: (
      <svg {...iconProps}>
        <path d="M6 8a6 6 0 0 1 12 0c0 4 1.5 5.5 2 6H4c.5-.5 2-2 2-6Z" />
        <path d="M10 19a2 2 0 0 0 4 0" />
      </svg>
    ),
  },
];

/**
 * Tab bar flottante: vive nello strato più alto della UI (sopra tutto
 * il contenuto), quindi è vetro puro. Su desktop resta comunque
 * utilizzabile ma il target primario è mobile (in coerenza con
 * l'obiettivo "self-service da smartphone" dell'evento).
 */
export function TabBar() {
  return (
    <nav className="fixed inset-x-0 bottom-4 z-50 px-4">
      <div className="glass-elevated mx-auto flex max-w-sm items-center justify-between rounded-[var(--radius-pill)] px-3 py-2">
        {tabs.map((tab) => (
          <a
            key={tab.label}
            href={tab.href}
            className="flex flex-col items-center gap-1 rounded-[var(--radius-md)] px-3 py-1.5 text-[10px] text-[var(--text-secondary)] transition-colors hover:text-[var(--accent-primary)]"
          >
            {tab.icon}
            {tab.label}
          </a>
        ))}
      </div>
    </nav>
  );
}
