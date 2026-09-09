// Isolated PostgreSQL verification. Never connects to the live Supabase project.
// LAG_AUDIT_PGLITE_MODULE may point to a temporary local PGlite installation.
//
// schema.sql is applied by hand in the Supabase SQL Editor, while CI installs the
// database from supabase/migrations/. Nothing forced the two to agree, so a fix
// landing in only one of them stayed invisible until an event day. This installs
// both into separate throwaway databases and compares the resulting catalog:
// tables, columns, constraints, indexes, policies, grants, RLS, realtime and every
// function body. Any divergence fails the build with the exact offending object.
//
// ponytail: the bootstrap block below is duplicated in every scripts/security
// verifier; extract a shared harness module if an eighth copy is ever needed.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
const { PGlite } = await import(process.env.LAG_AUDIT_PGLITE_MODULE ?? '@electric-sql/pglite');

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

// pgcrypto is unavailable in PGlite; the shims above stand in for it.
const shim = (sql) => sql.replace('create extension if not exists pgcrypto;', '-- shim');

async function install(files) {
  const db = new PGlite();
  await db.exec(BOOTSTRAP);
  for (const file of files) await db.exec(shim(readFileSync(file, 'utf8')));
  return db;
}

// Comments and line wrapping inside a function body are not behaviour: comparing
// raw source would report a reformatting as a schema drift and train us to ignore
// this check. Strip line comments and collapse whitespace before comparing.
const normalize = (body) => body.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();

const PROBES = {
  functions: `select p.proname||'('||pg_get_function_identity_arguments(p.oid)||') secdef='
      ||p.prosecdef::text||' volatility='||p.provolatile::text||' >> '||coalesce(p.prosrc,'') as item
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`,
  columns: `select table_name||'.'||column_name||' '||data_type||' nullable='||is_nullable
      ||' default='||coalesce(column_default,'-') as item
    from information_schema.columns where table_schema = 'public'`,
  constraints: `select conrelid::regclass::text||' | '||conname||' | '||pg_get_constraintdef(oid) as item
    from pg_constraint where connamespace = 'public'::regnamespace`,
  indexes: `select indexname||' | '||indexdef as item from pg_indexes where schemaname = 'public'`,
  policies: `select tablename||' | '||policyname||' | '||cmd||' | using '||coalesce(qual,'-')
      ||' | check '||coalesce(with_check,'-') as item
    from pg_policies where schemaname = 'public'`,
  rowLevelSecurity: `select c.relname||' rls='||c.relrowsecurity::text as item
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'`,
  functionGrants: `select p.proname||'('||pg_get_function_identity_arguments(p.oid)||') '||grantee.role
      ||' execute='||has_function_privilege(grantee.role, p.oid, 'EXECUTE')::text as item
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    cross join (values ('anon'),('authenticated')) grantee(role)
    where n.nspname = 'public'`,
  tableGrants: `select c.relname||' '||grantee.role||' '||privilege.name||'='
      ||has_table_privilege(grantee.role, c.oid, privilege.name)::text as item
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join (values ('anon'),('authenticated')) grantee(role)
    cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE')) privilege(name)
    where n.nspname = 'public' and c.relkind = 'r'`,
  realtime: `select c.relname as item
    from pg_publication_rel r join pg_class c on c.oid = r.prrelid`,
};

async function snapshot(db) {
  const result = {};
  for (const [name, query] of Object.entries(PROBES)) {
    result[name] = (await db.query(query)).rows.map((row) => normalize(row.item)).sort();
  }
  return result;
}

// Static guards, checked before spending time on two database installs.
// schema.sql used to be a plain concatenation of the migrations, so the same
// function was defined up to three times and only the last one was live. Keeping
// it to one definition per function is what makes the file readable at all.
const schemaText = readFileSync(new URL('../../supabase/schema.sql', import.meta.url), 'utf8');
const defined = [...schemaText.matchAll(/^create or replace function public\.([a-z_]+)\s*\(/gm)].map((m) => m[1]);
const repeated = [...new Set(defined.filter((name, i) => defined.indexOf(name) !== i))];
assert.deepEqual(repeated, [], `schema.sql defines the same function more than once: ${repeated.join(', ')}`);

// Every statement must be able to roll back together: a half-applied schema is
// harder to diagnose than a failed one.
assert.deepEqual(
  [schemaText.match(/^begin;$/gm)?.length ?? 0, schemaText.match(/^commit;$/gm)?.length ?? 0],
  [1, 1],
  'schema.sql must run as exactly one transaction: one begin; and one commit;',
);

const migrationDir = new URL('../../supabase/migrations/', import.meta.url);
const migrations = readdirSync(migrationDir).filter((n) => n.endsWith('.sql')).sort()
  .map((n) => new URL(n, migrationDir));
const schemaFile = new URL('../../supabase/schema.sql', import.meta.url);

const fromMigrations = await install(migrations);
const fromSchema = await install([schemaFile]);
const expected = await snapshot(fromMigrations);
const actual = await snapshot(fromSchema);

const failures = [];
for (const name of Object.keys(PROBES)) {
  const inSchema = new Set(actual[name]);
  const inMigrations = new Set(expected[name]);
  for (const item of expected[name]) if (!inSchema.has(item)) failures.push(`${name}: missing from schema.sql -> ${item.slice(0, 200)}`);
  for (const item of actual[name]) if (!inMigrations.has(item)) failures.push(`${name}: only in schema.sql -> ${item.slice(0, 200)}`);
}

assert.deepEqual(failures, [], `schema.sql and the migration chain describe different databases:\n${failures.join('\n')}`);
console.log(`PASS: schema.sql matches the migration chain (${Object.values(expected).flat().length} catalog entries compared).`);
await fromMigrations.close();
await fromSchema.close();
