// Isolated PostgreSQL verification. Never connects to the live Supabase project.
// Role decisions of 2026-10-03: the bar manages drinks only, the kitchen keeps the
// whole menu, only cashiers and admins close the event, staff no longer reads pushes.
import assert from "node:assert/strict";
import { migratedDatabase } from "./pglite-harness.mjs";

const { db, asUser, rpc, userWithRole } = await migratedDatabase();
const [bar, kitchen, staff, cashier] = [
  await userWithRole("bar"),
  await userWithRole("cucina"),
  await userWithRole("staff"),
  await userWithRole("cassa"),
];
const insert = (category, subcategory, name) =>
  db.query(
    "insert into menu_items(category,subcategory,name,price,available_portions) values ($1,$2,$3,4,10) returning id",
    [category, subcategory, name],
  );
const beer = (await insert("bevande", "birre", "Birra test")).rows[0].id;
const sandwich = (await insert("cibo", "secondi", "Panino test")).rows[0].id;
const portions = async (id) =>
  (await db.query("select available_portions from menu_items where id=$1", [id])).rows[0]?.available_portions;
const update = (id, set) => db.query(`update menu_items set ${set} where id=$1`, [id]);

await asUser(bar, async () => {
  await update(beer, "available_portions=3, price=5");
  await update(sandwich, "available_portions=0");
  await assert.rejects(update(beer, "category='cibo', subcategory='secondi'"), /row-level security/);
  await assert.rejects(insert("cibo", "dolci", "Torta test"), /row-level security/);
  await insert("bevande", "drinks", "Spritz test");
  await db.query("delete from menu_items where id=$1", [sandwich]);
});
assert.equal(await portions(beer), 3, "the bar updates drink stock");
assert.equal(await portions(sandwich), 10, "the bar cannot touch or delete food");
console.log("PASS: the bar manages drinks only.");

await asUser(kitchen, () => update(beer, "price=6, available_portions=8"));
assert.equal(await portions(beer), 8);
console.log("PASS: the kitchen still manages the whole menu, prices included.");

await db.exec("insert into push_broadcasts(kind,title,message) values ('tournament','Titolo','Messaggio')");
assert.equal((await asUser(staff, () => db.query("select id from push_broadcasts"))).rows.length, 0);
console.log("PASS: staff no longer reads the push history.");

await assert.rejects(
  asUser(staff, () => rpc("close_order_event")),
  /not_authorized/,
);
await asUser(cashier, () => rpc("close_order_event"));
console.log("PASS: only cashiers and admins close the event.");
await db.close();
