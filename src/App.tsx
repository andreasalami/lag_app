import { lazy, Suspense, useEffect, useState, type ComponentType } from "react";
import { Home } from "./pages/Home";
import { Staff } from "./pages/Staff";
import { OrderPage } from "./features/orders/OrderPage";
import { AuthProvider, useAuth, type Role } from "./features/auth/AuthContext";
import { TournamentBoard } from "./pages/TournamentBoard";
import { TournamentManagement } from "./pages/TournamentManagement";

const FeaturePreview = lazy(() => import("./pages/FeaturePreview").then((module) => ({ default: module.FeaturePreview })));
const Cassa = lazy(() => import("./features/orders/Cassa").then((module) => ({ default: module.Cassa })));
const Cucina = lazy(() => import("./features/orders/Cucina").then((module) => ({ default: module.Cucina })));

function ProtectedOperationalPage({
  allowedRoles,
  component: Component,
  title,
}: {
  allowedRoles: Role[];
  component: ComponentType;
  title: string;
}) {
  const { session, role, loading, profileError } = useAuth();
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

  if (loading) {
    return <section className="mx-auto max-w-sm px-4 py-16 text-center text-sm text-[var(--text-secondary)]">Verifico l’accesso…</section>;
  }

  if (!session || profileError || !allowedRoles.includes(role)) {
    return (
      <section className="mx-auto max-w-sm px-4 py-16 text-center">
        <h1 className="font-display text-2xl">{title}: accesso riservato</h1>
        <p className="mt-3 text-sm text-[var(--text-secondary)]">
          Questa sezione non è pubblica. Serve un account con il ruolo corretto.
        </p>
        <a href={`${basePath}/#staff`} className="signature-glow glass-elevated glass-elevated--strong mt-6 inline-block rounded-[var(--radius-pill)] px-5 py-2 text-sm font-semibold">
          Accedi all’area staff
        </a>
      </section>
    );
  }

  return (
    <Suspense fallback={<section className="mx-auto max-w-sm px-4 py-16 text-center text-sm text-[var(--text-secondary)]">Carico…</section>}>
      <Component />
    </Suspense>
  );
}

// Routing volutamente minimo: poche pagine interne (staff),
// non vale la pena aggiungere react-router per questo. Se in
// futuro servono più pagine pubbliche, si passa alla libreria.
function App() {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const path = window.location.pathname.replace(basePath, "") || "/";
  const [hashPath, setHashPath] = useState(() => window.location.hash.replace(/^#/, ""));

  useEffect(() => {
    const handleHashChange = () => setHashPath(window.location.hash.replace(/^#/, ""));
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  const previewEnabled = import.meta.env.VITE_FEATURE_PREVIEW === "true";
  const internalPages = previewEnabled
    ? ["staff", "cassa", "cucina", "ordina", "tabellone", "gestione-torneo", "anteprima"]
    : ["staff", "cassa", "cucina", "ordina", "tabellone", "gestione-torneo"];
  const internalPage = internalPages.includes(hashPath) ? hashPath : path.slice(1);

  return (
    <AuthProvider>
      {internalPage === "staff" ? (
        <Staff />
      ) : internalPage === "cassa" ? (
        <ProtectedOperationalPage allowedRoles={["cassa", "admin"]} component={Cassa} title="Cassa" />
      ) : internalPage === "cucina" ? (
        <ProtectedOperationalPage allowedRoles={["cucina", "admin"]} component={Cucina} title="Cucina" />
      ) : internalPage === "ordina" ? (
        <OrderPage />
      ) : internalPage === "tabellone" ? (
        <TournamentBoard />
      ) : internalPage === "gestione-torneo" ? (
        <ProtectedOperationalPage
          allowedRoles={["tournament_manager", "admin"]}
          component={TournamentManagement}
          title="Gestione torneo"
        />
      ) : internalPage === "anteprima" && previewEnabled ? (
        <Suspense fallback={<p className="p-8 text-sm text-[var(--text-secondary)]">Carico l’anteprima…</p>}>
          <FeaturePreview />
        </Suspense>
      ) : (
        <Home />
      )}
    </AuthProvider>
  );
}

export default App;
