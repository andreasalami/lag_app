import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { supabase } from "../../lib/supabaseClient";
import { Menu } from "../menu/Menu";
import { useAuth } from "../auth/AuthContext";
import type { OrderLine, StaffOrder } from "./types";

type KitchenOrder = Pick<StaffOrder,
  "id" | "display_number" | "alias" | "notes" | "items" | "created_at" | "paid_at"
>;

const KITCHEN_ORDER_SOUND_URL = `${import.meta.env.BASE_URL}sounds/line-simple-bell.mp3`;
let kitchenOrderAudio: HTMLAudioElement | null = null;

function playNewOrderSound() {
  kitchenOrderAudio ??= new Audio(KITCHEN_ORDER_SOUND_URL);
  kitchenOrderAudio.currentTime = 0;
  void kitchenOrderAudio.play().catch(() => {
    // Il browser può bloccare l'audio finché l'utente non attiva il toggle.
  });
}

export function Cucina() {
  const { role, loading: authLoading } = useAuth();
  const authorized = role === "cucina" || role === "admin";
  const [tab, setTab] = useState<"coda" | "menu">("coda");
  const [orders, setOrders] = useState<KitchenOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [numberSearch, setNumberSearch] = useState("");
  const [aliasSearch, setAliasSearch] = useState("");
  const [soundEnabled, setSoundEnabled] = useState(() => localStorage.getItem("lag:kitchen-sound") === "on");
  const [delivering, setDelivering] = useState<Set<string>>(() => new Set());
  const knownOrderIds = useRef<Set<string> | null>(null);

  const refetch = useCallback(async () => {
    if (!authorized) return;
    const { data, error } = await supabase
      .from("orders")
      .select("id, display_number, alias, notes, items, created_at, paid_at")
      .eq("status", "pagato")
      .order("display_number", { ascending: true });
    if (error) {
      setLoadError("Coda cucina non disponibile. Riprova.");
      setLoading(false);
      return;
    }
    const nextOrders = ((data ?? []) as KitchenOrder[])
      .map((order) => ({
        ...order,
        items: order.items.filter((line) => !line.category || line.category === "cibo"),
      }))
      .filter((order) => order.items.length > 0);
    const nextIds = new Set(nextOrders.map((order) => order.id));
    if (knownOrderIds.current && soundEnabled
      && nextOrders.some((order) => !knownOrderIds.current?.has(order.id))) {
      playNewOrderSound();
    }
    knownOrderIds.current = nextIds;
    setOrders(nextOrders);
    setLoadError(null);
    setLoading(false);
  }, [authorized, soundEnabled]);

  useEffect(() => {
    if (!authorized) return;
    void refetch();
    const channel = supabase
      .channel("orders-kitchen")
      .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, () => void refetch())
      .subscribe();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refetch();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      void supabase.removeChannel(channel);
    };
  }, [authorized, refetch]);

  const filteredOrders = useMemo(() => orders.filter((order) => {
    const numberMatches = !numberSearch.trim() || String(order.display_number).includes(numberSearch.trim());
    const aliasMatches = !aliasSearch.trim() || (order.alias ?? "").toLocaleLowerCase("it").includes(aliasSearch.trim().toLocaleLowerCase("it"));
    return numberMatches && aliasMatches;
  }), [aliasSearch, numberSearch, orders]);

  function toggleSound() {
    const next = !soundEnabled;
    setSoundEnabled(next);
    localStorage.setItem("lag:kitchen-sound", next ? "on" : "off");
    if (next) playNewOrderSound();
  }

  async function deliverOrder(id: string) {
    if (delivering.has(id)) return;
    setDelivering((current) => new Set(current).add(id));
    const { error } = await supabase.rpc("deliver_order", { p_order_id: id });
    if (error) setLoadError("Ordine non rimosso. Riprova.");
    else {
      setOrders((current) => current.filter((order) => order.id !== id));
      knownOrderIds.current?.delete(id);
    }
    setDelivering((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }

  if (authLoading) return <section className="mx-auto max-w-4xl px-4 py-10 text-sm text-[var(--text-secondary)]">Carico…</section>;
  if (!authorized) {
    return (
      <section className="mx-auto max-w-4xl px-4 py-10">
        <h1 className="text-2xl">Cucina</h1>
        <p className="mt-3 text-sm text-[var(--text-secondary)]">Accedi dall’area Staff con un account cucina.</p>
      </section>
    );
  }

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl">Cucina</h1>
          <p className="text-sm text-[var(--text-secondary)]">Solo prodotti alimentari; le bevande restano sullo scontrino.</p>
        </div>
        <a href={`${import.meta.env.BASE_URL}#staff`} className="text-xs text-[var(--text-secondary)] hover:underline">Area staff</a>
      </div>

      <div className="mt-5 grid grid-cols-2 rounded-[var(--radius-pill)] border border-[var(--surface-border)] p-1">
        <button type="button" onClick={() => setTab("coda")} className={`rounded-[var(--radius-pill)] px-3 py-2 text-sm ${tab === "coda" ? "bg-[var(--accent-primary)] text-[var(--text-on-accent)]" : "text-[var(--text-secondary)]"}`}>Coda</button>
        <button type="button" onClick={() => setTab("menu")} className={`rounded-[var(--radius-pill)] px-3 py-2 text-sm ${tab === "menu" ? "bg-[var(--accent-primary)] text-[var(--text-on-accent)]" : "text-[var(--text-secondary)]"}`}>Menu e scorte</button>
      </div>

      {tab === "coda" ? (
        <section className="mt-6">
          <div className="flex flex-wrap items-end gap-3">
            <label className="min-w-28 flex-1">
              <span className="mb-1 block text-xs">Numero</span>
              <input type="number" inputMode="numeric" value={numberSearch} onChange={(event) => setNumberSearch(event.target.value)} className="field w-full py-2" />
            </label>
            <label className="min-w-36 flex-[2]">
              <span className="mb-1 block text-xs">Alias</span>
              <input value={aliasSearch} onChange={(event) => setAliasSearch(event.target.value)} className="field w-full py-2" />
            </label>
            <div className="flex items-center gap-2 pb-1">
              <button
                type="button"
                role="switch"
                aria-checked={soundEnabled}
                onClick={toggleSound}
                className={`relative h-7 w-12 rounded-full transition-colors ${soundEnabled ? "bg-[var(--state-success)]" : "bg-[var(--surface-solid)]"}`}
              >
                <span className={`absolute left-1 top-1 h-5 w-5 rounded-full bg-white transition-transform ${soundEnabled ? "translate-x-5" : "translate-x-0"}`} />
              </button>
              <span className="text-xs">Suono</span>
            </div>
          </div>

          <p className="mt-3 text-sm text-[var(--text-secondary)]">{filteredOrders.length} ordini da consegnare.</p>
          {loadError && <p className="mt-3 text-sm text-[var(--state-error)]">{loadError}</p>}
          {loading ? <p className="mt-4 text-sm text-[var(--text-secondary)]">Carico…</p> : (
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {filteredOrders.map((order) => (
                <Card key={order.id} className="flex flex-col gap-2 border-l-4 border-l-[var(--accent-primary)]">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <span className="text-2xl font-semibold">#{order.display_number}</span>
                      <span className="ml-2 text-lg">{order.alias}</span>
                    </div>
                    <Button variant="ghost" onClick={() => void deliverOrder(order.id)} disabled={delivering.has(order.id)}>
                      {delivering.has(order.id) ? "Rimuovo…" : "Consegnato"}
                    </Button>
                  </div>
                  <div className="mt-1 flex flex-col gap-1">
                    {(order.items as OrderLine[]).map((line) => (
                      <p key={line.id} className="text-base font-semibold">{line.qty}× {line.name}</p>
                    ))}
                  </div>
                  {order.notes && (
                    <div className="mt-2 rounded-[var(--radius-sm)] border-2 border-[var(--state-warning)] bg-black/15 p-3 text-base text-[var(--state-warning)]">
                      <strong>NOTE:</strong> {order.notes}
                    </div>
                  )}
                </Card>
              ))}
              {filteredOrders.length === 0 && <p className="text-sm text-[var(--text-secondary)]">Nessun ordine corrispondente.</p>}
            </div>
          )}
        </section>
      ) : (
        <section className="mt-2">
          <p className="mx-auto max-w-3xl px-4 pt-6 text-sm text-[var(--text-secondary)]">
            La cucina può modificare prodotti, prezzi, scorte e allergeni. Il salvataggio è unico e atomico.
          </p>
          <Menu />
        </section>
      )}
    </main>
  );
}
