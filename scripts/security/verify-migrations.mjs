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
assert.equal((await db.query("select has_function_privilege('authenticated','public.pay_claimed_order(uuid,text)','EXECUTE') ok")).rows[0].ok,false);
assert.equal((await db.query("select column_name from information_schema.columns where table_name='tournament_state' and column_name='revision'")).rows.length,1);
console.log('PASS: database installed from zero using the complete ordered migration chain.');
await db.close();
