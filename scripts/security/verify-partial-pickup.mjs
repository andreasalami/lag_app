// Isolated PostgreSQL verification. Never connects to the live Supabase project.
// LAG_AUDIT_PGLITE_MODULE may point to a temporary local PGlite installation.
import assert from 'node:assert/strict';
import { emptyDatabase, installFiles, schemaFile } from './pglite-harness.mjs';
const db = await emptyDatabase();
await installFiles(db, [schemaFile]);
const admin = crypto.randomUUID(), bar = crypto.randomUUID(), kitchen = crypto.randomUUID();
for (const [id, role] of [[admin,'admin'],[bar,'bar'],[kitchen,'cucina']]) {
  await db.query('insert into auth.users values ($1)', [id]);
  await db.query('update profiles set role=$2 where id=$1', [id, role]);
}
await db.exec("update order_events set manual_closed=false,opens_at=now()-interval '1 hour',closes_at=now()+interval '1 day'");
const beer = (await db.query("insert into menu_items(category,subcategory,name,price) values ('bevande','birre','Test birra',4.5) returning id")).rows[0].id;
const food = (await db.query("insert into menu_items(category,subcategory,name,price) values ('cibo','secondi','Test panino',5) returning id")).rows[0].id;
async function asUser(id, action) {
  await db.exec(id ? 'set role authenticated' : 'set role anon');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id ?? '']);
  try { return await action(); } finally { await db.exec('reset role'); }
}
async function rpc(name, values) {
  // Order creation represents a server request AFTER proof validation, never a browser RPC.
  const role = (await db.query('select current_user as role')).rows[0].role;
  if (name === 'submit_public_order') await db.exec('set role service_role');
  try { return (await db.query(`select public.${name}(${values.map((_,i)=>'$'+(i+1)).join(',')}) result`, values)).rows[0].result; }
  finally { if (name === 'submit_public_order') await db.exec('set role "'+role.replaceAll('"','""')+'"'); }
}
const token = crypto.randomUUID(), device = crypto.randomUUID();
const order = await asUser(null, () => rpc('submit_public_order', ['Test parziale','',JSON.stringify([{id:beer,qty:10},{id:food,qty:2}]),crypto.randomUUID(),token,'']));
await asUser(admin, async () => {
  await rpc('claim_order_for_station', [order.order_id,'cassa_1',device]);
  await rpc('pay_order_for_station', [order.order_id,'cassa_1',device]);
});
async function deliver(user, station, id, qty) {
  return asUser(user, () => rpc('deliver_fulfillment_items', [order.order_id,station,JSON.stringify([{id,qty}])]));
}
async function progress() {
  return (await asUser(null, () => rpc('get_public_order_statuses', [[token]])))[0];
}
const before = (await db.query('select total from orders where id=$1',[order.order_id])).rows[0].total;
await deliver(bar,'birre',beer,2);
let state = await progress();
assert.equal(state.status,'ritiro_parziale');
assert.deepEqual(state.progress.find(p=>p.station==='birre'), {station:'birre',quantity:10,delivered:2});
assert.equal(state.progress.find(p=>p.station==='secondi').delivered,0);
console.log('PASS: 2 of 10 beers delivered; 8 remain, food unchanged, same QR token.');
await assert.rejects(deliver(bar,'birre',beer,9), /invalid_delivery_quantity/);
await assert.rejects(deliver(bar,'secondi',food,1), /not_authorized/);
await assert.rejects(deliver(kitchen,'birre',beer,1), /not_authorized/);
await assert.rejects(deliver(null,'birre',beer,1), /permission denied/);
for (const invalid of [0,-1,1.5]) await assert.rejects(deliver(bar,'birre',beer,invalid), /invalid_delivery/);
assert.equal((await progress()).progress.find(p=>p.station==='birre').delivered,2);
console.log('PASS: overdelivery, invalid quantities and unauthorized roles rejected without changes.');
await deliver(bar,'birre',beer,2);
await deliver(bar,'birre',beer,6);
assert.equal((await progress()).status,'ritiro_parziale');
await deliver(kitchen,'secondi',food,1);
assert.equal((await progress()).status,'ritiro_parziale');
await deliver(kitchen,'secondi',food,1);
assert.equal((await progress()).status,'consegnato');
await assert.rejects(deliver(bar,'birre',beer,1), /order_not_available/);
assert.equal((await db.query('select total from orders where id=$1',[order.order_id])).rows[0].total,before);
console.log('PASS: repeated pickups 2+2+6 and 1+1 complete the order; paid total unchanged.');
await db.close();
