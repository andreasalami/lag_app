// Isolated PostgreSQL verification. Never connects to the live Supabase project.
// LAG_AUDIT_PGLITE_MODULE may point to a temporary local PGlite installation.
import assert from "node:assert/strict";
import { emptyDatabase, installFiles, migrationFiles } from "./pglite-harness.mjs";
const db = await emptyDatabase();
await installFiles(db, migrationFiles());
const admin = crypto.randomUUID();
await db.query("insert into auth.users values($1)", [admin]);
await db.query("update profiles set role='admin' where id=$1", [admin]);
const { createECDH } = await import("node:crypto");
const ec = createECDH("prime256v1");
ec.generateKeys();
const key = ec.getPublicKey().toString("base64url");
const auth = Buffer.alloc(16, 1).toString("base64url");
async function rpc(name, values) {
  return (await db.query(`select public.${name}(${values.map((_, i) => "$" + (i + 1)).join(",")}) result`, values))
    .rows[0].result;
}
await db.exec("set role anon");
await assert.rejects(
  rpc("upsert_push_subscription", ["https://fcm.googleapis.com/fcm/send/test", key, auth, "tournament", null]),
  /permission denied/,
);
await db.exec("reset role; set role service_role");
for (const endpoint of [
  "https://127.0.0.1/private",
  "https://fcm.googleapis.com.evil.test/abc",
  "https://web.push.apple.com:8443/abc",
])
  await assert.rejects(
    rpc("upsert_push_subscription", [endpoint, key, auth, "tournament", null]),
    /invalid_push_subscription/,
  );
// Solo avvisi del torneo: una sorgente o un tipo "annunci" non sono più ammessi.
await assert.rejects(
  rpc("upsert_push_subscription", [
    "https://fcm.googleapis.com/fcm/send/old-announcements",
    key,
    auth,
    "announcements",
    null,
  ]),
  /invalid_push_subscription/,
);
await db.exec("reset role");
await assert.rejects(
  db.query("insert into push_broadcasts(kind,title,message) values ('announcement','Titolo','Messaggio')"),
  /push_broadcasts_kind_check/,
);
await db.exec("set role service_role");
for (let n = 0; n < 30; n++)
  await rpc("upsert_push_subscription", [
    `https://fcm.googleapis.com/fcm/send/test-${n}`,
    key,
    auth,
    "tournament",
    null,
  ]);
await db.exec("reset role; set role anon");
assert.equal(await rpc("has_push_subscription", ["https://fcm.googleapis.com/fcm/send/test-0", auth]), true);
assert.equal(await rpc("has_push_subscription", ["https://fcm.googleapis.com/fcm/send/test-0", "incorrect"]), false);
await assert.rejects(
  rpc("claim_push_broadcast", [crypto.randomUUID(), admin, "tournament", "Test", "Messaggio"]),
  /permission denied/,
);
await db.exec("reset role");
await db.exec("set role service_role");
// Le notifiche "annuncio" non esistono più: né lo staff né un admin possono inviarle.
const staff = crypto.randomUUID();
await db.exec("reset role");
await db.query("insert into auth.users values($1)", [staff]);
await db.query("update profiles set role='staff' where id=$1", [staff]);
await db.exec("set role service_role");
for (const sender of [staff, admin])
  await assert.rejects(
    rpc("claim_push_broadcast", [crypto.randomUUID(), sender, "announcement", "Test", "Messaggio"]),
    /not_authorized/,
  );
const id = crypto.randomUUID();
const first = await rpc("claim_push_broadcast", [id, admin, "tournament", "Test", "Messaggio"]);
assert.equal(first.batch.length, 25);
await assert.rejects(rpc("claim_push_broadcast", [id, admin, "tournament", "Test", "Messaggio"]), /broadcast_busy/);
const partial = await rpc("finish_push_batch", [
  id,
  first.lease,
  JSON.stringify(first.batch.map((row) => ({ id: row.id, delivered: true }))),
]);
assert.equal(partial.completed, false);
assert.equal(partial.sent, 25);
const second = await rpc("claim_push_broadcast", [id, admin, "tournament", "Test", "Messaggio"]);
assert.equal(second.batch.length, 5);
assert.equal(
  second.batch.some((row) => first.batch.some((prior) => prior.id === row.id)),
  false,
);
await db.exec("reset role");
await db.query("update push_broadcasts set lease_until=now()-interval '1 second' where id=$1", [id]);
await db.exec("set role service_role");
const resumed = await rpc("claim_push_broadcast", [id, admin, "tournament", "Test", "Messaggio"]);
assert.equal(resumed.batch.length, 0);
const final = await rpc("finish_push_batch", [id, resumed.lease, "[]"]);
assert.equal(final.completed, true);
assert.equal(final.sent, 25);
assert.equal(final.uncertain, 5);
const repeated = await rpc("claim_push_broadcast", [id, admin, "tournament", "Test", "Messaggio"]);
assert.equal(repeated.completed, true);
assert.equal(repeated.batch.length, 0);
console.log(
  "PASS: invalid endpoints denied; 25-item batches exclusive; completed batches and uncertain attempts never resent.",
);
await db.close();
