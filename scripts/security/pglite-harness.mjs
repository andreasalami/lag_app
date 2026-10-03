// Shared harness for the isolated PostgreSQL verifications. Never connects to the live Supabase project.
// LAG_AUDIT_PGLITE_MODULE may point to a temporary local PGlite installation.
import { readFileSync, readdirSync } from 'node:fs';
const { PGlite } = await import(process.env.LAG_AUDIT_PGLITE_MODULE ?? '@electric-sql/pglite');

// Supabase roles, auth.uid() and the pgcrypto functions PGlite does not ship.
const BOOTSTRAP = `create role anon; create role authenticated; create role service_role bypassrls;
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
create publication supabase_realtime;`;

const migrationDir = new URL('../../supabase/migrations/', import.meta.url);
export const schemaFile = new URL('../../supabase/schema.sql', import.meta.url);

/** Ordered migration files (URLs); `filter` narrows them by file name. */
export function migrationFiles(filter = () => true) {
  return readdirSync(migrationDir).filter((name) => name.endsWith('.sql') && filter(name)).sort()
    .map((name) => new URL(name, migrationDir));
}

/** Applies SQL files in order; pgcrypto is unavailable in PGlite and is replaced by the BOOTSTRAP shims. */
export async function installFiles(db, files) {
  for (const file of files) await db.exec(readFileSync(file, 'utf8').replace('create extension if not exists pgcrypto;', '-- shim'));
}

/** Empty database with the Supabase roles, auth schema and pgcrypto shims. */
export async function emptyDatabase() {
  const db = new PGlite();
  await db.exec(BOOTSTRAP);
  return db;
}

/** Fresh database with the complete migration chain, plus helpers to act as a Supabase user. */
export async function migratedDatabase() {
  const db = await emptyDatabase();
  await installFiles(db, migrationFiles());

  /** Runs `action` as an authenticated user (id) or as anon (null), like a browser request. */
  async function asUser(id, action) {
    await db.exec(id ? 'set role authenticated' : 'set role anon');
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id ?? '']);
    try { return await action(); } finally { await db.exec('reset role'); }
  }

  async function rpc(name, values = []) {
    // Order creation represents a server request after Turnstile validation, never a browser RPC.
    const role = (await db.query('select current_user as role')).rows[0].role;
    if (name === 'submit_public_order') await db.exec('set role service_role');
    try {
      return (await db.query(`select public.${name}(${values.map((_, i) => '$' + (i + 1)).join(',')}) result`, values)).rows[0].result;
    } finally {
      if (name === 'submit_public_order') await db.exec('set role "' + role.replaceAll('"', '""') + '"');
    }
  }

  async function userWithRole(role) {
    const id = crypto.randomUUID();
    await db.query('insert into auth.users values ($1)', [id]);
    await db.query('update profiles set role=$2 where id=$1', [id, role]);
    return id;
  }

  return { db, asUser, rpc, userWithRole };
}
