import { useEffect, useState } from "react";
import { readStorage, removeStorage, writeStorage } from "../../lib/browser";
import { supabase } from "../../lib/supabaseClient";
import { openEventId } from "./orderHistory";

/** Evento aperto, null se non c'è; undefined se la rete non risponde. */
async function currentEventId() {
  const { data, error } = await supabase.rpc("get_ordering_status");
  return error ? undefined : openEventId(data);
}

/** Decide se riprendere la postazione salvata: solo nello stesso evento ancora aperto. */
export function restoredStation<T extends string>(
  raw: string | null,
  options: readonly { key: T }[],
  eventId: string | null | undefined,
): T | null {
  try {
    const saved = JSON.parse(raw ?? "null") as { station?: unknown; eventId?: unknown } | null;
    const station = options.find((option) => option.key === saved?.station)?.key;
    if (!station) return null;
    // Senza rete vale l'ultima scelta: il servizio non si deve fermare per un ricaricamento.
    if (eventId === undefined) return station;
    return eventId !== null && eventId === saved?.eventId ? station : null;
  } catch {
    return null; // Formato precedente (solo la postazione): si riscegli.
  }
}

/**
 * Postazione di questo dispositivo, memorizzata soltanto per l'evento in corso: fuori
 * dall'evento, o quando ne inizia uno nuovo, si riparte sempre dalla scelta.
 */
export function useEventStation<T extends string>(key: string, options: readonly { key: T }[]) {
  const [station, setStation] = useState<T | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const raw = readStorage(key);
    void (raw ? currentEventId() : Promise.resolve(null)).then((eventId) => {
      if (cancelled) return;
      setStation(restoredStation(raw, options, eventId));
      setChecked(true);
    });
    return () => {
      cancelled = true;
    };
  }, [key, options]);

  function chooseStation(next: T | null) {
    setStation(next);
    if (!next) {
      removeStorage(key);
      return;
    }
    void currentEventId().then((eventId) =>
      writeStorage(key, JSON.stringify({ station: next, eventId: eventId ?? null })),
    );
  }

  return [station, chooseStation, checked] as const;
}
