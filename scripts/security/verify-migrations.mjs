// Isolated PostgreSQL verification. Never connects to the live Supabase project.
// LAG_AUDIT_PGLITE_MODULE may point to a temporary local PGlite installation.
import assert from 'node:assert/strict';
import { emptyDatabase, installFiles, migrationFiles } from './pglite-harness.mjs';
const db = await emptyDatabase();
await installFiles(db, migrationFiles());
assert.equal((await db.query("select to_regprocedure('public.pay_claimed_order(uuid,text)') fn")).rows[0].fn,null);
assert.equal((await db.query("select column_name from information_schema.columns where table_name='tournament_state' and column_name='revision'")).rows.length,1);
console.log('PASS: database installed from zero using the complete ordered migration chain.');
await db.close();
