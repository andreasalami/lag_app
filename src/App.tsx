import { Home } from "./pages/Home";
import { Staff } from "./pages/Staff";
import { Cassa } from "./features/orders/Cassa";
import { Cucina } from "./features/orders/Cucina";
import { AuthProvider } from "./features/auth/AuthContext";

// Routing volutamente minimo: poche pagine interne (staff),
// non vale la pena aggiungere react-router per questo. Se in
// futuro servono più pagine pubbliche, si passa alla libreria.
function App() {
  const path = window.location.pathname;

  return (
    <AuthProvider>
      {path === "/staff" ? (
        <Staff />
      ) : path === "/cassa" ? (
        <Cassa />
      ) : path === "/cucina" ? (
        <Cucina />
      ) : (
        <Home />
      )}
    </AuthProvider>
  );
}

export default App;
