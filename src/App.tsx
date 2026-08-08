import { Home } from "./pages/Home";
import { Staff } from "./pages/Staff";
import { Cassa } from "./features/orders/Cassa";
import { Cucina } from "./features/orders/Cucina";
import { AuthProvider } from "./features/auth/AuthContext";

// Routing volutamente minimo: poche pagine interne (staff),
// non vale la pena aggiungere react-router per questo. Se in
// futuro servono più pagine pubbliche, si passa alla libreria.
function App() {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const path = window.location.pathname.replace(basePath, "") || "/";
  const hashPath = window.location.hash.replace(/^#/, "");
  const internalPage = hashPath === "staff" || hashPath === "cassa" || hashPath === "cucina" ? hashPath : path.slice(1);

  return (
    <AuthProvider>
      {internalPage === "staff" ? (
        <Staff />
      ) : internalPage === "cassa" ? (
        <Cassa />
      ) : internalPage === "cucina" ? (
        <Cucina />
      ) : (
        <Home />
      )}
    </AuthProvider>
  );
}

export default App;
