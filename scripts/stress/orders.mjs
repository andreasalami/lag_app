import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createClient } from "@supabase/supabase-js";

const REQUIRED_CONFIRMATION = "LOCAL_SUPABASE_ONLY";
const url = process.env.LOADTEST_SUPABASE_URL;
const anonKey = process.env.LOADTEST_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.LOADTEST_SUPABASE_SERVICE_ROLE_KEY;

if (process.env.LOADTEST_CONFIRM !== REQUIRED_CONFIRMATION) {
  throw new Error(`Imposta LOADTEST_CONFIRM=${REQUIRED_CONFIRMATION} per confermare il test locale.`);
}
if (!url || !anonKey || !serviceRoleKey) {
  throw new Error("Mancano URL, anon key o service-role key del Supabase locale.");
}

const target = new URL(url);
const localHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
if (target.protocol !== "http:" || !localHosts.has(target.hostname)) {
  throw new Error(`Target rifiutato: ${target.origin}. Lo stress test accetta soltanto Supabase locale via HTTP.`);
}

const integerEnv = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} deve essere un intero positivo.`);
  return value;
};

const capacity = integerEnv("LOADTEST_CAPACITY", 150);
const capAttempts = integerEnv("LOADTEST_CAP_ATTEMPTS", capacity + 50);
const readAttempts = integerEnv("LOADTEST_READ_ATTEMPTS", 200);
const stockAttempts = integerEnv("LOADTEST_STOCK_ATTEMPTS", 50);
const raceOrders = integerEnv("LOADTEST_CLOSE_RACE_ORDERS", 30);
const raceRounds = integerEnv("LOADTEST_CLOSE_RACE_ROUNDS", 10);
const selectedScenarios = new Set((process.env.LOADTEST_SCENARIOS
  ?? "read,idempotency,stock,capacity,identities,close-race")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean));
const knownScenarios = new Set(["read", "idempotency", "stock", "capacity", "identities", "close-race"]);

for (const scenario of selectedScenarios) {
  if (!knownScenarios.has(scenario)) throw new Error(`Scenario sconosciuto: ${scenario}`);
}

if (capAttempts <= capacity) throw new Error("LOADTEST_CAP_ATTEMPTS deve superare LOADTEST_CAPACITY.");
if (capacity < 10 || capacity > 1000) throw new Error("La capienza deve restare tra 10 e 1000.");

const clientOptions = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const publicClient = createClient(url, anonKey, clientOptions);
const serviceClient = createClient(url, serviceRoleKey, clientOptions);
const runId = crypto.randomUUID().slice(0, 8);
const fixtureIds = { unlimited: crypto.randomUUID(), limited: crypto.randomUUID() };
const findings = [];
const checks = [];
let adminUserId = null;
let savedEvent = null;
let eventId = null;

function messageOf(error) {
  return error?.message ?? String(error ?? "");
}

function errorDetails(error) {
  return {
    message: messageOf(error),
    code: error?.code ?? null,
    details: error?.details ?? null,
    hint: error?.hint ?? null,
  };
}

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
    p99_ms: Math.round(percentile(durations, 0.99)),
    max_ms: Math.round(Math.max(0, ...durations)),
  };
}

function pass(name, details = {}) {
  checks.push({ name, ...details, status: "PASS" });
  console.log(`PASS  ${name}`, details);
}

function finding(name, details = {}) {
  findings.push({ name, ...details, status: "FINDING" });
  console.error(`FIND ${name}`, details);
}

async function timedRpc(client, name, args = undefined) {
  const started = performance.now();
  const { data, error } = await client.rpc(name, args);
  return { data, error, ms: performance.now() - started };
}

async function requireQuery(promise, label) {
  const result = await promise;
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

async function clearOrders() {
  await requireQuery(serviceClient.from("orders").delete().eq("event_id", eventId), "pulizia ordini");
}

async function openEvent(limit = capacity) {
  const now = Date.now();
  await requireQuery(serviceClient.from("order_events").update({
    name: `[LOADTEST] ${runId}`,
    opens_at: new Date(now - 60_000).toISOString(),
    closes_at: new Date(now + 3_600_000).toISOString(),
    manual_closed: false,
    permanently_closed_at: null,
    final_report: null,
    max_pending_orders: limit,
  }).eq("id", eventId), "apertura evento locale");
}

async function setLimitedStock(value) {
  await requireQuery(serviceClient.from("menu_items").update({
    available_portions: value,
    stock_capacity: value,
  }).eq("id", fixtureIds.limited), "reset scorta fixture");
}

function publicOrder(itemId, { requestId = crypto.randomUUID(), qrToken = crypto.randomUUID(), alias = "Load test" } = {}) {
  return timedRpc(publicClient, "submit_public_order", {
    p_alias: alias,
    p_notes: "",
    p_items: [{ id: itemId, qty: 1 }],
    p_client_request_id: requestId,
    p_qr_token: qrToken,
    p_bot_field: "",
  });
}

async function setup() {
  const events = await requireQuery(
    serviceClient.from("order_events").select("*").eq("is_current", true),
    "lettura evento",
  );
  assert.equal(events.length, 1, "Serve esattamente un evento corrente nel database locale.");
  savedEvent = events[0];
  eventId = savedEvent.id;

  const { count, error: countError } = await serviceClient
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("event_id", eventId);
  if (countError) throw new Error(`conteggio ordini iniziali: ${countError.message}`);
  assert.equal(count, 0, "Il database locale deve partire senza ordini per l'evento corrente.");

  await requireQuery(serviceClient.from("menu_items").insert([
    {
      id: fixtureIds.unlimited,
      category: "cibo",
      name: `[LOADTEST] illimitato ${runId}`,
      price: 1,
      available_portions: null,
      stock_capacity: null,
      allergens: [],
    },
    {
      id: fixtureIds.limited,
      category: "cibo",
      name: `[LOADTEST] ultima porzione ${runId}`,
      price: 1,
      available_portions: 1,
      stock_capacity: 1,
      allergens: [],
    },
  ]), "creazione fixture menu");
  await openEvent();

  const email = `lag-loadtest-${runId}@example.invalid`;
  const password = `Local-${crypto.randomUUID()}!`;
  const { data: created, error: createError } = await serviceClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createError || !created.user) throw new Error(`creazione utente locale: ${messageOf(createError)}`);
  adminUserId = created.user.id;
  await requireQuery(serviceClient.from("profiles").update({ role: "admin" }).eq("id", adminUserId), "assegnazione ruolo admin locale");

  const adminClient = createClient(url, anonKey, clientOptions);
  const { error: signInError } = await adminClient.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`login admin locale: ${signInError.message}`);
  return adminClient;
}

async function readBurst() {
  const results = await Promise.all(Array.from({ length: readAttempts }, () => timedRpc(publicClient, "get_ordering_status")));
  const errors = results.filter((result) => result.error);
  if (errors.length === 0) pass(`${readAttempts} letture concorrenti dello stato`, timingSummary(results));
  else finding("Errori nel burst di lettura", {
    errors: errors.length,
    first: errorDetails(errors[0].error),
    ...timingSummary(results),
  });
}

async function idempotencyScenario(adminClient) {
  await clearOrders();
  await openEvent();
  await setLimitedStock(10);
  const requestId = crypto.randomUUID();
  const qrToken = crypto.randomUUID();
  const results = await Promise.all(Array.from({ length: 25 }, () => publicOrder(fixtureIds.limited, { requestId, qrToken })));
  const successes = results.filter((result) => !result.error);
  const ids = new Set(successes.map((result) => result.data?.order_id));
  const rows = await requireQuery(serviceClient.from("orders").select("id").eq("event_id", eventId), "ordini idempotenza");
  const stockRows = await requireQuery(serviceClient.from("menu_items").select("available_portions").eq("id", fixtureIds.limited), "scorta idempotenza");
  if (successes.length === 25 && ids.size === 1 && rows.length === 1 && stockRows[0]?.available_portions === 9) {
    pass("25 retry simultanei producono un solo ordine", timingSummary(results));
  } else {
    finding("Idempotenza concorrente violata", {
      successes: successes.length,
      distinct_order_ids: ids.size,
      database_rows: rows.length,
      remaining_stock: stockRows[0]?.available_portions,
    });
  }

  const conflict = await publicOrder(fixtureIds.limited, { requestId, qrToken: crypto.randomUUID() });
  if (messageOf(conflict.error).includes("request_id_conflict")) pass("Request ID riutilizzato con QR diverso viene respinto");
  else finding("Request ID/QR conflict non respinto", { error: messageOf(conflict.error) });

  const orderId = successes[0]?.data?.order_id;
  const claimToken = crypto.randomUUID();
  const pendingStatuses = await timedRpc(publicClient, "get_public_order_statuses", { p_qr_tokens: [qrToken] });
  const claim = await timedRpc(adminClient, "claim_order", { p_order_id: orderId, p_claim_token: claimToken });
  const payment = claim.error
    ? { error: claim.error }
    : await timedRpc(adminClient, "pay_claimed_order", { p_order_id: orderId, p_claim_token: claimToken });
  const paidStatus = payment.error
    ? { error: payment.error }
    : await timedRpc(publicClient, "get_public_order_statuses", { p_qr_tokens: [qrToken] });
  const delivery = payment.error
    ? { error: payment.error }
    : await timedRpc(adminClient, "deliver_order_by_qr", { p_qr_token: qrToken });
  const deliveredStatus = delivery.error
    ? { error: delivery.error }
    : await timedRpc(publicClient, "get_public_order_statuses", { p_qr_tokens: [qrToken] });
  const lateRetry = await publicOrder(fixtureIds.limited, { requestId, qrToken });
  const finalRows = await requireQuery(serviceClient.from("orders").select("id,status").eq("event_id", eventId), "retry tardivo");
  const finalStock = (await requireQuery(
    serviceClient.from("menu_items").select("available_portions").eq("id", fixtureIds.limited),
    "scorta retry tardivo",
  ))[0]?.available_portions;
  if (
    !claim.error
    && !payment.error
    && !delivery.error
    && pendingStatuses.data?.[0]?.status === "in_attesa_pagamento"
    && paidStatus.data?.[0]?.status === "pagato"
    && deliveredStatus.data?.[0]?.status === "consegnato"
    && messageOf(lateRetry.error).includes("request_already_processed")
    && finalRows.length === 1
    && finalRows[0]?.status === "consegnato"
    && finalStock === 9
  ) {
    pass("Un retry tardivo dopo pagamento e consegna non duplica l'ordine");
  } else {
    finding("Retry tardivo non idempotente", {
      claim_error: messageOf(claim.error),
      payment_error: messageOf(payment.error),
      delivery_error: messageOf(delivery.error),
      pending_public_status: pendingStatuses.data?.[0]?.status,
      paid_public_status: paidStatus.data?.[0]?.status,
      delivered_public_status: deliveredStatus.data?.[0]?.status,
      retry_error: messageOf(lateRetry.error),
      database_rows: finalRows,
      remaining_stock: finalStock,
    });
  }
}

async function lastPortionScenario() {
  await clearOrders();
  await openEvent();
  await setLimitedStock(1);
  const results = await Promise.all(Array.from({ length: stockAttempts }, () => publicOrder(fixtureIds.limited)));
  const successes = results.filter((result) => !result.error);
  const expectedFailures = results.filter((result) => messageOf(result.error).includes("stock_unavailable"));
  const stockRows = await requireQuery(serviceClient.from("menu_items").select("available_portions").eq("id", fixtureIds.limited), "scorta finale");
  if (successes.length === 1 && expectedFailures.length === stockAttempts - 1 && stockRows[0]?.available_portions === 0) {
    pass(`${stockAttempts} concorrenti sull'ultima porzione`, timingSummary(results));
  } else {
    finding("Protezione ultima porzione violata", {
      successes: successes.length,
      expected_failures: expectedFailures.length,
      remaining_stock: stockRows[0]?.available_portions,
    });
  }
}

async function capacityScenario() {
  await clearOrders();
  await openEvent(capacity);
  const results = await Promise.all(Array.from({ length: capAttempts }, () => publicOrder(fixtureIds.unlimited)));
  const successes = results.filter((result) => !result.error);
  const capacityErrors = results.filter((result) => messageOf(result.error).includes("capacity_reached"));
  const unexpectedErrors = results.filter((result) => result.error && !messageOf(result.error).includes("capacity_reached"));
  const rows = await requireQuery(
    serviceClient.from("orders").select("id,display_number,status").eq("event_id", eventId).eq("status", "in_attesa_pagamento"),
    "ordini al limite",
  );
  const uniqueIds = new Set(rows.map((row) => row.id));
  const uniqueNumbers = new Set(rows.map((row) => row.display_number));
  const status = await timedRpc(publicClient, "get_ordering_status");
  const catalog = await timedRpc(publicClient, "get_ordering_catalog");
  if (
    successes.length === capacity
    && rows.length === capacity
    && uniqueIds.size === capacity
    && uniqueNumbers.size === capacity
    && status.data?.accepting === false
    && status.data?.reason === "capacity_reached"
    && Array.isArray(catalog.data?.items)
    && catalog.data.items.length === 0
  ) {
    pass(`Il burst da ${capAttempts} invii non supera il limite ${capacity}`, {
      accepted: successes.length,
      rejected_for_capacity: capacityErrors.length,
      ...timingSummary(results),
    });
  } else {
    finding("Invariante del limite ordini violata", {
      accepted: successes.length,
      capacity_errors: capacityErrors.length,
      unexpected_errors: unexpectedErrors.length,
      pending_rows: rows.length,
      unique_ids: uniqueIds.size,
      unique_numbers: uniqueNumbers.size,
      ordering_status: status.data,
      catalog_items: catalog.data?.items?.length,
    });
  }

  if (unexpectedErrors.length > 0) {
    finding("Errori di trasporto durante il burst di ordini", {
      errors: unexpectedErrors.length,
      first: errorDetails(unexpectedErrors[0].error),
      ...timingSummary(results),
    });
  } else if (capacityErrors.length !== capAttempts - capacity) {
    finding("Numero inatteso di rifiuti per capienza", {
      expected: capAttempts - capacity,
      actual: capacityErrors.length,
    });
  }
}

async function malformedIdentityScenarios(adminClient) {
  await clearOrders();
  await openEvent();
  const protectedOrder = await publicOrder(fixtureIds.unlimited);
  if (protectedOrder.error) throw new Error(`setup token NULL: ${protectedOrder.error.message}`);
  const validToken = crypto.randomUUID();
  const validClaim = await timedRpc(adminClient, "claim_order", {
    p_order_id: protectedOrder.data.order_id,
    p_claim_token: validToken,
  });
  if (validClaim.error) throw new Error(`claim valido: ${validClaim.error.message}`);

  const nullTokenCalls = await Promise.all([
    timedRpc(adminClient, "claim_order", {
      p_order_id: protectedOrder.data.order_id,
      p_claim_token: null,
    }),
    timedRpc(adminClient, "claim_order_by_qr", {
      p_qr_token: protectedOrder.data.qr_token,
      p_claim_token: null,
    }),
    timedRpc(adminClient, "release_order_claim", {
      p_order_id: protectedOrder.data.order_id,
      p_claim_token: null,
    }),
    timedRpc(adminClient, "update_claimed_order", {
      p_order_id: protectedOrder.data.order_id,
      p_claim_token: null,
      p_alias: "Load test",
      p_notes: "",
      p_items: [{ id: fixtureIds.unlimited, qty: 1 }],
    }),
    timedRpc(adminClient, "cancel_claimed_order", {
      p_order_id: protectedOrder.data.order_id,
      p_claim_token: null,
    }),
    timedRpc(adminClient, "pay_claimed_order", {
      p_order_id: protectedOrder.data.order_id,
      p_claim_token: null,
    }),
  ]);
  const protectedRow = (await requireQuery(
    serviceClient.from("orders").select("status,claimed_token_hash,claim_expires_at").eq("id", protectedOrder.data.order_id),
    "stato dopo token NULL",
  ))[0];
  const nullErrors = nullTokenCalls.filter((result) => messageOf(result.error).includes("invalid_claim_token"));
  const validPay = await timedRpc(adminClient, "pay_claimed_order", {
    p_order_id: protectedOrder.data.order_id,
    p_claim_token: validToken,
  });
  if (
    nullErrors.length === nullTokenCalls.length
    && protectedRow?.status === "in_attesa_pagamento"
    && protectedRow?.claimed_token_hash
    && protectedRow?.claim_expires_at
    && !validPay.error
  ) {
    pass("Token claim NULL respinto da tutte le RPC senza alterare il claim valido");
  } else {
    finding("Protezione token claim NULL incompleta", {
      expected_errors: nullTokenCalls.length,
      actual_errors: nullErrors.length,
      errors: nullTokenCalls.map((result) => errorDetails(result.error)),
      status_before_valid_pay: protectedRow?.status,
      claim_preserved: Boolean(protectedRow?.claimed_token_hash),
      valid_pay_error: messageOf(validPay.error),
    });
  }

  const unclaimedOperations = [
    {
      rpc: "update_claimed_order",
      args: (orderId, token) => ({
        p_order_id: orderId,
        p_claim_token: token,
        p_alias: "Load test",
        p_notes: "",
        p_items: [{ id: fixtureIds.unlimited, qty: 1 }],
      }),
    },
    {
      rpc: "cancel_claimed_order",
      args: (orderId, token) => ({ p_order_id: orderId, p_claim_token: token }),
    },
    {
      rpc: "pay_claimed_order",
      args: (orderId, token) => ({ p_order_id: orderId, p_claim_token: token }),
    },
  ];
  const unclaimedResults = [];
  for (const operation of unclaimedOperations) {
    const order = await publicOrder(fixtureIds.unlimited);
    if (order.error) throw new Error(`setup ${operation.rpc} non claimato: ${order.error.message}`);
    const result = await timedRpc(adminClient, operation.rpc, operation.args(order.data.order_id, crypto.randomUUID()));
    const row = (await requireQuery(
      serviceClient.from("orders").select("status").eq("id", order.data.order_id),
      `stato dopo ${operation.rpc} non claimato`,
    ))[0];
    unclaimedResults.push({ rpc: operation.rpc, error: messageOf(result.error), status: row?.status });
  }
  if (unclaimedResults.every((result) => result.error.includes("claim_lost") && result.status === "in_attesa_pagamento")) {
    pass("Ordini mai claimati resistono a update, annullamento e pagamento con token casuali");
  } else {
    finding("Un ordine non claimato accetta una mutazione", { results: unclaimedResults });
  }

  await clearOrders();
  await openEvent();
  await setLimitedStock(2);
  const sharedQr = crypto.randomUUID();
  const duplicateQr = await Promise.all([
    publicOrder(fixtureIds.limited, { qrToken: sharedQr }),
    publicOrder(fixtureIds.limited, { qrToken: sharedQr }),
  ]);
  const duplicateQrSuccesses = duplicateQr.filter((result) => !result.error);
  const duplicateQrFailures = duplicateQr.filter((result) => result.error);
  const qrRows = await requireQuery(serviceClient.from("orders").select("id").eq("event_id", eventId), "ordini QR duplicato");
  const qrStock = (await requireQuery(
    serviceClient.from("menu_items").select("available_portions").eq("id", fixtureIds.limited),
    "scorta QR duplicato",
  ))[0]?.available_portions;
  if (
    duplicateQrSuccesses.length === 1
    && duplicateQrFailures.length === 1
    && duplicateQrFailures[0].error?.code === "23505"
    && qrRows.length === 1
    && qrRows[0]?.id === duplicateQrSuccesses[0].data?.order_id
    && qrStock === 1
  ) {
    pass("QR duplicato respinto senza consumare due volte la scorta");
  } else {
    finding("Lo stesso QR non è protetto da unicità", {
      accepted: duplicateQrSuccesses.length,
      errors: duplicateQrFailures.map((result) => errorDetails(result.error)),
      database_rows: qrRows.length,
      remaining_stock: qrStock,
    });
  }

  await clearOrders();
  await openEvent();
  await setLimitedStock(2);
  const nullRequest = await Promise.all([
    publicOrder(fixtureIds.limited, { requestId: null }),
    publicOrder(fixtureIds.limited, { requestId: null }),
  ]);
  const nullRequestSuccesses = nullRequest.filter((result) => !result.error);
  const nullRequestErrors = nullRequest.filter((result) => messageOf(result.error).includes("invalid_client_request_id"));
  const nullRows = await requireQuery(serviceClient.from("orders").select("id").eq("event_id", eventId), "ordini request ID NULL");
  const nullStock = (await requireQuery(
    serviceClient.from("menu_items").select("available_portions").eq("id", fixtureIds.limited),
    "scorta request ID NULL",
  ))[0]?.available_portions;
  if (nullRequestSuccesses.length === 0 && nullRequestErrors.length === 2 && nullRows.length === 0 && nullStock === 2) {
    pass("Client request ID NULL respinto senza creare ordini o consumare scorte");
  } else {
    finding("Client request ID NULL non è protetto", {
      accepted: nullRequestSuccesses.length,
      expected_errors: nullRequestErrors.length,
      database_rows: nullRows.length,
      remaining_stock: nullStock,
    });
  }
}

async function closeRaceScenario(adminClient) {
  let inconsistentRounds = 0;
  let deadlocks = 0;
  const samples = [];
  for (let round = 0; round < raceRounds; round += 1) {
    await clearOrders();
    await openEvent();
    await setLimitedStock(raceOrders);
    const submitted = await Promise.all(Array.from({ length: raceOrders }, () => publicOrder(fixtureIds.limited)));
    const orders = submitted.filter((result) => !result.error).map((result) => result.data);
    assert.equal(orders.length, raceOrders, `Setup race chiusura incompleto al round ${round + 1}.`);
    const claims = await Promise.all(orders.map(async (order) => {
      const token = crypto.randomUUID();
      const result = await timedRpc(adminClient, "claim_order", { p_order_id: order.order_id, p_claim_token: token });
      return { order, token, result };
    }));
    assert.equal(claims.filter(({ result }) => !result.error).length, raceOrders, "Non tutti gli ordini sono stati presi in carico.");

    const seedClaim = claims[0];
    const seedPayment = await timedRpc(adminClient, "pay_claimed_order", {
      p_order_id: seedClaim.order.order_id,
      p_claim_token: seedClaim.token,
    });
    if (seedPayment.error) throw new Error(`Pagamento seed race: ${seedPayment.error.message}`);
    const raceClaims = claims.slice(1);
    const startPayments = () => raceClaims.map(({ order, token }) => ({
      orderId: order.order_id,
      promise: timedRpc(adminClient, "pay_claimed_order", {
        p_order_id: order.order_id,
        p_claim_token: token,
      }),
    }));

    let closePromise;
    let pendingPayments;
    if (round % 2 === 0) {
      closePromise = timedRpc(adminClient, "close_order_event");
      await new Promise((resolve) => setTimeout(resolve, 5));
      pendingPayments = startPayments();
    } else {
      pendingPayments = startPayments();
      await new Promise((resolve) => setTimeout(resolve, 5));
      closePromise = timedRpc(adminClient, "close_order_event");
    }
    const [closeResult, payResults] = await Promise.all([
      closePromise,
      Promise.all(pendingPayments.map(async ({ orderId, promise }) => ({ orderId, result: await promise }))),
    ]);
    const rawPayResults = payResults.map(({ result }) => result);
    deadlocks += [closeResult, ...rawPayResults].filter((result) => /deadlock|40P01/i.test(messageOf(result.error))).length;

    const finalOrders = await requireQuery(
      serviceClient.from("orders").select("id,status").eq("event_id", eventId),
      "stati dopo race chiusura",
    );
    const finalById = new Map(finalOrders.map((order) => [order.id, order.status]));
    const delivered = finalOrders.filter((order) => order.status === "consegnato").length;
    const cancelled = finalOrders.filter((order) => order.status === "annullato").length;
    const successfulRacePayments = payResults.filter(({ result }) => !result.error);
    const paySuccesses = 1 + successfulRacePayments.length;
    const expectedPayErrors = payResults.filter(({ result }) => messageOf(result.error).includes("event_closed")).length;
    const unexpectedPayErrors = payResults.length - successfulRacePayments.length - expectedPayErrors;
    const resultMappingValid = finalById.get(seedClaim.order.order_id) === "consegnato"
      && payResults.every(({ orderId, result }) => finalById.get(orderId) === (!result.error ? "consegnato" : "annullato"));
    const stockRows = await requireQuery(serviceClient.from("menu_items").select("available_portions").eq("id", fixtureIds.limited), "scorta dopo race chiusura");
    const actualStock = stockRows[0]?.available_portions;
    const expectedStock = raceOrders - paySuccesses;
    const reportPaid = Number(closeResult.data?.summary?.orders_paid ?? 0);
    const reportAbandoned = Number(closeResult.data?.summary?.orders_abandoned ?? -1);
    const reportTotal = Number(closeResult.data?.summary?.orders_total ?? -1);
    const reportRevenue = Number(closeResult.data?.summary?.revenue_total ?? -1);
    const reportProductQuantity = Array.isArray(closeResult.data?.products)
      ? closeResult.data.products.reduce((sum, product) => sum + Number(product.quantity ?? 0), 0)
      : -1;
    const eventRows = await requireQuery(
      serviceClient.from("order_events").select("permanently_closed_at,final_report").eq("id", eventId),
      "evento dopo race chiusura",
    );
    const coherent = !closeResult.error
      && eventRows[0]?.permanently_closed_at
      && eventRows[0]?.final_report
      && delivered === paySuccesses
      && cancelled === raceOrders - paySuccesses
      && resultMappingValid
      && actualStock === expectedStock
      && reportTotal === raceOrders
      && reportPaid === paySuccesses
      && reportAbandoned === raceOrders - paySuccesses
      && reportRevenue === paySuccesses
      && reportProductQuantity === paySuccesses
      && unexpectedPayErrors === 0;
    if (!coherent) {
      inconsistentRounds += 1;
      if (samples.length < 3) {
        samples.push({
          round: round + 1,
          pay_successes: paySuccesses,
          expected_pay_errors: expectedPayErrors,
          unexpected_pay_errors: unexpectedPayErrors,
          delivered,
          cancelled,
          actual_stock: actualStock,
          expected_stock: expectedStock,
          report_paid: reportPaid,
          report_abandoned: reportAbandoned,
          report_total: reportTotal,
          report_revenue: reportRevenue,
          report_product_quantity: reportProductQuantity,
          close_error: messageOf(closeResult.error),
          event_closed: Boolean(eventRows[0]?.permanently_closed_at),
          result_mapping_valid: resultMappingValid,
        });
      }
    }
  }

  if (inconsistentRounds === 0 && deadlocks === 0) {
    pass(`${raceRounds} race chiusura/pagamento coerenti`, { orders_per_round: raceOrders });
  } else {
    finding("Race chiusura/pagamento altera scorte o report", {
      rounds: raceRounds,
      orders_per_round: raceOrders,
      inconsistent_rounds: inconsistentRounds,
      deadlocks,
      samples,
    });
  }
}

async function cleanup() {
  if (eventId) {
    await serviceClient.from("orders").delete().eq("event_id", eventId);
  }
  await serviceClient.from("menu_items").delete().in("id", Object.values(fixtureIds));
  if (savedEvent) {
    await serviceClient.from("order_events").update({
      name: savedEvent.name,
      opens_at: savedEvent.opens_at,
      closes_at: savedEvent.closes_at,
      manual_closed: savedEvent.manual_closed,
      permanently_closed_at: savedEvent.permanently_closed_at,
      max_pending_orders: savedEvent.max_pending_orders,
      final_report: savedEvent.final_report,
    }).eq("id", savedEvent.id);
  }
  if (adminUserId) await serviceClient.auth.admin.deleteUser(adminUserId);
}

console.log(`Stress test ordini LAG su ${target.origin} (run ${runId})`);
try {
  const adminClient = await setup();
  if (selectedScenarios.has("read")) await readBurst();
  if (selectedScenarios.has("idempotency")) await idempotencyScenario(adminClient);
  if (selectedScenarios.has("stock")) await lastPortionScenario();
  if (selectedScenarios.has("capacity")) await capacityScenario();
  if (selectedScenarios.has("identities")) await malformedIdentityScenarios(adminClient);
  if (selectedScenarios.has("close-race")) await closeRaceScenario(adminClient);
} finally {
  await cleanup();
}

console.log(JSON.stringify({ target: target.origin, checks, findings }, null, 2));
if (findings.length > 0) process.exitCode = 2;
