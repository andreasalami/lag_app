import { useState, type FormEvent } from "react";
import { useAuth, type Role } from "./AuthContext";
import { isSupabaseConfigured } from "../../lib/supabaseClient";

/*
  Login compatto e inline (non una pagina a parte): si apre, si compila
  email+password, si chiude da sola. Un solo componente riusato per
  entrambi i ruoli — cambia solo quale ruolo richiede e l'etichetta.
  Gli account si creano a mano da chi amministra Supabase (dashboard
  Auth > Add user + riga in profiles): non c'è registrazione pubblica,
  sono account nominali per poche persone di fiducia.
*/
interface RoleLoginProps {
  requiredRole: Exclude<Role, null>;
  label: string;
}

export function RoleLogin({ requiredRole, label }: RoleLoginProps) {
  const { session, role, signIn, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!isSupabaseConfigured) {
    return (
      <p className="mb-4 text-xs text-[var(--text-secondary)]">
        Accesso {label.toLowerCase()} non ancora configurato (manca Supabase in .env.local).
      </p>
    );
  }

  if (session && (role === requiredRole || role === "admin")) {
    return (
      <div className="mb-4 flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--surface-border)] px-3 py-2 text-xs text-[var(--text-secondary)]">
        <span>{label}: {session.user.email}</span>
        <button onClick={signOut} className="text-[var(--accent-primary)] hover:underline">
          Esci
        </button>
      </div>
    );
  }

  if (session && role !== requiredRole && role !== "admin") {
    return (
      <p className="mb-4 text-xs text-[var(--text-secondary)]">
        Account senza permessi "{label.toLowerCase()}".{" "}
        <button onClick={signOut} className="text-[var(--accent-primary)] hover:underline">
          Esci
        </button>
      </p>
    );
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mb-4 text-xs text-[var(--text-secondary)] underline-offset-2 hover:text-[var(--accent-primary)] hover:underline"
      >
        Accesso {label.toLowerCase()}
      </button>
    );
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const { error } = await signIn(email, password);
    setSubmitting(false);
    if (error) setError(error);
    else setOpen(false);
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="surface-solid mb-4 flex flex-col gap-2 rounded-[var(--radius-md)] p-3 sm:flex-row sm:items-center"
    >
      <input
        type="email"
        required
        autoFocus
        placeholder={`Email ${label.toLowerCase()}`}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="field py-1.5"
      />
      <input
        type="password"
        required
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="field py-1.5"
      />
      <button
        type="submit"
        disabled={submitting}
        className="signature-glow glass-elevated glass-elevated--strong rounded-[var(--radius-pill)] px-4 py-1.5 text-xs font-semibold disabled:opacity-50"
      >
        {submitting ? "..." : "Accedi"}
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
      >
        Annulla
      </button>
      {error && <p className="w-full text-xs text-[var(--state-error)]">{error}</p>}
    </form>
  );
}
