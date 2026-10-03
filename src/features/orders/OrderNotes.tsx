/** Note del cliente in evidenza per cassa e postazioni di ritiro. */
export function OrderNotes({ notes }: { notes: string | null }) {
  if (!notes) return null;
  return (
    <div className="mb-4 rounded-sm border-2 border-(--state-warning) p-3 text-sm">
      <strong>NOTE:</strong> {notes}
    </div>
  );
}
