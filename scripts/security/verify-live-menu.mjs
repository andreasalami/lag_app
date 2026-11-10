// Isolated PostgreSQL verification. Never connects to the live Supabase project.
// Live menu edits (2026-11-10): an order already sent keeps its items; suspending or
// deleting a product only affects later orders and never blocks cash desk, expiry or ordering.
// Every scenario runs even when an earlier one fails, so one run lists all broken rules.
import assert from "node:assert/strict";
import { migratedDatabase } from "./pglite-harness.mjs";

const { db, asUser, rpc, userWithRole } = await migratedDatabase();
const [cashier, kitchen, bar, staff] = [
  await userWithRole("cassa"),
  await userWithRole("cucina"),
  await userWithRole("bar"),
  await userWithRole("staff"),
];
await db.exec(
  "update order_events set manual_closed=false,opens_at=now()-interval '1 hour',closes_at=now()+interval '1 day'",
);

let failures = 0;
async function check(name, scenario) {
  try {
    await scenario();
    console.log(`PASS: ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL: ${name}\n      ${String(error.message).split("\n")[0]}`);
  } finally {
    await db.exec("reset role");
  }
}

const one = async (sql, values = []) => (await db.query(sql, values)).rows[0];
async function product(category, section, name, price, stock = null) {
  return (
    await one(
      "insert into menu_items(category,subcategory,name,price,available_portions,stock_capacity) values ($1,$2,$3,$4,$5,$5) returning id",
      [category, section, name, price, stock],
    )
  ).id;
}
const menuRow = (id) => one("select * from menu_items where id=$1", [id]);
const orderRow = (id) => one("select * from orders where id=$1", [id]);
const submit = (items, more = []) =>
  asUser(null, () =>
    rpc("submit_public_order", [
      "Tavolo prova",
      "",
      JSON.stringify(items),
      crypto.randomUUID(),
      crypto.randomUUID(),
      "",
      ...more,
    ]),
  );
const device = crypto.randomUUID();
const atCashDesk = (name, orderId) => asUser(cashier, () => rpc(name, [orderId, "cassa_1", device]));
const saveMenu = (user, { created = [], updated = [], deleted = [] }) =>
  asUser(user, () =>
    rpc("bulk_upsert_menu_items", [JSON.stringify(created), JSON.stringify(updated), `{${deleted.join(",")}}`]),
  );
const suspend = (user, id, suspended = true) =>
  asUser(user, () => db.query("update menu_items set suspended=$2 where id=$1 returning id", [id, suspended]));
const publicStatus = () => asUser(null, () => rpc("get_ordering_status"));

await check("deleting a product never blocks cancelling an unpaid order that contains it", async () => {
  const [panino, birra] = [
    await product("cibo", "secondi", "Panino", 5, 10),
    await product("bevande", "birre", "Birra", 4, 10),
  ];
  const order = await submit([
    { id: panino, qty: 2 },
    { id: birra, qty: 3 },
  ]);
  await saveMenu(kitchen, { deleted: [panino] });
  await atCashDesk("claim_order_for_station", order.order_id);
  await atCashDesk("cancel_order_for_station", order.order_id);
  assert.equal((await orderRow(order.order_id)).status, "annullato");
  assert.equal((await menuRow(birra)).available_portions, 10, "the surviving product gets its stock back");
});

await check("deleting a product never blocks expiry, public status and catalog", async () => {
  const panino = await product("cibo", "secondi", "Panino a scadenza", 5, 10);
  const order = await submit([{ id: panino, qty: 1 }]);
  await saveMenu(kitchen, { deleted: [panino] });
  await db.query("update orders set created_at=now()-interval '61 minutes' where id=$1", [order.order_id]);
  assert.equal((await publicStatus()).accepting, true);
  assert.equal((await orderRow(order.order_id)).status, "annullato");
  await asUser(null, () => rpc("get_ordering_catalog"));
  await asUser(cashier, () => rpc("get_cashier_pending_orders"));
});

await check("an order sent before a deletion is still paid, prepared and delivered", async () => {
  const panino = await product("cibo", "secondi", "Panino pagato", 5, 10);
  const order = await submit([{ id: panino, qty: 2 }]);
  await saveMenu(kitchen, { deleted: [panino] });
  await atCashDesk("claim_order_for_station", order.order_id);
  await atCashDesk("pay_order_for_station", order.order_id);
  const delivered = await asUser(kitchen, () =>
    rpc("deliver_fulfillment_items", [order.order_id, "secondi", JSON.stringify([{ id: panino, qty: 2 }])]),
  );
  assert.equal(delivered.status, "consegnato");
});

await check("a suspended product cannot be ordered and stays suspended when stock comes back", async () => {
  const fritto = await product("cibo", "contorni", "Fritto", 3, 10);
  const before = await submit([{ id: fritto, qty: 4 }]);
  assert.equal((await suspend(kitchen, fritto)).rows.length, 1);
  await assert.rejects(submit([{ id: fritto, qty: 1 }]), /stock_unavailable:Fritto/);
  await atCashDesk("claim_order_for_station", before.order_id);
  await atCashDesk("cancel_order_for_station", before.order_id);
  const row = await menuRow(fritto);
  assert.deepEqual([row.available_portions, row.suspended], [10, true]);
  await assert.rejects(submit([{ id: fritto, qty: 1 }]), /stock_unavailable:Fritto/);
  const catalog = await asUser(null, () => rpc("get_ordering_catalog"));
  assert.equal(catalog.items.find((item) => item.id === fritto).suspended, true);
  await suspend(kitchen, fritto, false);
  await submit([{ id: fritto, qty: 1 }]);
});

await check("an order sent before a suspension is still paid and delivered; the cash desk sees the flag", async () => {
  const [pasta, acqua] = [
    await product("cibo", "primi", "Pasta", 6, 10),
    await product("bevande", "bevande", "Acqua", 1, null),
  ];
  const order = await submit([
    { id: pasta, qty: 1 },
    { id: acqua, qty: 1 },
  ]);
  await suspend(kitchen, pasta);
  const claimed = await atCashDesk("claim_order_for_station", order.order_id);
  assert.deepEqual(claimed.unavailable_items, [pasta]);
  assert.equal(Number(claimed.total), 7, "the total to pay does not change");
  await atCashDesk("pay_order_for_station", order.order_id);
  const delivered = await asUser(kitchen, () =>
    rpc("deliver_fulfillment_items", [order.order_id, "primi", JSON.stringify([{ id: pasta, qty: 1 }])]),
  );
  assert.equal(delivered.status, "ritiro_parziale");
});

await check("the bar suspends drinks only", async () => {
  const [spritz, risotto] = [
    await product("bevande", "drinks", "Spritz", 5),
    await product("cibo", "primi", "Risotto", 7),
  ];
  assert.equal((await suspend(bar, spritz)).rows.length, 1);
  assert.equal((await suspend(bar, risotto)).rows.length, 0);
  assert.equal((await menuRow(risotto)).suspended, false);
});

await check("commitments count what is still to prepare, paid and unpaid", async () => {
  const gnocchi = await product("cibo", "primi", "Gnocchi", 6, 50);
  const of = async () => (await asUser(kitchen, () => rpc("get_menu_item_commitments"))).find((c) => c.id === gnocchi);
  await submit([{ id: gnocchi, qty: 2 }]);
  const paid = await submit([{ id: gnocchi, qty: 3 }]);
  await atCashDesk("claim_order_for_station", paid.order_id);
  await atCashDesk("pay_order_for_station", paid.order_id);
  assert.deepEqual(await of(), { id: gnocchi, paid_portions: 3, paid_orders: 1, unpaid_portions: 2, unpaid_orders: 1 });
  await asUser(kitchen, () =>
    rpc("deliver_fulfillment_items", [paid.order_id, "primi", JSON.stringify([{ id: gnocchi, qty: 1 }])]),
  );
  assert.equal((await of()).paid_portions, 2);
  await assert.rejects(
    asUser(cashier, () => rpc("get_menu_item_commitments")),
    /not_authorized/,
  );
  await assert.rejects(
    asUser(null, () => rpc("get_menu_item_commitments")),
    /permission denied/,
  );
});

await check("stock edited during sales applies the difference and is never refused", async () => {
  const birra = await product("bevande", "birre", "Birra alla spina", 4, 50);
  await submit([{ id: birra, qty: 5 }]);
  await saveMenu(bar, { updated: [{ id: birra, available_portions: 80, original_available_portions: 50 }] });
  assert.equal((await menuRow(birra)).available_portions, 75);
  await saveMenu(bar, { updated: [{ id: birra, available_portions: 0, original_available_portions: 80 }] });
  assert.equal((await menuRow(birra)).available_portions, 0, "a result below zero stops at zero");
  await saveMenu(bar, { updated: [{ id: birra, available_portions: null, original_available_portions: 0 }] });
  assert.equal((await menuRow(birra)).available_portions, null, "empty means unlimited");
  await saveMenu(bar, { updated: [{ id: birra, available_portions: 20, original_available_portions: null }] });
  const row = await menuRow(birra);
  assert.deepEqual([row.available_portions, row.stock_capacity], [20, 20]);
});

await check("two devices editing different fields of the same product both keep their change", async () => {
  const torta = await product("cibo", "dolci", "Torta", 3, 10);
  await saveMenu(kitchen, { updated: [{ id: torta, price: 3.5 }] });
  await saveMenu(staff, { updated: [{ id: torta, name: "Torta della nonna" }] });
  const row = await menuRow(torta);
  assert.deepEqual([row.name, Number(row.price), row.available_portions], ["Torta della nonna", 3.5, 10]);
});

await check("editing a product deleted by another device is reported, the rest is saved", async () => {
  const [gone, kept] = [await product("cibo", "dolci", "Gelato", 2), await product("cibo", "dolci", "Crostata", 2)];
  await saveMenu(kitchen, { deleted: [gone] });
  const result = await saveMenu(staff, {
    updated: [
      { id: gone, price: 9 },
      { id: kept, price: 4 },
    ],
  });
  assert.deepEqual(result.missing, [gone]);
  assert.equal(Number((await menuRow(kept)).price), 4);
});

await check("roles without rights on a product get an error, not a silent ok", async () => {
  const [arrosto, vino] = [await product("cibo", "secondi", "Arrosto", 8), await product("bevande", "vini", "Vino", 5)];
  await assert.rejects(saveMenu(cashier, { updated: [{ id: arrosto, price: 1 }] }), /not_authorized/);
  await assert.rejects(saveMenu(bar, { updated: [{ id: arrosto, price: 1 }] }), /not_authorized/);
  await assert.rejects(saveMenu(bar, { deleted: [arrosto] }), /not_authorized/);
  await saveMenu(bar, { updated: [{ id: vino, price: 6 }] });
  assert.deepEqual([Number((await menuRow(arrosto)).price), Number((await menuRow(vino)).price)], [8, 6]);
});

await check("saving the same new product twice creates it once", async () => {
  const created = [{ id: crypto.randomUUID(), category: "cibo", subcategory: "primi", name: "Lasagne", price: 7 }];
  await saveMenu(kitchen, { created });
  await saveMenu(kitchen, { created });
  assert.equal((await one("select count(*)::int n from menu_items where name='Lasagne'")).n, 1);
});

await check("a price changed after the customer confirmed stops the order", async () => {
  const hotdog = await product("cibo", "secondi", "Hot dog", 5, 10);
  const items = [{ id: hotdog, qty: 2 }];
  await saveMenu(kitchen, { updated: [{ id: hotdog, price: 6 }] });
  await assert.rejects(submit(items, [null, null, "immediate", 10]), /price_changed/);
  assert.equal((await menuRow(hotdog)).available_portions, 10, "nothing is reserved");
  const order = await submit(items, [null, null, "immediate", 12]);
  assert.equal(Number(order.total), 12);
});

await check("paying twice answers already_paid", async () => {
  const caffe = await product("bevande", "bevande", "Caffè", 1);
  const order = await submit([{ id: caffe, qty: 1 }]);
  await atCashDesk("claim_order_for_station", order.order_id);
  await atCashDesk("pay_order_for_station", order.order_id);
  await assert.rejects(atCashDesk("pay_order_for_station", order.order_id), /already_paid/);
});

await check("out-of-range input gets a business error, not a technical one", async () => {
  const caviale = await product("cibo", "secondi", "Caviale", 9999.99);
  const acqua = await product("bevande", "bevande", "Acqua frizzante", 1);
  await assert.rejects(
    asUser(cashier, () =>
      rpc("create_counter_order", ["Banco", "", JSON.stringify([{ id: caviale, qty: 11 }]), "immediate"]),
    ),
    /order_total_too_high/,
  );
  const order = await submit([{ id: acqua, qty: 1 }], [null, null, "deferred"]);
  assert.equal(order.preparation_mode, "immediate", "a drinks-only order reports what was stored");
  await assert.rejects(
    asUser(cashier, () => rpc("claim_order_for_station", [order.order_id, null, device])),
    /invalid_station/,
  );
  await atCashDesk("claim_order_for_station", order.order_id);
  await atCashDesk("pay_order_for_station", order.order_id);
  for (const item of [
    { id: "-".repeat(36), qty: 1 },
    { id: acqua, qty: "99999999999" },
  ]) {
    await assert.rejects(
      asUser(bar, () => rpc("deliver_fulfillment_items", [order.order_id, "bar", JSON.stringify([item])])),
      /invalid_delivery/,
    );
  }
  await assert.rejects(
    asUser(cashier, () => rpc("update_order_event", ["Evento", null, null, 100, 1])),
    /invalid_event_settings/,
  );
});

await check("the schedule saves changed fields only, reports deleted slots and never duplicates", async () => {
  const save = (created, updated, deleted = [], days = null) =>
    asUser(staff, () =>
      rpc("save_program", [days, JSON.stringify(created), JSON.stringify(updated), `{${deleted.join(",")}}`]),
    );
  const [slot, gone] = [crypto.randomUUID(), crypto.randomUUID()];
  const created = [slot, gone].map((id) => ({
    id,
    day: 1,
    stage: "Stage 1",
    title: "Concerto",
    start_time: "20:00",
    end_time: "21:00",
  }));
  await save(created, []);
  await save(created, []);
  assert.equal((await one("select count(*)::int n from program_slots")).n, 2);
  await save([], [{ id: slot, title: "Concerto finale" }]);
  await save([], [{ id: slot, start_time: "22:00" }], [gone]);
  const row = await one("select title,start_time,end_time from program_slots where id=$1", [slot]);
  assert.deepEqual(row, { title: "Concerto finale", start_time: "22:00", end_time: "21:00" });
  assert.deepEqual((await save([], [{ id: gone, title: "Sparito" }])).missing, [gone]);
  await assert.rejects(save([], [{ id: slot, day: 2 }]), /every slot day/);
  // Un dispositivo porta i giorni a 2 e sposta l'evento; uno rimasto indietro salva senza toccare i giorni.
  await save([], [{ id: slot, day: 2 }], [], 2);
  await save([], [{ id: slot, title: "Concerto di chiusura" }]);
  assert.equal((await one("select days from program_settings where id='main'")).days, 2);
  await assert.rejects(save([], [], [], 1), /slots_beyond_days/);
  assert.equal((await one("select days from program_settings where id='main'")).days, 2);
});

await db.close();
if (failures > 0) {
  console.log(`\n${failures} scenario(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: live menu edits keep sent orders intact and never block the event.");
