import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "../features/auth/AuthContext";

/*
  Hub staff: un login unico e generico (qualsiasi ruolo: staff,
  cassa, cucina, tournament_manager — non lo distinguiamo qui),
  poi bottoni verso le destinazioni vere. Ogni destinazione ha
  già il proprio controllo di ruolo specifico (RoleLogin dentro
  Program/Menu/Announcements, o direttamente in Cassa/Cucina):
  se clicchi un bottone per cui non hai il permesso giusto, è
  quella pagina a dirtelo — qui non serve duplicare la logica.

  I link verso le sezioni embeddate in Home usano "/#ancora" (path
  assoluto) perché questa è una pagina diversa: serve una vera
  navigazione, non un semplice salto d'ancora nella stessa pagina.
*/
const DESTINATIONS = [
  { label: "Programma", href: "/#programma" },
  { label: "Annunci", href: "/#annunci" },
  { label: "Menu", href: "/#menu" },
  { label: "Cassa", href: "/cassa" },
  { label: "Cucina", href: "/cucina" },
];

export function Staff() {
  const { session, role, loading, signIn, signOut } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // tournament_manager non deve vedere l'hub con i 5 bottoni: per lui
  // "Staff" è solo la porta d'ingresso al torneo, punto. Redirect vera
  // navigazione (non un salto d'ancora) perché stiamo cambiando pagina.
  useEffect(() => {
    if (session && role === "tournament_manager") {
      window.location.href = "/#tornei";
    }
  }, [session, role]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const { error: signInError } = await signIn(email, password);
    setSubmitting(false);
    if (signInError) setError(signInError);
  }

  if (loading) {
    return (
      <section className="mx-auto max-w-sm px-4 py-16 text-center">
        <p className="text-sm text-[var(--text-secondary)]">Carico...</p>
      </section>
    );
  }

  if (!session) {
    return (
      <section className="mx-auto max-w-sm px-4 py-16">
        <h1 className="mb-6 text-center font-display text-2xl">Accesso staff</h1>
        <form onSubmit={handleSubmit} className="surface-solid flex flex-col gap-3 rounded-[var(--radius-md)] p-4">
          <input
            type="email"
            required
            autoFocus
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="field"
          />
          <input
            type="password"
            required
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="field"
          />
          <button
            type="submit"
            disabled={submitting}
            className="signature-glow glass-elevated glass-elevated--strong rounded-[var(--radius-pill)] px-4 py-2 text-sm font-semibold disabled:opacity-50"
          >
            {submitting ? "..." : "Accedi"}
          </button>
          {error && <p className="text-xs text-[var(--state-error)]">{error}</p>}
        </form>
        <a href="/" className="mt-4 block text-center text-xs text-[var(--text-secondary)] hover:underline">
          ← Torna al sito
        </a>
      </section>
    );
  }

  // Ruolo non ancora arrivato (query async dopo il login) o sei
  // tournament_manager e il redirect qui sopra sta per scattare:
  // in entrambi i casi meglio uno stato di attesa onesto che un
  // flash dell'hub sbagliato.
  if (role === null || role === "tournament_manager") {
    return (
      <section className="mx-auto max-w-sm px-4 py-16 text-center">
        <p className="text-sm text-[var(--text-secondary)]">Carico...</p>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-sm px-4 py-16">
      <h1 className="mb-1 text-center font-display text-2xl">Gestione</h1>
      <p className="mb-6 text-center text-xs text-[var(--text-secondary)]">{session.user.email}</p>

      <div className="flex flex-col gap-2">
        {DESTINATIONS.map((d) => (
          <a key={d.label} href={d.href} className="field text-center font-semibold">
            {d.label}
          </a>
        ))}
      </div>

      <button
        type="button"
        onClick={signOut}
        className="mt-6 block w-full text-center text-xs text-[var(--text-secondary)] hover:underline"
      >
        Esci
      </button>
      <a href="/" className="mt-2 block text-center text-xs text-[var(--text-secondary)] hover:underline">
        ← Torna al sito
      </a>
    </section>
  );
}
