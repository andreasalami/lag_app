import { Button } from "../ui/Button";
import { appHref } from "../../lib/browser";

// Dalle pagine riservate si torna sempre all'area staff (login o elenco sezioni),
// anche se la pagina è stata aperta da un link diretto: history.back() poteva
// uscire dall'app. Dall'area staff, "Torna al sito" porta alla Home.
export function StaffBackButton() {
  return (
    <Button href={appHref("#staff")} variant="back" className="min-h-10 px-4 py-2">
      ← Area staff
    </Button>
  );
}
