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
const {readdirSync}=await import('node:fs');
const migrationDir=new URL('../../supabase/migrations/',import.meta.url);
for (const name of readdirSync(migrationDir).filter(name=>name.endsWith('.sql')).sort()) {
  await db.exec(readFileSync(new URL(name,migrationDir),'utf8').replace('create extension if not exists pgcrypto;','-- shim'));
}

const admin=crypto.randomUUID(),kitchen=crypto.randomUUID(),bar=crypto.randomUUID();
const cashiers=Array.from({length:5},()=>({id:crypto.randomUUID(),device:crypto.randomUUID()}));
for(const [id,role] of [[admin,'admin'],[kitchen,'cucina'],[bar,'bar'],...cashiers.map(c=>[c.id,'cassa'])]){
 await db.query('insert into auth.users values($1)',[id]);await db.query('update profiles set role=$2 where id=$1',[id,role]);
}
await db.exec("update order_events set manual_closed=false,opens_at=now()-interval '1 hour',closes_at=now()+interval '1 day'");
const event=(await db.query('select id from order_events where is_current')).rows[0].id;
const food=(await db.query("insert into menu_items(category,subcategory,name,price,stock_capacity,available_portions) values ('cibo','secondi','Panino test',5,1000,1000) returning id")).rows[0].id;
const beer=(await db.query("insert into menu_items(category,subcategory,name,price,stock_capacity,available_portions) values ('bevande','birre','Birra test',4,1000,1000) returning id")).rows[0].id;
async function rpc(name,args=[]){return (await db.query('select public.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') result',args)).rows[0].result;}
async function asUser(id,fn){await db.exec(id?'set role authenticated':'set role anon');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id??'']);try{return await fn();}finally{await db.exec('reset role');}}
async function submit(mode='immediate',items=[{id:food,qty:1}]){const token=crypto.randomUUID();await db.exec('set role service_role');try{return await rpc('submit_public_order',['Cliente test','',JSON.stringify(items),crypto.randomUUID(),token,'',event,null,mode]);}finally{await db.exec('reset role');}}
const counter=()=>asUser(admin,()=>rpc('create_counter_order',['Banco test','',JSON.stringify([{id:food,qty:1}])]));
const occupied=()=>rpc('kitchen_occupied',[event]);
const row=async id=>(await db.query('select * from orders where id=$1',[id])).rows[0];
const claim=(order,i)=>asUser(cashiers[i].id,()=>rpc('claim_order_for_station',[order.order_id,'cassa_'+(i+1),cashiers[i].device]));
const pay=(order,i)=>asUser(cashiers[i].id,()=>rpc('pay_order_for_station',[order.order_id,'cassa_'+(i+1),cashiers[i].device]));
const stocks=async()=>(await db.query('select id,available_portions from menu_items where id in ($1,$2) order by id',[food,beer])).rows;
const active=[];
for(let n=0;n<95;n++)active.push(await counter());
const held=[];
for(let i=0;i<5;i++){const o=await submit();held.push(o);assert.equal((await claim(o,i)).kitchen_state,'reserved');}
assert.equal(await occupied(),100);
const beforeRejected=await stocks();await assert.rejects(counter(),/kitchen_capacity_reached/);assert.deepEqual(await stocks(),beforeRejected);
for(let i=0;i<4;i++)assert.equal((await pay(held[i],i)).kitchen_state,'active');
assert.equal(await occupied(),100);
console.log('PASS: five cashier reservations share the last five slots; payment preserves capacity; manual creation cannot bypass 100.');
const sleeping=await submit('deferred',[{id:food,qty:2},{id:beer,qty:2}]);
const afterReservation=await stocks();await claim(sleeping,0);const paid=await pay(sleeping,0);
assert.equal(paid.kitchen_state,'dormant');assert.deepEqual(await stocks(),afterReservation);
assert.equal((await asUser(kitchen,()=>rpc('get_fulfillment_queue',['secondi']))).some(o=>o.id===sleeping.order_id),false);
assert.equal((await asUser(bar,()=>rpc('get_fulfillment_queue',['birre']))).some(o=>o.id===sleeping.order_id),true);
await asUser(bar,()=>rpc('deliver_fulfillment_items',[sleeping.order_id,'birre',JSON.stringify([{id:beer,qty:1}])]));
await assert.rejects(asUser(kitchen,()=>rpc('deliver_fulfillment_items',[sleeping.order_id,'secondi',JSON.stringify([{id:food,qty:1}])])),/kitchen_not_active/);
await assert.rejects(asUser(bar,()=>rpc('activate_kitchen_order',[sleeping.order_id,'birre'])),/not_authorized/);
await assert.rejects(asUser(null,()=>rpc('activate_kitchen_order',[sleeping.order_id,'secondi'])),/permission denied/);
assert.equal((await asUser(kitchen,()=>rpc('get_fulfillment_order_by_qr',[sleeping.qr_token,'cucina']))).kitchen_state,'dormant');
assert.equal((await asUser(kitchen,()=>rpc('get_fulfillment_order_by_number',[sleeping.display_number,'secondi']))).id,sleeping.order_id);
assert.equal((await asUser(kitchen,()=>rpc('activate_kitchen_order',[sleeping.order_id,'cucina']))).kitchen_state,'waiting');
const requested=(await row(sleeping.order_id)).kitchen_requested_at;
await asUser(kitchen,()=>rpc('activate_kitchen_order',[sleeping.order_id,'secondi']));
assert.equal(String((await row(sleeping.order_id)).kitchen_requested_at),String(requested));
assert.deepEqual(await stocks(),afterReservation);
console.log('PASS: dormant food reserves stock once, stays out of kitchen; beer remains available; duplicate activation preserves queue time and stock.');
await asUser(cashiers[4].id,()=>rpc('release_order_for_station',[held[4].order_id,'cassa_5',cashiers[4].device]));
await asUser(kitchen,()=>rpc('get_fulfillment_queue',['cucina']));
assert.equal((await row(sleeping.order_id)).kitchen_state,'active');assert.equal(await occupied(),100);
assert.equal((await claim(held[4],4)).kitchen_state,'none');await assert.rejects(pay(held[4],4),/kitchen_capacity_reached/);
assert.equal((await row(held[4].order_id)).status,'in_attesa_pagamento');
await asUser(cashiers[4].id,()=>rpc('set_order_preparation',[held[4].order_id,'cassa_5',cashiers[4].device,'deferred']));
assert.equal((await pay(held[4],4)).kitchen_state,'dormant');
await asUser(kitchen,()=>rpc('activate_kitchen_order',[held[4].order_id,'secondi']));
assert.equal((await row(held[4].order_id)).kitchen_state,'waiting');
const delivered=await asUser(kitchen,()=>rpc('deliver_fulfillment_items',[active[0].id,'secondi',JSON.stringify([{id:food,qty:1}])]));
assert.equal((await row(held[4].order_id)).kitchen_state,'active');assert.equal(await occupied(),100);
await asUser(kitchen,()=>rpc('undo_fulfillment_delivery',[delivered.delivery_id,'secondi']));
assert.equal((await row(active[0].id)).kitchen_state,'waiting');assert.equal(await occupied(),100);
await asUser(kitchen,()=>rpc('deliver_fulfillment_items',[active[1].id,'secondi',JSON.stringify([{id:food,qty:1}])]));
assert.equal((await row(active[0].id)).kitchen_state,'active');
console.log('PASS: released slots promote paid waiting orders; full kitchen blocks immediate payment; cashier can switch to later; undo cannot exceed 100.');
const total=(await row(sleeping.order_id)).total;
await asUser(kitchen,()=>rpc('deliver_fulfillment_items',[sleeping.order_id,'secondi',JSON.stringify([{id:food,qty:1}])]));
assert.equal((await row(sleeping.order_id)).kitchen_state,'active');
await asUser(kitchen,()=>rpc('deliver_fulfillment_items',[sleeping.order_id,'secondi',JSON.stringify([{id:food,qty:1}])]));
assert.equal((await row(sleeping.order_id)).kitchen_state,'done');
assert.equal((await row(sleeping.order_id)).status,'ritiro_parziale');
assert.equal((await row(sleeping.order_id)).total,total);
const expiring=await submit();await claim(expiring,0);
assert.equal(await occupied(),100);
await db.query("update order_claim_devices set expires_at=now()-interval '1 second' where order_id=$1",[expiring.order_id]);
assert.equal(await occupied(),99);
await assert.rejects(pay(expiring,0),/claim_lost/);
console.log('PASS: expired cashier reservation releases its slot and cannot confirm payment.');
await asUser(admin,()=>rpc('close_order_event',[]));
await assert.rejects(asUser(kitchen,()=>rpc('activate_kitchen_order',[held[4].order_id,'secondi'])),/event_closed/);
console.log('PASS: partial food pickup keeps slot until food completed; pending beer does not hold kitchen capacity; closed event cannot activate orders.');
await db.close();
