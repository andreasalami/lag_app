import { Button } from "../ui/Button";

export function StaffBackButton() {
  function goBack() {
    if (window.history.length > 1) {
      window.history.back();
      return;
    }
    window.location.hash = "staff";
  }

  return (
    <Button type="button" variant="back" onClick={goBack} className="min-h-10 px-4 py-2">
      ← Indietro
    </Button>
  );
}
