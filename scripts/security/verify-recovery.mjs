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
for (const role of ['anon','authenticated']) {
  assert.equal((await db.query("select has_function_privilege($1,'public.submit_public_order(text,text,jsonb,uuid,text,text,uuid,text,text)','EXECUTE') allowed",[role])).rows[0].allowed,false);
}
console.log('PASS: browser roles cannot bypass the order gateway.');
const {createHmac}=await import('node:crypto');
const admin=crypto.randomUUID();await db.query('insert into auth.users values($1)',[admin]);await db.query("update profiles set role='admin' where id=$1",[admin]);
await db.exec("update order_events set manual_closed=false,opens_at=now()-interval '1 hour',closes_at=now()+interval '1 day'");
const event=(await db.query('select id from order_events where is_current')).rows[0].id;
const menu=(await db.query("insert into menu_items(category,subcategory,name,price) values ('bevande','birre','Test birra',4) returning id")).rows[0].id;
async function rpc(name, values) {
  // Order creation represents a server request AFTER proof validation, never a browser RPC.
  const role = (await db.query('select current_user as role')).rows[0].role;
  if (name === 'submit_public_order') await db.exec('set role service_role');
  try { return (await db.query(`select public.${name}(${values.map((_,i)=>'$'+(i+1)).join(',')}) result`, values)).rows[0].result; }
  finally { if (name === 'submit_public_order') await db.exec('set role "'+role.replaceAll('"','""')+'"'); }
}
function qr(key,id){const h=createHmac('sha256',key).update(id).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;}
async function submit(key){const id=crypto.randomUUID();const token=qr(key,id);return rpc('submit_public_order',['Cliente test','',JSON.stringify([{id:menu,qty:1}]),id,token,'',event,key]);}
const key='A'.repeat(43),other='B'.repeat(43);
await db.exec('set role anon');
const first=await submit(key);await submit(key);await submit(other);
let restored=await rpc('recover_order_history',[key]);assert.equal(restored.length,2);assert.equal(restored.find(row=>row.order_id===first.order_id).qr_token,first.qr_token);
assert.equal((await rpc('recover_order_history',['C'.repeat(43)])).length,0);
await assert.rejects(rpc('submit_public_order',['Cliente test','',JSON.stringify([{id:menu,qty:1}]),crypto.randomUUID(),crypto.randomUUID(),'',event,key]),/invalid_recovery_token/);
await submit(key);
await assert.rejects(submit(key),/public_order_rate_limit/);
await db.exec('reset role');
const firstRequest=(await db.query('select client_request_id from orders where id=$1',[first.order_id])).rows[0].client_request_id;
await db.exec('set role anon');
assert.equal((await rpc('submit_public_order',['Cliente test','',JSON.stringify([{id:menu,qty:1}]),firstRequest,first.qr_token,'',event,key])).order_id,first.order_id);
console.log('PASS: fourth order in a minute rejected; retry of existing order still recovers.');
for(let n=0;n<48;n++) {
  await db.exec("reset role; update orders set created_at=created_at-interval '2 minutes'; set role anon");
  await submit(key);
}
const page=await rpc('recover_order_history',[key]);assert.equal(page.length,50);
const tail=await rpc('recover_order_history',[key,page[49].order_id]);assert.equal(tail.length,1);assert.equal(page.some(row=>row.order_id===tail[0].order_id),false);
await db.exec('reset role');
assert.equal((await db.query('select recovery_token_hash from orders where id=$1',[first.order_id])).rows[0].recovery_token_hash.length,64);
await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[admin]);await rpc('close_order_event',[]);await db.exec('reset role');
await db.exec('set role anon');restored=await rpc('recover_order_history',[key]);assert.ok(restored.every(order=>order.event_closed_at));
console.log('PASS: recovery isolated by secret; same QR restored; wrong secret empty; mismatched QR rejected; paginated history retained after event closure.');
await db.close();
