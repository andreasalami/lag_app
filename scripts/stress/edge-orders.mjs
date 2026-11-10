// Stress test "edge case" degli ordini: scenari ripetuti con tempi e intrecci casuali su un
// PostgreSQL usa-e-getta (stessa infrastruttura di orders.mjs: socket Unix, nessuna rete,
// mai Supabase). Va oltre orders.mjs: casse concorrenti, claim che scadono, annullo contro
// scadenza, consegne e annulli di consegna, capienza cucina a 100, chiusura evento durante
// tutto il resto, ordini al banco, idempotenza contro pagamento, limiti 10/1000.
//
// Come si crea una vera gara: ogni passo "gated" tiene per un attimo il lock della riga
// order_events (una transazione di servizio) e lancia i chiamanti a ritardi casuali. Si
// accodano tutti sul lock e partono insieme appena viene rilasciato: è lo stesso punto in cui
// le RPC reali si serializzano. now() di una transazione è l'istante di avvio, quindi chi ha
// aspettato nella coda lavora con un orologio vecchio: è proprio il caso che interessa.
//
// Dopo ogni round si controllano gli invarianti (zero incoerenze sugli ordini) e il
// "giornale" delle chiamate riuscite contro lo stato finale del database. Lo scarto di scorta
// è solo un avviso (lo staff può correggere le scorte a mano), tutto il resto è un difetto.
// Il piano di ogni round è deterministico per LOADTEST_SEED; l'intreccio reale nel database no.
//
// Variabili: LOADTEST_ROUNDS (round per scenario), LOADTEST_SEED, LOADTEST_SCENARIOS
// (elenco separato da virgole), LOADTEST_MAX_SECONDS (tetto di durata), LOADTEST_JSON_OUT.
import { createHmac, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { createDb, invariantSql, jsonb, lit, messageOf } from "./lib.mjs";

const integerEnv = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} deve essere un intero positivo.`);
  return value;
};

const rounds = integerEnv("LOADTEST_ROUNDS", 5);
const seed = integerEnv("LOADTEST_SEED", 1);
const maxSeconds = integerEnv("LOADTEST_MAX_SECONDS", 270);
const knownScenarios = [
  "cash",
  "cancel",
  "expiry",
  "fulfillment",
  "kitchen",
  "close",
  "counter",
  "idempotency",
  "boundaries",
  "mass",
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

// ---------------------------------------------------------------------------------------
// Utilità: generatore pseudo-casuale con seme, attese, ritardi casuali.
// ---------------------------------------------------------------------------------------
function mulberry32(state) {
  let a = state >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(seed);
const rnd = (n) => Math.floor(rng() * n);
const pick = (list) => list[rnd(list.length)];
const range = (n) => Array.from({ length: n }, (_, index) => index);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const uuid = () => crypto.randomUUID();
function shuffle(list) {
  const copy = [...list];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = rnd(index + 1);
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}

const { workDir, sql, admin_sql: rawAdminSql, rpc, start, installSchema, stop } = createDb();
// Ogni processo psql avviato dal test è tracciato: prima di un reset (TRUNCATE) o di un nuovo round si
// aspetta che tutto sia finito, anche dopo un'eccezione. Senza questo un TRUNCATE incontrerebbe
// transazioni ancora in corso e andrebbe in deadlock per colpa del test, non dell'app.
const pending = new Set();
function track(promise) {
  const settled = promise
    .then(
      () => {},
      () => {},
    )
    .finally(() => pending.delete(settled));
  pending.add(settled);
  return promise;
}
async function drain() {
  while (pending.size > 0) await Promise.all([...pending]);
}
const admin_sql = (query) => track(rawAdminSql(query));
const startedAt = performance.now();
const deadline = startedAt + maxSeconds * 1000;

// ---------------------------------------------------------------------------------------
// Identità, menu, postazioni.
// ---------------------------------------------------------------------------------------
const people = { admin: uuid(), cassa: uuid(), cucina: uuid(), bar: uuid(), pending: uuid() };
const as = (role) => ({ as: "authenticated", user: people[role] });
const asAdmin = as("admin");
const asCassa = as("cassa");
const asCook = as("cucina");
const asBar = as("bar");
const asPending = as("pending");
const asPublic = { as: "anon" };
const asService = { as: "service_role" };

const FOOD = ["primo", "secondo", "contorno", "dolce", "furgone"];
const BAR = ["birra", "drink", "vino", "acqua"];
const KITCHEN_STATIONS = new Set(["primi", "secondi", "contorni", "dolci", "furgone"]);
const userFor = (station) => (KITCHEN_STATIONS.has(station) ? asCook : asBar);

// [categoria, sottosezione, nome, prezzo, scorta iniziale (null = illimitata)]. Prezzi con
// centesimi: i totali devono restare esatti. "lusso" serve solo ai test di totale enorme.
const menuSpec = {
  birra: ["bevande", "birre", "Birra edge", 2.55, 1000],
  drink: ["bevande", "drinks", "Drink edge", 6.5, 1000],
  vino: ["bevande", "vini", "Vino edge", 3.35, 1000],
  acqua: ["bevande", "bevande", "Acqua edge", 1, null],
  primo: ["cibo", "primi", "Primo edge", 8.1, 1000],
  secondo: ["cibo", "secondi", "Secondo edge", 10.05, 1000],
  contorno: ["cibo", "contorni", "Contorno edge", 3.3, 1000],
  dolce: ["cibo", "dolci", "Dolce edge", 4.45, 1000],
  furgone: ["cibo", "furgone", "Furgone edge", 7.7, 1000],
  lusso: ["bevande", "bevande", "Lusso edge", 9999.99, null],
};
const stationOfSubcategory = { vini: "bar", bevande: "bar" };
const menu = {};
const menuById = new Map();
for (const [key, [category, subcategory, name, price, stock]] of Object.entries(menuSpec)) {
  menu[key] = {
    key,
    id: uuid(),
    category,
    subcategory,
    name,
    price,
    stock,
    station: stationOfSubcategory[subcategory] ?? subcategory,
  };
  menuById.set(menu[key].id, menu[key]);
}
const line = (key, qty) => ({ id: menu[key].id, qty });

/** Righe d'ordine casuali: "food", "bar", "mixed" (almeno un piatto e una bevanda) o qualsiasi. */
function linesOf(kind = "any") {
  const pool = kind === "food" ? FOOD : kind === "bar" ? BAR : [...FOOD, ...BAR];
  const keys =
    kind === "mixed"
      ? [pick(FOOD), pick(BAR), ...shuffle([...FOOD, ...BAR]).slice(0, rnd(2))]
      : shuffle(pool).slice(0, 1 + rnd(3));
  return [...new Set(keys)].map((key) => line(key, 1 + rnd(3)));
}
const rowsOf = (order) =>
  order.lines.map((item) => ({
    ...item,
    station: menuById.get(item.id).station,
    food: menuById.get(item.id).category === "cibo",
  }));

// ---------------------------------------------------------------------------------------
// Registro dei risultati: round corrente, difetti per regola, avvisi di scorta.
// ---------------------------------------------------------------------------------------
const checks = [];
const findings = [];
const harnessErrors = [];
const stats = new Map();
let ctx = null; // round corrente
let initialStock = {}; // id prodotto -> scorta iniziale (null = illimitata)

const statsFor = (scenario) => {
  if (!stats.has(scenario))
    stats.set(scenario, {
      rounds: 0,
      calls: 0,
      ms: 0,
      failures: {},
      warnings: {},
      failedRounds: new Set(),
      outcomes: {},
    });
  return stats.get(scenario);
};

function record(rule, detail = {}, kind = "failure") {
  const scenarioStats = statsFor(ctx.scenario);
  const bucket = kind === "failure" ? scenarioStats.failures : scenarioStats.warnings;
  const entry = (bucket[rule] ??= { count: 0, rounds: [], samples: [] });
  entry.count += 1;
  if (!entry.rounds.includes(ctx.round)) entry.rounds.push(ctx.round);
  if (kind === "failure") scenarioStats.failedRounds.add(ctx.round);
  if (entry.samples.length < 3) entry.samples.push({ round: ctx.round, ...detail });
}
function expect(condition, rule, detail = {}) {
  if (!condition) record(rule, detail);
  return condition;
}

const isErr = (result, token) => messageOf(result.error).includes(token);
const summarize = (results) => results.map((result) => (result.error ? messageOf(result.error) : "ok"));
const successes = (results) => results.filter((result) => !result.error);
const must = (result, what = "setup") => {
  if (result.error) throw new Error(`${what}: ${result.error.message}`);
  return result;
};

// Errori di business documentati nelle funzioni: ogni altro errore è inatteso.
const documented =
  /claim_lost|order_not_available|order_already_claimed|reservation_expired|event_closed|kitchen_capacity_reached|kitchen_not_active|invalid_delivery_quantity|delivery_not_available|undo_window_expired|stock_unavailable|capacity_reached|request_id_conflict|public_order_rate_limit|ordering_paused|not_open_yet|ordering_closed/;

/** Ogni chiamata passa da qui: giornale del round. Gli errori si classificano a fine round (checkCallErrors). */
async function call(op, promise, meta = {}) {
  const result = await track(promise);
  const entry = {
    op,
    ...meta,
    ok: !result.error,
    code: result.error?.code ?? null,
    message: messageOf(result.error),
    data: result.data,
  };
  ctx.calls.push(entry);
  result.entry = entry;
  return result;
}

/** Controllo di validazione: l'errore atteso deve essere quello documentato, non un errore grezzo del database. */
async function probe(label, promise, token) {
  const result = await promise;
  result.entry.probe = label;
  const message = messageOf(result.error);
  const matches = token instanceof RegExp ? token.test(message) : message.includes(token);
  expect(Boolean(result.error) && matches, `validation ${label}`, {
    expected: token,
    got: result.error ? `${result.error.code} ${message}` : "success",
  });
  return result;
}

/** Deadlock ed errori fuori dall'elenco documentato (le chiamate di validazione sono già giudicate da probe). */
function checkCallErrors() {
  for (const entry of ctx.calls) {
    if (entry.ok) continue;
    if (entry.code === "40P01") record("deadlock", { op: entry.op, message: entry.message });
    else if (!entry.probe && !documented.test(entry.message) && !entry.allow?.test(entry.message))
      record(`unexpected_error ${entry.op} [${entry.code}] ${entry.message.slice(0, 70)}`, { op: entry.op });
  }
}

// ---------------------------------------------------------------------------------------
// Wrapper delle RPC (tutte registrate nel giornale).
// ---------------------------------------------------------------------------------------
function registerOrder(data, requestId, extra = {}) {
  const known = ctx.orders.get(data.order_id ?? data.id);
  const id = data.order_id ?? data.id;
  if (known && known.display !== Number(data.display_number))
    record("display_number_changed_on_retry", { order: id, first: known.display, now: data.display_number });
  if (known && known.mode && data.preparation_mode && known.mode !== data.preparation_mode)
    record("preparation_mode_changed_on_retry", { order: id, first: known.mode, retry: data.preparation_mode });
  if (requestId) {
    const previous = ctx.requests.get(requestId);
    if (previous && previous !== id) record("request_id_multiple_orders", { requestId, previous, now: id });
    ctx.requests.set(requestId, id);
  }
  ctx.orders.set(id, {
    display: Number(data.display_number),
    total: Number(data.total),
    mode: known?.mode ?? data.preparation_mode,
    ...extra,
  });
}

async function submit(lines, options = {}) {
  const {
    alias = "Edge test",
    notes = "",
    requestId = uuid(),
    qr = uuid(),
    mode = "immediate",
    recovery = null,
    bot = "",
    allow,
  } = options;
  const args = [
    lit(alias),
    lit(notes),
    jsonb(lines),
    lit(requestId),
    lit(qr),
    lit(bot),
    "null",
    lit(recovery),
    lit(mode),
  ];
  const result = await call("submit", rpc("submit_public_order", args, asService), { requestId, qr, allow });
  if (!result.error) registerOrder(result.data, requestId);
  return result;
}
async function counter(lines, { alias = "Edge counter", notes = "", mode = "immediate", user = asCassa, allow } = {}) {
  const result = await call(
    "counter",
    rpc("create_counter_order", [lit(alias), lit(notes), jsonb(lines), lit(mode)], user),
    { allow },
  );
  if (!result.error) {
    ctx.counterIds.add(result.data.id);
    registerOrder(result.data, null, { counter: true });
  }
  return result;
}
const claim = (order, device, station = "cassa_1", user = asCassa) =>
  call("claim", rpc("claim_order_for_station", [lit(order.id), lit(station), lit(device)], user), {
    orderId: order.id,
    station,
  });
const pay = (order, device, station = "cassa_1", user = asCassa) =>
  call("pay", rpc("pay_order_for_station", [lit(order.id), lit(station), lit(device)], user), { orderId: order.id });
const cancel = (order, device, station = "cassa_1", user = asCassa) =>
  call("cancel", rpc("cancel_order_for_station", [lit(order.id), lit(station), lit(device)], user), {
    orderId: order.id,
  });
const release = (order, device, station = "cassa_1", user = asCassa) =>
  call("release", rpc("release_order_for_station", [lit(order.id), lit(station), lit(device)], user), {
    orderId: order.id,
  });
const forceRelease = (order, user = asCassa) =>
  call("force_release", rpc("force_release_order", [lit(order.id)], user), { orderId: order.id });
const claimByQr = (qr, device, station = "cassa_1", user = asCassa) =>
  call("claim_qr", rpc("claim_order_by_qr_for_station", [lit(qr), lit(station), lit(device)], user), { station });
const prepare = (order, device, mode, station = "cassa_1", user = asCassa) =>
  call("prepare", rpc("set_order_preparation", [lit(order.id), lit(station), lit(device), lit(mode)], user), {
    orderId: order.id,
  });
const activate = (order, station = "cucina", user = asCook) =>
  call("activate", rpc("activate_kitchen_order", [lit(order.id), lit(station)], user), { orderId: order.id });
async function deliver(order, station, items, user = userFor(station), allow) {
  const result = await call(
    "deliver",
    rpc("deliver_fulfillment_items", [lit(order.id), lit(station), jsonb(items)], user),
    { orderId: order.id, station, allow },
  );
  if (!result.error) ctx.deliveries.push({ id: result.data.delivery_id, orderId: order.id, station, items });
  return result;
}
async function undo(deliveryId, station, user = userFor(station), allow) {
  const result = await call("undo", rpc("undo_fulfillment_delivery", [lit(deliveryId), lit(station)], user), {
    deliveryId,
    station,
    allow,
  });
  if (!result.error) ctx.undone.add(deliveryId);
  return result;
}
const closeEvent = () => call("close", rpc("close_order_event", [], asAdmin));
const statusRead = () => call("status", rpc("get_ordering_status", [], asPublic));
const catalogRead = () => call("catalog", rpc("get_ordering_catalog", [], asPublic));
const cashierList = () => call("cashier_list", rpc("get_cashier_pending_orders", [], asCassa));
const claimsList = () => call("claims_list", rpc("get_cashier_claims", [], asCassa));
const kitchenQueue = () => call("kitchen_queue", rpc("get_fulfillment_queue", [lit("cucina")], asCook));
const publicStatuses = (tokens) =>
  call("public_statuses", rpc("get_public_order_statuses", [`array[${tokens.map(lit).join(",")}]::text[]`], asPublic));

/** Chi fa scattare la scadenza pigra: stato, catalogo, nuovo invio, stati pubblici, coda cassa. */
const expiryTriggers = (qrs) => [
  statusRead,
  catalogRead,
  cashierList,
  () => submit([line("birra", 1)]),
  () => publicStatuses([qrs.length ? pick(qrs) : uuid()]),
];

const hasFood = (lines) => lines.some((item) => menuById.get(item.id).category === "cibo");
async function newOrder(
  lines,
  { mode = rng() < 0.25 && hasFood(lines) ? "deferred" : "immediate", requestId = uuid(), qr = uuid() } = {},
) {
  const result = must(await submit(lines, { mode, requestId, qr }), "submit_public_order");
  return { id: result.data.order_id, qr, requestId, lines, mode };
}
async function paidOrder(lines, mode = "immediate") {
  const order = await newOrder(lines, { mode });
  const device = uuid();
  must(await claim(order, device), "claim");
  must(await pay(order, device), "pay");
  return { ...order, device };
}

// ---------------------------------------------------------------------------------------
// Orologio simulato: si sposta created_at / expires_at nel database.
// ---------------------------------------------------------------------------------------
const idList = (ids) => `array[${ids.map(lit).join(",")}]::uuid[]`;
/** created_at = ora - 60 minuti - extraMs: extraMs>0 è già scaduto, <0 scade tra |extraMs| ms. */
const ageOrders = (ids, extraMs = 60_000) =>
  admin_sql(
    `update public.orders set created_at = clock_timestamp() - interval '60 minutes' - interval '${extraMs} milliseconds' where id = any(${idList(ids)})`,
  );
const setClaimExpiry = (ids, ms) =>
  admin_sql(
    `update public.order_claim_devices set expires_at = clock_timestamp() + interval '${ms} milliseconds' where order_id = any(${idList(ids)})`,
  );
const ageDeliveries = (ids, minutes) =>
  admin_sql(
    `update public.fulfillment_deliveries set created_at = now() - interval '${minutes} minutes' where id = any(${idList(ids)})`,
  );
async function orderStates() {
  const rows = await admin_sql(
    "select coalesce(json_agg(json_build_object('id', id, 'status', status, 'eff', coalesce(report_status, status), 'kitchen', kitchen_state, 'mode', preparation_mode, 'display', display_number, 'total', total)), '[]') from public.orders",
  );
  return new Map((rows ?? []).map((row) => [row.id, row]));
}
const callsFor = (orderId, op) => ctx.calls.filter((entry) => entry.orderId === orderId && entry.op === op);

// ---------------------------------------------------------------------------------------
// Tecnica delle gare: gate sul lock evento + raffica con ritardi casuali.
// ---------------------------------------------------------------------------------------
async function gated(work) {
  if (rng() < 0.3) return work();
  const hold = 120 + rnd(240);
  const gate = track(
    sql(
      `begin;\nselect 1 from public.order_events where is_current for update;\nselect pg_sleep(${hold / 1000});\ncommit;`,
    ),
  );
  await wait(70);
  const result = await work();
  await gate;
  return result;
}
function burst(functions, spread = 45) {
  const delays = functions.map(() => rnd(spread));
  return Promise.all(
    functions.map(async (fn, index) => {
      await wait(delays[index]);
      return fn();
    }),
  );
}

// ---------------------------------------------------------------------------------------
// Fixture e reset.
// ---------------------------------------------------------------------------------------
async function setup() {
  await installSchema();
  const roles = Object.entries(people);
  await admin_sql(`insert into auth.users values ${roles.map(([, id]) => `(${lit(id)})`).join(", ")};
${roles
  .filter(([role]) => role !== "pending")
  .map(([role, id]) => `update public.profiles set role = ${lit(role)} where id = ${lit(id)};`)
  .join("\n")}
insert into public.menu_items (id, category, subcategory, name, price, available_portions, stock_capacity) values
${Object.values(menu)
  .map(
    (item) =>
      `  (${lit(item.id)}, ${lit(item.category)}, ${lit(item.subcategory)}, ${lit(item.name)}, ${item.price}, ${item.stock ?? "null"}, ${item.stock ?? "null"})`,
  )
  .join(",\n")};`);
  // Il QR di recupero derivato in JavaScript deve coincidere con quello della funzione SQL.
  const probeToken = randomBytes(32).toString("base64url");
  const probeRequest = uuid();
  const sqlQr = await admin_sql(
    `select json_build_object('qr', public.recovery_order_qr(${lit(probeToken)}, ${lit(probeRequest)}))`,
  );
  if (sqlQr.qr !== recoveryQr(probeToken, probeRequest))
    throw new Error("recoveryQr JavaScript diverso da recovery_order_qr SQL: test non affidabile.");
}

function recoveryQr(token, request) {
  const h = createHmac("sha256", token).update(request).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function resetEvent({ limit = 100, stock = {}, evenings = 1 } = {}) {
  await drain();
  initialStock = Object.fromEntries(
    Object.values(menu).map((item) => [item.id, stock[item.key] === undefined ? item.stock : stock[item.key]]),
  );
  const values = Object.entries(initialStock)
    .map(([id, value]) => `(${lit(id)}::uuid, ${value === null ? "null" : value}::integer)`)
    .join(", ");
  await admin_sql(`truncate public.orders cascade;
delete from public.order_events where not is_current;
update public.order_events set opens_at = now() - interval '1 minute', closes_at = now() + interval '2 hours',
  manual_closed = false, permanently_closed_at = null, final_report = null, max_pending_orders = ${limit}, evening_count = ${evenings}
  where is_current;
update public.menu_items m set available_portions = v.stock, stock_capacity = v.stock from (values ${values}) v(id, stock) where m.id = v.id;`);
}

// ---------------------------------------------------------------------------------------
// Invarianti: tutto ciò che deve valere dopo OGNI round.
// ---------------------------------------------------------------------------------------
const PAID = "('pagato', 'ritiro_parziale', 'consegnato')";
const stockSql = `select coalesce(json_agg(json_build_object('id', m.id, 'available', m.available_portions, 'held', coalesce(h.q, 0))), '[]')
  from public.menu_items m left join (
    select (l->>'id')::uuid id, sum((l->>'qty')::integer) q from public.orders o
    cross join lateral jsonb_array_elements(o.items) l where o.status <> 'annullato' group by 1) h on h.id = m.id`;

async function checkInvariants() {
  for (const row of (await admin_sql(invariantSql)) ?? []) record(row.rule, { ref: row.ref, detail: row.detail });
  for (const row of (await admin_sql(stockSql)) ?? []) {
    const initial = initialStock[row.id];
    if (initial === null || initial === undefined) continue;
    const expected = initial - Number(row.held);
    if (Number(row.available) !== expected)
      record(
        "stock_drift",
        { item: menuById.get(row.id)?.key, available: row.available, expected, initial, held: row.held },
        "warning",
      );
  }
}

/** Esito delle chiamate riuscite contro lo stato finale: un pagamento riuscito non si perde né si duplica. */
async function checkOutcomes() {
  const states = await orderStates();
  const perOrder = new Map();
  for (const entry of ctx.calls) {
    if (!entry.ok || !entry.orderId || (entry.op !== "pay" && entry.op !== "cancel")) continue;
    const counts = perOrder.get(entry.orderId) ?? { pay: 0, cancel: 0 };
    counts[entry.op] += 1;
    perOrder.set(entry.orderId, counts);
  }
  const paidStatuses = new Set(["pagato", "ritiro_parziale", "consegnato"]);
  for (const [id, known] of ctx.orders) {
    const state = states.get(id);
    if (!state) {
      record("order_returned_but_missing", { order: id });
      continue;
    }
    const counts = perOrder.get(id) ?? { pay: 0, cancel: 0 };
    if (counts.pay > 1) record("pay_succeeded_twice", { order: id, successes: counts.pay });
    if (counts.pay + counts.cancel > 1) record("pay_and_cancel_both_succeeded", { order: id, ...counts });
    if (counts.pay === 1 && !paidStatuses.has(state.eff))
      record("successful_pay_lost", { order: id, final: state.eff });
    if (counts.cancel === 1 && state.eff !== "annullato")
      record("successful_cancel_lost", { order: id, final: state.eff });
    if (!known.counter && counts.pay === 0 && paidStatuses.has(state.eff))
      record("paid_without_successful_pay", { order: id, final: state.eff });
    if (known.display !== Number(state.display))
      record("returned_display_number_differs", { order: id, returned: known.display, stored: state.display });
    if (known.total !== Number(state.total))
      record("returned_total_differs", { order: id, returned: known.total, stored: state.total });
    const prepared = ctx.calls.some((entry) => entry.op === "prepare" && entry.orderId === id);
    if (known.mode && !prepared && known.mode !== state.mode)
      record("returned_preparation_mode_differs", { order: id, returned: known.mode, stored: state.mode });
  }
}

/** Consegne riuscite meno annulli riusciti devono coincidere con le quantità consegnate nel database. */
async function checkDeliveryJournal() {
  const expected = new Map();
  for (const delivery of ctx.deliveries) {
    if (ctx.undone.has(delivery.id)) continue;
    for (const item of delivery.items) {
      const key = `${delivery.orderId}/${item.id}`;
      expected.set(key, (expected.get(key) ?? 0) + Number(item.qty));
    }
  }
  const rows =
    (await admin_sql(
      "select coalesce(json_agg(json_build_object('k', order_id::text || '/' || menu_item_id::text, 'd', delivered_quantity)), '[]') from public.order_fulfillment_items",
    )) ?? [];
  for (const row of rows)
    if ((expected.get(row.k) ?? 0) !== Number(row.d))
      record("delivery_journal_mismatch", { item: row.k, db: row.d, journal: expected.get(row.k) ?? 0 });
}

/** Quante volte ogni operazione ha avuto ciascun esito: prova che le gare si sono davvero verificate. */
function tally() {
  const { outcomes } = statsFor(ctx.scenario);
  for (const entry of ctx.calls) {
    const key = `${entry.probe ? "probe:" : ""}${entry.op}:${entry.ok ? "ok" : entry.message.split(":")[0].slice(0, 36)}`;
    outcomes[key] = (outcomes[key] ?? 0) + 1;
  }
}

/** Ciò che vede il pubblico (stato e avanzamento per postazione) deve coincidere con il database. */
async function checkPublicView() {
  const event = await admin_sql(
    "select json_build_object('open', not bool_or(permanently_closed_at is not null)) from public.order_events where is_current",
  );
  const qrs = [
    ...new Set(ctx.calls.filter((entry) => entry.op === "submit" && entry.ok).map((entry) => entry.qr)),
  ].slice(0, 50);
  if (!event?.open || qrs.length === 0) return;
  const read = await publicStatuses(qrs);
  if (read.error) return record("public_statuses_failed", { error: read.error });
  const ids = read.data.map((row) => row.order_id);
  const rows =
    (await admin_sql(`select coalesce(json_agg(json_build_object('id', o.id, 'status', o.status, 'kitchen', o.kitchen_state, 'progress', coalesce((
      select json_agg(json_build_object('station', station, 'quantity', q, 'delivered', d) order by station)
      from (select station, sum(quantity)::integer q, sum(delivered_quantity)::integer d from public.order_fulfillment_items where order_id = o.id group by station) g), '[]'::json))), '[]')
      from public.orders o where o.id = any(${idList(ids)})`)) ?? [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const row of read.data) {
    const db = byId.get(row.order_id);
    const same =
      db &&
      db.status === row.status &&
      db.kitchen === row.kitchen_state &&
      JSON.stringify(db.progress) === JSON.stringify(row.progress);
    if (!same)
      record("public_status_differs_from_database", {
        order: row.order_id,
        public: [row.status, row.kitchen_state, row.progress],
        db: db ? [db.status, db.kitchen, db.progress] : null,
      });
  }
}

async function endRound() {
  checkCallErrors();
  await checkPublicView();
  await checkOutcomes();
  await checkDeliveryJournal();
  await checkInvariants();
  tally();
}

/** Chiude i controlli di una parte del round e azzera il giornale prima di un nuovo resetEvent. */
async function checkpoint() {
  await endRound();
  statsFor(ctx.scenario).calls += ctx.calls.length;
  Object.assign(ctx, {
    calls: [],
    orders: new Map(),
    requests: new Map(),
    deliveries: [],
    undone: new Set(),
    counterIds: new Set(),
  });
}

async function runScenario(name, body, count = rounds) {
  if (!selectedScenarios.has(name)) return;
  const scenarioStats = statsFor(name);
  for (let round = 1; round <= count; round += 1) {
    if (performance.now() > deadline) {
      scenarioStats.skipped = count - round + 1;
      break;
    }
    ctx = {
      scenario: name,
      round,
      calls: [],
      orders: new Map(),
      requests: new Map(),
      deliveries: [],
      undone: new Set(),
      counterIds: new Set(),
    };
    const started = performance.now();
    try {
      await body(round);
      await endRound();
    } catch (error) {
      harnessErrors.push({
        scenario: name,
        round,
        error: String(error?.stack ?? error)
          .split("\n")
          .slice(0, 4)
          .join(" | "),
      });
    }
    await drain();
    scenarioStats.rounds += 1;
    scenarioStats.calls += ctx.calls.length;
    scenarioStats.ms += performance.now() - started;
  }
}

// ---------------------------------------------------------------------------------------
// 1. Casse: due postazioni sullo stesso ordine, scadenza e rinnovo, pagamento contro
//    annullo, doppio pagamento, dispositivo sbagliato. Ogni variante gira su un ordine suo,
//    tutte insieme, passo dopo passo.
// ---------------------------------------------------------------------------------------
const cashVariants = {
  async twoDesks() {
    const order = await newOrder(linesOf("any"));
    const [a, b, c] = [uuid(), uuid(), uuid()];
    const v = { order };
    v.steps = [
      async () =>
        (v.claims = await burst([
          () => claim(order, a, "cassa_1"),
          () => claim(order, b, "cassa_2"),
          () => claim(order, c, "cassa_1"),
        ])),
      async () =>
        (v.pays = await burst([
          () => pay(order, a, "cassa_1"),
          () => pay(order, b, "cassa_2"),
          () => pay(order, c, "cassa_1"),
        ])),
    ];
    v.verify = () => {
      const won = successes(v.claims);
      expect(
        won.length >= 1 && new Set(won.map((result) => result.data.claimed_station)).size === 1,
        "two_desks_claim_not_exclusive",
        { claims: summarize(v.claims) },
      );
      expect(
        v.claims.every((result) => !result.error || isErr(result, "order_already_claimed")),
        "two_desks_unexpected_claim_error",
        { claims: summarize(v.claims) },
      );
      expect(
        successes(v.pays).length === 1 && v.pays.every((result) => !result.error || isErr(result, "claim_lost")),
        "two_desks_pay_not_single",
        { pays: summarize(v.pays) },
      );
    };
    return v;
  },

  async expiryRenew() {
    const order = await newOrder(linesOf("mixed"));
    const [a, b] = [uuid(), uuid()];
    const v = { order };
    v.steps = [
      async () => (v.first = await claim(order, a)),
      async () => {
        await setClaimExpiry([order.id], -1000); // i 30 secondi del claim sono passati
        v.late = await Promise.all([pay(order, a), cancel(order, a)]);
        v.afterLate = (await orderStates()).get(order.id)?.status;
      },
      async () => (v.race = await burst([() => claim(order, a, "cassa_1"), () => claim(order, b, "cassa_2")])),
      async () => {
        v.renewed = Number(
          await admin_sql(
            `select count(*) from public.order_claim_devices where order_id = ${lit(order.id)} and expires_at > now() + interval '20 seconds'`,
          ),
        );
        v.pays = await burst([() => pay(order, a, "cassa_1"), () => pay(order, b, "cassa_2")]);
      },
    ];
    v.verify = () => {
      expect(!v.first.error, "renew_first_claim_failed", { error: v.first.error });
      expect(
        v.late.every((result) => isErr(result, "claim_lost")) && v.afterLate === "in_attesa_pagamento",
        "pay_or_cancel_after_expired_claim_not_refused",
        { late: summarize(v.late), after: v.afterLate },
      );
      const won = successes(v.race);
      expect(
        won.length >= 1 && new Set(won.map((result) => result.data.claimed_station)).size === 1,
        "renew_race_not_exclusive",
        { race: summarize(v.race) },
      );
      expect(
        v.race.every((result) => !result.error || isErr(result, "order_already_claimed")),
        "renew_race_unexpected_error",
        { race: summarize(v.race) },
      );
      expect(v.renewed >= 1, "claim_renewal_did_not_extend_expiry", { rows: v.renewed });
      expect(
        successes(v.pays).length === 1 && v.pays.every((result) => !result.error || isErr(result, "claim_lost")),
        "renew_pay_not_single",
        { pays: summarize(v.pays) },
      );
    };
    return v;
  },

  async payVsCancel() {
    const order = await newOrder(linesOf("any"));
    const [a, b] = [uuid(), uuid()];
    const v = { order };
    v.steps = [
      async () => (v.claims = await Promise.all([claim(order, a), claim(order, b)])),
      async () =>
        (v.race = await burst([
          () => pay(order, a),
          () => pay(order, b),
          () => cancel(order, a),
          () => cancel(order, b),
          () => pay(order, a),
        ])),
    ];
    v.verify = () => {
      expect(
        v.claims.every((result) => !result.error),
        "two_devices_same_station_claim_failed",
        { claims: summarize(v.claims) },
      );
      expect(
        successes(v.race).length === 1 && v.race.every((result) => !result.error || isErr(result, "claim_lost")),
        "pay_vs_cancel_not_single_winner",
        { race: summarize(v.race) },
      );
    };
    return v;
  },

  async doublePay() {
    const order = await newOrder(linesOf("any"));
    const a = uuid();
    const v = { order };
    v.steps = [
      async () => (v.claim = await claim(order, a)),
      async () =>
        (v.pays = await burst(
          [() => pay(order, a), () => pay(order, a), () => pay(order, a), () => pay(order, a)],
          20,
        )),
      async () => (v.after = await Promise.all([pay(order, a), cancel(order, a), claim(order, a)])),
    ];
    v.verify = () => {
      expect(
        successes(v.pays).length === 1 && v.pays.every((result) => !result.error || isErr(result, "claim_lost")),
        "double_pay_not_single",
        { pays: summarize(v.pays) },
      );
      expect(
        isErr(v.after[0], "claim_lost") && isErr(v.after[1], "claim_lost") && isErr(v.after[2], "order_not_available"),
        "operations_after_pay_not_refused",
        { after: summarize(v.after) },
      );
    };
    return v;
  },

  async wrongDevice() {
    const order = await newOrder(linesOf("any"));
    const [a, b] = [uuid(), uuid()];
    const v = { order };
    v.steps = [
      async () => {
        v.claim = await claim(order, a);
        await Promise.all([
          probe("claim_short_device", claim(order, "corto"), "invalid_device"),
          probe(
            "claim_null_device",
            call("claim", rpc("claim_order_for_station", [lit(order.id), lit("cassa_1"), "null"], asCassa)),
            "invalid_device",
          ),
          probe("claim_bad_station", claim(order, uuid(), "cassa_9"), "invalid_station"),
          probe(
            "claim_null_station",
            call("claim", rpc("claim_order_for_station", [lit(order.id), "null", lit(uuid())], asCassa)),
            "invalid_station",
          ),
        ]);
      },
      async () => {
        v.wrong = await Promise.all([
          pay(order, b),
          pay(order, a, "cassa_2"),
          cancel(order, b),
          call("pay", rpc("pay_order_for_station", [lit(order.id), lit("cassa_1"), "null"], asCassa), {
            orderId: order.id,
          }),
        ]);
        await Promise.all([
          probe("pay_as_cook", pay(order, a, "cassa_1", asCook), "not_authorized"),
          probe("cancel_as_bar", cancel(order, a, "cassa_1", asBar), "not_authorized"),
          probe("claim_as_pending_role", claim(order, uuid(), "cassa_1", asPending), "not_authorized"),
          probe("pay_as_anon", pay(order, a, "cassa_1", asPublic), "permission denied"),
        ]);
        v.stillPending = (await orderStates()).get(order.id)?.status;
      },
      async () => (v.final = await pay(order, a)),
    ];
    v.verify = () => {
      expect(!v.claim.error, "wrong_device_first_claim_failed", { error: v.claim.error });
      expect(
        v.wrong.every((result) => isErr(result, "claim_lost")) && v.stillPending === "in_attesa_pagamento",
        "wrong_device_or_station_accepted",
        { wrong: summarize(v.wrong), status: v.stillPending },
      );
      expect(!v.final.error, "right_device_pay_failed_after_wrong_attempts", { error: v.final.error });
    };
    return v;
  },

  async qrClaim() {
    const order = await newOrder(linesOf("any"));
    const [a, b] = [uuid(), uuid()];
    const v = { order };
    v.steps = [
      async () => {
        const [first, second] = await burst([
          () => claimByQr(order.qr, a, "cassa_1"),
          () => claimByQr(order.qr, b, "cassa_3"),
        ]);
        v.claims = [first, second];
        await Promise.all([
          probe("claim_qr_short", claimByQr("corto", uuid()), "invalid_qr_token"),
          claimByQr(uuid(), uuid()).then((result) =>
            expect(isErr(result, "order_not_available"), "claim_unknown_qr_not_refused", { error: result.error }),
          ),
        ]);
      },
      async () => (v.pays = await burst([() => pay(order, a, "cassa_1"), () => pay(order, b, "cassa_3")])),
    ];
    v.verify = () => {
      const won = successes(v.claims);
      expect(
        won.length === 1 && v.claims.every((result) => !result.error || isErr(result, "order_already_claimed")),
        "qr_claim_not_exclusive",
        { claims: summarize(v.claims) },
      );
      expect(successes(v.pays).length === 1, "qr_claim_pay_not_single", { pays: summarize(v.pays) });
    };
    return v;
  },

  async releaseRace() {
    const order = await newOrder(linesOf("any"));
    const [a, b] = [uuid(), uuid()];
    const v = { order };
    v.steps = [
      async () => (v.first = await claim(order, a)),
      async () =>
        (v.race = await burst([
          () => release(order, a),
          () => claim(order, b, "cassa_2"),
          () => pay(order, a),
          () => forceRelease(order),
        ])),
      async () => (v.last = await pay(order, b, "cassa_2")),
    ];
    v.verify = () => {
      expect(
        v.race.every((result) => !result.error || documented.test(messageOf(result.error))),
        "release_race_unexpected_error",
        { race: summarize(v.race) },
      );
    };
    return v;
  },

  async togglePreparation() {
    const order = await newOrder(linesOf("mixed"), { mode: "immediate" });
    const a = uuid();
    const v = { order };
    v.steps = [
      async () => (v.first = await claim(order, a)),
      async () =>
        (v.race = await burst(
          [
            () => prepare(order, a, "deferred"),
            () => prepare(order, a, "immediate"),
            () => pay(order, a),
            () => prepare(order, a, "deferred"),
            () => prepare(order, a, "immediate"),
          ],
          50,
        )),
      async () => (v.last = await pay(order, a)),
    ];
    v.verify = () => {
      expect(
        successes(v.race.filter((result) => result.entry.op === "pay")).length + (v.last.error ? 0 : 1) === 1,
        "toggle_preparation_pay_not_single",
        { race: summarize(v.race), last: v.last.error?.message ?? "ok" },
      );
      expect(
        v.race.every((result) => !result.error || isErr(result, "claim_lost")),
        "toggle_preparation_unexpected_error",
        { race: summarize(v.race) },
      );
    };
    return v;
  },

  async multiDevice() {
    const order = await newOrder(linesOf("any"));
    const [a, b] = [uuid(), uuid()];
    const v = { order };
    v.steps = [
      async () => (v.claims = await Promise.all([claim(order, a), claim(order, b)])),
      async () => (v.first = await pay(order, a)),
      async () => (v.second = await Promise.all([pay(order, b), cancel(order, b)])),
    ];
    v.verify = () => {
      expect(v.claims.every((result) => !result.error) && !v.first.error, "multi_device_same_station_refused", {
        claims: summarize(v.claims),
        pay: v.first.error,
      });
      expect(
        v.second.every((result) => isErr(result, "claim_lost")),
        "second_device_acted_after_pay",
        { second: summarize(v.second) },
      );
    };
    return v;
  },
};

/** Ruoli sbagliati e utenti anonimi: nessuna RPC dello staff deve rispondere, e nessuna deve cambiare stato. */
function authorizationProbes() {
  const staff = [
    ["close_order_event", []],
    ["get_order_event_report", []],
    ["get_order_event_snapshot", []],
    ["get_cashier_pending_orders", []],
    ["get_cashier_claims", []],
    ["set_ordering_paused", ["true"]],
    ["force_release_order", [lit(uuid())]],
    ["create_counter_order", [lit("Abusivo"), lit(""), jsonb([line("acqua", 1)]), lit("immediate")]],
    ["deliver_fulfillment_items", [lit(uuid()), lit("birre"), jsonb([line("birra", 1)])]],
    ["undo_fulfillment_delivery", [lit(uuid()), lit("birre")]],
    ["get_fulfillment_queue", [lit("birre")]],
  ];
  const probes = [];
  for (const [name, args] of staff) {
    probes.push(probe(`anon_${name}`, call(name, rpc(name, args, asPublic)), "permission denied"));
    // Gli utenti senza ruolo, e i ruoli di altre aree, ricevono not_authorized (o l'errore del ruolo giusto per le RPC di evasione).
    const wrongRoles =
      name.includes("fulfillment") || name.includes("undo") ? ["cassa", "pending"] : ["cucina", "bar", "pending"];
    for (const role of wrongRoles)
      probes.push(probe(`${role}_${name}`, call(name, rpc(name, args, as(role))), "not_authorized"));
  }
  probes.push(
    probe(
      "anon_submit_public_order",
      call(
        "submit",
        rpc(
          "submit_public_order",
          [lit("Abusivo"), lit(""), jsonb([line("acqua", 1)]), lit(uuid()), lit(uuid()), lit("")],
          asPublic,
        ),
      ),
      "permission denied",
    ),
  );
  probes.push(
    probe(
      "authenticated_submit_public_order",
      call(
        "submit",
        rpc(
          "submit_public_order",
          [lit("Abusivo"), lit(""), jsonb([line("acqua", 1)]), lit(uuid()), lit(uuid()), lit("")],
          asAdmin,
        ),
      ),
      "permission denied",
    ),
  );
  return probes;
}

async function cashRound() {
  await resetEvent();
  const kinds = Object.keys(cashVariants);
  const names = shuffle([...kinds, "payVsCancel", "payVsCancel", "doublePay", "twoDesks", pick(kinds)]);
  const variants = await Promise.all(names.map((name) => cashVariants[name]()));
  const readers = [statusRead, cashierList, claimsList];
  const longest = Math.max(...variants.map((variant) => variant.steps.length));
  for (let index = 0; index < longest; index += 1) {
    const noise = burst(
      Array.from({ length: 4 }, () => pick(readers)),
      120,
    ); // la coda cassa pulisce i claim mentre le altre RPC li usano
    await gated(() =>
      Promise.all([
        noise,
        ...(index === 0 ? authorizationProbes() : []),
        ...variants.map((variant) => variant.steps[index]?.()),
      ]),
    );
  }
  for (const variant of variants) variant.verify();
}

// ---------------------------------------------------------------------------------------
// 2. Annullo: scorta rilasciata una volta sola; annullo contro scadenza.
// ---------------------------------------------------------------------------------------
async function cancelRound() {
  await resetEvent({ stock: { birra: 24 + rnd(8) } });
  const orders = await Promise.all(
    range(8).map(() => newOrder([line("birra", 1 + rnd(3)), ...(rng() < 0.5 ? [line(pick(FOOD), 1 + rnd(2))] : [])])),
  );
  const devices = orders.map(() => [uuid(), uuid()]);
  await gated(() =>
    Promise.all(orders.flatMap((order, index) => devices[index].map((device) => claim(order, device)))),
  );
  const pure = orders.slice(0, 4);
  const racing = orders.slice(4);
  // Gruppo B: ordine vecchio di oltre 60 minuti e claim che scade tra pochi millisecondi.
  await ageOrders(racing.map((order) => order.id));
  await Promise.all(racing.map((order) => setClaimExpiry([order.id], rnd(150))));
  const qrs = orders.map((order) => order.qr);
  const plan = [
    ...pure.flatMap((order, index) => [0, 1, 0, 1].map((slot) => () => cancel(order, devices[index][slot]))),
    ...racing.flatMap((order, index) => [0, 1].map((slot) => () => cancel(order, devices[4 + index][slot]))),
    ...range(5).map(() => pick(expiryTriggers(qrs))),
  ];
  await gated(() => burst(plan, 160));
  await wait(220); // anche il claim più lungo è scaduto
  await statusRead(); // la scadenza pigra chiude ciò che l'annullo non ha preso
  const states = await orderStates();
  for (const order of pure) {
    const results = callsFor(order.id, "cancel");
    expect(
      results.filter((entry) => entry.ok).length === 1 &&
        results.every((entry) => entry.ok || entry.message.includes("claim_lost")),
      "cancel_not_single",
      { cancels: results.map((entry) => entry.message || "ok") },
    );
    expect(states.get(order.id)?.status === "annullato", "cancelled_order_not_annullato", {
      status: states.get(order.id)?.status,
    });
  }
  for (const order of racing) {
    expect(callsFor(order.id, "cancel").filter((entry) => entry.ok).length <= 1, "cancel_vs_expiry_cancel_twice", {
      order: order.id,
    });
    expect(states.get(order.id)?.status === "annullato", "expired_or_cancelled_order_still_pending", {
      status: states.get(order.id)?.status,
    });
  }
}

// ---------------------------------------------------------------------------------------
// 3. Scadenza a 60 minuti: durante il pagamento, durante la presa in carico, con molti
//    chiamanti che la fanno scattare insieme.
// ---------------------------------------------------------------------------------------
async function expiryRound() {
  await resetEvent({ stock: { birra: 400 } });
  const make = () => newOrder([line("birra", 1 + rnd(2)), ...(rng() < 0.4 ? [line(pick(FOOD), 1)] : [])]);
  const [claimedAged, expiring, unclaimed, fresh, boundary] = await Promise.all(
    [4, 3, 3, 2, 4].map((count) => Promise.all(range(count).map(make))),
  );
  const device = new Map([...claimedAged, ...expiring].map((order) => [order.id, uuid()]));
  await Promise.all([...claimedAged, ...expiring].map((order) => claim(order, device.get(order.id))));
  // Claim ancora valido: l'ordine supera i 60 minuti proprio mentre viene pagato.
  await Promise.all(claimedAged.map((order) => ageOrders([order.id], rnd(190) - 150)));
  // Claim che scade nello stesso istante in cui parte il pagamento.
  await Promise.all(
    expiring.map(async (order) => {
      await ageOrders([order.id], 5000);
      await setClaimExpiry([order.id], rnd(120));
    }),
  );
  await ageOrders(
    unclaimed.map((order) => order.id),
    1000 + rnd(1000),
  );
  // Ordini che compiono 60 minuti mentre la cassa li prende in carico: se la presa in carico riesce, il pagamento deve riuscire.
  await Promise.all(boundary.map((order) => ageOrders([order.id], rnd(200) - 100)));
  const everyone = [...claimedAged, ...expiring, ...unclaimed, ...fresh, ...boundary];
  const qrs = everyone.map((order) => order.qr);
  const plan = [
    ...claimedAged.map((order) => () => pay(order, device.get(order.id))),
    ...expiring.map((order) => () => pay(order, device.get(order.id))),
    ...unclaimed.map((order) => () => claim(order, uuid(), "cassa_2")),
    ...boundary.map((order) => async () => {
      const device = uuid();
      const claimed = await claim(order, device, "cassa_2");
      if (!claimed.error) await pay(order, device, "cassa_2");
    }),
    ...range(22).map(() => pick(expiryTriggers(qrs))),
  ];
  await gated(() => burst(plan, 110));
  await wait(200);
  await statusRead();
  const states = await orderStates();
  for (const order of claimedAged) {
    const pays = callsFor(order.id, "pay");
    expect(pays.filter((entry) => entry.ok).length === 1, "pay_lost_to_expiry_with_active_claim", {
      pays: pays.map((entry) => entry.message || "ok"),
      status: states.get(order.id)?.status,
    });
  }
  for (const order of expiring) {
    const paid = callsFor(order.id, "pay").some((entry) => entry.ok);
    expect(states.get(order.id)?.eff === (paid ? "pagato" : "annullato"), "expiring_claim_inconsistent_outcome", {
      paid,
      status: states.get(order.id)?.status,
    });
  }
  for (const order of unclaimed) {
    expect(
      callsFor(order.id, "claim").every(
        (entry) => !entry.ok && /reservation_expired|order_not_available/.test(entry.message),
      ),
      "claim_on_expired_order_not_refused",
      { claims: callsFor(order.id, "claim").map((entry) => entry.message || "ok") },
    );
    expect(states.get(order.id)?.status === "annullato", "unclaimed_old_order_not_expired", {
      status: states.get(order.id)?.status,
    });
  }
  for (const order of boundary) {
    const claimed = callsFor(order.id, "claim");
    const paid = callsFor(order.id, "pay");
    expect(
      claimed.every((entry) => entry.ok)
        ? paid.every((entry) => entry.ok) && paid.length === 1
        : claimed.every((entry) => /reservation_expired|order_not_available/.test(entry.message)),
      "claim_near_60_minutes_then_pay_inconsistent",
      { claim: claimed.map((entry) => entry.message || "ok"), pay: paid.map((entry) => entry.message || "ok") },
    );
    expect(
      states.get(order.id)?.eff === (paid.some((entry) => entry.ok) ? "pagato" : "annullato"),
      "claim_near_60_minutes_wrong_final_state",
      { status: states.get(order.id)?.status, paid: paid.some((entry) => entry.ok) },
    );
  }
  for (const order of fresh)
    expect(states.get(order.id)?.status === "in_attesa_pagamento", "fresh_order_touched_by_expiry", {
      status: states.get(order.id)?.status,
    });

  // Molti chiamanti insieme su molti ordini scaduti (più alcuni con claim vivo che devono restare).
  const old = await Promise.all(range(12).map(make));
  const guarded = await Promise.all(range(5).map(make));
  await Promise.all(guarded.map((order) => claim(order, uuid())));
  await ageOrders(
    [...old, ...guarded].map((order) => order.id),
    2000,
  );
  await gated(() =>
    burst(
      range(32).map(() => pick(expiryTriggers([...old, ...guarded].map((order) => order.qr)))),
      120,
    ),
  );
  const flood = await orderStates();
  for (const order of old)
    expect(flood.get(order.id)?.status === "annullato", "flood_expiry_missed_order", {
      status: flood.get(order.id)?.status,
    });
  for (const order of guarded)
    expect(flood.get(order.id)?.status === "in_attesa_pagamento", "flood_expiry_cancelled_claimed_order", {
      status: flood.get(order.id)?.status,
    });
}

// ---------------------------------------------------------------------------------------
// 4. Evasione: ritiro parziale su più postazioni, due dispositivi sulla stessa voce,
//    annullo di consegna (anche contro una nuova consegna), consegna differita.
// ---------------------------------------------------------------------------------------
async function fulfillmentRound() {
  await resetEvent();
  const modes = ["immediate", "immediate", "immediate", "deferred", "deferred"];
  const orders = await Promise.all(
    modes.map((mode) =>
      paidOrder(
        [
          line("birra", 2 + rnd(3)),
          line("drink", 1 + rnd(2)),
          line("vino", 1 + rnd(2)),
          line(pick(["primo", "secondo"]), 1 + rnd(3)),
          line(pick(["dolce", "contorno", "furgone"]), 1 + rnd(2)),
        ],
        mode,
      ),
    ),
  );
  const food = (order) => rowsOf(order).filter((row) => row.food);

  // Passo 1: più sessioni consegnano le stesse voci insieme, con quantità spesso eccessive.
  const attempts = orders.flatMap((order) =>
    rowsOf(order).flatMap((row) =>
      range(1 + rnd(3)).map(() => {
        const qty = 1 + rnd(row.qty);
        return () => deliver(order, row.station, [{ id: row.id, qty }]);
      }),
    ),
  );
  const deferred = orders.filter((order) => order.mode === "deferred");
  attempts.push(...deferred.flatMap((order) => [() => activate(order), () => activate(order)]));
  const first = orders[0];
  const wrongStation = rowsOf(first).find((row) => row.station === "birre");
  attempts.push(
    () =>
      probe(
        "deliver_wrong_role",
        deliver(first, "birre", [{ id: menu.birra.id, qty: 1 }], asCook, /./),
        "not_authorized",
      ),
    () =>
      probe(
        "deliver_cucina_station",
        deliver(first, "cucina", [{ id: menu.primo.id, qty: 1 }], asCook, /./),
        "not_authorized",
      ),
    () =>
      probe(
        "deliver_zero_qty",
        deliver(first, "birre", [{ id: menu.birra.id, qty: 0 }], asBar, /./),
        "invalid_delivery",
      ),
    () =>
      probe(
        "deliver_item_of_other_station",
        deliver(first, "drinks", [{ id: wrongStation.id, qty: 1 }], asBar, /./),
        /invalid_delivery_quantity|order_not_available/,
      ),
    () =>
      probe(
        "deliver_malformed_id",
        deliver(first, "birre", [{ id: "-".repeat(36), qty: 1 }], asBar, /./),
        "invalid_delivery",
      ),
    () =>
      probe(
        "deliver_huge_qty",
        deliver(first, "birre", [{ id: menu.birra.id, qty: "99999999999" }], asBar, /./),
        "invalid_delivery",
      ),
  );
  await gated(() => burst(shuffle(attempts), 110));
  await checkDeliveryJournal();

  // Passo 2: annullo di consegna contro nuova consegna sulla stessa voce; finestra dei 5 minuti.
  const done = ctx.deliveries.filter((delivery) => !ctx.undone.has(delivery.id));
  const racing = done.slice(0, 5);
  const aged = done.slice(5, 8);
  await ageDeliveries(
    aged.map((delivery) => delivery.id),
    10,
  );
  const racePlan = racing.flatMap((delivery) => {
    const order = orders.find((candidate) => candidate.id === delivery.orderId);
    return [
      () => undo(delivery.id, delivery.station),
      () => undo(delivery.id, delivery.station),
      () => deliver(order, delivery.station, delivery.items),
    ];
  });
  const outsideWindow = aged.map((delivery) => () => undo(delivery.id, delivery.station, userFor(delivery.station)));
  await gated(() => burst([...racePlan, ...outsideWindow], 100));
  for (const delivery of aged) {
    const tries = ctx.calls.filter((entry) => entry.op === "undo" && entry.deliveryId === delivery.id);
    expect(
      tries.every((entry) => !entry.ok && entry.message.includes("undo_window_expired")),
      "undo_after_5_minutes_accepted",
      { tries: tries.map((entry) => entry.message || "ok") },
    );
  }
  if (aged[0]) {
    const adminUndo = await undo(aged[0].id, aged[0].station, asAdmin);
    expect(!adminUndo.error, "admin_undo_after_window_refused", { error: adminUndo.error });
    await probe("undo_as_pending_role", undo(done[0]?.id ?? uuid(), "birre", asPending, /./), "not_authorized");
  }
  if (racing[0]) {
    const other = KITCHEN_STATIONS.has(racing[0].station) ? asBar : asCook;
    const wrong = await call(
      "undo",
      rpc("undo_fulfillment_delivery", [lit(racing[0].id), lit(racing[0].station)], other),
      { allow: /./ },
    );
    expect(Boolean(wrong.error), "undo_from_other_role_accepted", { delivery: racing[0].id });
  }
  await checkDeliveryJournal();

  // Passo 3: si porta tutto a termine; ogni ordine deve chiudersi su "consegnato".
  for (const order of deferred) await activate(order);
  const remaining =
    (await admin_sql(
      "select coalesce(json_agg(json_build_object('order', order_id, 'item', menu_item_id, 'station', station, 'rest', quantity - delivered_quantity)), '[]') from public.order_fulfillment_items where quantity > delivered_quantity",
    )) ?? [];
  await Promise.all(remaining.map((row) => deliver({ id: row.order }, row.station, [{ id: row.item, qty: row.rest }])));
  const states = await orderStates();
  for (const order of orders) {
    const state = states.get(order.id);
    expect(
      state?.status === "consegnato" && state.kitchen === (food(order).length ? "done" : "none"),
      "order_not_closed_after_full_delivery",
      { status: state?.status, kitchen: state?.kitchen },
    );
  }
}

// ---------------------------------------------------------------------------------------
// 4b. Capienza cucina a 100: pagamenti, ordini al banco, attivazioni differite, consegne
//     e annulli di consegna insieme, vicino al limite.
// ---------------------------------------------------------------------------------------
async function kitchenRound() {
  await resetEvent();
  const free = 1 + rnd(4);
  const foodLine = jsonb([line("primo", 1)]);
  must(
    await sql(
      `select count(public.create_counter_order('Fill ' || g, '', ${foodLine}, 'immediate')) from generate_series(1, ${100 - free}) g`,
      asCassa,
    ),
    "riempimento cucina",
  );
  const dormant = 3 + rnd(3);
  must(
    await sql(
      `select count(public.create_counter_order('Differito ' || g, '', ${foodLine}, 'deferred')) from generate_series(1, ${dormant}) g`,
      asCassa,
    ),
    "ordini differiti",
  );
  const waiting = (
    await admin_sql("select coalesce(json_agg(id), '[]') from public.orders where alias like 'Differito%'")
  ).map((id) => ({ id }));
  const claimed = await Promise.all(
    range(3 + rnd(4)).map(async () => {
      const order = await newOrder(linesOf("food"), { mode: "immediate" });
      const device = uuid();
      const result = await claim(order, device);
      return { order, device, reserved: result.data?.kitchen_state === "reserved" };
    }),
  );
  const fills = (
    await admin_sql(
      "select coalesce(json_agg(id order by display_number), '[]') from public.orders where alias like 'Fill%'",
    )
  ).map((id) => ({ id }));
  // Due ordini già finiti (cucina libera) che poi vengono annullati insieme al resto.
  const finished = fills.slice(0, 2);
  await Promise.all(finished.map((order) => deliver(order, "primi", [{ id: menu.primo.id, qty: 1 }])));
  const completing = fills.slice(2, 4 + rnd(4));
  const counterQty = 2 + rnd(3);
  const plan = [
    ...claimed.map(
      ({ order, device }) =>
        () =>
          pay(order, device),
    ),
    ...range(counterQty).map(() => () => counter([line("secondo", 1)])),
    ...waiting.map((order) => () => activate(order)),
    ...completing.map((order) => () => deliver(order, "primi", [{ id: menu.primo.id, qty: 1 }])),
    ...ctx.deliveries
      .filter((delivery) => finished.some((order) => order.id === delivery.orderId))
      .map((delivery) => () => undo(delivery.id, "primi")),
    kitchenQueue,
    kitchenQueue,
  ];
  await gated(() => burst(plan, 120));
  for (const { order, reserved } of claimed) {
    const payment = callsFor(order.id, "pay")[0];
    expect(
      !(reserved && payment && !payment.ok && payment.message.includes("kitchen_capacity_reached")),
      "reserved_claimant_refused_by_capacity",
      { order: order.id, message: payment?.message },
    );
  }
  await kitchenQueue(); // la lettura della coda promuove chi aspetta: dopo, nessuno deve restare fermo con posti liberi
  const heal = await admin_sql(
    `select json_build_object('waiting', count(*) filter (where kitchen_state = 'waiting' and status in ('pagato', 'ritiro_parziale')),
       'occupied', public.kitchen_occupied((select id from public.order_events where is_current))) from public.orders`,
  );
  expect(!(heal.waiting > 0 && heal.occupied < 100), "kitchen_waiting_stuck_with_free_slots", heal);

  // Seconda fase, senza prenotazioni: coda FIFO. I posti liberati vanno a chi aspetta da più tempo,
  // mai a un nuovo ordine al banco che arriva nello stesso momento.
  await checkpoint();
  await resetEvent();
  must(
    await sql(
      `select count(public.create_counter_order('Fill ' || g, '', ${foodLine}, 'immediate')) from generate_series(1, 100) g`,
      asCassa,
    ),
    "riempimento cucina",
  );
  const queued = 4 + rnd(4);
  must(
    await sql(
      `select count(public.create_counter_order('Coda ' || g, '', ${foodLine}, 'deferred')) from generate_series(1, ${queued}) g`,
      asCassa,
    ),
    "ordini in coda",
  );
  const line_up = (
    await admin_sql(
      "select coalesce(json_agg(id order by display_number), '[]') from public.orders where alias like 'Coda%'",
    )
  ).map((id) => ({ id }));
  for (const order of line_up) must(await activate(order), "attivazione in coda"); // in sequenza: l'ordine di richiesta è noto
  const slots = 1 + rnd(3);
  const makeRoom = (
    await admin_sql(
      `select coalesce(json_agg(id order by display_number), '[]') from public.orders where alias like 'Fill%'`,
    )
  )
    .slice(0, slots)
    .map((id) => ({ id }));
  await gated(() =>
    burst(
      [
        ...makeRoom.map((order) => () => deliver(order, "primi", [{ id: menu.primo.id, qty: 1 }])),
        ...range(4).map(() => () => counter([line("secondo", 1)])),
        kitchenQueue,
        kitchenQueue,
      ],
      100,
    ),
  );
  const queue = await orderStates();
  const kitchenOf = (order) => queue.get(order.id)?.kitchen;
  expect(
    line_up.slice(0, slots).every((order) => kitchenOf(order) === "active") &&
      line_up.slice(slots).every((order) => kitchenOf(order) === "waiting"),
    "kitchen_queue_not_fifo",
    { kitchen: line_up.map(kitchenOf), freed: slots },
  );
  expect(
    ctx.calls.filter((entry) => entry.op === "counter" && entry.ok).length === 0,
    "counter_order_took_slot_ahead_of_queue",
    { accepted: ctx.calls.filter((entry) => entry.op === "counter" && entry.ok).length },
  );
}

// ---------------------------------------------------------------------------------------
// 5. Chiusura dell'evento durante pagamenti, claim, ordini in attesa e consegne; il report
//    finale deve coincidere con ciò che è successo davvero (anche per serata).
// ---------------------------------------------------------------------------------------
const reportCountsSql = `select json_build_object(
  'total', count(*),
  'paid', count(*) filter (where coalesce(report_status, status) in ${PAID}),
  'cancelled', count(*) filter (where coalesce(report_status, status) = 'annullato'),
  'abandoned', count(*) filter (where report_status = 'abbandonato'),
  'revenue', coalesce(sum(total) filter (where coalesce(report_status, status) in ${PAID}), 0),
  'paid_qty', (select coalesce(sum((l->>'qty')::integer), 0) from public.orders p cross join lateral jsonb_array_elements(p.items) l where coalesce(p.report_status, p.status) in ${PAID}),
  'closed', (select permanently_closed_at is not null from public.order_events where is_current),
  'final', (select final_report from public.order_events where is_current)
) from public.orders`;
const stateHashSql = `select json_build_object('h', md5(concat_ws('|',
  (select coalesce(string_agg(o::text, ',' order by o.id), '') from public.orders o),
  (select coalesce(string_agg(f::text, ',' order by f.order_id, f.menu_item_id), '') from public.order_fulfillment_items f),
  (select coalesce(string_agg(d::text, ',' order by d.id), '') from public.fulfillment_deliveries d),
  (select coalesce(string_agg(m.id::text || coalesce(m.available_portions::text, 'n'), ',' order by m.id), '') from public.menu_items m))))`;
const cents = (value) => Math.round(Number(value) * 100);

async function closeRound() {
  const evenings = 1 + rnd(3);
  await resetEvent({ evenings, stock: { birra: 60, primo: 60, secondo: 60 } });
  const paid = await Promise.all(
    range(5).map(() => paidOrder(linesOf("mixed"), rng() < 0.3 ? "deferred" : "immediate")),
  );
  const partial = paid.slice(0, 2);
  for (const order of partial) {
    const row = rowsOf(order).find((candidate) => !candidate.food);
    await deliver(order, row.station, [{ id: row.id, qty: 1 }]);
  }
  const finished = await paidOrder([line("birra", 1)]);
  await deliver(finished, "birre", [{ id: menu.birra.id, qty: 1 }]);
  const claimed = await Promise.all(
    range(4).map(async () => {
      const order = await newOrder(linesOf("any"));
      const device = uuid();
      must(await claim(order, device), "claim");
      return { order, device };
    }),
  );
  const unclaimed = await Promise.all(range(3).map(() => newOrder(linesOf("any"))));
  await Promise.all(
    range(2).map(async () => {
      const order = await newOrder(linesOf("any"));
      const device = uuid();
      must(await claim(order, device));
      must(await cancel(order, device));
      return order;
    }),
  );
  const old = await Promise.all(range(2).map(() => newOrder(linesOf("any"))));
  await ageOrders(
    old.map((order) => order.id),
    90_000,
  );
  // Pagamenti in serate diverse: 0, 1 o 2 giorni dopo l'apertura.
  await admin_sql(
    `update public.orders set paid_at = paid_at + (floor(random() * 3)::integer * interval '1 day') where status in ('pagato', 'ritiro_parziale', 'consegnato')`,
  );

  const closes = rng() < 0.3 ? 2 : 1;
  const barRows = paid.slice(2).map((order) => ({ order, row: rowsOf(order).find((row) => !row.food) }));
  const priorDelivery = ctx.deliveries.find((delivery) => delivery.orderId === partial[0].id);
  const plan = [
    ...claimed.slice(0, 3).map(
      ({ order, device }) =>
        () =>
          pay(order, device),
    ),
    () => cancel(claimed[3].order, claimed[3].device),
    ...unclaimed.map((order) => () => claim(order, uuid(), "cassa_2")),
    ...range(5).map(() => {
      const lines = linesOf("any");
      return () => submit(lines);
    }),
    () => submit(unclaimed[0].lines, { requestId: unclaimed[0].requestId, qr: unclaimed[0].qr }),
    ...range(3).map(() => {
      const lines = linesOf("any");
      const mode = pick(["immediate", "deferred"]);
      return () => counter(lines, { mode });
    }),
    ...barRows.map(
      ({ order, row }) =>
        () =>
          deliver(order, row.station, [{ id: row.id, qty: 1 }]),
    ),
    () => undo(priorDelivery.id, priorDelivery.station),
    () => call("pause", rpc("set_ordering_paused", ["true"], asCassa)),
    // Lo staff cambia i prezzi del menu mentre si incassa e si chiude: i totali restano quelli dello snapshot.
    () => admin_sql("update public.menu_items set price = price + 0.5 where category = 'bevande' and price < 100"),
    ...range(closes).map(() => closeEvent),
  ];
  await gated(() => burst(plan, 100));
  await reportChecks(evenings);
  await eveningBoundaryChecks(evenings);

  // Dopo la chiusura ogni operazione deve rispondere event_closed e non toccare nulla.
  const before = await admin_sql(stateHashSql);
  const battery = [
    ["claim", () => claim(unclaimed[1], uuid())],
    ["pay", () => pay(claimed[0].order, claimed[0].device)],
    ["cancel", () => cancel(claimed[1].order, claimed[1].device)],
    [
      "deliver",
      () =>
        deliver(
          paid[3],
          rowsOf(paid[3]).find((row) => !row.food).station,
          [{ id: rowsOf(paid[3]).find((row) => !row.food).id, qty: 1 }],
          undefined,
          /./,
        ),
    ],
    ["undo", () => undo(priorDelivery.id, priorDelivery.station, asAdmin, /./)],
    ["counter", () => counter(linesOf("any"), { allow: /./ })],
    ["submit_new", () => submit(linesOf("any"), { allow: /./ })],
    [
      "submit_retry",
      () => submit(unclaimed[0].lines, { requestId: unclaimed[0].requestId, qr: unclaimed[0].qr, allow: /./ }),
    ],
    ["pause", () => call("pause", rpc("set_ordering_paused", ["false"], asCassa), { allow: /./ })],
    [
      "update_event",
      () =>
        call(
          "update_event",
          rpc("update_order_event", [lit("Dopo"), "now()", "now() + interval '1 hour'", "100", "1"], asCassa),
          { allow: /./ },
        ),
    ],
    [
      "preparation",
      () =>
        call(
          "preparation",
          rpc("set_order_preparation", [lit(unclaimed[1].id), lit("cassa_1"), lit(uuid()), lit("deferred")], asCassa),
          { allow: /./ },
        ),
    ],
    [
      "activate",
      () => call("activate", rpc("activate_kitchen_order", [lit(paid[4].id), lit("cucina")], asCook), { allow: /./ }),
    ],
  ];
  const results = await Promise.all(battery.map(([, run]) => run()));
  battery.forEach(([label], index) =>
    expect(isErr(results[index], "event_closed"), `after_close_${label}_not_refused`, {
      result: results[index].error?.message ?? "success",
    }),
  );
  expect(JSON.stringify(before) === JSON.stringify(await admin_sql(stateHashSql)), "after_close_state_changed", {});
  const reads = await Promise.all([
    statusRead(),
    cashierList(),
    call("queue", rpc("get_fulfillment_queue", [lit("bar")], asBar)),
  ]);
  expect(reads[0].data?.reason === "event_closed" && reads[0].data?.accepting === false, "status_after_close_wrong", {
    status: reads[0].data,
  });
  expect((reads[1].data ?? []).length === 0 && (reads[2].data ?? []).length === 0, "queues_not_empty_after_close", {
    cashier: reads[1].data?.length,
    bar: reads[2].data?.length,
  });

  // L'evento successivo riparte pulito e il rapporto chiuso non cambia.
  const finalBefore = JSON.stringify((await admin_sql(reportCountsSql)).final);
  const next = await call(
    "next_event",
    rpc(
      "create_next_order_event",
      [lit("Prossimo"), "now() - interval '1 minute'", "now() + interval '2 hours'", "100", "2"],
      asCassa,
    ),
  );
  if (!next.error) {
    must(await call("unpause", rpc("set_ordering_paused", ["false"], asCassa)), "riapertura ordini");
    const fresh = await submit([line("acqua", 1)], { allow: /./ });
    expect(!fresh.error && Number(fresh.data?.display_number) === 1, "next_event_display_number_not_restarted", {
      result: fresh.error ?? fresh.data?.display_number,
    });
    ctx.orders.delete(fresh.data?.order_id);
    const oldEvent = await admin_sql(
      `select json_build_object('f', final_report) from public.order_events where not is_current order by created_at limit 1`,
    );
    expect(JSON.stringify(oldEvent.f) === finalBefore, "closed_event_report_changed_by_next_event", {});
  }
}

async function reportChecks(evenings) {
  const closes = ctx.calls.filter((entry) => entry.op === "close");
  expect(closes.length > 0 && closes.every((entry) => entry.ok), "close_failed", {
    errors: closes.map((entry) => entry.message),
  });
  const direct = await admin_sql(reportCountsSql);
  expect(direct.closed === true, "event_not_closed_after_close", {});
  const known = [...ctx.orders.keys()];
  const payOk = new Set(ctx.calls.filter((entry) => entry.op === "pay" && entry.ok).map((entry) => entry.orderId));
  const expectedPaid = known.filter((id) => payOk.has(id) || ctx.counterIds.has(id)).length;
  expect(direct.total === known.length, "db_orders_differ_from_journal", { db: direct.total, journal: known.length });
  expect(direct.paid === expectedPaid, "paid_orders_differ_from_successful_pays", {
    db: direct.paid,
    journal: expectedPaid,
  });
  expect(direct.paid + direct.cancelled + direct.abandoned === direct.total, "report_status_partition_broken", direct);
  const summaryOf = (report) => ({
    orders_total: Number(report?.summary?.orders_total),
    orders_paid: Number(report?.summary?.orders_paid),
    orders_cancelled: Number(report?.summary?.orders_cancelled),
    orders_abandoned: Number(report?.summary?.orders_abandoned),
    revenue_cents: cents(report?.summary?.revenue_total),
  });
  const wanted = {
    orders_total: direct.total,
    orders_paid: direct.paid,
    orders_cancelled: direct.cancelled,
    orders_abandoned: direct.abandoned,
    revenue_cents: cents(direct.revenue),
  };
  for (const entry of closes.filter((candidate) => candidate.ok)) {
    expect(
      JSON.stringify(summaryOf(entry.data)) === JSON.stringify(wanted),
      "close_report_differs_from_direct_counts",
      { reported: summaryOf(entry.data), direct: wanted },
    );
    const products = entry.data.products ?? [];
    expect(
      products.reduce((sum, product) => sum + Number(product.quantity), 0) === direct.paid_qty,
      "close_report_product_quantity_differs",
      { reported: products.reduce((sum, product) => sum + Number(product.quantity), 0), direct: direct.paid_qty },
    );
    expect(
      cents(products.reduce((sum, product) => sum + Number(product.revenue), 0)) === cents(direct.revenue),
      "close_report_product_revenue_differs",
      {},
    );
    expect((entry.data.orders ?? []).length === direct.total, "close_report_order_list_length_differs", {
      reported: entry.data.orders?.length,
      direct: direct.total,
    });
  }
  expect(
    JSON.stringify(summaryOf(direct.final)) === JSON.stringify(wanted),
    "stored_final_report_differs_from_direct_counts",
    { stored: summaryOf(direct.final), direct: wanted },
  );
  const reread = await call("report", rpc("get_order_event_report", [], asCassa));
  expect(
    JSON.stringify(summaryOf(reread.data)) === JSON.stringify(wanted) &&
      (reread.data?.orders ?? []).length === direct.total,
    "reread_report_differs_from_direct_counts",
    {},
  );
  const statuses = (reread.data?.orders ?? []).reduce(
    (all, order) => ({ ...all, [order.status]: (all[order.status] ?? 0) + 1 }),
    {},
  );
  expect(
    (statuses.abbandonato ?? 0) === direct.abandoned && (statuses.annullato ?? 0) === direct.cancelled,
    "reread_report_status_counts_differ",
    { statuses, direct },
  );
  // Situazione incassi: totale e serate devono ripartire senza perdere o duplicare ordini.
  const snapshot = (await call("snapshot", rpc("get_order_event_snapshot", [], asCassa))).data;
  expect(
    snapshot?.orders_paid === direct.paid && cents(snapshot?.revenue_total) === cents(direct.revenue),
    "snapshot_total_differs_from_report",
    { snapshot: [snapshot?.orders_paid, snapshot?.revenue_total], direct: [direct.paid, direct.revenue] },
  );
  expect(
    (snapshot?.products ?? []).reduce((sum, product) => sum + Number(product.quantity), 0) === direct.paid_qty,
    "snapshot_product_quantity_differs",
    {},
  );
  expect(
    (snapshot?.hours ?? []).reduce((sum, hour) => sum + Number(hour.orders), 0) === direct.paid,
    "snapshot_hours_do_not_sum_to_paid_orders",
    {},
  );
  const parts = snapshot?.evenings ?? [];
  expect(parts.length === (evenings === 1 ? 0 : evenings), "snapshot_evening_count_wrong", {
    parts: parts.length,
    evenings,
  });
  if (parts.length) {
    expect(
      parts.reduce((sum, part) => sum + Number(part.orders_paid), 0) === direct.paid &&
        cents(parts.reduce((sum, part) => sum + Number(part.revenue_total), 0)) === cents(direct.revenue),
      "snapshot_evenings_do_not_partition_total",
      { orders: parts.map((part) => part.orders_paid), total: direct.paid },
    );
  }
}

/** Una serata va dalle 06:00 alle 05:59 (ora di Roma): si assegnano orari di pagamento attorno al cambio e si confronta la ripartizione. */
async function eveningBoundaryChecks(evenings) {
  const cases = [
    [0, "05:59:59"],
    [0, "06:00:00"],
    [0, "23:59:59"],
    [1, "00:00:00"],
    [1, "05:59:59"],
    [1, "06:00:00"],
    [2, "05:59:59"],
    [2, "06:00:00"],
    [3, "06:00:00"],
  ];
  const orders =
    (await admin_sql(
      `select coalesce(json_agg(json_build_object('id', id, 'total', total) order by id), '[]') from public.orders where coalesce(report_status, status) in ${PAID}`,
    )) ?? [];
  if (orders.length === 0) return;
  const base = (
    await admin_sql(
      "select json_build_object('d', ((opens_at at time zone 'Europe/Rome') - interval '6 hours')::date) from public.order_events where is_current",
    )
  ).d;
  const assigned = orders.map((order, index) => ({ ...order, case: cases[index % cases.length] }));
  await admin_sql(
    assigned
      .map(
        (order) =>
          `update public.orders set paid_at = ((${lit(base)}::date + ${order.case[0]}) + time ${lit(order.case[1])}) at time zone 'Europe/Rome' where id = ${lit(order.id)};`,
      )
      .join("\n"),
  );
  const expected = range(evenings).map(() => ({ orders: 0, cents: 0 }));
  for (const order of assigned) {
    const [day, time] = order.case;
    const evening = Math.min(Math.max(day + (time < "06:00:00" ? 0 : 1), 1), evenings);
    expected[evening - 1].orders += 1;
    expected[evening - 1].cents += cents(order.total);
  }
  const snapshot = (await call("snapshot", rpc("get_order_event_snapshot", [], asCassa))).data;
  const parts = evenings === 1 ? [snapshot] : (snapshot?.evenings ?? []);
  const seen = parts.map((part) => ({ orders: Number(part.orders_paid), cents: cents(part.revenue_total) }));
  expect(JSON.stringify(seen) === JSON.stringify(expected), "snapshot_evening_assignment_wrong", {
    seen,
    expected,
    cases: assigned.map((order) => order.case.join("@")),
  });
}

// ---------------------------------------------------------------------------------------
// 6. Ordini al banco mescolati con ordini pubblici, sulle stesse scorte.
// ---------------------------------------------------------------------------------------
async function counterRound() {
  const stock = 8 + rnd(7);
  await resetEvent({ stock: { birra: stock } });
  const counterQty = range(8).map(() => 1 + rnd(2));
  const publicQty = range(8).map(() => 1 + rnd(2));
  const items = linesOf("any");
  const hugeLine = [{ id: menu.lusso.id, qty: 11 }];
  const plan = [
    ...counterQty.map((qty) => () => counter([line("birra", qty)], { mode: "immediate" })),
    ...publicQty.map((qty) => () => submit([line("birra", qty)])),
    // Ordini al banco non validi: respinti con l'errore documentato, senza toccare scorte o numeri.
    () => probe("counter_short_alias", counter(items, { alias: "x", allow: /./ }), "invalid_alias"),
    () => probe("counter_long_alias", counter(items, { alias: "a".repeat(33), allow: /./ }), "invalid_alias"),
    () => probe("counter_long_notes", counter(items, { notes: "n".repeat(301), allow: /./ }), "notes_too_long"),
    () => probe("counter_bad_mode", counter(items, { mode: "subito", allow: /./ }), "invalid_preparation_mode"),
    () => probe("counter_no_items", counter([], { allow: /./ }), "invalid_order_items"),
    () => probe("counter_zero_qty", counter([{ id: menu.acqua.id, qty: 0 }], { allow: /./ }), "invalid_order_items"),
    () => probe("counter_qty_1000", counter([{ id: menu.acqua.id, qty: 1000 }], { allow: /./ }), "invalid_order_items"),
    () => probe("counter_unknown_item", counter([{ id: uuid(), qty: 1 }], { allow: /./ }), "unknown_menu_item"),
    () =>
      probe(
        "counter_101_lines",
        counter(
          range(101).map(() => ({ id: menu.acqua.id, qty: 1 })),
          { allow: /./ },
        ),
        "invalid_order_items",
      ),
    () => probe("counter_as_cook", counter(items, { user: asCook, allow: /./ }), "not_authorized"),
    () => probe("counter_as_anon", counter(items, { user: asPublic, allow: /./ }), "permission denied"),
    () => probe("counter_total_overflow", counter(hugeLine, { allow: /./ }), "order_total_too_high"),
    () => probe("public_total_too_high", submit(hugeLine, { allow: /./ }), "order_total_too_high"),
  ];
  await gated(() => burst(plan, 130));
  const sold = ctx.calls.filter(
    (entry) => (entry.op === "counter" || entry.op === "submit") && entry.ok && entry.data?.items,
  );
  const soldQty = sold.reduce(
    (sum, entry) =>
      sum +
      entry.data.items.filter((item) => item.id === menu.birra.id).reduce((total, item) => total + Number(item.qty), 0),
    0,
  );
  expect(soldQty <= stock, "oversold_beyond_stock", { sold: soldQty, stock });
  // I pubblici pagano mentre altri ordini al banco arrivano: nessun numero perso o doppio.
  const publicOrders = [...ctx.orders.entries()].filter(([, order]) => !order.counter).map(([id]) => ({ id }));
  const devices = new Map(publicOrders.map((order) => [order.id, uuid()]));
  await Promise.all(publicOrders.map((order) => claim(order, devices.get(order.id))));
  await gated(() =>
    burst(
      [
        ...publicOrders.map((order) => () => pay(order, devices.get(order.id))),
        ...range(3).map(() => () => counter([line("acqua", 1)])),
      ],
      100,
    ),
  );
}

// ---------------------------------------------------------------------------------------
// 7. Idempotenza: retry contro presa in carico e pagamento, QR in conflitto, retry dopo
//    annullo e scadenza, limite di frequenza per token di recupero.
// ---------------------------------------------------------------------------------------
async function idempotencyRound() {
  await resetEvent({ stock: { birra: 30 } });
  // (a) otto retry dello stesso invio mentre la cassa lo prende in carico e lo incassa.
  const base = await newOrder([line("birra", 2), line(pick(FOOD), 1)], { mode: "immediate" });
  const device = uuid();
  const flow = async () => {
    await wait(rnd(60));
    must(await claim(base, device), "claim");
    await wait(rnd(40));
    return pay(base, device);
  };
  const [, retries] = await gated(() =>
    Promise.all([
      flow(),
      burst(
        range(8).map(() => () => submit(base.lines, { requestId: base.requestId, qr: base.qr })),
        120,
      ),
    ]),
  );
  expect(
    retries.every(
      (result) =>
        !result.error &&
        result.data.order_id === base.id &&
        ["in_attesa_pagamento", "pagato"].includes(result.data.status),
    ),
    "retry_during_pay_not_same_order",
    {
      retries: retries.map(
        (result) => result.error?.message ?? `${result.data.order_id === base.id}:${result.data.status}`,
      ),
    },
  );

  // (b) stesso request id con QR diversi in gara: vince un QR, gli altri ricevono il conflitto.
  const requestId = uuid();
  const qrs = [uuid(), uuid()];
  const raced = await gated(() =>
    burst(
      range(10).map((index) => () => submit([line("birra", 1)], { requestId, qr: qrs[index % 2] })),
      100,
    ),
  );
  const winners = successes(raced);
  expect(
    new Set(winners.map((result) => result.data.order_id)).size === 1 &&
      new Set(winners.map((result) => result.data.qr_token)).size === 1,
    "request_id_conflict_race_two_winners",
    { winners: winners.length },
  );
  expect(
    raced.filter((result) => result.error).every((result) => isErr(result, "request_id_conflict")),
    "request_id_conflict_race_wrong_error",
    { errors: summarize(raced) },
  );

  // (c) retry dopo annullo e dopo scadenza: restituiscono l'ordine esistente, mai un secondo ordine.
  const cancelled = await newOrder([line("birra", 1)]);
  const cancelDevice = uuid();
  must(await claim(cancelled, cancelDevice), "claim");
  const expired = await newOrder([line("birra", 1)]);
  await ageOrders([expired.id]);
  const afterwards = await gated(() =>
    Promise.all([
      burst(
        [
          () => cancel(cancelled, cancelDevice),
          ...range(3).map(() => () => submit(cancelled.lines, { requestId: cancelled.requestId, qr: cancelled.qr })),
        ],
        80,
      ),
      burst(
        [
          statusRead,
          ...range(3).map(() => () => submit(expired.lines, { requestId: expired.requestId, qr: expired.qr })),
        ],
        80,
      ),
    ]),
  );
  for (const [group, order] of [
    [afterwards[0].slice(1), cancelled],
    [afterwards[1].slice(1), expired],
  ])
    expect(
      group.every((result) => !result.error && result.data.order_id === order.id),
      "retry_after_cancel_or_expiry_not_same_order",
      { results: summarize(group) },
    );
  await statusRead();
  const lateRetry = await submit(expired.lines, { requestId: expired.requestId, qr: expired.qr });
  expect(!lateRetry.error && lateRetry.data.status === "annullato", "retry_of_expired_order_not_annullato", {
    result: lateRetry.error ?? lateRetry.data?.status,
  });

  // (d) limite 3 invii al minuto per token di recupero, in gara; i retry non lo consumano.
  const token = randomBytes(32).toString("base64url");
  const requests = range(8).map(() => uuid());
  const submitRecovery = (request) =>
    submit([line("acqua", 1)], { requestId: request, qr: recoveryQr(token, request), recovery: token });
  const tries = await gated(() =>
    burst(
      requests.map((request) => () => submitRecovery(request)),
      100,
    ),
  );
  const accepted = requests.filter((_, index) => !tries[index].error);
  const refused = requests.filter((_, index) => tries[index].error);
  expect(
    accepted.length === 3 && tries.every((result) => !result.error || isErr(result, "public_order_rate_limit")),
    "recovery_rate_limit_not_exactly_3",
    { accepted: accepted.length, errors: summarize(tries) },
  );
  const sameAgain = await Promise.all(accepted.map(submitRecovery));
  expect(
    sameAgain.every((result) => !result.error),
    "retry_refused_by_rate_limit",
    { results: summarize(sameAgain) },
  );
  await admin_sql(
    "update public.orders set created_at = created_at - interval '2 minutes' where recovery_token_hash is not null",
  );
  const later = await burst(
    refused.map((request) => () => submitRecovery(request)),
    60,
  );
  expect(successes(later).length === Math.min(3, refused.length), "recovery_rate_limit_window_not_reopened", {
    accepted_later: successes(later).length,
    expected: Math.min(3, refused.length),
  });

  // (e) ordine di sole bevande con "differita": la risposta deve dire ciò che è salvato (il client non lo invia, il gateway lo inoltra).
  const barOnly = await submit([line("birra", 1)], { mode: "deferred" });
  if (!barOnly.error)
    await submit([line("birra", 1)], { requestId: barOnly.entry.requestId, qr: barOnly.entry.qr, mode: "deferred" });

  // (f) un retry restituisce l'ordine esistente anche a ordini fermi, chiusi o non ancora aperti; un ordine nuovo no.
  const early = await newOrder([line("birra", 1)]);
  const windows = [
    ["ordering_closed", "opens_at = now() - interval '2 hours', closes_at = now() - interval '1 second'"],
    ["ordering_paused", "manual_closed = true"],
    ["not_open_yet", "opens_at = now() + interval '1 hour', closes_at = now() + interval '3 hours'"],
  ];
  for (const [token, change] of windows) {
    await admin_sql(`update public.order_events set ${change} where is_current`);
    const [retry, fresh] = await Promise.all([
      submit(early.lines, { requestId: early.requestId, qr: early.qr }),
      submit([line("birra", 1)], { allow: /./ }),
    ]);
    expect(!retry.error && retry.data.order_id === early.id, `retry_refused_while_${token}`, { error: retry.error });
    expect(isErr(fresh, token), `new_order_not_refused_while_${token}`, { result: fresh.error?.message ?? "accepted" });
    await admin_sql(
      "update public.order_events set opens_at = now() - interval '1 minute', closes_at = now() + interval '2 hours', manual_closed = false where is_current",
    );
  }
}

// ---------------------------------------------------------------------------------------
// 8. Limiti: 10 e 1000 ordini in attesa, impostazioni evento non valide, display_number
//    sotto concorrenza con invii che falliscono.
// ---------------------------------------------------------------------------------------
async function boundariesRound(round) {
  const eventArgs = (name, opens, closes, max, evening) => [
    name === null ? "null" : lit(name),
    opens,
    closes,
    max,
    evening,
  ];
  const opens = lit(new Date(Date.now() - 60_000).toISOString());
  const closes = lit(new Date(Date.now() + 3_600_000).toISOString());

  // (a) limite minimo: 10 posti, gara sui posti rimasti.
  await resetEvent({ limit: 10 });
  const extra = 3 + rnd(6);
  const first = await gated(() =>
    burst(
      range(10 + extra).map(() => () => submit([line("acqua", 1)])),
      90,
    ),
  );
  expect(
    successes(first).length === 10 &&
      first.filter((result) => result.error).every((result) => isErr(result, "capacity_reached")),
    "limit_10_not_exact",
    { accepted: successes(first).length, errors: [...new Set(summarize(first))] },
  );
  const full = (await statusRead()).data;
  expect(full?.accepting === false && full?.reason === "capacity_reached", "limit_10_status_wrong", { status: full });
  const victim = { id: successes(first)[0].data.order_id };
  const victimDevice = uuid();
  must(await claim(victim, victimDevice), "claim");
  // Un posto liberato (annullo o pagamento) può essere preso da un solo invio: da nessuno se tutti
  // gli invii sono arrivati prima, da uno se almeno uno è arrivato dopo, mai da due.
  const pending = async () =>
    Number(await admin_sql("select count(*) from public.orders where status = 'in_attesa_pagamento'"));
  const payee = { id: successes(first)[1].data.order_id };
  const payDevice = uuid();
  must(await claim(payee, payDevice), "claim");
  const [freeing, freed] = [
    { name: "cancel", run: () => cancel(victim, victimDevice) },
    { name: "pay", run: () => pay(payee, payDevice) },
  ].map((step) => step);
  for (const step of [freeing, freed]) {
    const results = await gated(() =>
      burst([step.run, ...range(extra).map(() => () => submit([line("acqua", 1)]))], 100),
    );
    const accepted = successes(results.slice(1)).length;
    const count = await pending();
    expect(
      !results[0].error && accepted <= 1 && count === 10 - 1 + accepted,
      `freed_seat_by_${step.name}_not_taken_by_at_most_one`,
      { accepted, pending: count },
    );
    if (count < 10)
      expect(!(await submit([line("acqua", 1)])).error, `free_seat_after_${step.name}_still_refused`, {
        pending: count,
      });
  }

  await checkpoint();
  // (b) impostazioni evento: valori limite e NULL devono dare invalid_event_settings, mai errori grezzi.
  const settings = [
    ["max_9", eventArgs("Evento", opens, closes, "9", "1")],
    ["max_1001", eventArgs("Evento", opens, closes, "1001", "1")],
    ["max_null", eventArgs("Evento", opens, closes, "null", "1")],
    ["closes_null", eventArgs("Evento", opens, "null", "100", "1")],
    ["opens_null", eventArgs("Evento", "null", closes, "100", "1")],
    ["name_null", eventArgs(null, opens, closes, "100", "1")],
    ["name_101", eventArgs("n".repeat(101), opens, closes, "100", "1")],
    ["closes_before_opens", eventArgs("Evento", closes, opens, "100", "1")],
    ["evening_0", eventArgs("Evento", opens, closes, "100", "0")],
    ["evening_4", eventArgs("Evento", opens, closes, "100", "4")],
  ];
  await Promise.all(
    settings.map(([label, args]) =>
      probe(
        `update_event_${label}`,
        call("update_event", rpc("update_order_event", args, asCassa), { allow: /./ }),
        "invalid_event_settings",
      ),
    ),
  );
  const edge = await Promise.all(
    [
      ["10", "1"],
      ["1000", "3"],
    ].map(([max, evening]) =>
      call("update_event", rpc("update_order_event", eventArgs("Evento limite", opens, closes, max, evening), asCassa)),
    ),
  );
  expect(
    edge.every((result) => !result.error),
    "update_event_valid_edge_refused",
    { errors: summarize(edge) },
  );

  // (c) display_number sotto concorrenza con invii che falliscono (scorta finita, limite pieno).
  await checkpoint();
  await resetEvent({ limit: 30, stock: { dolce: 0 } });
  const mixed = [
    ...range(36).map(() => () => submit([line("acqua", 1)])),
    ...range(8).map(() => () => submit([line("dolce", 1)])),
    ...range(8).map(() => () => counter([line("acqua", 1)])),
  ];
  await gated(() => burst(shuffle(mixed), 150));

  // (d) limite massimo: 1000 posti (riempimento in una transazione con la funzione vera).
  if (round % 3 === 1) {
    await checkpoint();
    await resetEvent({ limit: 1000 });
    must(
      await sql(
        `select count(public.submit_public_order('Fill ' || g, '', ${jsonb([line("acqua", 1)])}, gen_random_uuid(), gen_random_uuid()::text, '')) from generate_series(1, 990) g`,
        asService,
      ),
      "riempimento 990",
    );
    const burst1000 = await gated(() =>
      burst(
        range(10 + extra).map(() => () => submit([line("acqua", 1)])),
        90,
      ),
    );
    expect(
      successes(burst1000).length === 10 &&
        burst1000.filter((result) => result.error).every((result) => isErr(result, "capacity_reached")),
      "limit_1000_not_exact",
      { accepted: successes(burst1000).length, errors: [...new Set(summarize(burst1000))] },
    );
    const status = (await statusRead()).data;
    const catalog = (await catalogRead()).data;
    expect(
      status?.accepting === false && status?.reason === "capacity_reached" && catalog?.items?.length === 0,
      "limit_1000_status_or_catalog_wrong",
      { status, items: catalog?.items?.length },
    );
    const lowered = await call(
      "update_event",
      rpc("update_order_event", eventArgs("Evento ridotto", opens, closes, "10", "1"), asCassa),
    );
    const after = await submit([line("acqua", 1)], { allow: /./ });
    expect(!lowered.error && isErr(after, "capacity_reached"), "lowering_limit_below_pending_misbehaves", {
      lowered: lowered.error,
      after: after.error?.message ?? "accepted",
    });
  }
}

// ---------------------------------------------------------------------------------------
// 9. Molti ordini insieme: decine di catene (presa in carico, pagamento, consegne, annulli,
//    retry) partono nello stesso istante, con letture che fanno scattare la scadenza.
// ---------------------------------------------------------------------------------------
async function massChain(order, kind) {
  const device = uuid();
  const rows = rowsOf(order);
  await wait(rnd(150));
  if (kind === "twoDesks") {
    const [first, second] = await Promise.all([claim(order, device, "cassa_1"), claim(order, uuid(), "cassa_2")]);
    if (!first.error) await pay(order, device, "cassa_1");
    return second;
  }
  if (kind === "retry")
    return Promise.all([
      ...range(3).map(() => submit(order.lines, { requestId: order.requestId, qr: order.qr, mode: order.mode })),
      claim(order, device).then((claimed) => (claimed.error ? claimed : pay(order, device))),
    ]);
  if ((await claim(order, device)).error) return;
  if (kind === "abandon") return;
  if (kind === "cancel") return cancel(order, device);
  if ((await pay(order, device)).error) return;
  if (kind === "partialUndo") {
    const delivered = await deliver(order, rows[0].station, [{ id: rows[0].id, qty: 1 }]);
    if (!delivered.error) await undo(delivered.data.delivery_id, rows[0].station);
    return;
  }
  await Promise.all(rows.map((row) => deliver(order, row.station, [{ id: row.id, qty: row.qty }])));
}

async function massRound() {
  await resetEvent();
  const kinds = ["payDeliver", "payDeliver", "payDeliver", "partialUndo", "cancel", "abandon", "twoDesks", "retry"];
  const orders = await Promise.all(range(48).map(() => newOrder(linesOf("any"))));
  const qrs = orders.map((order) => order.qr);
  const readers = range(24).map(() => pick(expiryTriggers(qrs)));
  await gated(() =>
    Promise.all([burst(readers, 400), ...orders.map((order, index) => massChain(order, kinds[index % kinds.length]))]),
  );
}

// ---------------------------------------------------------------------------------------
// Esecuzione.
// ---------------------------------------------------------------------------------------
const scenarioCatalog = [
  ["cash", cashRound],
  ["cancel", cancelRound],
  ["expiry", expiryRound],
  ["fulfillment", fulfillmentRound],
  ["kitchen", kitchenRound],
  ["close", closeRound],
  ["counter", counterRound],
  ["idempotency", idempotencyRound],
  ["boundaries", boundariesRound],
  ["mass", massRound],
];

console.log(`Stress edge ordini LAG su PostgreSQL temporaneo (${workDir}), seed ${seed}, ${rounds} round per scenario`);
try {
  start({ maxConnections: 300 });
  await setup();
  for (const [name, body] of scenarioCatalog)
    await runScenario(name, body, name === "mass" ? Math.ceil(rounds / 2) : rounds);
} finally {
  stop();
}

const scenarios = {};
const warnings = [];
for (const [name, scenarioStats] of stats) {
  const failureRules = Object.entries(scenarioStats.failures);
  scenarios[name] = {
    rounds: scenarioStats.rounds,
    skipped_rounds: scenarioStats.skipped ?? 0,
    calls: scenarioStats.calls,
    outcomes: Object.fromEntries(Object.entries(scenarioStats.outcomes).sort(([a], [b]) => a.localeCompare(b))),
    failed_rounds: scenarioStats.failedRounds.size,
    seconds: Math.round(scenarioStats.ms / 1000),
    status: failureRules.length === 0 ? "PASS" : "FAIL",
  };
  if (failureRules.length === 0) {
    checks.push({ name, status: "PASS", rounds: scenarioStats.rounds });
    console.log(`PASS  ${name}`, scenarios[name]);
  }
  for (const [rule, entry] of failureRules) {
    findings.push({
      scenario: name,
      rule,
      status: "FINDING",
      seed,
      count: entry.count,
      rounds: entry.rounds,
      samples: entry.samples,
    });
    console.error(`FIND  ${name}: ${rule}`, { count: entry.count, rounds: entry.rounds, sample: entry.samples[0] });
  }
  for (const [rule, entry] of Object.entries(scenarioStats.warnings))
    warnings.push({ scenario: name, rule, seed, count: entry.count, rounds: entry.rounds, samples: entry.samples });
}
if (harnessErrors.length) console.error("ERRORI DEL TEST (non difetti dell'app):", harnessErrors);

const output = {
  seed,
  rounds,
  seconds: Math.round((performance.now() - startedAt) / 1000),
  scenarios,
  checks: checks.length,
  findings,
  warnings,
  harness_errors: harnessErrors,
};
if (process.env.LOADTEST_JSON_OUT) writeFileSync(process.env.LOADTEST_JSON_OUT, JSON.stringify(output, null, 2));
console.log(JSON.stringify(output, null, 2));
if (harnessErrors.length > 0) process.exitCode = 1;
if (findings.length > 0) process.exitCode = 2;
