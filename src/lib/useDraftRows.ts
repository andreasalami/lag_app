import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

// Le righe aggiunte in locale hanno un id temporaneo con questo prefisso: al salvataggio
// distinguono "da inserire" da "da aggiornare". Dopo il prefisso c'è già la uuid che la
// riga avrà nel database, così ripetere un salvataggio non crea doppioni.
const NEW_ID_PREFIX = "new:";
export const newDraftId = () => `${NEW_ID_PREFIX}${crypto.randomUUID()}`;
export const isNewId = (id: string) => id.startsWith(NEW_ID_PREFIX);
export const draftUuid = (id: string) => id.slice(NEW_ID_PREFIX.length);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Solo i campi cambiati rispetto all'originale: due dispositivi su campi diversi non si sovrascrivono. */
export function changedFields<T extends { id: string }>(row: T, original: T) {
  const patch: Partial<T> & { id: string } = { id: row.id } as Partial<T> & { id: string };
  for (const key of Object.keys(row) as (keyof T)[]) {
    if (!same(row[key], original[key])) patch[key] = row[key];
  }
  return patch;
}

/**
 * Fonde una rilettura del database nella bozza. Un campo non toccato segue il database;
 * un campo modificato resta com'è, insieme al valore che si vedeva quando è stato cambiato
 * (serve a salvare le scorte per differenza). Le righe eliminate altrove spariscono.
 */
export function mergeServerRows<T extends { id: string }>(rows: T[], saved: T[], server: T[]) {
  const nextRows: T[] = [];
  const nextSaved: T[] = [];
  for (const fresh of server) {
    const local = rows.find((row) => row.id === fresh.id);
    const base = saved.find((row) => row.id === fresh.id);
    if (!local || !base) {
      // Riga nuova sul database, oppure eliminata qui e non ancora salvata (resta fuori dalla bozza).
      if (!base) nextRows.push(fresh);
      nextSaved.push(fresh);
      continue;
    }
    const mergedLocal = { ...fresh };
    const mergedBase = { ...fresh };
    for (const key of Object.keys(fresh) as (keyof T)[]) {
      if (same(local[key], base[key])) continue;
      mergedLocal[key] = local[key];
      mergedBase[key] = base[key];
    }
    nextRows.push(mergedLocal);
    nextSaved.push(mergedBase);
  }
  return { rows: [...nextRows, ...rows.filter((row) => isNewId(row.id))], saved: nextSaved };
}

/**
 * Bozza locale di righe lette da Supabase (Menu, Programma): ogni modifica resta
 * nel browser finché non si preme Salva, che invia tutto in una sola RPC atomica.
 * `saved` è l'ultimo stato certo del database: serve a capire se c'è qualcosa da salvare.
 */
export function useDraftRows<T extends { id: string }>(
  rows: T[],
  setRows: Dispatch<SetStateAction<T[]>>,
  loading: boolean,
) {
  const [saved, setSaved] = useState<T[]>([]);
  const [deletedIds, setDeletedIds] = useState<string[]>([]);
  const syncedRef = useRef(false);
  // Valori correnti per le riletture in background, che arrivano fuori dal ciclo di render.
  const latest = useRef({ rows, saved });
  latest.current = { rows, saved };

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

  /** Rilettura in background: aggiorna ciò che non è stato toccato, senza perdere la bozza. */
  function syncFromServer(server: T[]) {
    if (!syncedRef.current) return;
    const merged = mergeServerRows(latest.current.rows, latest.current.saved, server);
    setRows(merged.rows);
    setSaved(merged.saved);
  }

  /** Un campo scritto subito sul database (es. la sospensione) non è una modifica in bozza. */
  function patchSaved(id: string, patch: Partial<T>) {
    const apply = (list: T[]) => list.map((row) => (row.id === id ? { ...row, ...patch } : row));
    setRows(apply);
    setSaved(apply);
  }

  const created = rows.filter((row) => isNewId(row.id));
  const updated = rows.flatMap((row) => {
    if (isNewId(row.id)) return [];
    const original = saved.find((candidate) => candidate.id === row.id);
    return original && !same(original, row) ? [{ row, original }] : [];
  });
  const isDirty = deletedIds.length > 0 || !same(rows, saved);

  return { created, updated, deletedIds, isDirty, removeRow, markSaved, syncFromServer, patchSaved };
}
