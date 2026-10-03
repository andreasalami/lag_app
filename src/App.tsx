import { lazy, Suspense, useEffect, useState, type ComponentType } from "react";
import { Home } from "./pages/Home";
import { Staff } from "./pages/Staff";
import { AuthProvider, useAuth, type Role } from "./features/auth/AuthContext";
import { staffPage, type StaffPageHash } from "./features/auth/staffPages";
import { TournamentBoard } from "./pages/TournamentBoard";
import { TournamentManagement } from "./pages/TournamentManagement";
import { ProgramManagement } from "./pages/ProgramManagement";
import { MenuManagement } from "./pages/MenuManagement";
import { StaffBackButton } from "./components/layout/StaffBackButton";
import { Button } from "./components/ui/Button";
import { appHref } from "./lib/browser";

// OrderPage porta con sé carrello, QR, PDF e scanner: chi apre la Home per
// vedere orari o programma non deve scaricarla. Come Cassa/Cucina/Bar, arriva
// solo quando si entra davvero in #ordina.
const OrderPage = lazy(() => import("./features/orders/OrderPage").then((module) => ({ default: module.OrderPage })));
const Cassa = lazy(() => import("./features/orders/Cassa").then((module) => ({ default: module.Cassa })));
const Cucina = lazy(() => import("./features/orders/Cucina").then((module) => ({ default: module.Cucina })));
const Bar = lazy(() => import("./features/orders/Bar").then((module) => ({ default: module.Bar })));
const EventManagement = lazy(() =>
  import("./features/event/EventManagement").then((module) => ({ default: module.EventManagement })),
);

// Componente di ogni pagina riservata; ruoli e titoli stanno in staffPages.ts.
const PAGE_COMPONENTS: Record<StaffPageHash, ComponentType> = {
  "gestione-programma": ProgramManagement,
  "gestione-menu": MenuManagement,
  "gestione-torneo": TournamentManagement,
  "gestione-evento": EventManagement,
  cassa: Cassa,
  cucina: Cucina,
  bar: Bar,
};

const LOADING = (
  <section className="mx-auto max-w-sm px-4 py-16 text-center text-sm text-(--text-secondary)">Carico…</section>
);

function ProtectedOperationalPage({
  allowedRoles,
  component: Component,
  title,
}: {
  allowedRoles: readonly Role[];
  component: ComponentType;
  title: string;
}) {
  const { session, role, loading, profileError } = useAuth();

  if (loading) {
    return (
      <section className="mx-auto max-w-sm px-4 py-16 text-center text-sm text-(--text-secondary)">
        Verifico l’accesso…
      </section>
    );
  }

  if (!session || profileError || !allowedRoles.includes(role)) {
    return (
      <section className="mx-auto max-w-sm px-4 py-16 text-center">
        <h1 className="font-display text-2xl">{title}: accesso riservato</h1>
        <p className="mt-3 text-sm text-(--text-secondary)">
          Questa sezione non è pubblica. Serve un account con il ruolo corretto.
        </p>
        <Button href={appHref("#staff")} variant="staff-primary" className="mt-6">
          Accedi all’area staff
        </Button>
      </section>
    );
  }

  return (
    <>
      <div className="mx-auto w-full max-w-5xl px-4 pt-4">
        <StaffBackButton />
      </div>
      <Suspense fallback={LOADING}>
        <Component />
      </Suspense>
    </>
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

  // Le anteprime dimostrative vivono nel loro entry point (anteprima.html), non
  // qui: non caricano Supabase né la sessione staff e non finiscono nel bundle.
  const hashRoute = hashPath.split("?")[0];
  const publicPages = ["staff", "ordina", "ordina-nuovo", "tabellone"];
  const internalPage = publicPages.includes(hashRoute) || staffPage(hashRoute) ? hashRoute : path.slice(1);
  const protectedPage = staffPage(internalPage);

  return (
    <AuthProvider>
      <Suspense fallback={LOADING}>
        {protectedPage ? (
          <ProtectedOperationalPage
            allowedRoles={protectedPage.roles}
            component={PAGE_COMPONENTS[protectedPage.hash]}
            title={protectedPage.title}
          />
        ) : internalPage === "staff" ? (
          <Staff />
        ) : internalPage === "ordina-nuovo" ? (
          <OrderPage startFresh />
        ) : internalPage === "ordina" ? (
          <OrderPage key={hashPath} />
        ) : internalPage === "tabellone" ? (
          <TournamentBoard />
        ) : (
          <Home />
        )}
      </Suspense>
    </AuthProvider>
  );
}

export default App;
