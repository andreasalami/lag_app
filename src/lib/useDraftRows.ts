import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

// Le righe aggiunte in locale hanno un id temporaneo con questo prefisso, mai una
// vera uuid: al salvataggio distinguono "da inserire" da "da aggiornare".
const NEW_ID_PREFIX = "new:";
export const newDraftId = () => `${NEW_ID_PREFIX}${crypto.randomUUID()}`;
export const isNewId = (id: string) => id.startsWith(NEW_ID_PREFIX);

/**
 * Bozza locale di righe lette da Supabase (Menu, Programma): ogni modifica resta
 * nel browser finché non si preme Salva, che invia tutto in una sola RPC atomica.
 * `saved` è l'ultimo stato certo del database: serve a capire se c'è qualcosa da salvare.
 */
export function useDraftRows<T extends { id: string }>(rows: T[], setRows: Dispatch<SetStateAction<T[]>>, loading: boolean) {
  const [saved, setSaved] = useState<T[]>([]);
  const [deletedIds, setDeletedIds] = useState<string[]>([]);
  const syncedRef = useRef(false);

  // Fotografa il database una sola volta, alla fine del primo caricamento.
  useEffect(() => {
    if (loading || syncedRef.current) return;
    setSaved(rows);
    syncedRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  function removeRow(id: string) {
    setRows((prev) => prev.filter((row) => row.id !== id));
    // Una riga mai salvata non esiste nel database: niente da eliminare lì.
    if (!isNewId(id)) setDeletedIds((prev) => [...prev, id]);
  }

  /** Dopo un salvataggio riuscito: la nuova fotografia del database diventa il riferimento. */
  function markSaved(fresh: T[] | null) {
    if (fresh) setSaved(fresh);
    setDeletedIds([]);
  }

  const created = rows.filter((row) => isNewId(row.id));
  const updated = rows.flatMap((row) => {
    if (isNewId(row.id)) return [];
    const original = saved.find((candidate) => candidate.id === row.id);
    return original && JSON.stringify(original) !== JSON.stringify(row) ? [{ row, original }] : [];
  });
  const isDirty = deletedIds.length > 0 || JSON.stringify(rows) !== JSON.stringify(saved);

  return { created, updated, deletedIds, isDirty, removeRow, markSaved };
}
