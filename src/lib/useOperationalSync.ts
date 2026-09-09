import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "./supabaseClient";

type OperationalSyncOptions = {
  enabled: boolean;
  channelName: string;
  tables: readonly string[];
  refresh: () => Promise<boolean>;
  pollingMs?: number;
  staleAfterMs?: number;
};

export type OperationalSyncState = {
  refreshNow: () => Promise<boolean>;
  refreshing: boolean;
  realtimeConnected: boolean;
  online: boolean;
  lastSuccessAt: number | null;
  stale: boolean;
};

export function isOperationalDataStale(
  online: boolean,
  lastSuccessAt: number | null,
  lastFailureAt: number | null,
  now: number,
  staleAfterMs: number,
) {
  if (!online) return true;
  if (lastSuccessAt === null) return lastFailureAt !== null;
  return now - lastSuccessAt > staleAfterMs;
}

export function useOperationalSync({
  enabled,
  channelName,
  tables,
  refresh,
  pollingMs = 15_000,
  staleAfterMs = 45_000,
}: OperationalSyncOptions): OperationalSyncState {
  const refreshRef = useRef(refresh);
  const inFlightRef = useRef<Promise<boolean> | null>(null);
  const queuedRef = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const [realtimeConnected, setRealtimeConnected] = useState(false);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null);
  const [lastFailureAt, setLastFailureAt] = useState<number | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const tablesKey = tables.join(",");

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  const refreshNow = useCallback(async () => {
    if (!enabled) return false;
    if (inFlightRef.current) {
      queuedRef.current = true;
      return inFlightRef.current;
    }
    const run = (async () => {
      let lastResult: boolean;
      setRefreshing(true);
      try {
        do {
          queuedRef.current = false;
          lastResult = await refreshRef.current();
          const timestamp = Date.now();
          if (lastResult) setLastSuccessAt(timestamp);
          else setLastFailureAt(timestamp);
        } while (queuedRef.current);
        return lastResult;
      } finally {
        setRefreshing(false);
        inFlightRef.current = null;
      }
    })();
    inFlightRef.current = run;
    return run;
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    void refreshNow();
    const channel = supabase.channel(channelName);
    tables.forEach((table) => {
      channel.on("postgres_changes", { event: "*", schema: "public", table }, () => void refreshNow());
    });
    channel.subscribe((status) => setRealtimeConnected(status === "SUBSCRIBED"));
    const poll = window.setInterval(() => {
      if (document.visibilityState === "visible" && navigator.onLine) void refreshNow();
    }, pollingMs);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refreshNow();
    };
    const onOnline = () => {
      setOnline(true);
      void refreshNow();
    };
    const onOffline = () => setOnline(false);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      setRealtimeConnected(false);
      void supabase.removeChannel(channel);
    };
    // tablesKey represents the stable set of subscribed table names.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelName, enabled, pollingMs, refreshNow, tablesKey]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);

  return {
    refreshNow,
    refreshing,
    realtimeConnected,
    online,
    lastSuccessAt,
    stale: isOperationalDataStale(online, lastSuccessAt, lastFailureAt, clock, staleAfterMs),
  };
}
