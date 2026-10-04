// Isolated PostgreSQL verification of the income snapshot and the tournament name limit.
import assert from "node:assert/strict";
import { migratedDatabase } from "./pglite-harness.mjs";

const { db, asUser, rpc, userWithRole } = await migratedDatabase();
const cashier = await userWithRole("cassa");
const kitchen = await userWithRole("cucina");
const admin = await userWithRole("admin");
await db.exec(
  "update order_events set manual_closed=false,opens_at=now()-interval '1 hour',closes_at=now()+interval '1 day'",
);

async function menuItem(category, section, name, price) {
  return (
    await db.query("insert into menu_items(category,subcategory,name,price) values ($1,$2,$3,$4) returning id", [
      category,
      section,
      name,
      price,
    ])
  ).rows[0].id;
}
const pasta = await menuItem("cibo", "primi", "Pasta", 8);
const risotto = await menuItem("cibo", "primi", "Risotto", 9);
await menuItem("cibo", "primi", "Lasagna", 10);
const beer = await menuItem("bevande", "birre", "Birra", 5);
await menuItem("bevande", "vini", "Vino", 4);

const device = crypto.randomUUID();
async function order(alias, notes, items) {
  return asUser(null, () =>
    rpc("submit_public_order", [alias, notes, JSON.stringify(items), crypto.randomUUID(), crypto.randomUUID(), ""]),
  );
}
async function paidOrder(items, paidAtUtc) {
  const created = await order("Alias segreto", "Nota segreta", items);
  await asUser(cashier, async () => {
    await rpc("claim_order_for_station", [created.order_id, "cassa_1", device]);
    await rpc("pay_order_for_station", [created.order_id, "cassa_1", device]);
  });
  await db.query("update orders set paid_at=$2 where id=$1", [created.order_id, paidAtUtc]);
}
// 18:30 UTC is 20:30 in Cremona (CEST): the chart must use the local hour.
await paidOrder(
  [
    { id: pasta, qty: 2 },
    { id: beer, qty: 3 },
  ],
  "2026-10-02T18:30:00Z",
);
await paidOrder([{ id: pasta, qty: 1 }], "2026-10-02T19:10:00Z");
await paidOrder(
  [
    { id: risotto, qty: 1 },
    { id: beer, qty: 2 },
  ],
  "2026-10-02T19:50:00Z",
);
await order("In attesa", "", [{ id: beer, qty: 4 }]);
const cancelled = await order("Annullato", "", [{ id: risotto, qty: 5 }]);
await asUser(cashier, async () => {
  await rpc("claim_order_for_station", [cancelled.order_id, "cassa_1", device]);
  await rpc("cancel_order_for_station", [cancelled.order_id, "cassa_1", device]);
});

const snapshot = await asUser(cashier, () => rpc("get_order_event_snapshot"));
assert.equal(snapshot.orders_paid, 3);
assert.equal(Number(snapshot.revenue_total), 2 * 8 + 3 * 5 + 8 + 9 + 2 * 5);
assert.deepEqual(
  snapshot.hours.map(({ hour, orders }) => [hour, orders]),
  [
    ["2026-10-02T20:00:00", 1],
    ["2026-10-02T21:00:00", 2],
  ],
);
const product = (name) => snapshot.products.find((row) => row.name === name);
assert.deepEqual([product("Pasta").quantity, product("Risotto").quantity, product("Birra").quantity], [3, 1, 5]);
assert.equal(product("Lasagna").quantity, 0, "unsold menu items are listed with zero pieces");
assert.equal(product("Lasagna").section, "primi");
assert.equal(product("Vino").section, "vini");
assert.ok(!/segret|attesa|Annullato/.test(JSON.stringify(snapshot)), "no alias or notes in the snapshot");
await assert.rejects(
  asUser(kitchen, () => rpc("get_order_event_snapshot")),
  /not_authorized/,
);
await assert.rejects(
  asUser(null, () => rpc("get_order_event_snapshot")),
  /permission denied/,
);
console.log(
  "PASS: snapshot counts only paid orders, uses local hours, lists unsold items and hides customer data; kitchen and public denied.",
);

assert.deepEqual(snapshot.evenings, [], "a one-evening event has only the total");
// 23:30 UTC on 3 October is 01:30 on the 4th in Cremona: it still belongs to the second evening.
await paidOrder([{ id: risotto, qty: 2 }], "2026-10-03T23:30:00Z");
await asUser(cashier, () =>
  rpc("update_order_event", ["Due serate", "2026-10-02T16:00:00Z", "2026-10-05T03:00:00Z", 100, 2]),
);
const twoEvenings = await asUser(cashier, () => rpc("get_order_event_snapshot"));
assert.deepEqual(
  twoEvenings.evenings.map((part) => [part.evening, part.date, part.orders_paid, Number(part.revenue_total)]),
  [
    [1, "2026-10-02", 3, Number(snapshot.revenue_total)],
    [2, "2026-10-03", 1, 18],
  ],
);
assert.equal(twoEvenings.orders_paid, 4);
assert.equal(twoEvenings.evenings[1].products.find((row) => row.name === "Pasta").quantity, 0);
assert.deepEqual(twoEvenings.evenings[1].hours, [{ hour: "2026-10-04T01:00:00", orders: 1, revenue: 18 }]);
await assert.rejects(
  asUser(cashier, () => rpc("update_order_event", ["Quattro", "2026-10-02T16:00:00Z", "2026-10-05T03:00:00Z", 100, 4])),
  /invalid_event_settings/,
);
await assert.rejects(
  asUser(cashier, () => rpc("order_event_snapshot_part", [crypto.randomUUID(), null])),
  /permission denied/,
);
console.log(
  "PASS: two-evening snapshot splits paid orders by evening (after midnight included) and adds up to the total; part function private.",
);

await asUser(admin, () => rpc("close_order_event"));
const afterClose = await asUser(admin, () => rpc("get_order_event_snapshot"));
assert.equal(Number(afterClose.revenue_total), Number(twoEvenings.revenue_total));
assert.deepEqual(afterClose.hours, twoEvenings.hours);
assert.deepEqual(afterClose.evenings, twoEvenings.evenings);
console.log("PASS: snapshot unchanged after the event is closed and anonymised.");

const teams = (name) => JSON.stringify([name, ...Array.from({ length: 7 }, (_, i) => `Squadra ${i + 2}`)]);
const twenty = "A".repeat(20);
const revision = await asUser(admin, () => rpc("publish_tournament", [0, 8, teams(twenty), "{}", "{}"]));
assert.equal(revision, 1);
await assert.rejects(
  asUser(admin, () => rpc("publish_tournament", [1, 8, teams(twenty + "B"), "{}", "{}"])),
  /team_name_too_long/,
);
await assert.rejects(
  asUser(admin, () =>
    rpc("publish_tournament", [1, 8, teams(twenty), "{}", JSON.stringify({ "1-0-A": twenty + "B" })]),
  ),
  /team_name_too_long/,
);
await assert.rejects(
  asUser(admin, () => rpc("publish_tournament", [1, 8, JSON.stringify([1, 2]), "{}", "{}"])),
  /invalid_tournament/,
);
assert.deepEqual(
  (await db.query("select teams->>0 as first, revision from tournament_state where id='main'")).rows[0],
  { first: twenty, revision: 1 },
);
console.log(
  "PASS: tournament names up to 20 characters published; longer names and overrides rejected without changes.",
);
await db.close();
