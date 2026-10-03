// Stress test degli ordini: concorrenza reale su un PostgreSQL usa-e-getta.
//
// Il runner crea un cluster PostgreSQL in una cartella temporanea, raggiungibile solo
// via socket Unix (nessuna porta di rete), installa supabase/schema.sql con i ruoli di
// Supabase e lancia molte connessioni psql in parallelo. Alla fine spegne il cluster e
// cancella la cartella. Non si collega mai a Supabase: non può toccare la produzione.
//
// Verifica le funzioni SQL sotto concorrenza (lock, limiti, idempotenza); il gateway
// Turnstile, PostgREST e la rete restano fuori. Ogni chiamata apre un processo psql:
// i tempi includono quell'avvio e servono a confrontare esecuzioni, non come latenza reale.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const integerEnv = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} deve essere un intero positivo.`);
  return value;
};

const capacity = integerEnv("LOADTEST_CAPACITY", 100);
const capAttempts = integerEnv("LOADTEST_CAP_ATTEMPTS", capacity + 50);
const readAttempts = integerEnv("LOADTEST_READ_ATTEMPTS", 200);
const stockAttempts = integerEnv("LOADTEST_STOCK_ATTEMPTS", 50);
const raceOrders = integerEnv("LOADTEST_CLOSE_RACE_ORDERS", 30);
const raceRounds = integerEnv("LOADTEST_CLOSE_RACE_ROUNDS", 10);
const knownScenarios = ["read", "idempotency", "stock", "capacity", "identities", "close-race"];
const selectedScenarios = new Set(
  (process.env.LOADTEST_SCENARIOS ?? knownScenarios.join(","))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
for (const scenario of selectedScenarios) {
  if (!knownScenarios.includes(scenario)) throw new Error(`Scenario sconosciuto: ${scenario}`);
}
if (capAttempts <= capacity) throw new Error("LOADTEST_CAP_ATTEMPTS deve superare LOADTEST_CAPACITY.");
if (capacity < 10 || capacity > 1000) throw new Error("La capienza deve restare tra 10 e 1000.");

// Binari PostgreSQL: dal PATH, oppure da LOADTEST_PG_BIN (per esempio /opt/homebrew/opt/postgresql@17/bin).
const bin = (name) => (process.env.LOADTEST_PG_BIN ? join(process.env.LOADTEST_PG_BIN, name) : name);
// Su macOS il postmaster si rifiuta di partire senza una LC_ALL valida.
const pgEnv = { ...process.env, LC_ALL: "C" };
const workDir = mkdtempSync(join(tmpdir(), "lag-stress-"));
const dataDir = join(workDir, "data");
const port = "55432"; // Solo il nome del socket: listen_addresses vuoto, nessuna porta TCP.
const PSQL_ARGS = ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"];
const connection = ["-h", workDir, "-p", port, "-U", "postgres", "-d", "postgres"];

const checks = [];
const findings = [];
const fixtureIds = { unlimited: crypto.randomUUID(), limited: crypto.randomUUID() };
const admin = crypto.randomUUID();

// Letterali SQL: i valori sono generati qui (UUID, costanti), mai input esterno.
const lit = (value) => (value === null || value === undefined ? "null" : `'${String(value).replaceAll("'", "''")}'`);
const jsonb = (value) => `${lit(JSON.stringify(value))}::jsonb`;

/** Esegue SQL in una connessione propria: come browser (anon), gateway (service_role) o utente autenticato. */
function sql(query, { as = "postgres", user = null } = {}) {
  const preamble = as === "postgres" ? "" : `set role ${as};\nset request.jwt.claim.sub = ${lit(user ?? "")};\n`;
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(bin("psql"), [...PSQL_ARGS, ...connection]);
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (code) => {
      const ms = performance.now() - started;
      if (code === 0) {
        const text = out.trim();
        let data = text;
        try {
          data = text === "" ? null : JSON.parse(text);
        } catch {
          /* risultato non JSON: resta testo */
        }
        resolve({ data, error: null, ms });
      } else {
        const match = err.match(/ERROR:\s+([0-9A-Z]{5}):\s+([^\n]*)/);
        resolve({ data: null, error: { code: match?.[1] ?? null, message: match?.[2] ?? err.trim() }, ms });
      }
    });
    child.stdin.end(`${preamble}${query}\n`);
  });
}

async function admin_sql(query) {
  const result = await sql(query);
  if (result.error) throw new Error(`${query.slice(0, 80)}: ${result.error.message}`);
  return result.data;
}

const rpc = (name, args, options) => sql(`select public.${name}(${args.join(", ")})`, options);
const asAdmin = { as: "authenticated", user: admin };
const asPublic = { as: "anon" };
const messageOf = (error) => error?.message ?? "";

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function timingSummary(results) {
  const durations = results.map((result) => result.ms);
  return {
    p50_ms: Math.round(percentile(durations, 0.5)),
    p95_ms: Math.round(percentile(durations, 0.95)),
    max_ms: Math.round(Math.max(0, ...durations)),
  };
}

function pass(name, details = {}) {
  checks.push({ name, ...details, status: "PASS" });
  console.log(`PASS  ${name}`, details);
}

function finding(name, details = {}) {
  findings.push({ name, ...details, status: "FINDING" });
  console.error(`FIND  ${name}`, details);
}

/** Ordine pubblico come lo inoltra il gateway dopo la verifica Turnstile (service_role). */
function publicOrder(itemId, { requestId = crypto.randomUUID(), qrToken = crypto.randomUUID() } = {}) {
  return rpc(
    "submit_public_order",
    [lit("Load test"), lit(""), jsonb([{ id: itemId, qty: 1 }]), lit(requestId), lit(qrToken), lit("")],
    { as: "service_role" },
  );
}

const stationCall = (name, orderId, device, station = "cassa_1") =>
  rpc(name, [lit(orderId), lit(station), lit(device)], asAdmin);
const publicStatus = (qrToken) => rpc("get_public_order_statuses", [`array[${lit(qrToken)}]`], asPublic);
const stock = async () =>
  (await admin_sql(`select available_portions from public.menu_items where id = ${lit(fixtureIds.limited)}`)) ?? null;
const orderCount = async (where = "true") =>
  Number(await admin_sql(`select count(*) from public.orders where ${where}`));

async function startCluster() {
  execFileSync(bin("initdb"), ["-D", dataDir, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--locale=C"], {
    stdio: "ignore",
    env: pgEnv,
  });
  try {
    execFileSync(
      bin("pg_ctl"),
      [
        "-D",
        dataDir,
        "-l",
        join(workDir, "postgres.log"),
        "-o",
        `-k ${workDir} -p ${port} -c listen_addresses='' -c max_connections=${Math.max(capAttempts, readAttempts) + 50}`,
        "-w",
        "start",
      ],
      { stdio: "ignore", env: pgEnv },
    );
  } catch {
    throw new Error(
      `PostgreSQL temporaneo non avviato:\n${readFileSync(join(workDir, "postgres.log"), "utf8").slice(-1500)}`,
    );
  }
}

async function setup() {
  // Ruoli, auth.uid() e pgcrypto come su Supabase.
  await admin_sql(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth; create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create schema extensions; create extension pgcrypto with schema extensions;
grant usage on schema public, auth, extensions to anon, authenticated, service_role;
create publication supabase_realtime;`);
  const schema = new URL("../../supabase/schema.sql", import.meta.url);
  const install = spawn(bin("psql"), [...PSQL_ARGS, ...connection, "-f", schema.pathname]);
  let err = "";
  install.stderr.on("data", (chunk) => (err += chunk));
  const code = await new Promise((resolve) => install.on("close", resolve));
  if (code !== 0) throw new Error(`installazione schema.sql: ${err.trim()}`);

  await admin_sql(`insert into auth.users values (${lit(admin)});
update public.profiles set role = 'admin' where id = ${lit(admin)};
insert into public.menu_items (id, category, subcategory, name, price, available_portions, stock_capacity) values
  (${lit(fixtureIds.unlimited)}, 'bevande', 'birre', '[LOADTEST] illimitato', 1, null, null),
  (${lit(fixtureIds.limited)}, 'bevande', 'birre', '[LOADTEST] scorta limitata', 1, 1, 1);`);
  assert.equal(Number(await admin_sql("select count(*) from public.order_events where is_current")), 1);
}

async function resetEvent({ limit = capacity, portions = 1 } = {}) {
  await admin_sql(`truncate public.orders cascade;
update public.order_events set opens_at = now() - interval '1 minute', closes_at = now() + interval '1 hour',
  manual_closed = false, permanently_closed_at = null, final_report = null, max_pending_orders = ${limit}
  where is_current;
update public.menu_items set available_portions = ${portions}, stock_capacity = ${portions} where id = ${lit(fixtureIds.limited)};`);
}

async function readBurst() {
  const results = await Promise.all(
    Array.from({ length: readAttempts }, () => rpc("get_ordering_status", [], asPublic)),
  );
  const errors = results.filter((result) => result.error);
  if (errors.length === 0) pass(`${readAttempts} letture concorrenti dello stato`, timingSummary(results));
  else finding("Errori nel burst di lettura", { errors: errors.length, first: errors[0].error });
}

async function idempotencyScenario() {
  await resetEvent({ portions: 10 });
  const requestId = crypto.randomUUID();
  const qrToken = crypto.randomUUID();
  const results = await Promise.all(
    Array.from({ length: 25 }, () => publicOrder(fixtureIds.limited, { requestId, qrToken })),
  );
  const successes = results.filter((result) => !result.error);
  const ids = new Set(successes.map((result) => result.data?.order_id));
  if (successes.length === 25 && ids.size === 1 && (await orderCount()) === 1 && (await stock()) === 9) {
    pass("25 retry simultanei producono un solo ordine", timingSummary(results));
  } else {
    finding("Idempotenza concorrente violata", {
      successes: successes.length,
      distinct_order_ids: ids.size,
      database_rows: await orderCount(),
      remaining_stock: await stock(),
      first_error: results.find((result) => result.error)?.error,
    });
  }

  const conflict = await publicOrder(fixtureIds.limited, { requestId, qrToken: crypto.randomUUID() });
  if (messageOf(conflict.error).includes("request_id_conflict"))
    pass("Request ID riutilizzato con QR diverso respinto");
  else finding("Request ID/QR conflict non respinto", { error: conflict.error });

  // Cassa, consegna al bar e stato pubblico, poi un retry tardivo dello stesso invio.
  const orderId = successes[0]?.data?.order_id;
  const device = crypto.randomUUID();
  const pending = await publicStatus(qrToken);
  const claim = await stationCall("claim_order_for_station", orderId, device);
  const payment = claim.error ? claim : await stationCall("pay_order_for_station", orderId, device);
  const paid = await publicStatus(qrToken);
  const delivery = payment.error
    ? payment
    : await rpc(
        "deliver_fulfillment_items",
        [lit(orderId), lit("birre"), jsonb([{ id: fixtureIds.limited, qty: 1 }])],
        asAdmin,
      );
  const delivered = await publicStatus(qrToken);
  const lateRetry = await publicOrder(fixtureIds.limited, { requestId, qrToken });
  if (
    !claim.error &&
    !payment.error &&
    !delivery.error &&
    pending.data?.[0]?.status === "in_attesa_pagamento" &&
    paid.data?.[0]?.status === "pagato" &&
    delivered.data?.[0]?.status === "consegnato" &&
    lateRetry.data?.order_id === orderId &&
    lateRetry.data?.status === "consegnato" &&
    (await orderCount()) === 1 &&
    (await stock()) === 9
  ) {
    pass("Un retry tardivo dopo pagamento e consegna restituisce lo stesso ordine senza duplicarlo");
  } else {
    finding("Flusso cassa/consegna o retry tardivo non coerente", {
      claim_error: claim.error,
      payment_error: payment.error,
      delivery_error: delivery.error,
      statuses: [pending.data?.[0]?.status, paid.data?.[0]?.status, delivered.data?.[0]?.status],
      late_retry: lateRetry.data ?? lateRetry.error,
      database_rows: await orderCount(),
      remaining_stock: await stock(),
    });
  }
}

async function lastPortionScenario() {
  await resetEvent({ portions: 1 });
  const results = await Promise.all(Array.from({ length: stockAttempts }, () => publicOrder(fixtureIds.limited)));
  const successes = results.filter((result) => !result.error);
  const soldOut = results.filter((result) => messageOf(result.error).includes("stock_unavailable"));
  if (successes.length === 1 && soldOut.length === stockAttempts - 1 && (await stock()) === 0) {
    pass(`${stockAttempts} concorrenti sull'ultima porzione: una sola vendita`, timingSummary(results));
  } else {
    finding("Protezione ultima porzione violata", {
      successes: successes.length,
      sold_out_errors: soldOut.length,
      remaining_stock: await stock(),
      other_error: results.find((result) => result.error && !soldOut.includes(result))?.error,
    });
  }
}

async function capacityScenario() {
  await resetEvent();
  const results = await Promise.all(Array.from({ length: capAttempts }, () => publicOrder(fixtureIds.unlimited)));
  const successes = results.filter((result) => !result.error);
  const capacityErrors = results.filter((result) => messageOf(result.error).includes("capacity_reached"));
  const unexpected = results.filter((result) => result.error && !messageOf(result.error).includes("capacity_reached"));
  const rows = Number(await admin_sql("select count(*) from public.orders where status = 'in_attesa_pagamento'"));
  const numbers = Number(await admin_sql("select count(distinct display_number) from public.orders"));
  const status = await rpc("get_ordering_status", [], asPublic);
  const catalog = await rpc("get_ordering_catalog", [], asPublic);
  if (
    successes.length === capacity &&
    rows === capacity &&
    numbers === capacity &&
    capacityErrors.length === capAttempts - capacity &&
    unexpected.length === 0 &&
    status.data?.accepting === false &&
    status.data?.reason === "capacity_reached" &&
    catalog.data?.items?.length === 0
  ) {
    pass(`Il burst da ${capAttempts} invii non supera il limite ${capacity}`, timingSummary(results));
  } else {
    finding("Invariante del limite ordini violata", {
      accepted: successes.length,
      capacity_errors: capacityErrors.length,
      unexpected_errors: unexpected.length,
      first_unexpected: unexpected[0]?.error,
      pending_rows: rows,
      unique_numbers: numbers,
      ordering_status: status.data,
    });
  }
}

async function identityScenarios() {
  await resetEvent({ portions: 2 });
  const order = await publicOrder(fixtureIds.unlimited);
  if (order.error) throw new Error(`setup identità: ${order.error.message}`);
  const orderId = order.data.order_id;
  const owner = crypto.randomUUID();

  // Postazione o dispositivo non validi, operazioni senza presa in carico o da un altro dispositivo.
  const rejected = await Promise.all([
    stationCall("claim_order_for_station", orderId, null).then((result) => ["invalid_device", result]),
    stationCall("claim_order_for_station", orderId, owner, "cassa_9").then((result) => ["invalid_station", result]),
    stationCall("pay_order_for_station", orderId, owner).then((result) => ["claim_lost", result]),
    stationCall("cancel_order_for_station", orderId, owner).then((result) => ["claim_lost", result]),
  ]);
  const claim = await stationCall("claim_order_for_station", orderId, owner);
  const stranger = await Promise.all([
    stationCall("pay_order_for_station", orderId, crypto.randomUUID()),
    stationCall("cancel_order_for_station", orderId, crypto.randomUUID()),
  ]);
  const statusBefore = await admin_sql(`select status from public.orders where id = ${lit(orderId)}`);
  const ownerPay = await stationCall("pay_order_for_station", orderId, owner);
  if (
    rejected.every(([expected, result]) => messageOf(result.error).includes(expected)) &&
    !claim.error &&
    stranger.every((result) => messageOf(result.error).includes("claim_lost")) &&
    statusBefore === "in_attesa_pagamento" &&
    !ownerPay.error
  ) {
    pass("Solo il dispositivo che ha preso l'ordine in carico può incassarlo o annullarlo");
  } else {
    finding("Protezione della presa in carico incompleta", {
      rejected: rejected.map(([expected, result]) => ({ expected, error: result.error })),
      claim_error: claim.error,
      stranger: stranger.map((result) => result.error),
      status_before_owner_pay: statusBefore,
      owner_pay_error: ownerPay.error,
    });
  }

  await resetEvent({ portions: 2 });
  const sharedQr = crypto.randomUUID();
  const duplicateQr = await Promise.all([
    publicOrder(fixtureIds.limited, { qrToken: sharedQr }),
    publicOrder(fixtureIds.limited, { qrToken: sharedQr }),
  ]);
  const accepted = duplicateQr.filter((result) => !result.error);
  const refused = duplicateQr.filter((result) => result.error);
  if (
    accepted.length === 1 &&
    refused[0]?.error?.code === "23505" &&
    (await orderCount()) === 1 &&
    (await stock()) === 1
  ) {
    pass("QR duplicato respinto senza consumare due volte la scorta");
  } else {
    finding("Lo stesso QR non è protetto da unicità", {
      accepted: accepted.length,
      errors: refused.map((result) => result.error),
      database_rows: await orderCount(),
      remaining_stock: await stock(),
    });
  }

  await resetEvent({ portions: 2 });
  const nullRequest = await Promise.all([
    publicOrder(fixtureIds.limited, { requestId: null }),
    publicOrder(fixtureIds.limited, { requestId: null }),
  ]);
  if (
    nullRequest.every((result) => messageOf(result.error).includes("invalid_client_request_id")) &&
    (await orderCount()) === 0 &&
    (await stock()) === 2
  ) {
    pass("Client request ID NULL respinto senza creare ordini o consumare scorte");
  } else {
    finding("Client request ID NULL non è protetto", {
      errors: nullRequest.map((result) => result.error),
      database_rows: await orderCount(),
      remaining_stock: await stock(),
    });
  }
}

async function closeRaceScenario() {
  let inconsistentRounds = 0;
  let deadlocks = 0;
  const samples = [];
  for (let round = 0; round < raceRounds; round += 1) {
    await resetEvent({ portions: raceOrders });
    const submitted = await Promise.all(Array.from({ length: raceOrders }, () => publicOrder(fixtureIds.limited)));
    const orders = submitted.filter((result) => !result.error).map((result) => result.data);
    assert.equal(orders.length, raceOrders, `Setup gara di chiusura incompleto al round ${round + 1}.`);
    const claims = await Promise.all(
      orders.map(async (order) => {
        const device = crypto.randomUUID();
        return { order, device, result: await stationCall("claim_order_for_station", order.order_id, device) };
      }),
    );
    assert.equal(claims.filter(({ result }) => !result.error).length, raceOrders, "Prese in carico incomplete.");

    const [seed, ...racing] = claims;
    const seedPayment = await stationCall("pay_order_for_station", seed.order.order_id, seed.device);
    if (seedPayment.error) throw new Error(`Pagamento iniziale: ${seedPayment.error.message}`);
    const startPayments = () =>
      racing.map(({ order, device }) => ({
        orderId: order.order_id,
        promise: stationCall("pay_order_for_station", order.order_id, device),
      }));

    // Turni alterni: chiusura prima dei pagamenti, poi pagamenti prima della chiusura.
    let closePromise;
    let payments;
    if (round % 2 === 0) {
      closePromise = rpc("close_order_event", [], asAdmin);
      await new Promise((resolve) => setTimeout(resolve, 5));
      payments = startPayments();
    } else {
      payments = startPayments();
      await new Promise((resolve) => setTimeout(resolve, 5));
      closePromise = rpc("close_order_event", [], asAdmin);
    }
    const [close, payResults] = await Promise.all([
      closePromise,
      Promise.all(payments.map(async ({ orderId, promise }) => ({ orderId, result: await promise }))),
    ]);
    deadlocks += [close, ...payResults.map(({ result }) => result)].filter(
      (result) => result.error?.code === "40P01",
    ).length;

    const finalById = new Map(
      (
        (await admin_sql(
          "select coalesce(json_agg(json_build_object('id', id, 'status', status)), '[]') from public.orders",
        )) ?? []
      ).map((row) => [row.id, row.status]),
    );
    const paidInRace = payResults.filter(({ result }) => !result.error);
    const closedErrors = payResults.filter(({ result }) => messageOf(result.error).includes("event_closed")).length;
    const unexpectedPayErrors = payResults.length - paidInRace.length - closedErrors;
    const paySuccesses = 1 + paidInRace.length;
    const statuses = [...finalById.values()];
    const resultMappingValid =
      finalById.get(seed.order.order_id) === "consegnato" &&
      payResults.every(({ orderId, result }) => finalById.get(orderId) === (result.error ? "annullato" : "consegnato"));
    const summary = close.data?.summary ?? {};
    const productQuantity = Array.isArray(close.data?.products)
      ? close.data.products.reduce((sum, product) => sum + Number(product.quantity ?? 0), 0)
      : -1;
    const closedAt = await admin_sql(
      "select permanently_closed_at is not null from public.order_events where is_current",
    );
    const actualStock = await stock();
    const coherent =
      !close.error &&
      closedAt === "t" &&
      statuses.filter((status) => status === "consegnato").length === paySuccesses &&
      statuses.filter((status) => status === "annullato").length === raceOrders - paySuccesses &&
      resultMappingValid &&
      actualStock === raceOrders - paySuccesses &&
      Number(summary.orders_total) === raceOrders &&
      Number(summary.orders_paid) === paySuccesses &&
      Number(summary.orders_abandoned) === raceOrders - paySuccesses &&
      Number(summary.revenue_total) === paySuccesses &&
      productQuantity === paySuccesses &&
      unexpectedPayErrors === 0;
    if (!coherent) {
      inconsistentRounds += 1;
      if (samples.length < 3) {
        samples.push({
          round: round + 1,
          pay_successes: paySuccesses,
          unexpected_pay_errors: unexpectedPayErrors,
          first_unexpected: payResults.find(
            ({ result }) => result.error && !messageOf(result.error).includes("event_closed"),
          )?.result.error,
          actual_stock: actualStock,
          summary,
          product_quantity: productQuantity,
          close_error: close.error,
          result_mapping_valid: resultMappingValid,
        });
      }
    }
  }
  if (inconsistentRounds === 0 && deadlocks === 0) {
    pass(`${raceRounds} gare chiusura/pagamento coerenti`, { orders_per_round: raceOrders });
  } else {
    finding("La gara chiusura/pagamento altera scorte o report", {
      inconsistent_rounds: inconsistentRounds,
      deadlocks,
      samples,
    });
  }
}

console.log(`Stress test ordini LAG su PostgreSQL temporaneo (${workDir})`);
try {
  await startCluster();
  await setup();
  if (selectedScenarios.has("read")) await readBurst();
  if (selectedScenarios.has("idempotency")) await idempotencyScenario();
  if (selectedScenarios.has("stock")) await lastPortionScenario();
  if (selectedScenarios.has("capacity")) await capacityScenario();
  if (selectedScenarios.has("identities")) await identityScenarios();
  if (selectedScenarios.has("close-race")) await closeRaceScenario();
} finally {
  try {
    execFileSync(bin("pg_ctl"), ["-D", dataDir, "-m", "fast", "-w", "stop"], { stdio: "ignore", env: pgEnv });
  } catch {
    /* cluster mai avviato */
  }
  rmSync(workDir, { recursive: true, force: true });
}

console.log(JSON.stringify({ checks: checks.length, findings }, null, 2));
if (findings.length > 0) process.exitCode = 2;
