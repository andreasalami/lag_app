import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { RoleLogin } from "../auth/RoleLogin";
import { supabase } from "../../lib/supabaseClient";
import { Card } from "../../components/ui/Card";

type Order = {
  id: string;
  queue_number: number;
  items: { name: string; qty: number; price: number }[];
  total: number;
  created_at: string;
};
type LowStockItem = { id: string; name: string; remaining: number; available: number };

/*
  Cucina: solo 1-2 dispositivi collegati, quindi il realtime "broadcast
  a tutti + refetch completo" che era un problema per Menu/Programma
  qui non lo è affatto — è esattamente il posto giusto per usarlo.

  "Completa" non cancella la riga: valorizza completed_at. La coda
  filtra `completed_at is null`, i dati restano nel DB per le stats.
*/
export function Cucina() {
  const { role } = useAuth();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [lowStock, setLowStock] = useState<LowStockItem[]>([]);

  async function refetch() {
    const { data, error } = await supabase
      .from("orders")
      .select("id, queue_number, items, total, created_at")
      .is("completed_at", null)
      .order("queue_number", { ascending: true });
    if (!error && data) setOrders(data as Order[]);
    const { data: stockData } = await supabase.rpc("get_low_stock_items");
    if (stockData) setLowStock(stockData as LowStockItem[]);
    setLoading(false);
  }

  useEffect(() => {
    if (role !== "cucina" && role !== "admin") return;

    refetch();

    const channel = supabase
      .channel("orders-kitchen")
      .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, () => refetch())
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role]);

  async function completeOrder(id: string) {
    setOrders((prev) => prev.filter((o) => o.id !== id));
    const { error } = await supabase
      .from("orders")
      .update({ completed_at: new Date().toISOString() })
      .eq("id", id);
    if (error) refetch();
  }

  if (role !== "cucina" && role !== "admin") {
    return (
      <section className="mx-auto max-w-3xl px-4 py-10">
        <h2 className="mb-4 text-2xl font-semibold">Cucina</h2>
        <RoleLogin requiredRole="cucina" label="Cucina" />
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-3xl px-4 py-10">
      <h2 className="mb-1 text-2xl font-semibold">Cucina — coda ordini</h2>
      <p className="mb-4 text-sm text-[var(--text-secondary)]">{orders.length} ordini attivi.</p>

      <RoleLogin requiredRole="cucina" label="Cucina" />

      {loading ? (
        <p className="text-sm text-[var(--text-secondary)]">Carico...</p>
      ) : orders.length === 0 ? (
        <p className="text-sm text-[var(--text-secondary)]">Nessun ordine in coda.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {orders.map((order) => (
            <Card key={order.id} className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="font-display text-lg">#{order.queue_number}</span>
                <button
                  type="button"
                  onClick={() => completeOrder(order.id)}
                  className="text-xs text-[var(--state-error)] hover:underline"
                >
                  Completato — rimuovi
                </button>
              </div>
              {order.items.map((it, i) => (
                <div key={i} className="flex justify-between text-sm">
                  <span>
                    {it.qty}× {it.name}
                  </span>
                </div>
              ))}
            </Card>
          ))}
        </div>
      )}
      {lowStock.length > 0 && (
        <Card className="mt-6 border border-[var(--state-warning)]">
          <h3 className="font-display text-lg text-[var(--state-warning)]">Scorte in esaurimento</h3>
          {lowStock.map((item) => (
            <p key={item.id} className="text-sm text-[var(--state-warning)]">
              {item.name}: rimangono {item.remaining} porzioni su {item.available}.
            </p>
          ))}
        </Card>
      )}
    </section>
  );
}
