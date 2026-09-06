// Solo database in memoria: nessun accesso al progetto Supabase remoto.
const { PGlite } = await import(process.env.LAG_AUDIT_PGLITE_MODULE ?? '@electric-sql/pglite');
import { readFileSync } from 'node:fs';
const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
create schema auth; create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create schema extensions;
create function extensions.digest(text,text) returns bytea language sql immutable as $$ select sha256(convert_to($1,'UTF8')) $$;
grant usage on schema public, auth to anon,authenticated,service_role;
create publication supabase_realtime;`);
const schema = readFileSync(new URL('../../supabase/schema.sql', import.meta.url),'utf8').replace('create extension if not exists pgcrypto;', '-- pgcrypto digest shim for this isolated PostgreSQL harness');
try { await db.exec(schema); console.log('SCHEMA_FIRST_APPLY: OK'); }
catch(e) { console.log('SCHEMA_FIRST_APPLY:',e.message); process.exit(1); }
try { await db.exec(schema); console.log('SCHEMA_SECOND_APPLY: OK'); }
catch(e) { console.log('SCHEMA_SECOND_APPLY:', e.message); await db.exec('rollback'); }
const admin='00000000-0000-4000-8000-000000000001';
const kitchen='00000000-0000-4000-8000-000000000002';
const bar='00000000-0000-4000-8000-000000000003';
await db.exec(`insert into auth.users values ('${admin}'),('${kitchen}'),('${bar}');
update profiles set role='admin' where id='${admin}'; update profiles set role='cucina' where id='${kitchen}'; update profiles set role='bar' where id='${bar}';
update order_events set manual_closed=false,opens_at=now()-interval '1 hour',closes_at=now()+interval '1 day';`);
const [{rows:[menu]}] = await db.exec(`insert into menu_items(category,subcategory,name,price,available_portions,stock_capacity) values ('cibo','primi','Audit pasta',1,5000,5000) returning id`);
async function asUser(id, fn) { await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${id}',false)`); try {return await fn();} finally {await db.exec('reset role');} }
async function rpc(name, values) {return (await db.query(`select public.${name}(${values.map((_,i)=>'$'+(i+1)).join(',')}) result`,values)).rows[0].result;}
async function publicOrder(qty=1) {await db.exec('set role anon'); try{return await rpc('submit_public_order',['Audit cliente','nota audit',JSON.stringify([{id:menu.id,qty}]),crypto.randomUUID(),crypto.randomUUID(),'']);}finally{await db.exec('reset role');}}
async function paidOrder() {const o=await publicOrder();const d=crypto.randomUUID();await asUser(admin,async()=>{await rpc('claim_order_for_station',[o.order_id,'cassa_1',d]);await rpc('pay_order_for_station',[o.order_id,'cassa_1',d]);});return o;}
const bulk=await publicOrder(999);
console.log('ANON_RESERVATION:', JSON.stringify((await db.query('select available_portions from menu_items where id=$1',[menu.id])).rows));
const cancelled=await publicOrder(); const dev=crypto.randomUUID();
await asUser(admin,async()=>{await rpc('claim_order_for_station',[cancelled.order_id,'cassa_1',dev]);await rpc('cancel_order_for_station',[cancelled.order_id,'cassa_1',dev]);});
console.log('CANCELLED_PII:',JSON.stringify((await db.query('select status,alias,notes from orders where id=$1',[cancelled.order_id])).rows));
const legacy=await paidOrder();
await asUser(kitchen,()=>rpc('deliver_order',[legacy.order_id]));
console.log('LEGACY_DELIVERY:',JSON.stringify((await db.query('select o.status,f.quantity,f.delivered_quantity from orders o join order_fulfillment_items f on f.order_id=o.id where o.id=$1',[legacy.order_id])).rows));
const delivered=await paidOrder();
const receipt=await asUser(kitchen,()=>rpc('deliver_fulfillment_items',[delivered.order_id,'primi',JSON.stringify([{id:menu.id,qty:1}])]));
console.log('DELIVERED_PII:',JSON.stringify((await db.query('select status,alias,notes from orders where id=$1',[delivered.order_id])).rows));
const barRows=await asUser(bar,()=>db.query('select id,alias,notes from orders where id=$1',[delivered.order_id]));
console.log('BAR_CAN_READ_FOOD_DELIVERED:',barRows.rows.length);
await db.exec('set role anon');
await rpc('upsert_push_subscription',['https://arbitrary.example.test/path', 'A'.repeat(87), 'B'.repeat(22),'tournament',null]);
await db.exec('reset role');
console.log('ARBITRARY_PUSH_ENDPOINT_ACCEPTED: true');
await db.exec('set role anon');
console.log('ANON_ORDER_ROWS_VISIBLE:',(await db.query('select count(*)::int n from orders').catch(e=>({rows:[{n:'denied: '+e.code}]}))).rows[0].n);
await db.exec('reset role');
const oldClaim=crypto.randomUUID(); const newClaim=crypto.randomUUID(); const conflicting=await publicOrder();
await asUser(admin,async()=>{
 await rpc('claim_order_for_station',[conflicting.order_id,'cassa_1',newClaim]);
 await rpc('claim_order',[conflicting.order_id,oldClaim]);
 await rpc('pay_claimed_order',[conflicting.order_id,oldClaim]);
});
console.log('LEGACY_PAYMENT_WITH_STATION_CLAIM:',JSON.stringify((await db.query('select status,(select count(*)::int from order_fulfillment_items f where f.order_id=o.id) fulfillment_rows from orders o where id=$1',[conflicting.order_id])).rows));
await asUser(admin,()=>rpc('close_order_event',[]));
const repeatedClose=await asUser(admin,()=>rpc('close_order_event',[]));
console.log('REPEATED_CLOSE_HAS_ORDERS:',Array.isArray(repeatedClose.orders));
await asUser(kitchen,()=>rpc('undo_fulfillment_delivery',[receipt.delivery_id,'primi']));
console.log('UNDO_AFTER_CLOSE:',JSON.stringify((await db.query('select o.status,e.permanently_closed_at is not null event_closed from orders o join order_events e on e.id=o.event_id where o.id=$1',[delivered.order_id])).rows));
await db.close();
