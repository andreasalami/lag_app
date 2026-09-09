import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createClient } from "@supabase/supabase-js";

const url = process.env.LOADTEST_SUPABASE_URL;
const anonKey = process.env.LOADTEST_SUPABASE_ANON_KEY;
const serviceKey = process.env.LOADTEST_SUPABASE_SERVICE_ROLE_KEY;
if (process.env.LOADTEST_CONFIRM !== "LOCAL_SUPABASE_ONLY") throw new Error("Conferma richiesta: LOADTEST_CONFIRM=LOCAL_SUPABASE_ONLY");
if (!url || !anonKey || !serviceKey) throw new Error("Mancano le credenziali del Supabase locale.");
const target = new URL(url);
if (target.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)) {
  throw new Error(`Target non locale rifiutato: ${target.origin}`);
}

const intEnv = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} non valido`);
  return value;
};
const capacity = intEnv("LOADTEST_CAPACITY", 150);
const capAttempts = intEnv("LOADTEST_CAP_ATTEMPTS", capacity + 50);
const readAttempts = intEnv("LOADTEST_READ_ATTEMPTS", 200);
const stockAttempts = intEnv("LOADTEST_STOCK_ATTEMPTS", 50);
const raceOrders = intEnv("LOADTEST_CLOSE_RACE_ORDERS", 30);
const raceRounds = intEnv("LOADTEST_CLOSE_RACE_ROUNDS", 10);
const selected = new Set((process.env.LOADTEST_SCENARIOS
  ?? "read,idempotency,claims,expiry,stock,capacity,legacy,close-race").split(",").map((v) => v.trim()));
const known = new Set(["read", "idempotency", "claims", "expiry", "stock", "capacity", "legacy", "close-race"]);
for (const scenario of selected) if (!known.has(scenario)) throw new Error(`Scenario sconosciuto: ${scenario}`);

const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const publicClient = createClient(url, anonKey, options);
const service = createClient(url, serviceKey, options);
const runId = crypto.randomUUID().slice(0, 8);
const fixtures = { unlimited: crypto.randomUUID(), limited: crypto.randomUUID() };
const checks = [];
const findings = [];
let eventId;
let savedEvent;
let adminId;

const message = (error) => error?.message ?? String(error ?? "");
const summary = (results) => {
  const sorted = results.map((r) => r.ms).sort((a, b) => a - b);
  const percentile = (p) => Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0);
  return { p50_ms: percentile(0.5), p95_ms: percentile(0.95), p99_ms: percentile(0.99) };
};
const pass = (name, details = {}) => { checks.push({ name, status: "PASS", ...details }); console.log("PASS", name, details); };
const fail = (name, details = {}) => { findings.push({ name, status: "FINDING", ...details }); console.error("FIND", name, details); };

async function rpc(client, name, args) {
  const start = performance.now();
  const { data, error } = await client.rpc(name, args);
  return { data, error, ms: performance.now() - start };
}
async function query(promise, label) {
  const result = await promise;
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}
async function clearOrders() { await query(service.from("orders").delete().eq("event_id", eventId), "pulizia ordini"); }
async function openEvent(limit = capacity) {
  const now = Date.now();
  await query(service.from("order_events").update({
    name: `[LOADTEST] ${runId}`, opens_at: new Date(now - 60_000).toISOString(),
    closes_at: new Date(now + 3_600_000).toISOString(), manual_closed: false,
    permanently_closed_at: null, final_report: null, max_pending_orders: limit,
  }).eq("id", eventId), "apertura evento");
}
async function setStock(value) {
  await query(service.from("menu_items").update({ available_portions: value, stock_capacity: value }).eq("id", fixtures.limited), "scorta fixture");
}
function submit(itemId, { requestId = crypto.randomUUID(), qrToken = crypto.randomUUID(), clientId = crypto.randomUUID() } = {}) {
  return rpc(publicClient, "submit_public_order", {
    p_alias: "Load test", p_notes: "", p_items: [{ id: itemId, qty: 1 }],
    p_client_request_id: requestId, p_qr_token: qrToken, p_bot_field: "", p_client_id: clientId,
  });
}
const claim = (client, orderId, deviceId) => rpc(client, "claim_order_for_station", {
  p_order_id: orderId, p_station: "cassa_1", p_device_id: deviceId,
});
const pay = (client, orderId, deviceId, operationId = crypto.randomUUID()) => rpc(client, "pay_order_for_station", {
  p_order_id: orderId, p_station: "cassa_1", p_device_id: deviceId, p_operation_id: operationId,
});
const deliver = (client, orderId, operationId = crypto.randomUUID()) => rpc(client, "deliver_fulfillment_items", {
  p_order_id: orderId, p_station: "primi", p_items: [{ id: fixtures.limited, qty: 1 }], p_operation_id: operationId,
});

async function setup() {
  const events = await query(service.from("order_events").select("*").eq("is_current", true), "evento corrente");
  assert.equal(events.length, 1);
  savedEvent = events[0]; eventId = savedEvent.id;
  const { count } = await service.from("orders").select("id", { count: "exact", head: true }).eq("event_id", eventId);
  assert.equal(count, 0, "Lo stress test richiede un evento locale senza ordini.");
  await query(service.from("menu_items").insert([
    { id: fixtures.unlimited, category: "cibo", subcategory: "primi", name: `[LOADTEST] unlimited ${runId}`, price: 1, available_portions: null, stock_capacity: null, allergens: [] },
    { id: fixtures.limited, category: "cibo", subcategory: "primi", name: `[LOADTEST] limited ${runId}`, price: 1, available_portions: 1, stock_capacity: 1, allergens: [] },
  ]), "fixture menu");
  await openEvent();
  const email = `load-${runId}@example.invalid`; const password = `Local-${crypto.randomUUID()}!`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`utente admin: ${message(error)}`);
  adminId = data.user.id;
  await query(service.from("profiles").update({ role: "admin" }).eq("id", adminId), "ruolo admin");
  const client = createClient(url, anonKey, options);
  const login = await client.auth.signInWithPassword({ email, password });
  if (login.error) throw login.error;
  return client;
}

async function readScenario() {
  const results = await Promise.all(Array.from({ length: readAttempts }, () => rpc(publicClient, "get_ordering_status")));
  const errors = results.filter((r) => r.error);
  if (errors.length) fail("burst letture", { errors: errors.length });
  else pass(`${readAttempts} letture concorrenti`, summary(results));
}

async function idempotencyScenario(admin) {
  await clearOrders(); await openEvent(); await setStock(10);
  const identity = { requestId: crypto.randomUUID(), qrToken: crypto.randomUUID(), clientId: crypto.randomUUID() };
  const submissions = await Promise.all(Array.from({ length: 25 }, () => submit(fixtures.limited, identity)));
  const successes = submissions.filter((r) => !r.error);
  const rows = await query(service.from("orders").select("id").eq("event_id", eventId), "ordini idempotenti");
  const stock = (await query(service.from("menu_items").select("available_portions").eq("id", fixtures.limited), "scorta"))[0]?.available_portions;
  if (successes.length === 25 && new Set(successes.map((r) => r.data.order_id)).size === 1 && rows.length === 1 && stock === 9) pass("invio pubblico idempotente", summary(submissions));
  else fail("invio pubblico idempotente", { successes: successes.length, rows: rows.length, stock });

  const orderId = successes[0]?.data.order_id; const deviceId = crypto.randomUUID();
  const claimed = await claim(admin, orderId, deviceId); if (claimed.error) throw claimed.error;
  const payId = crypto.randomUUID();
  const payments = await Promise.all(Array.from({ length: 20 }, () => pay(admin, orderId, deviceId, payId)));
  const payAudit = await query(service.from("order_operations").select("operation_id").eq("operation_id", payId), "audit pagamento");
  if (payments.every((r) => !r.error) && payAudit.length === 1) pass("pagamento idempotente", summary(payments));
  else fail("pagamento idempotente", { errors: payments.filter((r) => r.error).map((r) => message(r.error)), audit: payAudit.length });

  const deliveryId = crypto.randomUUID();
  const deliveries = await Promise.all(Array.from({ length: 20 }, () => deliver(admin, orderId, deliveryId)));
  const item = (await query(service.from("order_fulfillment_items").select("quantity,delivered_quantity").eq("order_id", orderId), "evasione"))[0];
  if (deliveries.every((r) => !r.error) && item?.delivered_quantity === 1) pass("consegna idempotente", summary(deliveries));
  else fail("consegna idempotente", { errors: deliveries.filter((r) => r.error).map((r) => message(r.error)), item });
}

async function claimsScenario(admin) {
  await clearOrders(); await openEvent();
  const order = await submit(fixtures.unlimited); if (order.error) throw order.error;
  const results = await Promise.all([claim(admin, order.data.order_id, crypto.randomUUID()), claim(admin, order.data.order_id, crypto.randomUUID())]);
  const rows = await query(service.from("order_claim_devices").select("order_id").eq("order_id", order.data.order_id), "claim");
  if (results.filter((r) => !r.error).length === 1 && results.filter((r) => message(r.error).includes("order_already_claimed")).length === 1 && rows.length === 1) pass("claim esclusivo per dispositivo");
  else fail("claim esclusivo", { results: results.map((r) => message(r.error) || "ok"), rows: rows.length });
}

async function expiryScenario() {
  await clearOrders(); await openEvent(); await setStock(1);
  const order = await submit(fixtures.limited); if (order.error) throw order.error;
  await query(service.from("orders").update({ pending_expires_at: new Date(Date.now() - 60_000).toISOString() }).eq("id", order.data.order_id), "forza scadenza");
  await rpc(publicClient, "get_ordering_status");
  const row = (await query(service.from("orders").select("status,expired_at,pending_expires_at").eq("id", order.data.order_id), "scadenza"))[0];
  const stock = (await query(service.from("menu_items").select("available_portions").eq("id", fixtures.limited), "scorta ripristinata"))[0]?.available_portions;
  if (row?.status === "annullato" && row.expired_at && row.pending_expires_at === null && stock === 1) pass("scadenza restituisce la scorta");
  else fail("scadenza", { row, stock });

  const clientId = crypto.randomUUID(); const limited = [];
  for (let i = 0; i < 7; i += 1) limited.push(await submit(fixtures.unlimited, { clientId }));
  if (limited.filter((r) => !r.error).length === 6 && limited.filter((r) => message(r.error).includes("submission_rate_limited")).length === 1) pass("rate limit per dispositivo");
  else fail("rate limit", { results: limited.map((r) => message(r.error) || "ok") });
}

async function stockScenario() {
  await clearOrders(); await openEvent(); await setStock(1);
  const results = await Promise.all(Array.from({ length: stockAttempts }, () => submit(fixtures.limited)));
  const ok = results.filter((r) => !r.error).length; const rejected = results.filter((r) => message(r.error).includes("stock_unavailable")).length;
  if (ok === 1 && rejected === stockAttempts - 1) pass("ultima porzione concorrente", summary(results));
  else fail("ultima porzione", { ok, rejected });
}

async function capacityScenario() {
  await clearOrders(); await openEvent(capacity);
  const results = await Promise.all(Array.from({ length: capAttempts }, () => submit(fixtures.unlimited)));
  const ok = results.filter((r) => !r.error).length; const rejected = results.filter((r) => message(r.error).includes("capacity_reached")).length;
  const rows = await query(service.from("orders").select("display_number").eq("event_id", eventId).eq("status", "in_attesa_pagamento"), "capienza");
  if (ok === capacity && rejected === capAttempts - capacity && rows.length === capacity && new Set(rows.map((r) => r.display_number)).size === capacity) pass("limite ordini concorrente", summary(results));
  else fail("capienza", { ok, rejected, rows: rows.length });
}

async function legacyScenario(admin) {
  const names = ["claim_order", "claim_order_by_qr", "release_order_claim", "update_claimed_order", "cancel_claimed_order", "pay_claimed_order", "deliver_order", "deliver_order_by_qr"];
  const results = await Promise.all(names.map((name) => rpc(admin, name, {})));
  if (results.every((r) => r.error?.code === "PGRST202" || /schema cache|could not find/i.test(message(r.error)))) pass("RPC legacy assenti");
  else fail("RPC legacy raggiungibile", { results: names.map((name, i) => [name, message(results[i].error)]) });
}

async function closeRaceScenario(admin) {
  let inconsistent = 0; let deadlocks = 0;
  for (let round = 0; round < raceRounds; round += 1) {
    await clearOrders(); await openEvent(); await setStock(raceOrders);
    const submitted = await Promise.all(Array.from({ length: raceOrders }, () => submit(fixtures.limited)));
    const orders = submitted.filter((r) => !r.error).map((r) => r.data); assert.equal(orders.length, raceOrders);
    const claimed = await Promise.all(orders.map(async (order) => {
      const device = crypto.randomUUID(); return { order, device, result: await claim(admin, order.order_id, device) };
    }));
    assert.equal(claimed.filter((c) => !c.result.error).length, raceOrders);
    const seed = claimed[0]; const seedPay = await pay(admin, seed.order.order_id, seed.device); if (seedPay.error) throw seedPay.error;
    const startPays = () => claimed.slice(1).map((c) => pay(admin, c.order.order_id, c.device));
    let closing; let paying;
    if (round % 2 === 0) { closing = rpc(admin, "close_order_event"); await new Promise((r) => setTimeout(r, 5)); paying = startPays(); }
    else { paying = startPays(); await new Promise((r) => setTimeout(r, 5)); closing = rpc(admin, "close_order_event"); }
    const [closed, payments] = await Promise.all([closing, Promise.all(paying)]);
    deadlocks += [closed, ...payments].filter((r) => /deadlock|40P01/i.test(message(r.error))).length;
    const final = await query(service.from("orders").select("status").eq("event_id", eventId), "race finale");
    const paid = 1 + payments.filter((r) => !r.error).length;
    const coherent = !closed.error && final.filter((r) => r.status === "consegnato").length === paid
      && final.filter((r) => r.status === "annullato").length === raceOrders - paid
      && Number(closed.data?.summary?.orders_paid) === paid;
    if (!coherent) inconsistent += 1;
  }
  if (inconsistent === 0 && deadlocks === 0) pass("race chiusura/pagamento", { rounds: raceRounds });
  else fail("race chiusura", { inconsistent, deadlocks });
}

async function cleanup() {
  if (eventId) await service.from("orders").delete().eq("event_id", eventId);
  await service.from("menu_items").delete().in("id", Object.values(fixtures));
  if (savedEvent) await service.from("order_events").update({
    name: savedEvent.name, opens_at: savedEvent.opens_at, closes_at: savedEvent.closes_at,
    manual_closed: savedEvent.manual_closed, permanently_closed_at: savedEvent.permanently_closed_at,
    max_pending_orders: savedEvent.max_pending_orders, final_report: savedEvent.final_report,
  }).eq("id", savedEvent.id);
  if (adminId) await service.auth.admin.deleteUser(adminId);
}

console.log(`Stress test ordini LAG su ${target.origin} (${runId})`);
try {
  const admin = await setup();
  if (selected.has("read")) await readScenario();
  if (selected.has("idempotency")) await idempotencyScenario(admin);
  if (selected.has("claims")) await claimsScenario(admin);
  if (selected.has("expiry")) await expiryScenario();
  if (selected.has("stock")) await stockScenario();
  if (selected.has("capacity")) await capacityScenario();
  if (selected.has("legacy")) await legacyScenario(admin);
  if (selected.has("close-race")) await closeRaceScenario(admin);
} finally { await cleanup(); }
console.log(JSON.stringify({ target: target.origin, checks, findings }, null, 2));
if (findings.length) process.exitCode = 2;
