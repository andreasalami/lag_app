import {readdirSync} from "node:fs";
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
const schema = readFileSync(new URL('../../supabase/schema.sql', import.meta.url), 'utf8').replace('create extension if not exists pgcrypto;', '-- shim');
await db.exec(schema);
console.log('PASS: schema applied twice.');
for(const name of readdirSync(new URL('../../supabase/migrations/',import.meta.url)).filter(name=>name.startsWith('20260905') && name.endsWith('.sql')).sort()) await db.exec(readFileSync(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8'));
await db.query('update menu_items set available_portions=5000,stock_capacity=5000 where id=$1',[beer]);
async function stock() {return (await db.query('select available_portions from menu_items where id=$1',[beer])).rows[0].available_portions;}
async function submit(items) {
 const token=crypto.randomUUID();
 const order=await asUser(null,()=>rpc('submit_public_order',['Test sicuro','',JSON.stringify(items),crypto.randomUUID(),token,'']));
 return {...order,token};
}
await assert.rejects(submit([{id:beer,qty:999}]), /public_order_quantity_limit/);
await assert.rejects(submit([{id:beer,qty:20},{id:beer,qty:6}]), /public_order_quantity_limit/);
const third=(await db.query("insert into menu_items(category,subcategory,name,price) values ('cibo','contorni','Test patate',3) returning id")).rows[0].id;
await assert.rejects(submit([{id:beer,qty:25},{id:food,qty:25},{id:third,qty:11}]), /public_order_quantity_limit/);
assert.equal(await stock(),5000);
console.log('PASS: 999, duplicate product aggregation and 61 total items rejected; stock unchanged.');
const max=await submit([{id:beer,qty:25},{id:food,qty:25},{id:third,qty:10}]);
assert.equal(max.items.reduce((n,line)=>n+line.qty,0),60);
const abandoned=await submit([{id:beer,qty:10}]);
const claimed=await submit([{id:beer,qty:2}]);
const paid=await submit([{id:beer,qty:3}]);
const device=crypto.randomUUID();
await asUser(admin,async()=>{
 await rpc('claim_order_for_station',[claimed.order_id,'cassa_1',device]);
 await rpc('claim_order_for_station',[paid.order_id,'cassa_2',device]);
 await rpc('pay_order_for_station',[paid.order_id,'cassa_2',device]);
});
for (const order of [abandoned,claimed,paid]) await db.query("update orders set created_at=now()-interval '61 minutes' where id=$1",[order.order_id]);
const before=await stock();
const states=await asUser(null,()=>rpc('get_public_order_statuses',[[abandoned.token,claimed.token,paid.token]]));
assert.equal(states.find(o=>o.order_id===abandoned.order_id).status,'annullato');
assert.equal(states.find(o=>o.order_id===claimed.order_id).status,'in_attesa_pagamento');
assert.equal(states.find(o=>o.order_id===paid.order_id).status,'pagato');
assert.equal(await stock(),before+10);
const stored=(await db.query('select alias,notes from orders where id=$1',[abandoned.order_id])).rows[0];
assert.equal(stored.alias,null); assert.equal(stored.notes,null);
await asUser(null,()=>rpc('get_ordering_status',[]));
assert.equal(await stock(),before+10);
console.log('PASS: expired stock restored exactly once; active cashier claim and paid order preserved; notes erased.');
await db.query("update order_claim_devices set expires_at=now()-interval '1 second' where order_id=$1",[claimed.order_id]);
await assert.rejects(asUser(admin,()=>rpc('claim_order_for_station',[claimed.order_id,'cassa_1',device])),/reservation_expired/);
await asUser(admin,()=>rpc('get_cashier_pending_orders',[]));
assert.equal(await stock(),before+12);
const fresh=await submit([{id:beer,qty:1}]);
await db.query("update orders set created_at=now()-interval '59 minutes' where id=$1",[fresh.order_id]);
const freshStates=await asUser(null,()=>rpc('get_public_order_statuses',[[fresh.token]]));
assert.equal(freshStates[0].status,'in_attesa_pagamento');
console.log('PASS: no new claims after expiry; abandoned cashier claim released; order younger than 60 minutes kept.');
await assert.rejects(asUser(null,()=>rpc('expire_unpaid_orders',[])),/permission denied/);
const paidRequestId=(await db.query('select client_request_id from orders where id=$1',[paid.order_id])).rows[0].client_request_id;
const recoveredPaid = await asUser(null,()=>rpc('submit_public_order',['Test sicuro','',JSON.stringify([{id:beer,qty:3}]),paidRequestId,paid.token,'',paid.event_id]));
assert.equal(recoveredPaid.order_id,paid.order_id);assert.equal(recoveredPaid.status,'pagato');
await assert.rejects(asUser(null,()=>rpc('submit_public_order',['Test sicuro','',JSON.stringify([{id:beer,qty:1}]),crypto.randomUUID(),crypto.randomUUID(),'',crypto.randomUUID()])),/event_changed/);
console.log('PASS: recover paid request without duplication; expected event mismatch rejected.');
assert.equal((await db.query('select max_pending_orders from order_events where is_current')).rows[0].max_pending_orders,100);
const pendingCount=Number((await db.query("select count(*) total from orders where status='in_attesa_pagamento'")).rows[0].total);
for(let n=pendingCount;n<100;n++) await submit([{id:beer,qty:1}]);
const stockAtCapacity=await stock();
await assert.rejects(submit([{id:beer,qty:1}]),/capacity_reached/);
assert.equal(await stock(),stockAtCapacity);
assert.equal((await asUser(null,()=>rpc('get_ordering_status',[]))).reason,'capacity_reached');
assert.equal((await asUser(null,()=>rpc('submit_public_order',['Test sicuro','',JSON.stringify([{id:beer,qty:3}]),paidRequestId,paid.token,'',paid.event_id]))).order_id,paid.order_id);
// Applying the lower limit never removes existing orders, even above the threshold.
await db.exec('update order_events set max_pending_orders=150 where is_current');
await submit([{id:beer,qty:1}]);
await db.exec(readFileSync(new URL('../../supabase/migrations/20260905120000_pending_orders_limit_100.sql',import.meta.url),'utf8'));
assert.equal(Number((await db.query("select count(*) total from orders where status='in_attesa_pagamento'")).rows[0].total),101);
await assert.rejects(submit([{id:beer,qty:1}]),/capacity_reached/);
await asUser(admin,()=>rpc('close_order_event',[]));
const nextEvent=await asUser(admin,()=>rpc('create_next_order_event',['Evento successivo',new Date().toISOString(),new Date(Date.now()+3600000).toISOString()]));
assert.equal(nextEvent.max_pending_orders,100);
console.log('PASS: 100 pending orders accepted, 101st rejected without stock changes; existing excess orders preserved; new event defaults to 100.');
await db.close();
