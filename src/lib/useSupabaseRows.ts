import { useEffect, useState } from "react";
import { supabase, isSupabaseConfigured } from "./supabaseClient";

interface OrderClause {
  column: string;
  ascending?: boolean;
}

interface UseSupabaseRowsOptions<T> {
  table: string;
  select: string;
  orderBy?: OrderClause[];
  fallback: T[];
  realtime?: boolean;
}

/**
 * Fetch iniziale da una tabella pubblica, con fallback di esempio se
 * Supabase non è ancora configurato. Il realtime è opt-in: va usato solo
 * sulle tabelle che devono aggiornarsi live per il pubblico, come Annunci.
 * Le sezioni di editing fanno refetch esplicito dopo le proprie scritture.
 *
 * Un solo posto dove questa logica può avere un bug, invece di tre.
 */
export function useSupabaseRows<T>({ table, select, orderBy = [], fallback, realtime = false }: UseSupabaseRowsOptions<T>) {
  const [rows, setRows] = useState<T[]>(fallback);
  const [loading, setLoading] = useState(isSupabaseConfigured);

  async function refetch() {
    let query = supabase.from(table).select(select);
    for (const { column, ascending = true } of orderBy) {
      query = query.order(column, { ascending });
    }
    const { data, error } = await query;
    if (!error && data) setRows(data as T[]);
    setLoading(false);
    return !error && data ? (data as T[]) : null;
  }

  useEffect(() => {
    if (!isSupabaseConfigured) return;

    refetch();

    if (!realtime) return;

    const channel = supabase
      .channel(`${table}-changes`)
      .on("postgres_changes", { event: "*", schema: "public", table }, () => refetch())
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, realtime]);

  return { rows, setRows, loading, refetch };
}
