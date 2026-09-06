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
const baseline = readFileSync(new URL('../../supabase/migrations/20260801000000_initial_schema.sql',import.meta.url),'utf8').replace('create extension if not exists pgcrypto;','-- shim');
await db.exec(baseline);
for (let pass=0;pass<2;pass++) {
 for (const name of readdirSync(new URL('../../supabase/migrations/',import.meta.url)).filter(name=>name.startsWith('20260905') && name.endsWith('.sql')).sort()) {
  await db.exec(readFileSync(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8'));
 }
}
console.log('PASS: upgrade from audited baseline; all security migrations applied twice.');
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
const signatures=['claim_order(uuid,text)','claim_order_by_qr(text,text)','release_order_claim(uuid,text)','update_claimed_order(uuid,text,text,text,jsonb)','cancel_claimed_order(uuid,text)','pay_claimed_order(uuid,text)','deliver_order(uuid)','deliver_order_by_qr(text)'];
for (const role of ['anon','authenticated','service_role']) for(const signature of signatures) {
 assert.equal((await db.query('select has_function_privilege($1,$2,$3) allowed',[role,'public.'+signature,'EXECUTE'])).rows[0].allowed,false);
}
console.log('PASS: all retired order APIs denied to API roles.');
const token=crypto.randomUUID(),device=crypto.randomUUID();
const order=await asUser(null,()=>rpc('submit_public_order',['Test chiusura','',JSON.stringify([{id:beer,qty:10},{id:food,qty:2}]),crypto.randomUUID(),token,'']));
await asUser(admin,async()=>{
 await rpc('claim_order_for_station',[order.order_id,'cassa_1',device]);
 await rpc('pay_order_for_station',[order.order_id,'cassa_1',device]);
});
// Staff may see only their station's quantities through the RPC, never full order rows.
assert.deepEqual((await asUser(bar,()=>db.query('select * from orders where id=$1',[order.order_id]))).rows,[]);
const queue=await asUser(bar,()=>rpc('get_fulfillment_queue',['birre']));
assert.ok(queue.find(row=>row.id===order.order_id).items.every(item=>item.station==='birre'));
await assert.rejects(asUser(bar,()=>rpc('get_fulfillment_queue',['secondi'])),/not_authorized/);
const privacy=await rpc('submit_public_order',['Da cancellare','Nota privata',JSON.stringify([{id:beer,qty:1}]),crypto.randomUUID(),crypto.randomUUID(),'']);
await asUser(admin,async()=>{await rpc('claim_order_for_station',[privacy.order_id,'cassa_1',device]);await rpc('pay_order_for_station',[privacy.order_id,'cassa_1',device]);});
await asUser(bar,()=>rpc('deliver_fulfillment_items',[privacy.order_id,'birre',JSON.stringify([{id:beer,qty:1}])]));
await db.query("update orders set delivered_at=now()-interval '6 minutes' where id=$1",[privacy.order_id]);
await asUser(null,()=>rpc('get_ordering_status',[]));
const cleared=(await db.query('select alias,notes from orders where id=$1',[privacy.order_id])).rows[0];
assert.deepEqual(cleared,{alias:null,notes:null});
console.log('PASS: full order rows hidden from bar; queue restricted to station; delivered alias/notes erased after grace window.');
const delivery=await asUser(bar,()=>rpc('deliver_fulfillment_items',[order.order_id,'birre',JSON.stringify([{id:beer,qty:2}])]));
await asUser(bar,()=>rpc('undo_fulfillment_delivery',[delivery.delivery_id,'birre']));
assert.equal((await db.query('select delivered_quantity from order_fulfillment_items where order_id=$1 and menu_item_id=$2',[order.order_id,beer])).rows[0].delivered_quantity,0);
await assert.rejects(asUser(bar,()=>rpc('undo_fulfillment_delivery',[delivery.delivery_id,'birre'])),/delivery_not_available/);
const final=await asUser(bar,()=>rpc('deliver_fulfillment_items',[order.order_id,'birre',JSON.stringify([{id:beer,qty:2}])]));
const firstReport=await asUser(admin,()=>rpc('close_order_event',[]));
const repeatedReport=await asUser(admin,()=>rpc('close_order_event',[]));
assert.deepEqual(repeatedReport,firstReport);
console.log('PASS: repeated close returns identical complete report.');
for(const [user,station] of [[bar,'birre'],[kitchen,'secondi'],[admin,'birre']]) {
 await assert.rejects(asUser(user,()=>rpc('undo_fulfillment_delivery',[final.delivery_id,station])),/event_closed/);
}
await assert.rejects(asUser(bar,()=>rpc('deliver_fulfillment_items',[order.order_id,'birre',JSON.stringify([{id:beer,qty:1}])])),/event_closed/);
assert.equal((await db.query('select status from orders where id=$1',[order.order_id])).rows[0].status,'consegnato');
assert.equal((await db.query('select reversed_at from fulfillment_deliveries where id=$1',[final.delivery_id])).rows[0].reversed_at,null);
console.log('PASS: undo once while open; delivery and undo blocked after closure for every staff role.');
const rev=await asUser(admin,()=>rpc('publish_tournament',[0,8,JSON.stringify(['A','B']), '{}','{}']));
assert.equal(rev,1);
await assert.rejects(asUser(admin,()=>rpc('publish_tournament',[0,8,JSON.stringify(['STALE']), '{}','{}'])),/tournament_conflict/);
assert.deepEqual((await db.query("select teams from tournament_state where id='main'")).rows[0].teams,['A','B']);
await assert.rejects(asUser(admin,()=>db.query("update tournament_state set teams='[]' where id='main'")),/permission denied/);
await assert.rejects(asUser(null,()=>rpc('get_cashier_claims',[])),/permission denied/);
assert.deepEqual(await asUser(admin,()=>rpc('get_cashier_claims',[])),[]);
console.log('PASS: stale tournament publication and direct write denied; claim summary restricted to cashiers.');
await db.close();
