import { Home } from "./pages/Home";
import { AuthProvider } from "./features/auth/AuthContext";

function App() {
  return (
    <AuthProvider>
      <Home />
    </AuthProvider>
  );
}

export default App;
