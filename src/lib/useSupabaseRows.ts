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
}

/**
 * Pattern ripetuto identico in Annunci, Programma e Menu: fetch iniziale
 * da una tabella pubblica, sottoscrizione realtime che rifà il fetch ad
 * ogni cambiamento (insert/update/delete — sono poche righe, un fetch
 * completo è più semplice e robusto di un merge incrementale a mano),
 * fallback di esempio se Supabase non è ancora configurato.
 *
 * Un solo posto dove questa logica può avere un bug, invece di tre.
 */
export function useSupabaseRows<T>({ table, select, orderBy = [], fallback }: UseSupabaseRowsOptions<T>) {
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
  }

  useEffect(() => {
    if (!isSupabaseConfigured) return;

    refetch();

    const channel = supabase
      .channel(`${table}-changes`)
      .on("postgres_changes", { event: "*", schema: "public", table }, () => refetch())
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table]);

  return { rows, setRows, loading, refetch };
}
