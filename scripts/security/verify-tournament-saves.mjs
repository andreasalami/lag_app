// Isolated PostgreSQL verification. Never connects to the live Supabase project.
// Tournament saves (2026-10-06): one save is live and updates the public bracket;
// the others stay private; concurrent edits never overwrite each other.
import assert from "node:assert/strict";
import { migratedDatabase } from "./pglite-harness.mjs";

const { db, asUser, rpc, userWithRole } = await migratedDatabase();
const [manager, staff] = [await userWithRole("tournament_manager"), await userWithRole("staff")];
const teams = (first) => JSON.stringify([first, ...Array.from({ length: 7 }, (_, i) => `Squadra ${i + 2}`)]);
const save = (id, name, expected, first, publish = false, overrides = "{}") =>
  asUser(manager, () => rpc("save_tournament", [id, name, expected, 8, teams(first), "{}", overrides, publish]));
const publicState = async () =>
  (await db.query("select teams->>0 first, revision, live_save_id from tournament_state where id='main'")).rows[0];

const seeded = await publicState();
const live = (
  await db.query("select id, name, updated_at::text from tournament_snapshots where id=$1", [seeded.live_save_id])
).rows[0];
assert.equal(live?.name, "Torneo pubblicato", "the published bracket becomes the first live save");
console.log("PASS: the migration turns the published bracket into the live save.");

const liveUpdate = await save(live.id, live.name, live.updated_at, "Leoni");
assert.equal(liveUpdate.live, true);
assert.deepEqual(await publicState(), { first: "Leoni", revision: seeded.revision + 1, live_save_id: live.id });
console.log("PASS: saving the live save updates the public bracket.");

const draft = await save(null, "Prova finale", null, "Tigri");
assert.equal(draft.live, false);
assert.equal((await publicState()).first, "Leoni", "a private save never reaches the public");
const edited = await save(draft.id, "Prova finale", draft.updated_at, "Aquile");
await assert.rejects(save(draft.id, "Prova finale", draft.updated_at, "Vecchia"), /save_conflict/);
assert.equal(
  (await db.query("select teams->>0 first from tournament_snapshots where id=$1", [draft.id])).rows[0].first,
  "Aquile",
);
console.log("PASS: private saves stay private and a stale device cannot overwrite a newer save.");

const published = await save(edited.id, "Prova finale", edited.updated_at, "Aquile", true);
assert.equal(published.live, true);
assert.deepEqual(await publicState(), { first: "Aquile", revision: seeded.revision + 2, live_save_id: draft.id });
console.log("PASS: putting a save on air publishes it and makes it the live one.");

const twenty = "A".repeat(20);
await assert.rejects(save(null, "Lunghi", null, twenty + "B"), /team_name_too_long/);
await assert.rejects(
  save(null, "Lunghi", null, twenty, false, JSON.stringify({ "1-0-A": twenty + "B" })),
  /team_name_too_long/,
);
await assert.rejects(
  asUser(manager, () =>
    rpc("save_tournament", [null, "Pochi", null, 8, JSON.stringify(["A", "B"]), "{}", "{}", false]),
  ),
  /invalid_tournament/,
);
await assert.rejects(save(null, " ", null, twenty), /invalid_tournament/);
await save(null, "Nomi da venti", null, twenty);
console.log("PASS: names up to 20 characters saved; longer names, wrong sizes and empty save names rejected.");

await assert.rejects(
  asUser(staff, () => rpc("save_tournament", [null, "Staff", null, 8, teams("X"), "{}", "{}", true])),
  /not_authorized/,
);
await assert.rejects(
  asUser(manager, () =>
    db.query(
      "insert into tournament_snapshots(size,teams,matches,overrides,reason,name) values (8,$1,'{}','{}','manual','x')",
      [teams("X")],
    ),
  ),
  /permission denied/,
);
await assert.rejects(
  asUser(null, () => db.query("select id from tournament_snapshots")),
  /permission denied/,
);
assert.equal(
  (await db.query("select to_regprocedure('public.publish_tournament(bigint,integer,jsonb,jsonb,jsonb)') fn")).rows[0]
    .fn,
  null,
);
console.log("PASS: only tournament managers and admins save; direct writes and the old publish RPC are gone.");
await db.close();
