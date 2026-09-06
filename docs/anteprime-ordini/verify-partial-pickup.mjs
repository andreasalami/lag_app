// Isolated PostgreSQL verification. Never connects to the live Supabase project.
// LAG_AUDIT_PGLITE_MODULE may point to a temporary local PGlite installation.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const { PGlite } = await import(process.env.LAG_AUDIT_PGLITE_MODULE ?? '@electric-sql/pglite');
const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
create schema auth; create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create schema extensions;
create function extensions.digest(text,text) returns bytea language sql immutable as $$ select sha256(convert_to($1,'UTF8')) $$;
grant usage on schema public, auth to anon,authenticated,service_role;
create function extensions.hmac(data text, secret text, algorithm text) returns bytea language plpgsql immutable as $$
declare k bytea:=convert_to(secret,'UTF8'); ipad bytea:=decode(repeat('00',64),'hex');opad bytea:=ipad;i integer;
begin
 if algorithm<>'sha256' then raise exception 'unsupported_test_algorithm';end if;
 if octet_length(k)>64 then k:=sha256(k);end if;
 k:=k||decode(repeat('00',64-octet_length(k)),'hex');
 for i in 0..63 loop ipad:=set_byte(ipad,i,get_byte(k,i)#54);opad:=set_byte(opad,i,get_byte(k,i)#92);end loop;
 return sha256(opad||sha256(ipad||convert_to(data,'UTF8')));
end;$$;
create publication supabase_realtime;`);
await db.exec(readFileSync(new URL('../../supabase/schema.sql', import.meta.url), 'utf8')
  .replace('create extension if not exists pgcrypto;', '-- digest shim for isolated test'));
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
