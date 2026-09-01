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
    label: "Menu",
    href: "#menu",
    icon: (
      <svg {...iconProps}>
        <path d="M7 3v8M4 3v5a3 3 0 0 0 6 0V3M7 11v10" />
        <path d="M16 3v18M16 3c3 1 4 4 4 7h-4" />
      </svg>
    ),
  },
  {
    label: "Torneo",
    href: "#tornei",
    icon: (
      <svg {...iconProps}>
        <path d="M8 4h8v4a4 4 0 0 1-8 0Z" />
        <path d="M8 6H5v1a4 4 0 0 0 4 4M16 6h3v1a4 4 0 0 1-4 4" />
        <path d="M12 12v5M8 21h8M9 17h6v4" />
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
