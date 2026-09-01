import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "../features/auth/AuthContext";
import { isSupabaseConfigured } from "../lib/supabaseClient";
import { Button } from "../components/ui/Button";
import { StaffPageHeading, StaffPanel } from "../components/ui/StaffPanel";

/*
  Hub staff: un login unico e generico (qualsiasi ruolo: staff,
  cassa, cucina, tournament_manager — non lo distinguiamo qui),
  poi bottoni verso le destinazioni vere. I permessi restano verificati
  dalle singole sezioni, ma il login e il logout vivono soltanto qui.

  I link verso le sezioni embeddate in Home usano "/#ancora" (path
  assoluto) perché questa è una pagina diversa: serve una vera
  navigazione, non un semplice salto d'ancora nella stessa pagina.
*/
const DESTINATIONS = [
  { label: "Scaletta", path: "/#gestione-programma", roles: ["staff", "admin"] },
  { label: "Gestione Menu e Scorte", path: "/#gestione-menu", roles: ["staff", "cucina", "admin"] },
  { label: "Gestione torneo", path: "/#gestione-torneo", roles: ["admin"] },
];

const OPERATIONS = [
  { label: "Casse", path: "/#cassa", role: "cassa" },
  { label: "Cucina", path: "/#cucina", role: "cucina" },
  { label: "Bar", path: "/#bar", role: "bar" },
];

export function Staff() {
  const { session, role, loading, profileError, signIn, signOut } = useAuth();
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // tournament_manager non deve vedere l'hub con i bottoni operativi: per lui
  // "Staff" è solo la porta d'ingresso al torneo, punto. Redirect vera
  // navigazione (non un salto d'ancora) perché stiamo cambiando pagina.
  useEffect(() => {
    if (session && role === "tournament_manager") {
      window.location.href = `${import.meta.env.BASE_URL}#gestione-torneo`;
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
      <section className="mx-auto max-w-md px-4 py-12">
        <StaffPageHeading eyebrow="Area riservata" title="Accesso staff" description="Accedi con l’account assegnato alla tua funzione." />
        {!isSupabaseConfigured && (
          <p className="mb-4 text-center text-xs text-[var(--state-error)]">
            Accesso non disponibile: Supabase non è configurato nella build pubblicata.
          </p>
        )}
        <StaffPanel eyebrow="Autenticazione" title="Entra nella gestione" description="I permessi vengono applicati automaticamente in base al tuo ruolo.">
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
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
            <Button variant="staff-primary" type="submit" disabled={submitting || !isSupabaseConfigured} className="w-full">
              {submitting ? "..." : "Accedi"}
            </Button>
            {error && <p className="text-xs text-[var(--state-error)]">{error}</p>}
          </form>
        </StaffPanel>
        <Button variant="back" href={`${basePath}/`} className="mt-4 w-full">← Torna al sito</Button>
      </section>
    );
  }

  if (profileError) {
    return (
      <section className="mx-auto max-w-md px-4 py-12">
        <StaffPageHeading title="Profilo non disponibile" description="Non è stato possibile caricare i permessi dell’account." />
        <StaffPanel eyebrow="Accesso interrotto" title="Controlla il profilo">
          <p className="text-sm text-[var(--state-error)]">{profileError}</p>
          <Button variant="staff-secondary" className="mt-5" onClick={signOut}>Esci</Button>
        </StaffPanel>
      </section>
    );
  }

  if (role === null || role === "tournament_manager") {
    return (
      <section className="mx-auto max-w-sm px-4 py-16 text-center">
        <p className="text-sm text-[var(--text-secondary)]">Carico...</p>
      </section>
    );
  }

  if (role === "pending") {
    return (
      <section className="mx-auto max-w-md px-4 py-12">
        <StaffPageHeading title="Account in attesa" description="Il profilo esiste, ma deve ancora essere abilitato." />
        <StaffPanel eyebrow="Permessi staff" title="Ruolo non assegnato">
          <p className="text-sm text-[var(--text-secondary)]">
            Contatta l’amministratore per ricevere il ruolo necessario.
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Button variant="staff-secondary" onClick={signOut}>Esci</Button>
            <Button variant="back" href={`${basePath}/`}>← Torna al sito</Button>
          </div>
        </StaffPanel>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-3xl px-4 py-10">
      <StaffPageHeading eyebrow="Area riservata" title="Gestione" description={`Accesso attivo · ${session.user.email ?? "account staff"}`} />

      <div className="flex flex-col gap-6">
        {(role === "staff" || role === "cucina" || role === "admin") && <StaffPanel eyebrow="Contenuti pubblici" title="Sezioni del sito" description="Aggiorna ciò che viene mostrato nella Home.">
          <div className="grid gap-3 sm:grid-cols-2">
            {DESTINATIONS.filter((d) => d.roles.includes(role)).map((d) => (
              <a key={d.label} href={`${basePath}${d.path}`} className="rounded-[var(--radius-md)] border border-[var(--accent-primary)]/45 bg-[rgba(242,128,46,0.08)] p-4 text-left font-semibold text-[var(--accent-primary)] transition-colors hover:bg-[rgba(242,128,46,0.16)]">
                {d.label}
                <span className="mt-1 block text-xs font-normal text-[var(--text-secondary)]">Apri la pagina di gestione →</span>
              </a>
            ))}
          </div>
        </StaffPanel>}

        {(role === "cassa" || role === "cucina" || role === "bar" || role === "admin") && <StaffPanel eyebrow="Evento live" title="Operatività" description="Apri la postazione assegnata durante il servizio.">
          <div className="grid gap-3 sm:grid-cols-3">
            {OPERATIONS.filter((d) => role === "admin" || d.role === role).map((d) => (
              <a key={d.label} href={`${basePath}${d.path}`} className="rounded-[var(--radius-md)] border border-[var(--accent-primary)]/45 bg-[rgba(242,128,46,0.08)] p-4 text-left font-semibold text-[var(--accent-primary)] transition-colors hover:bg-[rgba(242,128,46,0.16)]">
                {d.label}
                <span className="mt-1 block text-xs font-normal text-[var(--text-secondary)]">Avvia postazione →</span>
              </a>
            ))}
          </div>
        </StaffPanel>}
      </div>

      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <Button variant="staff-secondary" onClick={signOut}>Esci</Button>
        <Button variant="back" href={`${basePath}/`}>← Torna al sito</Button>
      </div>
    </section>
  );
}
