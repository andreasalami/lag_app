// Stress test dei casi limite sulle modifiche dello staff: menu, scorte, scaletta, torneo e permessi.
//
// Stesso schema di orders.mjs: PostgreSQL usa-e-getta in una cartella temporanea, solo socket Unix,
// supabase/schema.sql installato con i ruoli di Supabase. Nessuna rete, nessun Supabase, dati sintetici.
// Ogni scenario si ripete LOADTEST_ROUNDS volte con tempi e interleaving casuali; LOADTEST_SEED fissa i
// piani temporali e gli UUID (quindi anche l'ordine dei lock), ma non lo scheduler del sistema operativo.
//
// Il test NON corregge niente: ogni difetto diventa un finding, con la gravità scelta tra
//   order inconsistency | ordering outage | staff blocked | lost edit | stock drift | unclear message.
// Gli invarianti controllati dopo ogni round:
//   1. totali e snapshot degli ordini non cambiano dopo l'invio, qualunque modifica al menu;
//   2. nessun ordine diventa impossibile da pagare, annullare, evadere o chiudere;
//   3. letture pubbliche e invio ordini non falliscono per una modifica staff;
//   4. nessun aggiornamento perso in silenzio (menu, scaletta, torneo);
//   5. nessun deadlock (40P01) e nessun errore diverso dagli errori di business documentati.
// La deriva di scorta resta un avviso (stock drift), non un errore sugli ordini.
//
// Modello del torneo: i periodi reali (30 s, 10 s, 2 s per dispositivo) sono divisi per
// LOADTEST_TIME_COMPRESS (10 per default). Ogni chiamata apre un processo psql: i tempi servono a
// confrontare esecuzioni, non sono la latenza reale (circa 30 ms qui, 100-300 ms con Supabase).
import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { createDb, jsonb, lit, messageOf } from "./lib.mjs";

const integerEnv = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} deve essere un intero positivo.`);
  return value;
};

const rounds = integerEnv("LOADTEST_ROUNDS", 3);
const seed = integerEnv("LOADTEST_SEED", 1);
const compress = integerEnv("LOADTEST_TIME_COMPRESS", 10);
const budgetMs = integerEnv("LOADTEST_BUDGET_SECONDS", 270) * 1000;
const suspendWindowMs = integerEnv("LOADTEST_SUSPEND_WINDOW_MS", 3000);
// Gli scenari lunghi (sospensione, torneo) usano due terzi dei round per restare sotto il budget.
const heavyRounds = Math.max(1, Math.round((rounds * 2) / 3));
const reportPath = process.env.LOADTEST_REPORT || null;
const knownScenarios = [
  "delete",
  "recovery",
  "add",
  "suspend",
  "price",
  "move",
  "menu-race",
  "schedule",
  "tournament",
  "permissions",
];
const selectedScenarios = new Set(
  (process.env.LOADTEST_SCENARIOS ?? knownScenarios.join(","))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
for (const scenario of selectedScenarios) {
  if (!knownScenarios.includes(scenario)) throw new Error(`Scenario sconosciuto: ${scenario}`);
}

const { workDir, sql, admin_sql, rpc, start, installSchema, stop } = createDb();
const runStart = performance.now();

// ---------------------------------------------------------------------------------------------
// Casualità riproducibile e utilità
// ---------------------------------------------------------------------------------------------
function mulberry32(state) {
  let a = state;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(seed);
const rand = (min, max) => min + rng() * (max - min);
const randInt = (min, max) => Math.floor(rand(min, max + 1));
const pick = (list) => list[Math.floor(rng() * list.length)];
const hex = (length) => Array.from({ length }, () => Math.floor(rng() * 16).toString(16)).join("");
// UUID v4 dal generatore con seme: schema.sql accetta versione 1-5 e variante 8-b.
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-${pick(["8", "9", "a", "b"])}${hex(3)}-${hex(12)}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const token = () => crypto.randomUUID() + crypto.randomUUID().slice(0, 8);
const cents = (value) => Math.round(Number(value) * 100);
const sum = (list, fn) => list.reduce((total, item) => total + fn(item), 0);
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const uuidArray = (ids) => `array[${ids.map(lit).join(", ")}]::uuid[]`;

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

// ---------------------------------------------------------------------------------------------
// Registro dei risultati
// ---------------------------------------------------------------------------------------------
const SEV = {
  ORDER: "order inconsistency",
  OUTAGE: "ordering outage",
  BLOCKED: "staff blocked",
  LOST: "lost edit",
  STOCK: "stock drift",
  UNCLEAR: "unclear message",
  UNEXPECTED: "unexpected error",
  DEADLOCK: "deadlock",
};
const findings = new Map();
const scenarioStats = {};
const metrics = {};
const harnessErrors = [];
const callStats = { calls: 0, deadlocks: 0 };
let currentScenario = "";
let roundHits = new Set();

function finding(name, severity, details = {}) {
  roundHits.add(name);
  const entry = findings.get(name);
  if (entry) {
    entry.events += 1;
    return;
  }
  findings.set(name, { name, severity, scenario: currentScenario, events: 1, rounds_hit: 0, details });
  console.error(`FIND  [${severity}] ${name}`, details);
}

async function runScenario(name, count, fn) {
  currentScenario = name;
  const stat = (scenarioStats[name] = { rounds_planned: count, rounds_run: 0, rounds_with_findings: 0, seconds: 0 });
  const started = performance.now();
  for (let round = 1; round <= count; round += 1) {
    if (performance.now() - runStart > budgetMs) {
      stat.skipped_for_budget = (stat.skipped_for_budget ?? 0) + 1;
      continue;
    }
    roundHits = new Set();
    try {
      await fn(round);
      await checkSnapshots(`${name} round ${round}`);
    } catch (error) {
      // Errore del test (fixture, attesa non verificata): non è un difetto dell'app.
      harnessErrors.push({ scenario: name, round, error: String(error?.stack ?? error).slice(0, 700) });
      console.error(`HARNESS ${name} round ${round}:`, error);
    }
    stat.rounds_run += 1;
    if (roundHits.size > 0) stat.rounds_with_findings += 1;
    for (const hit of roundHits) findings.get(hit).rounds_hit += 1;
  }
  stat.seconds = Math.round((performance.now() - started) / 100) / 10;
  const mine = [...findings.values()].filter((entry) => entry.scenario === name).map((entry) => entry.name);
  console.log(`${mine.length === 0 ? "PASS" : "FAIL"}  ${name}`, { ...stat, findings: mine.length });
}

/**
 * Esegue una chiamata e ne classifica l'errore: i messaggi in `allowed` sono errori di business documentati,
 * 40P01 è un deadlock, tutto il resto è un errore non documentato. `allowed = true` non segnala nulla
 * (il chiamante interpreta l'esito); il deadlock viene segnalato comunque.
 */
async function call(label, promise, allowed = []) {
  const result = await promise;
  callStats.calls += 1;
  const error = result.error;
  if (!error) return result;
  if (error.code === "40P01") {
    callStats.deadlocks += 1;
    finding(`Deadlock 40P01 in ${label}`, SEV.DEADLOCK, { message: error.message });
  } else if (allowed !== true && !allowed.some((text) => messageOf(error).includes(text))) {
    finding(`Errore non documentato in ${label}: ${messageOf(error).slice(0, 70)}`, SEV.UNEXPECTED, {
      code: error.code,
      message: error.message,
    });
  }
  return result;
}

/** Errore del test, non dell'app: interrompe il round. */
function must(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}
const outcome = (result) => (result.error ? `${result.error.code}:${result.error.message}`.slice(0, 90) : "ok");

// ---------------------------------------------------------------------------------------------
// Account, fixture e chiamate come nell'app
// ---------------------------------------------------------------------------------------------
const roles = ["admin", "staff", "cucina", "bar", "cassa", "tournament_manager", "pending"];
const account = Object.fromEntries(roles.map((role) => [role, uuid()]));
const asRole = (role) => ({ as: "authenticated", user: account[role] });
const asPublic = { as: "anon" };
const asGateway = { as: "service_role" };
let eventId = null;

async function setup() {
  await installSchema();
  const grants = roles
    .filter((role) => role !== "pending")
    .map((role) => `update public.profiles set role = ${lit(role)} where id = ${lit(account[role])};`)
    .join("\n");
  // deadlock_timeout basso: i test di lock incrociati non devono aspettare 1 s per ogni tentativo.
  await admin_sql(`insert into auth.users values ${roles.map((role) => `(${lit(account[role])})`).join(", ")};
${grants}
alter system set deadlock_timeout = '150ms';
select pg_reload_conf();`);
  eventId = await admin_sql("select id from public.order_events where is_current");
}

const KITCHEN_STATIONS = ["primi", "secondi", "contorni", "dolci", "furgone"];
const BAR_STATIONS = ["birre", "drinks", "bar"];
const station = (subcategory) => (subcategory === "vini" || subcategory === "bevande" ? "bar" : subcategory);
const roleOfStation = (name) => (BAR_STATIONS.includes(name) ? "bar" : "cucina");

function fixtureMenu() {
  const item = (key, category, subcategory, price, stock) => ({
    key,
    id: uuid(),
    category,
    subcategory,
    name: `[EDGE] ${key}`,
    price,
    stock,
  });
  return {
    beer: item("birra", "bevande", "birre", 4, 5000),
    spritz: item("spritz", "bevande", "drinks", 5, 5000),
    wine: item("vino", "bevande", "vini", 3.5, 5000),
    water: item("acqua", "bevande", "bevande", 1, null),
    panino: item("panino", "cibo", "secondi", 6, 5000),
    pasta: item("pasta", "cibo", "primi", 7, 5000),
  };
}
const L = (...pairs) => pairs.map(([item, qty = 1]) => ({ id: item.id, qty }));

const placed = new Map(); // ordine -> snapshot ricevuto all'invio, per l'invariante 1

/** Riporta l'evento e il menu a uno stato noto: nessun ordine, evento aperto, un solo evento corrente. */
async function resetAll(items = []) {
  placed.clear();
  const values = items
    .map(
      (m) =>
        `(${lit(m.id)}, ${lit(m.category)}, ${lit(m.subcategory)}, ${lit(m.name)}, ${m.price}, ${m.stock ?? "null"}, ${m.stock ?? "null"})`,
    )
    .join(", ");
  await admin_sql(`truncate public.orders cascade;
delete from public.order_events where id <> ${lit(eventId)};
update public.order_events set is_current = true, name = 'Evento corrente', opens_at = now() - interval '1 minute',
  closes_at = now() + interval '1 hour', manual_closed = false, permanently_closed_at = null, final_report = null,
  max_pending_orders = 1000, evening_count = 1 where id = ${lit(eventId)};
delete from public.menu_items;
${values ? `insert into public.menu_items (id, category, subcategory, name, price, available_portions, stock_capacity) values ${values};` : ""}`);
}

function publicOrder(
  lines,
  { requestId = crypto.randomUUID(), qrToken = token(), alias = "Edge test", expectedTotal = null } = {},
) {
  return rpc(
    "submit_public_order",
    [
      lit(alias),
      lit(""),
      jsonb(lines),
      lit(requestId),
      lit(qrToken),
      lit(""),
      "null",
      "null",
      lit("immediate"),
      expectedTotal === null ? "null" : String(expectedTotal),
    ],
    asGateway,
  );
}

async function place(lines, { allowed = ["stock_unavailable", "capacity_reached"], ...options } = {}) {
  const result = await call("submit_public_order", publicOrder(lines, options), allowed);
  if (!result.error) {
    placed.set(result.data.order_id, {
      items: result.data.items,
      total: result.data.total,
      token: result.data.qr_token,
    });
  }
  return result;
}

const claimOrder = (orderId, device, name = "cassa_1") =>
  rpc("claim_order_for_station", [lit(orderId), lit(name), lit(device)], asRole("cassa"));

async function payOrder(orderId, allowed = []) {
  const device = crypto.randomUUID();
  const claim = await call("claim_order_for_station", claimOrder(orderId, device), allowed);
  if (claim.error) return { ...claim, stage: "claim" };
  const pay = await call(
    "pay_order_for_station",
    rpc("pay_order_for_station", [lit(orderId), lit("cassa_1"), lit(device)], asRole("cassa")),
    allowed,
  );
  return { ...pay, stage: "pay" };
}

async function cancelOrder(orderId, allowed = []) {
  const device = crypto.randomUUID();
  const claim = await call("claim_order_for_station", claimOrder(orderId, device), allowed);
  if (claim.error) return { ...claim, stage: "claim" };
  const cancel = await call(
    "cancel_order_for_station",
    rpc("cancel_order_for_station", [lit(orderId), lit("cassa_1"), lit(device)], asRole("cassa")),
    allowed,
  );
  return { ...cancel, stage: "cancel" };
}

const deliver = (orderId, name, lines, role = roleOfStation(name)) =>
  rpc("deliver_fulfillment_items", [lit(orderId), lit(name), jsonb(lines)], asRole(role));

const staffMenu = (updated = [], created = [], deleted = [], role = "staff") =>
  rpc("bulk_upsert_menu_items", [jsonb(created), jsonb(updated), uuidArray(deleted)], asRole(role));

/**
 * Il client manda solo i campi cambiati; per le scorte anche il numero letto al caricamento,
 * così il database applica la differenza (Menu.tsx, handleSave).
 */
const menuRow = (base, edits = {}) => ({
  id: base.id,
  ...edits,
  ...("available_portions" in edits ? { original_available_portions: base.available_portions } : {}),
});

async function loadMenuRows(role = "staff") {
  const result = await sql(
    `select coalesce(json_agg(row_to_json(m) order by m.id), '[]') from
      (select id, category, subcategory, name, price, available_portions, stock_capacity, allergens from public.menu_items) m`,
    asRole(role),
  );
  return must(result, "caricamento menu") ?? [];
}

const ordersRows = async () =>
  (await admin_sql(`select coalesce(json_agg(json_build_object('id', id, 'status', status, 'total', total, 'items', items,
    'display_number', display_number, 'kitchen_state', kitchen_state) order by display_number), '[]') from public.orders`)) ??
  [];
const stockOf = (id) => admin_sql(`select available_portions from public.menu_items where id = ${lit(id)}`);
const fulfillmentRows = async () =>
  (await admin_sql(`select coalesce(json_agg(json_build_object('order_id', order_id, 'id', menu_item_id, 'station', station,
    'category', category, 'subcategory', subcategory, 'quantity', quantity, 'remaining', quantity - delivered_quantity)), '[]')
    from public.order_fulfillment_items`)) ?? [];

/** Invariante 1: totale e righe di un ordine non cambiano dopo l'invio; il totale è la somma delle righe. */
async function checkSnapshots(label) {
  if (placed.size === 0) return;
  const rows = await ordersRows();
  const problems = [];
  for (const row of rows) {
    const original = placed.get(row.id);
    if (!original) continue;
    if (!same(original.items, row.items)) problems.push({ order: row.id, what: "items cambiati" });
    if (cents(original.total) !== cents(row.total)) problems.push({ order: row.id, what: "totale cambiato" });
    const lines = sum(row.items, (line) => cents(line.price) * line.qty);
    if (lines !== cents(row.total)) problems.push({ order: row.id, what: "totale diverso dalla somma delle righe" });
  }
  if (problems.length > 0)
    finding("Totale o snapshot di un ordine cambiato dopo l'invio", SEV.ORDER, {
      label,
      problems: problems.slice(0, 5),
    });
}

/** Invariante 3: le letture pubbliche non devono fallire per una modifica dello staff. */
async function publicReads(label) {
  const [status, catalog] = await Promise.all([
    call("get_ordering_status", rpc("get_ordering_status", [], asPublic), true),
    call("get_ordering_catalog", rpc("get_ordering_catalog", [], asPublic), true),
  ]);
  if (status.error || catalog.error)
    finding("Lettura pubblica fallita durante una modifica staff", SEV.OUTAGE, {
      label,
      status: outcome(status),
      catalog: outcome(catalog),
    });
  return { status, catalog };
}

// ---------------------------------------------------------------------------------------------
// Chiusura evento, report finale e "assestamento" di tutti gli ordini (invarianti 1 e 2)
// ---------------------------------------------------------------------------------------------
const PAID = new Set(["pagato", "ritiro_parziale", "consegnato"]);

function expectedReport(rows) {
  const paid = rows.filter((row) => PAID.has(row.status));
  const byId = new Map();
  const byName = new Map();
  for (const row of paid) {
    for (const line of row.items) {
      byId.set(line.id, (byId.get(line.id) ?? 0) + line.qty);
      byName.set(line.name, (byName.get(line.name) ?? 0) + line.qty);
    }
  }
  return {
    total: rows.length,
    paid: paid.length,
    cancelled: rows.filter((row) => row.status === "annullato").length,
    abandoned: rows.filter((row) => row.status === "in_attesa_pagamento").length,
    revenue: sum(paid, (row) => cents(row.total)),
    byId,
    byName,
  };
}

async function closeAndCheck(label) {
  const rows = await ordersRows();
  const close = await call("close_order_event", rpc("close_order_event", [], asRole("cassa")), true);
  if (close.error) {
    finding("close_order_event fallisce", SEV.BLOCKED, { label, error: close.error });
    return null;
  }
  const want = expectedReport(rows);
  const summary = close.data.summary ?? {};
  const problems = [];
  const check = (what, got, expected) => {
    if (got !== expected) problems.push({ what, got, expected });
  };
  check("orders_total", Number(summary.orders_total), want.total);
  check("orders_paid", Number(summary.orders_paid), want.paid);
  check("orders_cancelled", Number(summary.orders_cancelled), want.cancelled);
  check("orders_abandoned", Number(summary.orders_abandoned), want.abandoned);
  check("revenue_total", cents(summary.revenue_total), want.revenue);
  // Un prodotto spostato di categoria compare in più righe del report (id, nome, categoria): si sommano.
  const products = new Map();
  for (const product of close.data.products ?? [])
    products.set(product.id, (products.get(product.id) ?? 0) + Number(product.quantity));
  for (const [id, qty] of want.byId) check(`prodotto ${id.slice(0, 8)}`, products.get(id) ?? 0, qty);

  const report = await call("get_order_event_report", rpc("get_order_event_report", [], asRole("cassa")), true);
  if (report.error || !same(report.data?.summary, close.data.summary) || report.data?.orders?.length !== want.total)
    problems.push({ what: "get_order_event_report diverso dal report di chiusura", got: outcome(report) });

  const snapshot = await call("get_order_event_snapshot", rpc("get_order_event_snapshot", [], asRole("cassa")), true);
  if (snapshot.error) problems.push({ what: "get_order_event_snapshot", got: outcome(snapshot) });
  else {
    check("snapshot revenue_total", cents(snapshot.data.revenue_total), want.revenue);
    check("snapshot orders_paid", Number(snapshot.data.orders_paid), want.paid);
    const byName = new Map();
    for (const product of snapshot.data.products ?? [])
      byName.set(product.name, (byName.get(product.name) ?? 0) + Number(product.quantity));
    for (const [name, qty] of want.byName) check(`snapshot ${name}`, byName.get(name) ?? 0, qty);
  }
  if (problems.length > 0) finding("Report finale incoerente con gli ordini", SEV.ORDER, { label, problems });
  return close.data;
}

/** Paga o annulla gli ordini aperti, evade quelli pagati, poi chiude: nessuno deve restare bloccato. */
async function settleAndClose(label, { leaveUnpaid = 1 } = {}) {
  const rows = await ordersRows();
  const unpaid = rows.filter((row) => row.status === "in_attesa_pagamento");
  const stuck = [];
  await Promise.all(
    unpaid.slice(leaveUnpaid).map(async (row, index) => {
      const result = index % 2 === 0 ? await payOrder(row.id, true) : await cancelOrder(row.id, true);
      if (result.error) stuck.push({ order: row.id, stage: result.stage, error: outcome(result) });
    }),
  );
  const groups = new Map();
  for (const row of await fulfillmentRows()) {
    if (row.remaining <= 0) continue;
    const key = `${row.order_id}|${row.station}`;
    groups.set(key, [...(groups.get(key) ?? []), { id: row.id, qty: row.remaining }]);
  }
  await Promise.all(
    [...groups].map(async ([key, lines]) => {
      const [orderId, name] = key.split("|");
      const result = await call("deliver_fulfillment_items", deliver(orderId, name, lines), true);
      if (result.error) stuck.push({ order: orderId, stage: `deliver ${name}`, error: outcome(result) });
    }),
  );
  if (stuck.length > 0)
    finding("Ordine impossibile da pagare, annullare o evadere", SEV.BLOCKED, { label, stuck: stuck.slice(0, 5) });
  return closeAndCheck(label);
}

// ---------------------------------------------------------------------------------------------
// Scenario 1: prodotto eliminato mentre compare in ordini di ogni stato
// ---------------------------------------------------------------------------------------------
async function probeOutage(cheap, tokenForStatuses) {
  const run = async (label, promise) => [label, outcome(await promise)];
  const entries = await Promise.all([
    run("get_ordering_status", rpc("get_ordering_status", [], asPublic)),
    run("get_ordering_catalog", rpc("get_ordering_catalog", [], asPublic)),
    run("submit_public_order", publicOrder(L([cheap]))),
    run(
      "get_public_order_statuses",
      rpc("get_public_order_statuses", [`array[${lit(tokenForStatuses)}]::text[]`], asPublic),
    ),
    run("get_cashier_pending_orders", rpc("get_cashier_pending_orders", [], asRole("cassa"))),
    run(
      "create_counter_order",
      rpc("create_counter_order", [lit("Cassa prova"), lit(""), jsonb(L([cheap])), lit("immediate")], asRole("cassa")),
    ),
    run("get_fulfillment_queue", rpc("get_fulfillment_queue", [lit("birre")], asRole("bar"))),
  ]);
  return Object.fromEntries(entries);
}
const brokenOf = (probe) =>
  Object.entries(probe)
    .filter(([, value]) => value !== "ok")
    .map(([name]) => name);
const agePending = (ids, minutes = 61) =>
  admin_sql(
    `update public.orders set created_at = now() - interval '${minutes} minutes' where id = any(${uuidArray(ids)})`,
  );

/** Legge le regole di submitFailure dal sorgente del client (sola lettura) e prova se una riconosce il codice. */
function clientRecognises(code) {
  try {
    const source = readFileSync(new URL("../../src/features/orders/orderUtils.ts", import.meta.url), "utf8");
    const rules = [...source.matchAll(/match:\s*\/(.+?)\/,/g)].map((found) => new RegExp(found[1]));
    return rules.length === 0 ? true : rules.some((rule) => rule.test(code));
  } catch {
    return true; // sorgente non leggibile: nessun finding
  }
}

async function scenarioDelete(round) {
  const fx = fixtureMenu();
  const { spritz: X, panino: Y, beer: Z } = fx;
  await resetAll(Object.values(fx));
  const mk = async (lines) => must(await place(lines, { allowed: [] }), "ordine di partenza");
  const [unpaidCancel, unpaidPay, unpaidRace, paid, part1, part2, done] = await Promise.all([
    mk(L([X], [Z])),
    mk(L([X], [Y])),
    mk(L([X, 2])),
    mk(L([X], [Y])),
    mk(L([X], [Y])),
    mk(L([X], [Y])),
    mk(L([X], [Y])),
  ]);
  for (const order of await Promise.all([paid, part1, part2, done].map((o) => payOrder(o.order_id))))
    must(order, "pagamento di partenza");
  // part1: panino consegnato, spritz da consegnare. part2: spritz consegnato, panino da consegnare. done: tutto.
  must(await deliver(part1.order_id, "secondi", L([Y])), "consegna parziale 1");
  must(await deliver(part2.order_id, "drinks", L([X])), "consegna parziale 2");
  must(await deliver(done.order_id, "drinks", L([X])), "consegna 1 completa");
  must(await deliver(done.order_id, "secondi", L([Y])), "consegna 2 completa");

  // Fase concorrente: l'eliminazione contro pagamento, nuovi ordini sullo stesso prodotto, altri ordini e letture.
  const raced = [];
  const customersRejected = [];
  const plan = {
    del: rand(0, 50),
    pay: rand(0, 50),
    raced: Array.from({ length: 5 }, () => rand(0, 70)),
    others: Array.from({ length: 4 }, () => rand(0, 70)),
    reads: Array.from({ length: 6 }, () => rand(0, 90)),
  };
  const phase = await Promise.all([
    sleep(plan.del).then(() => call("bulk_upsert_menu_items", staffMenu([], [], [X.id]))),
    sleep(plan.pay).then(() => payOrder(unpaidRace.order_id)),
    ...plan.raced.map((ms) =>
      sleep(ms).then(async () => {
        const result = await place(L([X]), { allowed: ["stock_unavailable", "unknown_menu_item"] });
        if (result.error) customersRejected.push(outcome(result));
        else raced.push(result.data);
      }),
    ),
    ...plan.others.map((ms) => sleep(ms).then(() => place(L([Z], [Y])))),
    ...plan.reads.map((ms) => sleep(ms).then(() => publicReads("delete: lettura concorrente"))),
  ]);
  const deletion = phase[0];
  const gone = Number(await admin_sql(`select count(*) from public.menu_items where id = ${lit(X.id)}`)) === 0;
  if (deletion.error || !gone) throw new Error(`eliminazione non riuscita: ${outcome(deletion)}`);

  // Matrice per stato: cosa succede dopo l'eliminazione.
  const matrix = { unpaid: {}, paid: {}, partial_x_pending: {}, partial_y_pending: {}, delivered: {} };
  const cancel = await cancelOrder(unpaidCancel.order_id, ["unknown_menu_item", "claim_lost"]);
  matrix.unpaid.cancel = outcome(cancel);
  matrix.unpaid.pay = outcome(await payOrder(unpaidPay.order_id));
  matrix.unpaid.pay_racing_the_delete = outcome(phase[1]);
  const fulfillStates = async (order, name, lines, bucket) => {
    const result = await call("deliver_fulfillment_items", deliver(order.order_id, name, lines), true);
    matrix[bucket][`deliver_${name}`] = outcome(result);
    return result;
  };
  const queue = await rpc("get_fulfillment_queue", [lit("drinks")], asRole("bar"));
  matrix.paid.queue_lists_order = (queue.data ?? []).some((entry) => entry.id === paid.order_id);
  await fulfillStates(paid, "drinks", L([X]), "paid");
  await fulfillStates(paid, "secondi", L([Y]), "paid");
  await fulfillStates(part1, "drinks", L([X]), "partial_x_pending");
  await fulfillStates(part2, "secondi", L([Y]), "partial_y_pending");
  const delivery = await admin_sql(
    `select id from public.fulfillment_deliveries where order_id = ${lit(done.order_id)} and station = 'drinks'`,
  );
  const undo = await call(
    "undo_fulfillment_delivery",
    rpc("undo_fulfillment_delivery", [lit(delivery), lit("drinks")], asRole("bar")),
    true,
  );
  matrix.delivered.undo_x_delivery = outcome(undo);
  if (!undo.error)
    matrix.delivered.redeliver_x = outcome(
      await call("deliver_fulfillment_items", deliver(done.order_id, "drinks", L([X])), true),
    );
  const finalStates = await ordersRows();
  const statusOf = (order) => finalStates.find((row) => row.id === order.order_id)?.status;
  matrix.paid.final_status = statusOf(paid);
  matrix.partial_x_pending.final_status = statusOf(part1);
  matrix.partial_y_pending.final_status = statusOf(part2);
  matrix.delivered.final_status = statusOf(done);
  const notDelivered = [paid, part1, part2, done].filter((order) => statusOf(order) !== "consegnato");
  if (notDelivered.length > 0 || Object.values(matrix.paid).some((v) => String(v).includes(":")))
    finding("Ordine pagato con un prodotto eliminato non evadibile", SEV.BLOCKED, { matrix });

  // Scadenza dei 60 minuti: l'ordine non pagato (e quelli nati durante la gara) con il prodotto eliminato.
  const blocking = [unpaidCancel.order_id, ...raced.map((order) => order.order_id)];
  // Il claim dura 30 s e protegge l'ordine dalla scadenza: si simula il tempo che passa prima dei 60 minuti.
  await admin_sql("delete from public.order_claim_devices");
  await agePending(blocking);
  const probe = await probeOutage(Z, placed.get(paid.order_id).token);
  matrix.unpaid.expiry_probe = probe;
  const claimAfter = await call(
    "claim_order_for_station",
    claimOrder(unpaidCancel.order_id, crypto.randomUUID()),
    true,
  );
  matrix.unpaid.claim_after_expiry = outcome(claimAfter);

  const cancelFailed = cancel.error?.message?.includes("unknown_menu_item") ?? false;
  const outage = brokenOf(probe);
  if (cancelFailed)
    finding(
      "cancel_order_for_station fallisce con unknown_menu_item se l'ordine contiene un prodotto eliminato",
      SEV.BLOCKED,
      {
        function: "apply_order_stock (schema.sql riga 613) chiamata da cancel_order_for_station (riga 1419)",
        cancel: matrix.unpaid.cancel,
      },
    );
  if (outage.includes("get_ordering_status"))
    finding(
      "Prodotto eliminato con un ordine non pagato: alla scadenza dei 60 minuti le letture pubbliche e l'invio falliscono per tutti",
      SEV.OUTAGE,
      {
        function: "expire_unpaid_orders (riga 667) -> apply_order_stock (riga 613)",
        broken: outage,
        claim_after_expiry: matrix.unpaid.claim_after_expiry,
      },
    );
  if (customersRejected.some((text) => text.includes("unknown_menu_item")) && !clientRecognises("unknown_menu_item"))
    finding(
      "Cliente con un prodotto eliminato nel carrello: unknown_menu_item non è riconosciuto dal client",
      SEV.UNCLEAR,
      {
        server:
          "normalize_order_items (riga 1274) risponde unknown_menu_item; il gateway lo inoltra (publicGateway.ts riga 97)",
        client:
          "orderUtils.ts SUBMIT_FAILURES non ha una regola: messaggio 'Non riesco a verificare l'esito, premi Recupera ordine', esito incerto, nessun ricaricamento del catalogo",
      },
    );
  const closed = await closeAndCheck("delete: dopo scadenza bloccata");
  matrix.close = closed ? "ok" : "fallita";
  metrics.delete ??= {
    rounds: 0,
    cancel_failed: 0,
    outage: 0,
    raced_orders_created: 0,
    customers_rejected_unknown_item: 0,
    last_matrix: null,
  };
  metrics.delete.rounds += 1;
  metrics.delete.cancel_failed += cancelFailed ? 1 : 0;
  metrics.delete.outage += outage.length > 0 ? 1 : 0;
  metrics.delete.raced_orders_created += raced.length;
  metrics.delete.customers_rejected_unknown_item += customersRejected.filter((text) =>
    text.includes("unknown_menu_item"),
  ).length;
  metrics.delete.last_matrix = { round, ...matrix };
}

// ---------------------------------------------------------------------------------------------
// Scenario 2: recupero dall'interruzione
// ---------------------------------------------------------------------------------------------
async function buildOutage({ age = true } = {}) {
  const fx = fixtureMenu();
  const { spritz: X, beer: Z } = fx;
  await resetAll(Object.values(fx));
  const blocking = must(await place(L([X], [Z]), { allowed: [] }), "ordine bloccante");
  const fresh = must(await place(L([Z]), { allowed: [] }), "ordine fresco");
  const waiting = must(await place(L([Z], [X]), { allowed: [] }), "ordine pagato in attesa");
  must(await payOrder(waiting.order_id), "pagamento ordine in attesa");
  must(await call("bulk_upsert_menu_items", staffMenu([], [], [X.id])), "eliminazione prodotto");
  if (age) await agePending([blocking.order_id, fresh.order_id]);
  return { fx, X, Z, blocking, fresh, waiting, token: placed.get(waiting.order_id).token };
}
const restored = (probe) => brokenOf(probe).length === 0;

async function scenarioRecovery(round) {
  const out = {};
  // A. Pagare l'ordine bloccante prima della scadenza: l'interruzione non nasce.
  {
    const o = await buildOutage({ age: false });
    const pay = await payOrder(o.blocking.order_id);
    await agePending([o.fresh.order_id]);
    const probe = await probeOutage(o.Z, o.token);
    out.pay_before_expiry = { pay: outcome(pay), restored: restored(probe), broken: brokenOf(probe) };
  }
  // B. Pagare dopo la scadenza.
  {
    const o = await buildOutage();
    const before = await probeOutage(o.Z, o.token);
    const pay = await payOrder(o.blocking.order_id, true);
    const after = await probeOutage(o.Z, o.token);
    out.pay_after_expiry = {
      outage_before: brokenOf(before),
      pay: outcome(pay),
      stage: pay.stage,
      restored: restored(after),
      broken: brokenOf(after),
    };
  }
  // C. Annullare prima e dopo la scadenza.
  {
    const o = await buildOutage({ age: false });
    const early = await cancelOrder(o.blocking.order_id, true);
    await admin_sql("delete from public.order_claim_devices"); // il claim di 30 s è scaduto
    await agePending([o.blocking.order_id, o.fresh.order_id]);
    const late = await cancelOrder(o.blocking.order_id, true);
    const after = await probeOutage(o.Z, o.token);
    out.cancel = {
      before_expiry: outcome(early),
      after_expiry: outcome(late),
      restored: restored(after),
      broken: brokenOf(after),
    };
  }
  // D. Riaggiungere lo stesso prodotto con l'app (bulk_upsert_menu_items ignora l'id) e con un insert diretto.
  {
    const o = await buildOutage();
    const readd = await call(
      "bulk_upsert_menu_items",
      staffMenu(
        [],
        [
          {
            id: o.X.id,
            category: o.X.category,
            subcategory: o.X.subcategory,
            name: o.X.name,
            price: o.X.price,
            available_portions: 1000,
            allergens: [],
          },
        ],
      ),
      true,
    );
    const newId = await admin_sql(`select id from public.menu_items where name = ${lit(o.X.name)}`);
    const after = await probeOutage(o.Z, o.token);
    out.readd_same_name_with_app = {
      save: outcome(readd),
      keeps_original_id: newId === o.X.id,
      restored: restored(after),
      broken: brokenOf(after),
    };
  }
  {
    const o = await buildOutage();
    const insert = await sql(
      `insert into public.menu_items (id, category, subcategory, name, price, available_portions, stock_capacity)
       values (${lit(o.X.id)}, ${lit(o.X.category)}, ${lit(o.X.subcategory)}, ${lit(o.X.name)}, ${o.X.price}, 1000, 1000)`,
      asRole("staff"),
    );
    const after = await probeOutage(o.Z, o.token);
    const status = await admin_sql(`select status from public.orders where id = ${lit(o.blocking.order_id)}`);
    out.readd_same_id_direct_insert_outside_app = {
      insert: outcome(insert),
      restored: restored(after),
      broken: brokenOf(after),
      blocking_order_status_after: status,
      stock_after_restore: await stockOf(o.X.id),
    };
  }
  // E. Altre azioni dell'app che non toccano il prodotto: pausa, orari, rilascio claim.
  {
    const o = await buildOutage();
    const pause = await call("set_ordering_paused", rpc("set_ordering_paused", ["true"], asRole("cassa")), true);
    const afterPause = await probeOutage(o.Z, o.token);
    const extend = await call(
      "update_order_event",
      rpc(
        "update_order_event",
        [lit("Evento corrente"), "now() - interval '2 hours'", "now() + interval '1 day'", "500", "1"],
        asRole("cassa"),
      ),
      true,
    );
    const afterExtend = await probeOutage(o.Z, o.token);
    const release = await call(
      "force_release_order",
      rpc("force_release_order", [lit(o.blocking.order_id)], asRole("cassa")),
      true,
    );
    const afterRelease = await probeOutage(o.Z, o.token);
    out.pause_extend_release = {
      pause: outcome(pause),
      restored_by_pause: restored(afterPause),
      extend: outcome(extend),
      restored_by_extend: restored(afterExtend),
      release: outcome(release),
      restored_by_release: restored(afterRelease),
    };
  }
  // F. Chiudere e riaprire: l'unica azione dell'app che sblocca. Effetti collaterali misurati.
  {
    const o = await buildOutage();
    const closed = await call("close_order_event", rpc("close_order_event", [], asRole("cassa")), true);
    const statusClosed = await call("get_ordering_status", rpc("get_ordering_status", [], asPublic), true);
    const reopenSame = await call("set_ordering_paused", rpc("set_ordering_paused", ["false"], asRole("cassa")), true);
    const next = await call(
      "create_next_order_event",
      rpc(
        "create_next_order_event",
        [lit("Evento prova 2"), "now() - interval '1 minute'", "now() + interval '1 hour'", "100", "1"],
        asRole("cassa"),
      ),
      true,
    );
    // create_next_order_event crea l'evento in pausa (manual_closed = true): serve anche set_ordering_paused(false).
    const unpause = await call("set_ordering_paused", rpc("set_ordering_paused", ["false"], asRole("cassa")), true);
    const after = await probeOutage(o.Z, o.token);
    const newOrder = await call("submit_public_order", publicOrder(L([o.Z])), true);
    const waitingRow = (await ordersRows()).find((row) => row.id === o.waiting.order_id);
    const fulfil = (await fulfillmentRows()).filter((row) => row.order_id === o.waiting.order_id && row.remaining > 0);
    const tryDeliver = await call("deliver_fulfillment_items", deliver(o.waiting.order_id, "birre", L([o.Z])), true);
    const byQr = await call(
      "get_fulfillment_order_by_qr",
      rpc("get_fulfillment_order_by_qr", [lit(o.token), lit("birre")], asRole("bar")),
      true,
    );
    const oldReport = await call("get_order_event_report", rpc("get_order_event_report", [], asRole("cassa")), true);
    const oldRowKept = await admin_sql(
      "select count(*) from public.order_events where not is_current and final_report is not null",
    );
    out.close_and_reopen = {
      close: outcome(closed),
      status_while_closed: statusClosed.data?.reason ?? outcome(statusClosed),
      reopen_same_event_with_pause_false: outcome(reopenSame),
      create_next_order_event: outcome(next),
      unpause_new_event: outcome(unpause),
      restored: restored(after),
      broken: brokenOf(after),
      new_order: outcome(newOrder),
      paid_waiting_order_status_after_close: waitingRow?.status,
      paid_waiting_items_still_to_hand_over: fulfil.length,
      deliver_to_that_customer: outcome(tryDeliver),
      scan_that_customer_qr: outcome(byQr),
      get_order_event_report_after_new_event: oldReport.error
        ? outcome(oldReport)
        : oldReport.data === null
          ? "null (il report dell'evento chiuso non è più raggiungibile)"
          : "report presente",
      closed_event_final_report_rows_in_table: Number(oldRowKept),
    };
  }

  // Finding derivati: l'interruzione non ha riparazione fuori da chiusura e riapertura.
  const stuckAfterExpiry = [
    out.pay_after_expiry,
    out.cancel,
    out.readd_same_name_with_app,
    out.pause_extend_release,
  ].every(
    (entry) =>
      entry.restored === false ||
      (entry.restored_by_pause === false && entry.restored_by_extend === false && entry.restored_by_release === false),
  );
  if (out.pay_after_expiry.outage_before.length > 0 && stuckAfterExpiry)
    finding(
      "Dopo la scadenza l'ordine bloccante non si può più né pagare né annullare e nessuna funzione dell'app ripristina l'ordinazione",
      SEV.OUTAGE,
      {
        pay_after_expiry: out.pay_after_expiry,
        cancel: out.cancel,
        readd_with_app: out.readd_same_name_with_app,
        pause_extend_release: out.pause_extend_release,
        functions:
          "claim_order_for_station (riga 1990: reservation_expired), cancel_order_for_station (riga 1419), bulk_upsert_menu_items (riga 366: l'insert ignora l'id)",
      },
    );
  // Chiudere l'evento consegna d'ufficio gli ordini pagati: è un difetto solo se chiudere è
  // l'unico modo per sbloccare un'interruzione, cioè se l'interruzione esiste ancora.
  if (
    out.pay_after_expiry.outage_before.length > 0 &&
    out.close_and_reopen.paid_waiting_items_still_to_hand_over > 0 &&
    out.close_and_reopen.paid_waiting_order_status_after_close === "consegnato"
  )
    finding(
      "Chiudere e riaprire per sbloccare segna come consegnati gli ordini pagati ma non ritirati, che non si possono più evadere",
      SEV.ORDER,
      {
        close_and_reopen: out.close_and_reopen,
        function: "close_order_event (righe 1545-1556)",
      },
    );
  metrics.recovery ??= { rounds: 0, last: null };
  metrics.recovery.rounds += 1;
  metrics.recovery.last = { round, ...out };
}

// ---------------------------------------------------------------------------------------------
// Scenario 3: prodotto aggiunto a evento in corso mentre gli ordini scorrono
// ---------------------------------------------------------------------------------------------
async function scenarioAdd() {
  const fx = fixtureMenu();
  await resetAll(Object.values(fx));
  const subs = { bevande: ["birre", "vini", "drinks", "bevande"], cibo: KITCHEN_STATIONS };
  const category = pick(["bevande", "cibo"]);
  const subcategory = pick(subs[category]);
  const stock = pick([null, randInt(3, 12)]);
  const price = pick([0.5, 2.5, 9.99, 12]);
  const allergens = pick([[], [1, 7], [14]]);
  const name = `[EDGE] nuovo ${hex(4)}`;

  const saveAfter = rand(30, 150);
  const [saved] = await Promise.all([
    sleep(saveAfter).then(async () => {
      const result = await call(
        "bulk_upsert_menu_items",
        staffMenu([], [{ category, subcategory, name, price, available_portions: stock, allergens }]),
      );
      const catalog = await rpc("get_ordering_catalog", [], asPublic); // subito dopo il salvataggio
      return { result, catalog };
    }),
    ...Array.from({ length: 12 }, () => sleep(rand(0, 250)).then(() => place(L([fx.beer], [fx.panino])))),
    ...Array.from({ length: 10 }, () => sleep(rand(0, 250)).then(() => publicReads("add: lettura concorrente"))),
  ]);
  const item = saved.catalog.data?.items?.find((entry) => entry.name === name);
  const expectedCatalog = { category, subcategory, price, available_portions: stock, stock_capacity: stock, allergens };
  if (
    !item ||
    !same(
      {
        category: item.category,
        subcategory: item.subcategory,
        price: Number(item.price),
        available_portions: item.available_portions,
        stock_capacity: item.stock_capacity,
        allergens: item.allergens,
      },
      expectedCatalog,
    )
  ) {
    finding("Prodotto aggiunto non visibile o diverso nel catalogo subito dopo il salvataggio", SEV.LOST, {
      expected: expectedCatalog,
      got: item ?? null,
      catalog_error: outcome(saved.catalog),
    });
    return;
  }

  // Clienti che ordinano il nuovo prodotto: mai più della scorta.
  const want = stock === null ? 10 : stock + 4;
  const buyers = await Promise.all(
    Array.from({ length: want }, () =>
      sleep(rand(0, 80)).then(() => place([{ id: item.id, qty: pick([1, 1, 2]) }], { allowed: ["stock_unavailable"] })),
    ),
  );
  const orders = buyers
    .filter((result) => !result.error)
    .map((result) => ({ id: result.data.order_id, qty: result.data.items[0].qty }));
  const soldQty = sum(orders, (order) => order.qty);
  if (stock !== null && soldQty > stock)
    finding("Venduto più della scorta del prodotto appena aggiunto", SEV.ORDER, { stock, soldQty });

  // Metà pagati, metà annullati: la scorta finale deve riflettere solo i pagati.
  const toPay = orders.filter((_, index) => index % 2 === 0);
  const toCancel = orders.filter((_, index) => index % 2 === 1);
  await Promise.all([...toPay.map((order) => payOrder(order.id)), ...toCancel.map((order) => cancelOrder(order.id))]);
  const paidQty = sum(toPay, (order) => order.qty);
  const stockNow = await stockOf(item.id);
  const capacityNow = await admin_sql(`select stock_capacity from public.menu_items where id = ${lit(item.id)}`);
  const expectedStock = stock === null ? null : stock - paidQty;
  if (stockNow !== expectedStock || (stock !== null && capacityNow < stockNow))
    finding("Scorta del prodotto aggiunto non coerente dopo pagamenti e annullamenti", SEV.STOCK, {
      stock,
      paidQty,
      stockNow,
      capacityNow,
      expectedStock,
    });

  // Instradamento: postazione attesa, presenza nella sola coda giusta, consegna con il ruolo giusto.
  const expectedStation = station(subcategory);
  const rows = (await fulfillmentRows()).filter((row) => row.id === item.id);
  const misrouted = rows.filter((row) => row.station !== expectedStation || row.category !== category);
  if (misrouted.length > 0)
    finding("Prodotto aggiunto instradato alla postazione sbagliata", SEV.ORDER, {
      expectedStation,
      misrouted: misrouted.slice(0, 3),
    });
  const queues = await Promise.all(
    [...KITCHEN_STATIONS, ...BAR_STATIONS].map(async (name) => {
      const result = await call(
        "get_fulfillment_queue",
        rpc("get_fulfillment_queue", [lit(name)], asRole(roleOfStation(name))),
        true,
      );
      const ids = (result.data ?? []).map((entry) => entry.id);
      return [name, toPay.filter((order) => ids.includes(order.id)).length];
    }),
  );
  const wrongQueues = queues.filter(([name, count]) => count !== (name === expectedStation ? toPay.length : 0));
  if (wrongQueues.length > 0)
    finding("Ordine del prodotto aggiunto nella coda sbagliata", SEV.ORDER, {
      expectedStation,
      queues: Object.fromEntries(queues),
    });
  const wrongStation = [...KITCHEN_STATIONS, ...BAR_STATIONS].find(
    (name) => name !== expectedStation && roleOfStation(name) === roleOfStation(expectedStation),
  );
  if (toPay.length > 0) {
    const wrong = await call(
      "deliver_fulfillment_items",
      deliver(toPay[0].id, wrongStation, [{ id: item.id, qty: toPay[0].qty }]),
      true,
    );
    if (!wrong.error)
      finding("Consegna accettata alla postazione sbagliata", SEV.ORDER, { expectedStation, wrongStation });
    const results = await Promise.all(
      toPay.map((order) =>
        call("deliver_fulfillment_items", deliver(order.id, expectedStation, [{ id: item.id, qty: order.qty }]), true),
      ),
    );
    const failed = results.filter((result) => result.error);
    if (failed.length > 0)
      finding("Prodotto aggiunto non evadibile alla postazione prevista", SEV.BLOCKED, {
        expectedStation,
        failed: failed.map(outcome).slice(0, 3),
      });
  }
  await settleAndClose("add");
  metrics.add ??= { rounds: 0, unlimited: 0, limited: 0 };
  metrics.add.rounds += 1;
  metrics.add[stock === null ? "unlimited" : "limited"] += 1;
}

// ---------------------------------------------------------------------------------------------
// Scenario 4: sospendere un prodotto che si vende a 1, 5, 20 ordini al secondo
// ---------------------------------------------------------------------------------------------
function startSales(item, ratePerSecond) {
  const sales = [];
  let stopped = false;
  const inFlight = new Set();
  const loop = (async () => {
    let next = performance.now();
    while (!stopped) {
      next += (-Math.log(1 - rng()) / ratePerSecond) * 1000; // arrivi di Poisson
      await sleep(next - performance.now());
      if (stopped) break;
      const startedAt = performance.now();
      const promise = place(L([item]), { allowed: ["stock_unavailable"] }).then((result) =>
        sales.push({ startedAt, ok: !result.error, error: result.error ? outcome(result) : null }),
      );
      inFlight.add(promise);
      promise.finally(() => inFlight.delete(promise));
    }
    await Promise.all(inFlight);
  })();
  return {
    sales,
    stop: async () => {
      stopped = true;
      await loop;
    },
  };
}

const suspendCells = [
  { rate: 1, think: 150 },
  { rate: 1, think: 1000 },
  { rate: 5, think: 150 },
  { rate: 5, think: 1000 },
  { rate: 20, think: 150 },
  { rate: 20, think: 1000 },
];

async function suspendTrial({ rate, think }, windowMs) {
  const F = {
    key: "veloce",
    id: uuid(),
    category: "bevande",
    subcategory: "drinks",
    name: "[EDGE] veloce",
    price: 4,
    stock: 100000,
  };
  await resetAll([F]);
  const sales = startSales(F, rate);
  await sleep(300); // gli ordini scorrono prima che lo staff decida di sospendere
  const began = performance.now();
  const salesBefore = sales.sales.length;
  const saveMs = [];
  let attempts = 0;
  let rejected = 0;
  let suspendedAt = null;
  while (performance.now() - began < windowMs) {
    attempts += 1;
    // Lo staff apre il prodotto, "pensa" e tocca Sospendi: un interruttore separato dalla scorta,
    // scritto subito sul database (SuspendButton.tsx, setSuspended).
    await sleep(think * rand(0.8, 1.2));
    const save = await call(
      "sospensione (interruttore)",
      sql(`update public.menu_items set suspended = true where id = ${lit(F.id)} returning id`, asRole("staff")),
    );
    saveMs.push(save.ms);
    if (!save.error) {
      suspendedAt = performance.now();
      break;
    }
    rejected += 1;
  }
  const soldWhileTrying = sales.sales.length - salesBefore;
  await sleep(suspendedAt ? 700 : 0); // il prodotto deve restare fermo anche dopo
  await sales.stop();
  const soldAfter = suspendedAt === null ? [] : sales.sales.filter((sale) => sale.startedAt >= suspendedAt && sale.ok);
  const result = {
    attempts,
    rejected,
    suspended: suspendedAt !== null,
    time_to_suspend_ms: suspendedAt === null ? null : Math.round(suspendedAt - began),
    sold_while_trying: soldWhileTrying,
    save_ms: saveMs,
    sold_after_suspend: soldAfter.length,
    still_sold_after_cancel: null,
    stock_after_expiry: null,
  };
  if (soldAfter.length > 0)
    finding("Prodotto sospeso venduto di nuovo dopo la sospensione", SEV.ORDER, {
      sold_after: soldAfter.length,
      rate,
      think,
    });

  if (suspendedAt !== null) {
    // Durata della sospensione: un annullamento o la scadenza di un ordine non pagato restituisce le porzioni.
    const unpaid =
      (await admin_sql(
        `select coalesce(json_agg(id order by display_number), '[]') from public.orders where status = 'in_attesa_pagamento'`,
      )) ?? [];
    if (unpaid.length > 0) {
      await cancelOrder(unpaid[0]);
      const stockAfterCancel = await stockOf(F.id);
      const again = await place(L([F]), { allowed: ["stock_unavailable"] });
      result.stock_after_cancel = stockAfterCancel;
      result.still_sold_after_cancel = !again.error;
      if (!again.error)
        finding("La sospensione si annulla da sola quando un ordine non pagato viene annullato o scade", SEV.STOCK, {
          unpaid_orders_when_suspended: unpaid.length,
          stock_after_cancel: stockAfterCancel,
          function: "apply_order_stock restituisce le porzioni: la sospensione deve restare",
        });
      await agePending(unpaid.slice(1));
      await rpc("get_ordering_status", [], asPublic);
      result.stock_after_expiry = await stockOf(F.id);
    }
  }
  return result;
}

async function scenarioSuspend(round) {
  metrics.suspend ??= {};
  for (const cell of suspendCells) {
    if (performance.now() - runStart > budgetMs) return;
    const key = `rate${cell.rate}_think${cell.think}`;
    const windowMs = cell.rate === 20 && cell.think >= 1000 ? Math.min(suspendWindowMs, 2000) : suspendWindowMs;
    const trial = await suspendTrial(cell, windowMs);
    const entry = (metrics.suspend[key] ??= {
      orders_per_second: cell.rate,
      think_ms: cell.think,
      trials: 0,
      attempts: 0,
      rejected: 0,
      suspended_trials: 0,
      times_ms: [],
      sold_while_trying: [],
      save_ms: [],
      sold_after_suspend: 0,
      suspension_undone_by_cancel: 0,
      suspensions_checked: 0,
    });
    entry.trials += 1;
    entry.attempts += trial.attempts;
    entry.rejected += trial.rejected;
    entry.suspended_trials += trial.suspended ? 1 : 0;
    if (trial.time_to_suspend_ms !== null) entry.times_ms.push(trial.time_to_suspend_ms);
    entry.sold_while_trying.push(trial.sold_while_trying);
    entry.save_ms.push(...trial.save_ms);
    entry.sold_after_suspend += trial.sold_after_suspend;
    if (trial.still_sold_after_cancel !== null) {
      entry.suspensions_checked += 1;
      entry.suspension_undone_by_cancel += trial.still_sold_after_cancel ? 1 : 0;
    }
  }
  void round;
}

function finalizeSuspendMetrics() {
  for (const entry of Object.values(metrics.suspend ?? {})) {
    entry.reject_rate = entry.attempts === 0 ? null : Math.round((entry.rejected / entry.attempts) * 1000) / 1000;
    entry.model_success_per_attempt =
      Math.round(Math.exp((-entry.orders_per_second * entry.think_ms) / 1000) * 1000) / 1000;
    entry.model_success_if_think_5s = Number(Math.exp(-entry.orders_per_second * 5).toExponential(2));
    entry.model_success_if_think_10s = Number(Math.exp(-entry.orders_per_second * 10).toExponential(2));
    entry.suspended_share_of_trials = Math.round((entry.suspended_trials / entry.trials) * 100) / 100;
    entry.time_to_suspend_p50_ms = percentile(entry.times_ms, 0.5);
    entry.sold_while_trying_p50 = percentile(entry.sold_while_trying, 0.5);
    entry.save_latency_p50_ms = Math.round(percentile(entry.save_ms, 0.5));
    entry.save_latency_p95_ms = Math.round(percentile(entry.save_ms, 0.95));
    delete entry.times_ms;
    delete entry.sold_while_trying;
    delete entry.save_ms;
  }
}

// ---------------------------------------------------------------------------------------------
// Scenario 5: prezzo cambiato tra carrello e invio
// ---------------------------------------------------------------------------------------------
async function scenarioPrice() {
  const fx = fixtureMenu();
  const { beer: P, panino: R } = fx;
  await resetAll(Object.values(fx));
  const cart = (await rpc("get_ordering_catalog", [], asPublic)).data.items.find((entry) => entry.id === P.id);
  const cartPrice = Number(cart.price);
  const p1 = pick([5, 5.5, 3.5, 6.25]);
  const p2 = p1 + 1;
  const rows = await loadMenuRows();
  const rowP = rows.find((row) => row.id === P.id);

  const racing = [];
  await Promise.all([
    sleep(rand(20, 80)).then(() => call("bulk_upsert_menu_items", staffMenu([menuRow(rowP, { price: p1 })]))),
    ...Array.from({ length: 10 }, () =>
      sleep(rand(0, 120)).then(async () => {
        const result = await place(L([P, randInt(1, 3)], [R]), { allowed: [] });
        if (!result.error) racing.push(result.data);
      }),
    ),
    ...Array.from({ length: 5 }, () => sleep(rand(0, 120)).then(() => publicReads("price: lettura concorrente"))),
  ]);
  // Il carrello del cliente mostrava cartPrice: il prezzo letto all'invio è quello corrente.
  const stale = must(await place(L([P, 3]), { allowed: [] }), "invio dopo la modifica del prezzo");
  const staleLine = stale.items.find((line) => line.id === P.id);
  const chargedPerUnit = Number(staleLine.price);
  const coherent = racing.every((order) => {
    const line = order.items.find((entry) => entry.id === P.id);
    return [cartPrice, p1].includes(Number(line.price));
  });
  const sequence = (await ordersRows()).map((row) => Number(row.items.find((line) => line.id === P.id).price));
  const flips = sequence.filter((value, index) => index > 0 && value !== sequence[index - 1]).length;
  if (!coherent || flips > 1 || chargedPerUnit !== p1)
    finding("Prezzo nello snapshot non coerente con la modifica", SEV.ORDER, {
      cartPrice,
      p1,
      chargedPerUnit,
      flips,
      sequence,
    });
  // Il client invia il totale che il cliente ha confermato: con il prezzo vecchio l'ordine si ferma.
  const unaware = await place(L([P, 3]), { allowed: ["price_changed"], expectedTotal: cartPrice * 3 });
  const aware = await place(L([P, 3]), { allowed: [], expectedTotal: p1 * 3 });
  if (cartPrice !== p1 && (!messageOf(unaware.error ?? {}).includes("price_changed") || aware.error))
    finding("Prezzo cambiato: l'ordine parte senza che il cliente confermi il nuovo totale", SEV.ORDER, {
      cartPrice,
      p1,
      with_old_total: outcome(unaware),
      with_new_total: outcome(aware),
    });
  const totalsOk = cents(stale.total) === cents(p1 * 3 + Number(R.price) * 0);
  if (!totalsOk)
    finding("Totale ordine diverso da prezzo corrente per quantità", SEV.ORDER, { total: stale.total, p1 });

  // Seconda modifica dopo l'invio: gli ordini già inviati non cambiano (verificato da checkSnapshots).
  const rows2 = await loadMenuRows();
  must(
    await call(
      "bulk_upsert_menu_items",
      staffMenu([
        menuRow(
          rows2.find((row) => row.id === P.id),
          { price: p2 },
        ),
      ]),
    ),
    "seconda modifica",
  );
  await checkSnapshots("price: dopo la seconda modifica");
  await settleAndClose("price");
  metrics.price ??= {
    rounds: 0,
    charged_price_equals_current_price_not_cart_price: 0,
    cart_price_differed: 0,
    note: "submit_public_order riceve il totale confermato dal cliente (p_expected_total): se un prezzo è cambiato risponde price_changed e il client mostra il nuovo totale da confermare",
  };
  metrics.price.rounds += 1;
  metrics.price.cart_price_differed += cartPrice !== p1 ? 1 : 0;
  metrics.price.charged_price_equals_current_price_not_cart_price += chargedPerUnit === p1 && cartPrice !== p1 ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// Scenario 6: prodotto spostato di categoria con ordini aperti
// ---------------------------------------------------------------------------------------------
async function scenarioMove() {
  const fx = fixtureMenu();
  const { beer: M, panino: Y } = fx;
  await resetAll(Object.values(fx));
  const destinations = [
    ["bevande", "drinks"],
    ["bevande", "vini"],
    ["bevande", "bevande"],
    ["cibo", "secondi"],
    ["cibo", "primi"],
    ["cibo", "furgone"],
  ];
  const [category, subcategory] = pick(destinations);
  const mk = async (lines) => must(await place(lines, { allowed: [] }), "ordine di partenza");
  const [unpaid, paidBefore, partial] = await Promise.all([mk(L([M])), mk(L([M, 2])), mk(L([M], [Y]))]);
  must(await payOrder(paidBefore.order_id), "pagamento");
  must(await payOrder(partial.order_id), "pagamento");
  must(await deliver(partial.order_id, "secondi", L([Y])), "consegna parziale");
  const row = (await loadMenuRows()).find((entry) => entry.id === M.id);

  const fresh = [];
  const phase = await Promise.all([
    sleep(rand(20, 90)).then(() =>
      call("bulk_upsert_menu_items", staffMenu([menuRow(row, { category, subcategory })])),
    ),
    sleep(rand(0, 110)).then(() => payOrder(unpaid.order_id)),
    sleep(rand(0, 110)).then(() =>
      call("deliver_fulfillment_items", deliver(paidBefore.order_id, "birre", L([M])), true),
    ),
    ...Array.from({ length: 6 }, () =>
      sleep(rand(0, 130)).then(async () => {
        const result = await place(L([M]), { allowed: [] });
        if (!result.error) fresh.push(result.data);
      }),
    ),
    ...Array.from({ length: 4 }, () => sleep(rand(0, 130)).then(() => publicReads("move: lettura concorrente"))),
  ]);
  if (phase[0].error) throw new Error(`spostamento non riuscito: ${outcome(phase[0])}`);

  // Ogni riga di evasione segue lo snapshot dell'ordine, non la voce di menu corrente.
  const snapshots = new Map((await ordersRows()).map((order) => [order.id, order]));
  const mismatched = [];
  for (const entry of await fulfillmentRows()) {
    const line = snapshots.get(entry.order_id)?.items.find((candidate) => candidate.id === entry.id);
    if (line && (entry.station !== station(line.subcategory) || entry.category !== line.category))
      mismatched.push({
        order: entry.order_id,
        station: entry.station,
        snapshot: `${line.category}/${line.subcategory}`,
      });
  }
  if (mismatched.length > 0)
    finding("Instradamento diverso dallo snapshot dell'ordine dopo lo spostamento del prodotto", SEV.ORDER, {
      mismatched: mismatched.slice(0, 3),
    });
  const split = { old_station_orders: 0, new_station_orders: 0 };
  for (const order of fresh) {
    const line = order.items.find((candidate) => candidate.id === M.id);
    split[line.subcategory === "birre" ? "old_station_orders" : "new_station_orders"] += 1;
  }
  const wrong = await call(
    "deliver_fulfillment_items",
    deliver(unpaid.order_id, station(subcategory) === "birre" ? "drinks" : station(subcategory), L([M]), "admin"),
    true,
  );
  if (!wrong.error && station(subcategory) !== "birre")
    finding("Ordine nato prima dello spostamento consegnabile alla nuova postazione", SEV.ORDER, {
      moved_to: `${category}/${subcategory}`,
    });
  await settleAndClose("move");
  metrics.move ??= {
    rounds: 0,
    orders_created_before_move_keep_old_station: 0,
    orders_created_after_move_use_new_station: 0,
  };
  metrics.move.rounds += 1;
  metrics.move.orders_created_before_move_keep_old_station += split.old_station_orders;
  metrics.move.orders_created_after_move_use_new_station += split.new_station_orders;
}

// ---------------------------------------------------------------------------------------------
// Scenario 7: due dispositivi staff salvano il menu insieme, più lock incrociati
// ---------------------------------------------------------------------------------------------
async function lockOrderProbe(kind) {
  const [a, b, c] = [uuid(), uuid(), uuid()].sort();
  const items = [a, b, c].map((id, index) => ({
    key: `lock${index}`,
    id,
    category: "bevande",
    subcategory: "birre",
    name: `[EDGE] lock ${index}`,
    price: 1,
    stock: 1000,
  }));
  // Inserimento in ordine decrescente: l'ordine fisico delle righe è l'inverso dell'ordine degli id.
  await resetAll([...items].reverse());
  if (kind === "close") must(await place(L(...items.map((item) => [item])), { allowed: [] }), "ordine per la chiusura");
  const hold = sql(
    `begin; select 1 from public.menu_items where id = ${lit(b)} for update; select pg_sleep(0.6); commit;`,
  );
  await sleep(180);
  let first;
  let second;
  if (kind === "delete") {
    first = call("submit_public_order (interleaving forzato)", publicOrder(L(...items.map((item) => [item]))), [
      "unknown_menu_item",
      "stock_unavailable",
    ]);
    await sleep(80);
    second = call("bulk_upsert_menu_items delete (interleaving forzato)", staffMenu([], [], [a, b, c]));
  } else {
    const rows = await loadMenuRows();
    first = call(
      "bulk_upsert_menu_items update (interleaving forzato)",
      staffMenu(rows.map((row) => menuRow(row, { name: `${row.name} bis` }))),
      ["stock_changed_retry"],
    );
    await sleep(80);
    second = call("close_order_event (interleaving forzato)", rpc("close_order_event", [], asRole("cassa")), true);
  }
  const [r1, r2, held] = await Promise.all([first, second, hold]);
  void held;
  return { kind, first: outcome(r1), second: outcome(r2), deadlock: [r1, r2].some((r) => r.error?.code === "40P01") };
}

/** Stesso schema di lockOrderProbe, ma senza lock tenuto da un'altra sessione: la finestra è quella naturale. */
async function naturalLockHammer(iterations) {
  await resetAll(); // la prova "close" ha chiuso l'evento: si riapre e si svuota il menu
  let deadlocks = 0;
  for (let wave = 0; wave < iterations; wave += 4) {
    const results = await Promise.all(
      Array.from({ length: Math.min(4, iterations - wave) }, async () => {
        const [a, b, c] = [uuid(), uuid(), uuid()].sort();
        const items = [c, b, a].map((id, index) => ({
          id,
          category: "bevande",
          subcategory: "birre",
          name: `[EDGE] caldo ${index}`,
          price: 1,
          available_portions: 1000,
          allergens: [],
        }));
        await admin_sql(`insert into public.menu_items (id, category, subcategory, name, price, available_portions, stock_capacity) values
          ${items.map((item) => `(${lit(item.id)}, 'bevande', 'birre', ${lit(item.name)}, 1, 1000, 1000)`).join(", ")}`);
        const lines = [a, b, c].map((id) => ({ id, qty: 1 }));
        return Promise.all([
          sleep(rand(0, 12)).then(() =>
            call("submit_public_order (naturale)", publicOrder(lines), ["unknown_menu_item", "stock_unavailable"]),
          ),
          sleep(rand(0, 12)).then(() =>
            call("submit_public_order (naturale)", publicOrder(lines), ["unknown_menu_item", "stock_unavailable"]),
          ),
          sleep(rand(0, 12)).then(() => call("bulk_upsert_menu_items delete (naturale)", staffMenu([], [], [a, b, c]))),
          sleep(rand(0, 12)).then(() =>
            call(
              "bulk_upsert_menu_items update (naturale)",
              staffMenu(items.map((item) => menuRow(item, { name: `${item.name} bis` }))),
              ["stock_changed_retry"],
            ),
          ),
        ]);
      }),
    );
    deadlocks += results.flat().filter((result) => result.error?.code === "40P01").length;
  }
  return { iterations, deadlocks };
}

async function scenarioMenuRace() {
  const mkItem = (key, category, subcategory, price, stock) => ({
    key,
    id: uuid(),
    category,
    subcategory,
    name: `[EDGE] ${key}`,
    price,
    stock,
  });
  const items = {
    fields: mkItem("campi", "bevande", "birre", 4, 500),
    gone: mkItem("sparisce", "bevande", "vini", 3, 500),
    stockA: mkItem("scorta", "bevande", "drinks", 5, 50),
    stale: mkItem("obsoleto", "cibo", "primi", 7, 100),
    selling: mkItem("vende", "bevande", "birre", 4, 5000),
    one: mkItem("uno", "cibo", "secondi", 6, 100),
    two: mkItem("due", "cibo", "dolci", 3, 100),
  };
  await resetAll(Object.values(items));
  const rows0 = await loadMenuRows();
  const base = (item) => rows0.find((row) => row.id === item.id);
  const save = (item, edits, delay, role = "staff") =>
    sleep(delay).then(() => call("bulk_upsert_menu_items", staffMenu([menuRow(base(item), edits)], [], [], role)));
  const finalRow = async (item) => (await loadMenuRows()).find((row) => row.id === item.id) ?? null;

  // A. Stesso prodotto, campi diversi: ogni dispositivo manda solo il campo che ha cambiato.
  {
    const renamed = "[EDGE] campi rinominato";
    const [ra, rb] = await Promise.all([
      save(items.fields, { price: 7.5 }, rand(0, 25)),
      save(items.fields, { name: renamed }, rand(0, 25)),
    ]);
    const row = await finalRow(items.fields);
    const kept = { price: Number(row.price) === 7.5, name: row.name === renamed };
    if (!ra.error && !rb.error && !(kept.price && kept.name))
      finding(
        "Due dispositivi modificano campi diversi dello stesso prodotto: un salvataggio annulla l'altro senza errore",
        SEV.LOST,
        {
          final: { price: row.price, name: row.name },
          kept,
          function: "bulk_upsert_menu_items: ogni campo presente nella richiesta va applicato da solo",
        },
      );
  }
  // B. Un dispositivo elimina, l'altro (obsoleto) modifica lo stesso prodotto.
  {
    must(await call("bulk_upsert_menu_items", staffMenu([], [], [items.gone.id])), "eliminazione");
    const late = await save(items.gone, { name: "[EDGE] modificato dopo l'eliminazione" }, 0);
    const exists = (await finalRow(items.gone)) !== null;
    // Il client mostra "era già stata eliminata da un altro dispositivo" quando la riga è in `missing`.
    const reported = (late.data?.missing ?? []).includes(items.gone.id);
    if (!late.error && !exists && !reported)
      finding("La modifica di un prodotto eliminato da un altro dispositivo risponde ok ma non salva nulla", SEV.LOST, {
        function: "bulk_upsert_menu_items deve elencare la riga in `missing`",
      });
  }
  // C. Due dispositivi impostano la scorta dello stesso prodotto dalla stessa lettura.
  {
    const [ra, rb] = await Promise.all([
      save(items.stockA, { available_portions: 0 }, rand(0, 25)),
      save(items.stockA, { available_portions: 30 }, rand(0, 25)),
    ]);
    const okCount = [ra, rb].filter((result) => !result.error).length;
    const row = await finalRow(items.stockA);
    // Scorte per differenza: da 50 uno toglie 50 e l'altro toglie 20. Entrambe accettate, in
    // qualunque ordine il risultato è 0 (mai negativo).
    if (okCount !== 2 || row.available_portions !== 0)
      finding("Due modifiche di scorta dalla stessa lettura: attese entrambe applicate per differenza", SEV.LOST, {
        okCount,
        stock: row.available_portions,
      });
    metrics["menu-race"] ??= {};
    metrics["menu-race"].stock_vs_stock = {
      both_applied: (metrics["menu-race"].stock_vs_stock?.both_applied ?? 0) + (okCount === 2 ? 1 : 0),
      rounds: (metrics["menu-race"].stock_vs_stock?.rounds ?? 0) + 1,
    };
  }
  // D. Modifica del prezzo con scorta obsoleta mentre il prodotto vende: la scorta non deve tornare indietro.
  {
    await Promise.all(Array.from({ length: 5 }, () => place(L([items.stale]), { allowed: [] })));
    must(await save(items.stale, { price: 8 }, 0), "modifica prezzo con scorta obsoleta");
    const row = await finalRow(items.stale);
    if (row.available_portions !== 95 || Number(row.price) !== 8)
      finding("Una modifica del prezzo con scorta obsoleta riporta la scorta al valore vecchio", SEV.STOCK, {
        stock: row.available_portions,
        expected: 95,
        price: row.price,
      });
  }
  // E. Scorta abbassata mentre il prodotto vende: sempre accettata, per differenza (5000 -> 20 toglie 4980).
  {
    const sold = [];
    const [save20] = await Promise.all([
      save(items.selling, { available_portions: 20 }, rand(0, 60)),
      ...Array.from({ length: 10 }, () =>
        sleep(rand(0, 90)).then(async () => {
          const result = await place(L([items.selling]), { allowed: [] });
          if (!result.error) sold.push(1);
        }),
      ),
    ]);
    const row = await finalRow(items.selling);
    const soldTotal = sold.length;
    const accepted = !save20.error;
    const drift = !accepted || row.available_portions !== 20 - soldTotal;
    if (drift || row.stock_capacity < row.available_portions)
      finding("Scorta incoerente dopo una modifica concorrente alle vendite", SEV.STOCK, {
        accepted,
        stock: row.available_portions,
        capacity: row.stock_capacity,
        soldTotal,
      });
    metrics["menu-race"] ??= {};
    const entry = (metrics["menu-race"].stock_edit_while_selling ??= { attempts: 0, rejected_stock_changed_retry: 0 });
    entry.attempts += 1;
    entry.rejected_stock_changed_retry += accepted ? 0 : 1;
  }
  // F. Prodotti diversi nello stesso istante: entrambi applicati.
  {
    const [ra, rb] = await Promise.all([
      save(items.one, { price: 6.5 }, rand(0, 25)),
      save(items.two, { name: "[EDGE] due rinominato" }, rand(0, 25)),
    ]);
    const [one, two] = await Promise.all([finalRow(items.one), finalRow(items.two)]);
    if (ra.error || rb.error || Number(one.price) !== 6.5 || two.name !== "[EDGE] due rinominato")
      finding("Salvataggi di prodotti diversi: un aggiornamento mancante", SEV.LOST, { one: one.price, two: two.name });
  }
  // G. Lock incrociati con interleaving forzato (si crea una finestra con un lock tenuto da un'altra sessione).
  const probes = [await lockOrderProbe("delete"), await lockOrderProbe("close")];
  const natural = await naturalLockHammer(24);
  metrics["menu-race"] ??= {};
  metrics["menu-race"].forced_lock_order_probes = [...(metrics["menu-race"].forced_lock_order_probes ?? []), ...probes];
  const hammer = (metrics["menu-race"].natural_lock_hammer ??= { iterations: 0, deadlocks: 0 });
  hammer.iterations += natural.iterations;
  hammer.deadlocks += natural.deadlocks;
}

// ---------------------------------------------------------------------------------------------
// Scenario 8: scaletta (program_slots, program_settings)
// ---------------------------------------------------------------------------------------------
/** `days` null: il dispositivo non ha cambiato i giorni, come fa il client (Program.tsx, handleSave). */
const saveProgram = (days, created = [], updated = [], deleted = [], role = "staff") =>
  rpc(
    "save_program",
    [days === null ? "null" : String(days), jsonb(created), jsonb(updated), uuidArray(deleted)],
    asRole(role),
  );
const slotRows = async () =>
  (await admin_sql(
    `select coalesce(json_agg(row_to_json(s) order by s.id), '[]') from (select id, day, stage, title, start_time, end_time from public.program_slots) s`,
  )) ?? [];
const programDays = () => admin_sql("select days from public.program_settings where id = 'main'");

async function resetProgram(days = 3) {
  const slots = [
    { id: uuid(), day: 1, stage: "Stage 1", title: "Band uno", start_time: "18:00", end_time: "19:00" },
    { id: uuid(), day: 2, stage: "Stage 2", title: "Band due", start_time: "20:00", end_time: "21:00" },
    { id: uuid(), day: 3, stage: "Stage 1", title: "Band tre", start_time: "22:00", end_time: "23:30" },
  ];
  await admin_sql(`delete from public.program_slots;
update public.program_settings set days = ${days} where id = 'main';
insert into public.program_slots (id, day, stage, title, start_time, end_time) values
${slots.map((s) => `(${lit(s.id)}, ${s.day}, ${lit(s.stage)}, ${lit(s.title)}, ${lit(s.start_time)}, ${lit(s.end_time)})`).join(",\n")};`);
  return slots;
}

async function scenarioSchedule() {
  const allowed = ["days must be", "every slot day", "slots_beyond_days"];
  // A. Stesso slot, campi diversi: ogni dispositivo manda solo il campo che ha cambiato.
  {
    const [slot] = await resetProgram();
    const [ra, rb] = await Promise.all([
      sleep(rand(0, 25)).then(() =>
        call("save_program", saveProgram(null, [], [{ id: slot.id, start_time: "19:30" }]), allowed),
      ),
      sleep(rand(0, 25)).then(() =>
        call("save_program", saveProgram(null, [], [{ id: slot.id, title: "Band uno (cambiato)" }]), allowed),
      ),
    ]);
    const row = (await slotRows()).find((entry) => entry.id === slot.id);
    const kept = { start_time: row.start_time === "19:30", title: row.title === "Band uno (cambiato)" };
    if (!ra.error && !rb.error && !(kept.start_time && kept.title))
      finding(
        "Scaletta: due dispositivi modificano campi diversi dello stesso slot e uno annulla l'altro senza errore",
        SEV.LOST,
        {
          final: { start_time: row.start_time, title: row.title },
          function: "save_program: ogni campo presente nella richiesta va applicato da solo",
        },
      );
  }
  // B. Un dispositivo riduce i giorni, uno obsoleto aggiunge uno slot al giorno 3: nei due ordini possibili.
  {
    let slots = await resetProgram();
    await call("save_program", saveProgram(1, [], [], [slots[1].id, slots[2].id]), allowed);
    // Il dispositivo obsoleto non ha toccato i giorni: non li invia.
    const stale = await call(
      "save_program",
      saveProgram(null, [
        { day: 3, stage: "Stage 1", title: "Nuovo giorno 3", start_time: "21:00", end_time: "22:00" },
      ]),
      allowed,
    );
    const daysAfter = await programDays();
    if (!stale.error && daysAfter === 3)
      finding(
        "Scaletta: un dispositivo obsoleto riporta i giorni pubblicati al valore vecchio senza errore",
        SEV.LOST,
        {
          days_after: daysAfter,
          function: "save_program: i giorni cambiano solo se il chiamante li invia",
        },
      );
    slots = await resetProgram();
    await call(
      "save_program",
      saveProgram(null, [
        { day: 3, stage: "Stage 1", title: "Nuovo giorno 3", start_time: "21:00", end_time: "22:00" },
      ]),
      allowed,
    );
    await call("save_program", saveProgram(1, [], [], [slots[1].id, slots[2].id]), allowed);
    const orphan = (await slotRows()).filter((row) => row.day > 1);
    const daysOrphan = await programDays();
    if (daysOrphan === 1 && orphan.length > 0)
      finding("Scaletta: riducendo i giorni resta uno slot oltre i giorni pubblicati", SEV.LOST, {
        days: daysOrphan,
        orphan_slots: orphan.map((row) => ({ day: row.day, title: row.title })),
        function: "save_program deve rifiutare la riduzione dei giorni se restano eventi oltre (slots_beyond_days)",
      });
  }
  // C. Eliminazione contro modifica dello stesso slot.
  {
    const [slot] = await resetProgram();
    await call("save_program", saveProgram(null, [], [], [slot.id]), allowed);
    const late = await call(
      "save_program",
      saveProgram(null, [], [{ id: slot.id, title: "Modificato dopo l'eliminazione" }]),
      allowed,
    );
    const exists = (await slotRows()).some((row) => row.id === slot.id);
    // Il client mostra "era già stato eliminato da un altro dispositivo" quando lo slot è in `missing`.
    if (!late.error && !exists && !(late.data?.missing ?? []).includes(slot.id))
      finding(
        "Scaletta: la modifica di uno slot eliminato da un altro dispositivo risponde ok ma non salva nulla",
        SEV.LOST,
        { function: "save_program deve elencare lo slot in `missing`" },
      );
  }
  // D. Quattro dispositivi aggiungono slot e modificano slot diversi nello stesso momento.
  {
    const slots = await resetProgram();
    const results = await Promise.all(
      [0, 1, 2, 3].map((device) =>
        sleep(rand(0, 40)).then(() =>
          call(
            "save_program",
            saveProgram(
              null,
              Array.from({ length: 3 }, (_, index) => ({
                day: 1 + (index % 3),
                stage: "Stage 2",
                title: `D${device} slot ${index}`,
                start_time: `1${device}:0${index}`,
                end_time: `1${device}:5${index}`,
              })),
              device < 3 ? [{ id: slots[device].id, title: `Modificato da ${device}` }] : [],
            ),
            allowed,
          ),
        ),
      ),
    );
    const rows = await slotRows();
    const edited = rows.filter((row) => row.title.startsWith("Modificato da")).length;
    if (results.some((result) => result.error) || rows.length !== 3 + 12 || edited !== 3)
      finding("Scaletta: salvataggi concorrenti di slot diversi perdono aggiornamenti", SEV.LOST, {
        errors: results.filter((result) => result.error).map(outcome),
        rows: rows.length,
        edited,
      });
  }
  metrics.schedule ??= { rounds: 0 };
  metrics.schedule.rounds += 1;
}

// ---------------------------------------------------------------------------------------------
// Scenario 9: torneo, 4 dispositivi con campi diversi, salvataggi con nome e pubblicazione
// ---------------------------------------------------------------------------------------------
const TEAMS = Array.from({ length: 8 }, (_, index) => `Squadra ${index + 1}`);
const saveTournament = (id, name, expected, doc, publish = false, role = "tournament_manager") =>
  rpc(
    "save_tournament",
    [
      lit(id),
      lit(name),
      expected ? `${lit(expected)}::timestamptz` : "null",
      String(doc.size ?? 8),
      jsonb(doc.teams),
      jsonb(doc.matches),
      jsonb(doc.overrides),
      String(publish),
    ],
    asRole(role),
  );
const fetchSave = async (id) =>
  must(
    await sql(
      `select to_jsonb(s) from public.tournament_snapshots s where id = ${lit(id)}`,
      asRole("tournament_manager"),
    ),
    "lettura salvataggio",
  );
const liveConsistency = () =>
  admin_sql(`select (s.size = n.size and s.teams = n.teams and s.matches = n.matches and s.overrides = n.overrides)
    from public.tournament_state s join public.tournament_snapshots n on n.id = s.live_save_id where s.id = 'main'`);
const revisionNow = () => admin_sql("select revision from public.tournament_state where id = 'main'");

async function resetTournament() {
  await admin_sql(
    `update public.tournament_state set live_save_id = null where id = 'main'; delete from public.tournament_snapshots;`,
  );
  return must(
    await call(
      "save_tournament",
      saveTournament(null, "Torneo prova", null, { teams: TEAMS, matches: {}, overrides: {} }, true),
    ),
    "salvataggio iniziale",
  );
}

/** Stessa fusione a tre vie del client (tournamentState.ts, mergeTournament): vale la mia modifica, altrimenti la loro. */
function mergeDocs(base, mine, theirs) {
  const choose = (b, m, t) => (same(m, b) ? t : m);
  const mergeMap = (b, m, t) => {
    const merged = {};
    for (const key of new Set([...Object.keys(b), ...Object.keys(m), ...Object.keys(t)])) {
      const value = choose(b[key], m[key], t[key]);
      if (value !== undefined) merged[key] = value;
    }
    return merged;
  };
  return {
    ...theirs,
    teams: base.teams.map((team, index) => choose(team, mine.teams[index], theirs.teams[index])),
    matches: mergeMap(base.matches, mine.matches, theirs.matches),
    overrides: mergeMap(base.overrides, mine.overrides, theirs.overrides),
  };
}

/** Ogni dispositivo modifica un campo diverso: nomi squadra, partite del turno 0, del turno 1, ripescaggi. */
function applyEdit(doc, device, counter) {
  if (device === 0) {
    const index = counter % 8;
    const value = `S0-${counter}`;
    doc.teams[index] = value;
    return { key: `team:${index}`, value };
  }
  if (device === 1 || device === 2) {
    const round = device - 1;
    const index = counter % (device === 1 ? 4 : 2);
    const value = { winner: "A", scoreA: counter + 1, scoreB: 0, completedAt: "2026-06-12T20:00:00.000Z" };
    doc.matches[`${round}-${index}`] = value;
    return { key: `m:${round}-${index}`, value };
  }
  const side = counter % 2 === 0 ? "A" : "B";
  const value = `Rip${counter}`;
  doc.overrides[`2-0-${side}`] = value;
  return { key: `o:2-0-${side}`, value };
}
function readEdit(doc, key) {
  const [kind, rest] = key.split(":");
  if (kind === "team") return doc.teams[Number(rest)];
  if (kind === "m") return doc.matches[rest];
  return doc.overrides[rest];
}

async function tournamentRun({ name, periodMs, durationMs, redo = false, extras = false }) {
  const first = await resetTournament();
  const revisionBefore = await revisionNow();
  const deadline = performance.now() + durationMs;
  const probes = { consistency_checks: 0, inconsistent: 0 };
  const expected = new Map(); // chiave -> ultimo valore salvato con successo
  const stats = {
    saves: 0,
    ok: 0,
    conflicts: 0,
    errors: 0,
    edits: 0,
    edits_lost: 0,
    edits_persisted: 0,
    unpublished_ok: 0,
    live_ok: 0,
    ms: [],
  };
  const extra = { private_saves: 0, private_conflicts: 0, publishes: 0, published_at_ms: null };

  async function device(index) {
    let doc = await fetchSave(first.id);
    let base = structuredClone(doc); // ultima versione letta o salvata: serve alla fusione
    let counter = index * 100;
    let pending = [];
    while (performance.now() < deadline) {
      await sleep(periodMs * rand(0.7, 1.3));
      if (performance.now() >= deadline) break;
      const batch = randInt(1, 3);
      for (let i = 0; i < batch; i += 1) {
        pending.push(applyEdit(doc, index, counter));
        counter += 1;
      }
      stats.edits += batch;
      stats.saves += 1;
      let result = await call("save_tournament", saveTournament(doc.id, doc.name, doc.updated_at, doc), [
        "save_conflict",
      ]);
      stats.ms.push(result.ms);
      // Come l'app (TournamentBracket.tsx, save): al conflitto rilegge, fonde e riprova, fino a 3 volte.
      for (
        let retry = 0;
        !redo && retry < 3 && result.error && messageOf(result.error).includes("save_conflict");
        retry += 1
      ) {
        stats.conflicts += 1;
        const theirs = await fetchSave(first.id);
        doc = mergeDocs(base, doc, theirs);
        base = structuredClone(theirs);
        result = await call("save_tournament", saveTournament(doc.id, doc.name, doc.updated_at, doc), [
          "save_conflict",
        ]);
        stats.ms.push(result.ms);
      }
      if (!result.error) {
        stats.ok += 1;
        stats.edits_persisted += pending.length;
        if (result.data.live === true) stats.live_ok += 1;
        else stats.unpublished_ok += 1;
        doc.updated_at = result.data.updated_at;
        base = structuredClone(doc);
        for (const edit of pending) expected.set(edit.key, edit.value);
        pending = [];
      } else if (messageOf(result.error).includes("save_conflict")) {
        stats.conflicts += 1;
        // Fusione non riuscita dopo 3 tentativi (o modalità "rifacimento"): si ricarica e le modifiche si perdono.
        const lost = pending;
        doc = await fetchSave(first.id);
        base = structuredClone(doc);
        if (redo) {
          for (const edit of lost) {
            const [kind, rest] = edit.key.split(":");
            if (kind === "team") doc.teams[Number(rest)] = edit.value;
            else if (kind === "m") doc.matches[rest] = edit.value;
            else doc.overrides[rest] = edit.value;
          }
          pending = lost;
        } else {
          stats.edits_lost += lost.length;
          pending = [];
        }
      } else {
        stats.errors += 1;
      }
    }
  }

  async function extraDevice() {
    // Salvataggi con nome (privati) e una pubblicazione di un altro salvataggio mentre gli altri salvano.
    const publishAt = performance.now() + durationMs * rand(0.4, 0.6);
    let own = null;
    while (performance.now() < deadline) {
      await sleep(rand(250, 450));
      if (extra.publishes === 0 && performance.now() >= publishAt) {
        const published = await call(
          "save_tournament",
          saveTournament(
            null,
            "Pubblicato",
            null,
            {
              teams: TEAMS,
              matches: { "0-0": { winner: "B", scoreA: 0, scoreB: 1, completedAt: null } },
              overrides: {},
            },
            true,
          ),
        );
        extra.publishes += 1;
        extra.published_at_ms = Math.round(performance.now() - (deadline - durationMs));
        void published;
        continue;
      }
      if (own === null || rng() < 0.4) {
        const created = await call(
          "save_tournament",
          saveTournament(null, `Copia ${hex(3)}`, null, { teams: TEAMS, matches: {}, overrides: {} }),
        );
        own = created.data;
        extra.private_saves += 1;
      } else {
        const result = await call(
          "save_tournament",
          saveTournament(own.id, own.name, own.updated_at, {
            teams: TEAMS,
            matches: { "0-1": { winner: "A", scoreA: 1, scoreB: 0, completedAt: null } },
            overrides: {},
          }),
          ["save_conflict"],
        );
        extra.private_saves += 1;
        if (result.error) extra.private_conflicts += 1;
        else own = result.data;
      }
    }
  }

  async function prober() {
    while (performance.now() < deadline) {
      await sleep(rand(25, 60));
      const value = await liveConsistency();
      probes.consistency_checks += 1;
      if (value === "f") probes.inconsistent += 1;
    }
  }

  await Promise.all([...[0, 1, 2, 3].map(device), ...(extras ? [extraDevice(), prober()] : [])]);

  const final = await fetchSave(first.id);
  const liveState = await admin_sql("select live_save_id from public.tournament_state where id = 'main'");
  const missing = [];
  for (const [key, value] of expected) {
    // Dopo la pubblicazione di un altro salvataggio il salvataggio dei dispositivi resta valido nella sua riga.
    if (!same(readEdit(final, key), value)) missing.push({ key, expected: value, final: readEdit(final, key) });
  }
  const revisionAfter = await revisionNow();
  const revisionExpected = stats.live_ok + extra.publishes;
  const revisionDelta = revisionAfter - revisionBefore;
  const result = {
    name,
    period_ms: periodMs,
    saves: stats.saves,
    ok: stats.ok,
    conflicts: stats.conflicts,
    other_errors: stats.errors,
    edits: stats.edits,
    edits_lost: stats.edits_lost,
    edits_persisted: stats.edits_persisted,
    saves_ok_but_not_published: stats.unpublished_ok,
    silent_overwrites: missing.length,
    save_p50_ms: Math.round(percentile(stats.ms, 0.5)),
    save_p95_ms: Math.round(percentile(stats.ms, 0.95)),
    ...(extras
      ? {
          ...extra,
          ...probes,
          revision_delta: revisionDelta,
          revision_expected: revisionExpected,
          live_is_published_save: liveState !== first.id,
        }
      : {}),
  };
  if (missing.length > 0)
    finding("Torneo: un salvataggio riuscito è stato sovrascritto in silenzio", SEV.LOST, {
      name,
      missing: missing.slice(0, 3),
    });
  if (stats.errors > 0)
    finding("Torneo: errori diversi da save_conflict durante i salvataggi", SEV.UNEXPECTED, {
      name,
      errors: stats.errors,
    });
  if (extras) {
    if (extra.private_conflicts > 0)
      finding("Torneo: conflitto spurio su un salvataggio privato che nessun altro modifica", SEV.LOST, {
        name,
        private_conflicts: extra.private_conflicts,
      });
    if (probes.inconsistent > 0)
      finding("Torneo: tabellone pubblico diverso dal salvataggio in onda", SEV.LOST, { name, probes });
    if (revisionDelta !== revisionExpected)
      finding("Torneo: la revisione pubblica non conta i salvataggi in onda", SEV.LOST, {
        name,
        revisionDelta,
        revisionExpected,
      });
    // Dopo che un altro salvataggio è andato in onda, save_tournament risponde live=false: è
    // corretto, e il client ora toglie l'etichetta "in onda" (TournamentBracket.tsx, save).
    // Resta solo come metrica: saves_ok_but_not_published.
  }
  return result;
}

async function scenarioTournament(round) {
  metrics.tournament ??= {};
  const settings = [
    { name: "ogni_30s", periodMs: Math.round(30000 / compress), durationMs: 7000 },
    { name: "ogni_10s", periodMs: Math.round(10000 / compress), durationMs: 4500 },
    { name: "ogni_2s", periodMs: Math.round(2000 / compress), durationMs: 3000 },
  ];
  for (const setting of settings) {
    if (performance.now() - runStart > budgetMs) return;
    const result = await tournamentRun(setting);
    const entry = (metrics.tournament[setting.name] ??= {
      period_ms: result.period_ms,
      rounds: 0,
      saves: 0,
      ok: 0,
      conflicts: 0,
      other_errors: 0,
      edits: 0,
      edits_lost: 0,
      silent_overwrites: 0,
      save_ms_p50: [],
      save_ms_p95: [],
    });
    entry.rounds += 1;
    for (const field of ["saves", "ok", "conflicts", "other_errors", "edits", "edits_lost", "silent_overwrites"])
      entry[field] += result[field];
    entry.save_ms_p50.push(result.save_p50_ms);
    entry.save_ms_p95.push(result.save_p95_ms);
  }
  // Con ripetizione dell'edit dopo il ricaricamento: quanti salvataggi servono per ogni salvataggio riuscito.
  const redoRun = await tournamentRun({
    name: "ogni_10s_con_rifacimento",
    periodMs: Math.round(10000 / compress),
    durationMs: 4500,
    redo: true,
  });
  const redoEntry = (metrics.tournament.ogni_10s_con_rifacimento ??= { rounds: 0, saves: 0, ok: 0, conflicts: 0 });
  redoEntry.rounds += 1;
  redoEntry.saves += redoRun.saves;
  redoEntry.ok += redoRun.ok;
  redoEntry.conflicts += redoRun.conflicts;
  // Salvataggi con nome e pubblicazione contro i salvataggi in onda.
  const racing = await tournamentRun({
    name: "salvataggi_con_nome_e_pubblicazione",
    periodMs: Math.round(10000 / compress),
    durationMs: 3500,
    extras: true,
  });
  const racingEntry = (metrics.tournament.salvataggi_con_nome_e_pubblicazione ??= {
    rounds: 0,
    device_saves_ok_but_not_published: 0,
    private_saves: 0,
    private_conflicts: 0,
    consistency_checks: 0,
    inconsistent: 0,
    revision_mismatches: 0,
  });
  racingEntry.rounds += 1;
  racingEntry.device_saves_ok_but_not_published += racing.saves_ok_but_not_published;
  racingEntry.private_saves += racing.private_saves;
  racingEntry.private_conflicts += racing.private_conflicts;
  racingEntry.consistency_checks += racing.consistency_checks;
  racingEntry.inconsistent += racing.inconsistent;
  racingEntry.revision_mismatches += racing.revision_delta === racing.revision_expected ? 0 : 1;
  void round;
}

function finalizeTournamentMetrics() {
  if (!metrics.tournament) return;
  let totalSaves = 0;
  let totalConflicts = 0;
  for (const [name, entry] of Object.entries(metrics.tournament ?? {})) {
    if (entry.saves !== undefined && entry.conflicts !== undefined) {
      entry.conflict_share = entry.saves === 0 ? null : Math.round((entry.conflicts / entry.saves) * 1000) / 1000;
      if (entry.edits !== undefined && name !== "ogni_10s_con_rifacimento")
        entry.edit_loss_share_following_reload_instruction =
          entry.edits === 0 ? null : Math.round((entry.edits_lost / entry.edits) * 1000) / 1000;
      if (name === "ogni_10s_con_rifacimento")
        entry.saves_needed_per_successful_save =
          entry.ok === 0 ? null : Math.round((entry.saves / entry.ok) * 100) / 100;
      if (entry.save_ms_p50) {
        entry.save_ms_p50 = percentile(entry.save_ms_p50, 0.5);
        entry.save_ms_p95 = percentile(entry.save_ms_p95, 0.5);
      }
      if (name.startsWith("ogni_") && !name.includes("rifacimento")) {
        totalSaves += entry.saves;
        totalConflicts += entry.conflicts;
      }
    }
  }
  const lostEdits = Object.entries(metrics.tournament)
    .filter(([name]) => name.startsWith("ogni_") && !name.includes("rifacimento"))
    .reduce((total, [, entry]) => total + entry.edits_lost + entry.silent_overwrites, 0);
  metrics.tournament.requirement_different_matches_updated_independently = {
    met: lostEdits === 0,
    saves: totalSaves,
    conflicts_merged_and_retried: totalConflicts,
    lost_edits: lostEdits,
    why: "save_tournament confronta updated_at dell'intero salvataggio; al conflitto il client rilegge, fonde squadre, partite e ripescaggi uno per uno e riprova",
  };
}

// ---------------------------------------------------------------------------------------------
// Scenario 10: permessi
// ---------------------------------------------------------------------------------------------
async function scenarioPermissions() {
  const ZERO = "00000000-0000-4000-8000-000000000000";
  const DEV = "d".repeat(40);
  const QR = "q".repeat(44);
  const actors = [...roles, "anon"];
  const optionsOf = (role) => (role === "anon" ? asPublic : asRole(role));
  const cash = (role) => role === "cassa" || role === "admin";
  const stationAllowed = (role, name) =>
    role === "admin" ||
    (role === "cucina" && (name === "cucina" || KITCHEN_STATIONS.includes(name))) ||
    (role === "bar" && BAR_STATIONS.includes(name));
  const items = jsonb([{ id: ZERO, qty: 1 }]);
  const plain = [
    // [funzione, argomenti, chi ha il diritto, modifica lo stato se chiamata da chi ha il diritto]
    ["claim_order_for_station", [lit(ZERO), lit("cassa_1"), lit(DEV)], cash, false],
    ["release_order_for_station", [lit(ZERO), lit("cassa_1"), lit(DEV)], cash, false],
    ["force_release_order", [lit(ZERO)], cash, false],
    ["cancel_order_for_station", [lit(ZERO), lit("cassa_1"), lit(DEV)], cash, false],
    ["pay_order_for_station", [lit(ZERO), lit("cassa_1"), lit(DEV)], cash, false],
    ["set_order_preparation", [lit(ZERO), lit("cassa_1"), lit(DEV), lit("immediate")], cash, false],
    ["create_counter_order", [lit("Prova"), lit(""), items, lit("immediate")], cash, false],
    ["update_order_event", [lit("Evento"), "now()", "now() + interval '1 hour'", "100", "1"], cash, true],
    ["set_ordering_paused", ["true"], cash, true],
    ["close_order_event", [], cash, true],
    ["create_next_order_event", [lit("Nuovo"), "now()", "now() + interval '1 hour'", "100", "1"], cash, true],
    ["get_cashier_pending_orders", [], cash, false],
    ["get_cashier_claims", [], cash, false],
    ["get_order_event_admin_state", [], cash, false],
    ["get_order_event_report", [], cash, false],
    ["get_order_event_snapshot", [], cash, false],
    ["get_low_stock_items", [], (role) => role === "cucina" || role === "admin", false],
    [
      "save_tournament",
      [lit(null), lit("Prova"), "null", "8", jsonb(TEAMS), jsonb({}), jsonb({}), "false"],
      (role) => role === "tournament_manager" || role === "admin",
      true,
    ],
    [
      "save_program",
      ["1", jsonb([]), jsonb([]), "array[]::uuid[]"],
      (role) => role === "staff" || role === "admin",
      true,
    ],
    [
      "bulk_upsert_program_slots",
      [jsonb([]), jsonb([]), "array[]::uuid[]"],
      (role) => role === "staff" || role === "admin",
      true,
    ],
    [
      "undo_fulfillment_delivery",
      [lit(ZERO), lit("birre")],
      (role) => ["admin", "cucina", "bar"].includes(role),
      false,
    ],
  ];
  const stationCalls = (name) => [
    ["get_fulfillment_queue", [lit(name)], (role) => stationAllowed(role, name), false],
    ["get_fulfillment_order_by_number", ["1", lit(name)], (role) => stationAllowed(role, name), false],
    ["get_fulfillment_order_by_qr", [lit(QR), lit(name)], (role) => stationAllowed(role, name), false],
    ["get_recent_fulfillment_deliveries", [lit(name)], (role) => stationAllowed(role, name), false],
    [
      "deliver_fulfillment_items",
      [lit(ZERO), lit(name), items],
      (role) => name !== "cucina" && stationAllowed(role, name),
      false,
    ],
    [
      "activate_kitchen_order",
      [lit(ZERO), lit(name)],
      (role) => name !== "birre" && name !== "bar" && stationAllowed(role, name),
      false,
    ],
  ];
  const cells = [...plain, ...["secondi", "birre", "cucina"].flatMap(stationCalls)];
  const wrong = [];
  let checked = 0;
  const tasks = [];
  for (const [fn, args, allowedFor, mutates] of cells) {
    for (const role of actors) {
      const allowed = allowedFor(role);
      if (allowed && mutates) continue; // non si eseguono azioni distruttive con un ruolo autorizzato
      tasks.push(async () => {
        const result = await rpc(fn, args, optionsOf(role));
        checked += 1;
        const denied = result.error?.code === "42501";
        // Chi non ha il diritto deve ricevere 42501. Chi lo ha non deve riceverlo.
        if (!allowed && !denied) wrong.push({ fn, role, expected: "rifiuto 42501", got: outcome(result) });
        if (allowed && denied) wrong.push({ fn, role, expected: "autorizzato", got: outcome(result) });
      });
    }
  }
  for (let index = 0; index < tasks.length; index += 30)
    await Promise.all(tasks.slice(index, index + 30).map((task) => task()));
  if (wrong.length > 0)
    finding("Funzione staff senza il rifiuto atteso per un ruolo", SEV.ORDER, { checked, wrong: wrong.slice(0, 8) });

  // Menu: policy RLS, security invoker. Verifica anche cosa vede chi non ha diritti.
  const fx = fixtureMenu();
  await resetAll(Object.values(fx));
  const rowOf = async (item) => (await loadMenuRows("admin")).find((row) => row.id === item.id);
  const silent = [];
  const menuProblems = [];
  const drinkBase = await rowOf(fx.beer);
  const foodBase = await rowOf(fx.panino);
  for (const role of ["tournament_manager", "cassa", "pending", "anon", "bar"]) {
    const created = await rpc(
      "bulk_upsert_menu_items",
      [
        jsonb([
          {
            category: role === "bar" ? "cibo" : "bevande",
            subcategory: role === "bar" ? "primi" : "birre",
            name: "[EDGE] abusivo",
            price: 1,
            available_portions: 1,
          },
        ]),
        jsonb([]),
        "array[]::uuid[]",
      ],
      optionsOf(role),
    );
    if (created.error?.code !== "42501")
      menuProblems.push({ role, what: "creazione ammessa o errore diverso", got: outcome(created) });
    const target = role === "bar" ? foodBase : drinkBase;
    const updated = await rpc(
      "bulk_upsert_menu_items",
      [jsonb([]), jsonb([menuRow(target, { name: "[EDGE] abusivo", price: 99 })]), "array[]::uuid[]"],
      optionsOf(role),
    );
    const removed = await rpc(
      "bulk_upsert_menu_items",
      [jsonb([]), jsonb([]), uuidArray([target.id])],
      optionsOf(role),
    );
    const after = await rowOf(target.id === drinkBase.id ? fx.beer : fx.panino);
    if (!after || after.name !== target.name || Number(after.price) !== Number(target.price))
      menuProblems.push({ role, what: "il menu è stato modificato o eliminato", after });
    if (!updated.error || !removed.error) silent.push({ role, update: outcome(updated), delete: outcome(removed) });
  }
  if (menuProblems.length > 0) finding("Menu modificato da un ruolo senza diritti", SEV.ORDER, { menuProblems });
  if (silent.length > 0)
    finding("Un ruolo senza diritti sul menu riceve successo senza che cambi nulla (nessun errore)", SEV.UNCLEAR, {
      roles: silent,
      function:
        "bulk_upsert_menu_items (righe 396-417): security invoker, nessun controllo del ruolo; la RLS filtra update e delete in silenzio",
    });
  // Ruoli con diritti: staff, cucina, admin su tutto; bar solo sulle bevande.
  const rights = [];
  for (const role of ["staff", "cucina", "admin", "bar"]) {
    const result = await call(
      "bulk_upsert_menu_items",
      staffMenu([menuRow(await rowOf(fx.spritz), { price: 5.5 })], [], [], role),
      true,
    );
    const now = await rowOf(fx.spritz);
    rights.push({ role, drink_update: outcome(result), applied: Number(now.price) === 5.5 });
    await admin_sql(`update public.menu_items set price = 5 where id = ${lit(fx.spritz.id)}`);
  }
  const barMove = await rpc(
    "bulk_upsert_menu_items",
    [
      jsonb([]),
      jsonb([menuRow(await rowOf(fx.spritz), { category: "cibo", subcategory: "primi" })]),
      "array[]::uuid[]",
    ],
    asRole("bar"),
  );
  if (rights.some((entry) => entry.drink_update !== "ok" || !entry.applied) || barMove.error?.code !== "42501")
    finding("Ruolo con diritti sul menu rifiutato, o il bar sposta una bevanda in cucina", SEV.BLOCKED, {
      rights,
      bar_move: outcome(barMove),
    });

  // Scaletta e torneo: scritture dirette e funzioni.
  const direct = [];
  const tryDirect = async (label, role, query, expectDenied) => {
    const result = await sql(query, optionsOf(role));
    if (expectDenied && !result.error) direct.push({ label, got: "ok (atteso rifiuto)" });
    if (!expectDenied && result.error) direct.push({ label, got: outcome(result) });
  };
  await tryDirect(
    "tournament_manager scrive tournament_state",
    "tournament_manager",
    "update public.tournament_state set size = 8 where id = 'main'",
    true,
  );
  await tryDirect(
    "admin scrive tournament_state",
    "admin",
    "update public.tournament_state set size = 8 where id = 'main'",
    true,
  );
  await tryDirect(
    "tournament_manager inserisce uno snapshot",
    "tournament_manager",
    `insert into public.tournament_snapshots (size, teams, matches, overrides, reason, name) values (8, ${jsonb(TEAMS)}, '{}', '{}', 'manual', 'x')`,
    true,
  );
  await tryDirect(
    "admin inserisce un ordine",
    "admin",
    `insert into public.orders (event_id, display_number, items, total, status) values (${lit(eventId)}, 99999, '[]', 0, 'pagato')`,
    true,
  );
  await tryDirect("anon legge gli ordini", "anon", "select count(*) from public.orders", true);
  await tryDirect("pending legge gli ordini (nessuna riga)", "pending", "select count(*) from public.orders", false);
  await tryDirect(
    "tournament_manager scrive la scaletta",
    "tournament_manager",
    "insert into public.program_slots (day, stage, title, start_time, end_time) values (1, 'Stage 1', 'x', '10:00', '11:00')",
    true,
  );
  await tryDirect(
    "pending scrive la scaletta",
    "pending",
    "insert into public.program_slots (day, stage, title, start_time, end_time) values (1, 'Stage 1', 'x', '10:00', '11:00')",
    true,
  );
  await tryDirect(
    "staff scrive la scaletta",
    "staff",
    "insert into public.program_slots (day, stage, title, start_time, end_time) values (1, 'Stage 1', 'staff', '10:00', '11:00')",
    false,
  );
  await tryDirect(
    "cassa invia un ordine pubblico",
    "cassa",
    `select public.submit_public_order('Prova x','',${jsonb(L([fx.beer]))},gen_random_uuid(),${lit(token())},'')`,
    true,
  );
  await tryDirect(
    "anon invia un ordine pubblico",
    "anon",
    `select public.submit_public_order('Prova x','',${jsonb(L([fx.beer]))},gen_random_uuid(),${lit(token())},'')`,
    true,
  );
  const pendingOrders = await sql("select count(*) from public.orders", asRole("pending"));
  if (pendingOrders.data !== 0) direct.push({ label: "pending vede ordini", got: pendingOrders.data });
  if (direct.length > 0)
    finding("Scrittura o lettura diretta con un esito diverso dal permesso atteso", SEV.ORDER, { direct });
  metrics.permissions = {
    function_role_cells_checked: checked,
    direct_checks: 12,
    menu_silent_noop_roles: silent.map((entry) => entry.role),
    roles_with_menu_rights: rights,
  };
}

// ---------------------------------------------------------------------------------------------
// Esecuzione
// ---------------------------------------------------------------------------------------------
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stop();
    process.exit(130);
  });
}

console.log(`Stress test modifiche staff LAG su PostgreSQL temporaneo (${workDir})`);
console.log(
  `seed=${seed} rounds=${rounds} (scenari lunghi ${heavyRounds}) compress=${compress} budget=${budgetMs / 1000}s`,
);
try {
  start({ maxConnections: 200 });
  await setup();
  if (selectedScenarios.has("delete")) await runScenario("delete", rounds, scenarioDelete);
  if (selectedScenarios.has("recovery")) await runScenario("recovery", rounds, scenarioRecovery);
  if (selectedScenarios.has("add")) await runScenario("add", rounds, scenarioAdd);
  if (selectedScenarios.has("suspend")) await runScenario("suspend", heavyRounds, scenarioSuspend);
  if (selectedScenarios.has("price")) await runScenario("price", rounds, scenarioPrice);
  if (selectedScenarios.has("move")) await runScenario("move", rounds, scenarioMove);
  if (selectedScenarios.has("menu-race")) await runScenario("menu-race", rounds, scenarioMenuRace);
  if (selectedScenarios.has("schedule")) await runScenario("schedule", rounds, scenarioSchedule);
  if (selectedScenarios.has("tournament")) await runScenario("tournament", heavyRounds, scenarioTournament);
  if (selectedScenarios.has("permissions")) await runScenario("permissions", 1, scenarioPermissions);
} finally {
  stop();
}

finalizeSuspendMetrics();
finalizeTournamentMetrics();
const summary = {
  seed,
  rounds,
  heavy_rounds: heavyRounds,
  time_compress: compress,
  elapsed_seconds: Math.round((performance.now() - runStart) / 100) / 10,
  calls: callStats,
  scenarios: scenarioStats,
  metrics,
  findings: [...findings.values()],
  harness_errors: harnessErrors,
};
const json = JSON.stringify(summary, null, 2);
console.log(json);
if (reportPath) writeFileSync(reportPath, json);
if (harnessErrors.length > 0) process.exitCode = 1;
if (findings.size > 0) process.exitCode = 2;
