// Traffico reale verso un progetto Supabase di test: 30 dispositivi staff con gli stessi
// intervalli dell'app, più i dispositivi pubblici, a gradini fino al carico dell'evento.
// Non supera quel carico (tetto medio di 190 richieste al secondo) e si ferma al primo segnale di
// cedimento. Rifiuta il progetto di produzione. Comandi, con i valori in .env.stress.local:
//   npm run stress:traffic -- check | prepare-gateway | setup | run <scenario>
//
// Tutte le richieste partono da un solo computer: un eventuale blocco per IP è un limite del
// test, non dell'app. Il tempo vero di Turnstile resta fuori (vedi gateway/index.ts).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { createClient } from "@supabase/supabase-js";
import { invariantSql } from "./lib.mjs";

const PRODUCTION_REF = "avsqjsobnzhpikhsoorm";
const ORIGIN = "https://lag-stress.test";
const RESULTS_DIR = process.env.STRESS_RESULTS_DIR ?? "stress-results.local";
const EGRESS_FILE = join(RESULTS_DIR, "egress.json");
const STAFF_FILE = join(RESULTS_DIR, "staff.json");
const EGRESS_BUDGET_MB = Number(process.env.STRESS_EGRESS_BUDGET_MB ?? 4096);
const MAX_REQUESTS_PER_SECOND = 190;
const MAX_IN_FLIGHT = 1500;
const STOP_ERROR_RATE = 0.01;
const STOP_P95_MS = 10_000;
// Solo per traffic.selftest.mjs: accorcia i tempi e toglie Realtime e database.
const TIME_SCALE = Number(process.env.STRESS_TIME_SCALE ?? 1);
const SKIP_EXTERNAL = process.env.STRESS_SKIP_EXTERNAL === "1";

const EVENT_DEVICES = 2500;
const PEAK = { pollsPerDevice: 2, opensPerDeviceHour: 2, ordersPerMin: 17 };
const SCENARIOS = {
  baseline: [{ label: "solo staff", seconds: 300, devices: 0 }],
  evening: [
    {
      label: "serata reale",
      seconds: 600,
      devices: EVENT_DEVICES,
      pollsPerDevice: 1,
      opensPerDeviceHour: 2,
      ordersPerMin: 9,
    },
  ],
  ramp: [250, 500, 1000, 1500, 2000, EVENT_DEVICES].map((devices) => ({
    label: `${devices} dispositivi`,
    seconds: 150,
    devices,
    ...PEAK,
  })),
  worst: [
    { label: "punta", seconds: 300, devices: EVENT_DEVICES, ...PEAK },
    { label: "picco di 50 ordini al minuto", seconds: 300, devices: EVENT_DEVICES, ...PEAK, ordersPerMin: 50 },
  ],
  "open-burst": [
    { label: "500 aperture in 60 s", seconds: 120, devices: 0, spike: { count: 500, seconds: 60, action: "openApp" } },
  ],
  "tournament-publish": [
    {
      label: "risultato del torneo visto da tutti",
      seconds: 120,
      devices: EVENT_DEVICES,
      pollsPerDevice: 1,
      publish: true,
      spike: { count: EVENT_DEVICES, seconds: 30, action: "fullTournament" },
    },
  ],
  "realtime-reconnect": [
    { label: "staff si riconnette", seconds: 120, devices: 0, ordersPerMin: 17, reconnectAfterSeconds: 30 },
  ],
  "staff-edits": [
    { label: "modifiche staff sotto carico", seconds: 300, devices: EVENT_DEVICES, ...PEAK, edits: true },
  ],
};

const same = (count, device) => Array.from({ length: count }, () => ({ ...device }));
const STAFF_DEVICES = [
  ...["cucina", "primi", "secondi", "contorni", "dolci", "furgone"].map((station) => ({
    kind: "fulfillment",
    role: "cucina",
    station,
  })),
  ...same(4, { kind: "fulfillment", role: "bar", station: "birre" }),
  ...same(4, { kind: "fulfillment", role: "bar", station: "drinks" }),
  ...same(2, { kind: "fulfillment", role: "bar", station: "bar" }),
  ...[1, 2, 3, 4, 5].map((n) => ({ kind: "cash", role: "cassa", station: `cassa_${n}` })),
  ...same(4, { kind: "tournament", role: "tournament_manager" }),
  ...same(5, { kind: "spare", role: "admin" }),
];
const ROLES = [...new Set(STAFF_DEVICES.map((device) => device.role))];

const named = (subcategory, category, price, names) => names.map((name) => ({ name, category, subcategory, price }));
const MENU = [
  ...named("birre", "bevande", 5, ["Birra chiara", "Birra rossa", "Birra bianca", "Birra ambrata", "Birra analcolica"]),
  ...named("drinks", "bevande", 7, ["Spritz", "Gin tonic", "Vodka lemon", "Rum cola", "Hugo", "Americano", "Negroni"]),
  ...named("bevande", "bevande", 2, ["Acqua", "Cola", "Aranciata", "Tè freddo"]),
  ...named("vini", "bevande", 4, ["Vino bianco", "Vino rosso", "Prosecco"]),
  ...named("primi", "cibo", 8, ["Carbonara", "Amatriciana", "Cacio e pepe", "Lasagna"]),
  ...named("secondi", "cibo", 10, ["Grigliata", "Salsiccia", "Pollo", "Hamburger"]),
  ...named("contorni", "cibo", 4, ["Patatine", "Insalata", "Verdure"]),
  ...named("dolci", "cibo", 4, ["Tiramisù", "Crostata", "Gelato"]),
  ...named("furgone", "cibo", 6, ["Panino", "Piadina", "Hot dog"]),
];
const TEAMS = Array.from({ length: 32 }, (_, index) => `Squadra ${index + 1}`);
const MATCHES = Object.fromEntries(
  Array.from({ length: 31 }, (_, index) => [`m${index}`, { scoreA: index % 7, scoreB: index % 5, played: true }]),
);

const env = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} manca in .env.stress.local`);
  return value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms * TIME_SCALE));
const randomOf = (values) => values[Math.floor(Math.random() * values.length)];

function projectRef() {
  const { hostname } = new URL(env("STRESS_SUPABASE_URL"));
  if (hostname === "127.0.0.1" && SKIP_EXTERNAL) return "selftest";
  if (!hostname.endsWith(".supabase.co")) throw new Error("STRESS_SUPABASE_URL non è un progetto Supabase");
  return hostname.split(".")[0];
}

function assertTestProject() {
  const ref = projectRef();
  const database = SKIP_EXTERNAL ? "" : env("STRESS_DB_URL");
  if (ref === PRODUCTION_REF || database.includes(PRODUCTION_REF)) {
    throw new Error("Questi valori puntano al progetto di produzione: il test si rifiuta di partire.");
  }
  return ref;
}

// La stringa di connessione passa solo dall'ambiente del figlio: mai dagli argomenti né dai log.
function databaseEnv() {
  let url;
  try {
    url = new URL(env("STRESS_DB_URL"));
  } catch {
    throw new Error("STRESS_DB_URL non è valida: copiala di nuovo e controlla i simboli nella password.");
  }
  return {
    ...process.env,
    LC_ALL: "C",
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: url.pathname.slice(1) || "postgres",
    PGSSLMODE: "require",
    PGCONNECT_TIMEOUT: "15",
  };
}

function psql(query, file = null) {
  const bin = process.env.LOADTEST_PG_BIN ? join(process.env.LOADTEST_PG_BIN, "psql") : "psql";
  const args = ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", ...(file ? ["-f", file] : [])];
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: databaseEnv() });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(`psql: ${err.trim().slice(0, 500)}`)),
    );
    child.stdin.end(file ? "" : query);
  });
}

function check() {
  const ref = assertTestProject();
  const kind = (value) =>
    value.startsWith("sb_") ? value.split("_").slice(0, 2).join("_") : "JWT (anon/service_role)";
  console.log(`Progetto di test: ${ref} (non è la produzione)`);
  console.log(`Chiave pubblica: ${kind(env("STRESS_SUPABASE_PUBLIC_KEY"))}`);
  console.log(`Chiave privata: ${kind(env("STRESS_SUPABASE_SECRET_KEY"))}`);
  return psql("select count(*) from information_schema.tables where table_schema = 'public'").then((tables) =>
    console.log(`Database raggiungibile, tabelle in public: ${tables}`),
  );
}

function prepareGateway() {
  const ref = assertTestProject();
  const root = join(RESULTS_DIR, "gateway");
  const functions = join(root, "supabase", "functions");
  mkdirSync(join(functions, "submit-order"), { recursive: true });
  mkdirSync(join(functions, "_shared"), { recursive: true });
  cpSync("supabase/functions/_shared/publicGateway.ts", join(functions, "_shared", "publicGateway.ts"));
  for (const file of ["deno.json", "deno.lock"]) {
    cpSync(join("supabase/functions/submit-order", file), join(functions, "submit-order", file));
  }
  cpSync("scripts/stress/gateway/index.ts", join(functions, "submit-order", "index.ts"));
  writeFileSync(
    join(root, "supabase", "config.toml"),
    'project_id = "lag-stress"\n\n[functions.submit-order]\nverify_jwt = false\n',
  );
  console.log(`npx supabase login
npx supabase functions deploy submit-order --project-ref ${ref} --workdir ${root} --no-verify-jwt --use-api
npx supabase secrets set ORDER_ALLOWED_ORIGINS=${ORIGIN} TURNSTILE_SECRET_KEY=not-used --project-ref ${ref}`);
}

async function setup() {
  assertTestProject();
  mkdirSync(RESULTS_DIR, { recursive: true });
  await psql(null, "supabase/schema.sql");
  if (!existsSync(STAFF_FILE)) {
    const admin = createClient(env("STRESS_SUPABASE_URL"), env("STRESS_SUPABASE_SECRET_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const accounts = {};
    for (const role of ROLES) {
      const email = `stress-${role.replaceAll("_", "-")}@example.test`;
      const password = crypto.randomUUID();
      const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (error) throw new Error(`Account ${role}: ${error.message}`);
      accounts[role] = { email, password, id: data.user.id };
    }
    writeFileSync(STAFF_FILE, JSON.stringify(accounts), { mode: 0o600 });
  }
  const accounts = JSON.parse(readFileSync(STAFF_FILE, "utf8"));
  const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const profiles = Object.entries(accounts).map(([role, { id }]) => `(${literal(id)}, ${literal(role)})`);
  const items = MENU.map(
    (item) =>
      `(${literal(item.category)}, ${literal(item.subcategory)}, ${literal(`[STRESS] ${item.name}`)}, ${item.price}, 100000, 100000)`,
  );
  await psql(`insert into public.profiles (id, role) values ${profiles.join(", ")}
  on conflict (id) do update set role = excluded.role;
delete from public.menu_items where name like '[STRESS]%';
insert into public.menu_items (category, subcategory, name, price, available_portions, stock_capacity)
  values ${items.join(", ")};`);
  console.log(`Schema, ${ROLES.length} account di prova e ${MENU.length} voci di menu pronti.`);
}

async function runScenario(name) {
  const phases = SCENARIOS[name];
  if (!phases) throw new Error(`Scenario sconosciuto. Disponibili: ${Object.keys(SCENARIOS).join(", ")}`);
  assertTestProject();
  mkdirSync(RESULTS_DIR, { recursive: true });
  const BASE = env("STRESS_SUPABASE_URL").replace(/\/$/, "");
  const PUBLIC_KEY = env("STRESS_SUPABASE_PUBLIC_KEY");

  let running = true;
  let stopReason = null;
  let currentPhase = null;
  let inFlight = 0;
  let sentThisSecond = 0;
  let capped = 0;
  let saturated = 0;
  let egressBytes = 0;
  const previousEgressMb = existsSync(EGRESS_FILE) ? JSON.parse(readFileSync(EGRESS_FILE, "utf8")).mb : 0;
  const totals = { submitted: 0, paid: 0, delivered: 0, pendingPeak: 0, conflicts: 0, saves: 0 };
  const realtime = { messages: 0, subscribed: 0, errors: 0, subscribeMs: [], delayMs: [] };
  const recent = [];
  const tick = { done: 0, bad: 0, seconds: 0 };
  const timeline = [];
  const phaseStats = [];
  const timers = new Set();
  const qrTokens = [];

  const stop = (reason) => {
    if (running) console.error(`STOP: ${reason}`);
    stopReason ??= reason;
    running = false;
  };
  const every = (seconds, action) => {
    const period = seconds * 1000 * TIME_SCALE;
    const first = setTimeout(
      () => {
        if (!running) return;
        void action();
        const timer = setInterval(() => running && void action(), period);
        timers.add(timer);
      },
      Math.random() * period, // Dispositivi diversi non partono tutti nello stesso istante.
    );
    timers.add(first);
  };
  const clearTimers = () => {
    for (const timer of timers) clearInterval(timer);
    timers.clear();
  };

  function record(group, endpoint, ms, status, bytes, outcome) {
    const stats = currentPhase?.stats;
    if (stats) {
      const entry = (stats[`${group} ${endpoint}`] ??= {
        group,
        endpoint,
        ok: 0,
        expected: 0,
        errors: 0,
        statuses: {},
        ms: [],
        bytes: 0,
      });
      entry[outcome] += 1;
      entry.statuses[status] = (entry.statuses[status] ?? 0) + 1;
      entry.ms.push(ms);
      entry.bytes += bytes;
    }
    egressBytes += bytes + 400; // Intestazioni di risposta, stimate.
    recent.push({ at: performance.now(), ms, bad: outcome === "errors" });
    tick.done += 1;
    if (outcome === "errors") tick.bad += 1;
    if (status === 429 || status === 503) stop(`risposta ${status} da ${endpoint}`);
  }

  async function request(group, endpoint, url, init, expected = []) {
    inFlight += 1;
    sentThisSecond += 1;
    const started = performance.now();
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
      const text = await response.text();
      const isExpected = !response.ok && expected.some((code) => text.includes(code));
      const outcome = response.ok ? "ok" : isExpected ? "expected" : "errors";
      record(group, endpoint, performance.now() - started, response.status, text.length, outcome);
      return { ok: response.ok, json: () => (text ? JSON.parse(text) : null) };
    } catch (error) {
      // Timeout, connessione chiusa o DNS: distingue la rete da un rifiuto del server.
      const cause = error?.name === "TimeoutError" ? "timeout" : (error?.cause?.code ?? error?.name ?? "network");
      if (running) record(group, endpoint, performance.now() - started, `rete:${cause}`, 0, "errors");
      return { ok: false, json: () => null };
    } finally {
      inFlight -= 1;
    }
  }

  const headers = (token, extra = {}) => ({
    apikey: PUBLIC_KEY,
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  });
  const rpc = (group, fn, args, token, expected) =>
    request(
      group,
      fn,
      `${BASE}/rest/v1/rpc/${fn}`,
      { method: "POST", headers: headers(token), body: JSON.stringify(args) },
      expected,
    );
  const select = (group, endpoint, path, token) =>
    request(group, endpoint, `${BASE}/rest/v1/${path}`, { headers: headers(token) });

  // ---------- Pubblico ----------
  const fullTournament = () =>
    select(
      "public",
      "tournament_state (completo)",
      "tournament_state?select=size,teams,matches,overrides,revision&id=eq.main",
    );

  async function openApp() {
    await Promise.all([
      rpc("public", "get_ordering_status", {}),
      select("public", "menu_items", "menu_items?select=*&order=category,subcategory,name"),
      select("public", "program_slots", "program_slots?select=*"),
      select("public", "program_settings", "program_settings?select=days&id=eq.main"),
      fullTournament(),
    ]);
  }
  const ACTIONS = { openApp, fullTournament };

  function publicPoll() {
    if (Math.random() < 0.5 && qrTokens.length > 0) {
      const tokens = Array.from({ length: 1 + Math.floor(Math.random() * 3) }, () => randomOf(qrTokens));
      return rpc("public", "get_public_order_statuses", { p_qr_tokens: tokens });
    }
    return select("public", "tournament_state (revisione)", "tournament_state?select=revision&id=eq.main");
  }

  let catalog = [];
  let eventId = null;

  function pickLines() {
    const drinks = catalog.filter((item) => item.category === "bevande");
    const food = catalog.filter((item) => item.category === "cibo");
    const beer = drinks.filter((item) => item.subcategory === "birre");
    const pool = () => (Math.random() < 0.56 ? beer : drinks);
    const picks = Math.random() < 0.15 ? [randomOf(food), randomOf(drinks)] : [randomOf(pool()), randomOf(pool())];
    const lines = new Map();
    for (const item of picks) lines.set(item.id, (lines.get(item.id) ?? 0) + 1);
    return [...lines].map(([id, qty]) => ({ id, qty }));
  }

  async function submitOrder() {
    const fresh = await rpc("public", "get_ordering_catalog", {});
    if (fresh.ok) {
      const data = fresh.json();
      if (data?.items?.length) catalog = data.items;
      eventId = data?.event_id ?? eventId;
    }
    if (catalog.length === 0) return;
    const qrToken = crypto.randomUUID();
    const response = await request(
      "order",
      "submit-order",
      `${BASE}/functions/v1/submit-order`,
      {
        method: "POST",
        headers: headers(PUBLIC_KEY, { Origin: ORIGIN }),
        body: JSON.stringify({
          turnstileToken: "stress",
          order: {
            p_alias: `Stress ${Math.floor(Math.random() * 1000)}`,
            p_notes: "",
            p_items: pickLines(),
            p_client_request_id: crypto.randomUUID(),
            p_qr_token: qrToken,
            p_bot_field: "",
            p_expected_event_id: eventId,
            p_preparation_mode: "immediate",
          },
        }),
      },
      ["capacity_reached", "stock_unavailable"],
    );
    if (response.ok) {
      totals.submitted += 1;
      qrTokens.push(qrToken);
      if (qrTokens.length > 500) qrTokens.shift();
    }
  }

  /** Open loop come il traffico vero: una coda lenta non frena i nuovi arrivi. */
  function openLoop(ratePerSecond, action) {
    let carry = 0;
    const timer = setInterval(() => {
      if (!running) return;
      carry += ratePerSecond * 0.1;
      while (carry >= 1) {
        carry -= 1;
        if (sentThisSecond >= MAX_REQUESTS_PER_SECOND) capped += 1;
        else if (inFlight >= MAX_IN_FLIGHT) saturated += 1;
        else void action();
      }
    }, 100);
    timers.add(timer);
    return () => {
      clearInterval(timer);
      timers.delete(timer);
    };
  }

  // ---------- Staff: stessi intervalli e stesse chiamate dell'app ----------
  function subscribe(device, channelName, tables, onEvent) {
    if (SKIP_EXTERNAL) return;
    device.client ??= createClient(BASE, PUBLIC_KEY, {
      accessToken: async () => device.token,
      auth: { persistSession: false, autoRefreshToken: false },
    });
    (device.subscriptions ??= []).push({ channelName, tables, onEvent });
    openChannel(device, channelName, tables, onEvent);
  }

  function openChannel(device, channelName, tables, onEvent) {
    let channel = device.client.channel(channelName);
    for (const table of tables) {
      channel = channel.on("postgres_changes", { event: "*", schema: "public", table }, (payload) => {
        realtime.messages += 1;
        egressBytes += JSON.stringify(payload).length + 100;
        const at = Date.parse(payload.commit_timestamp);
        if (Number.isFinite(at)) realtime.delayMs.push(Date.now() - at);
        if (running) void onEvent();
      });
    }
    const started = performance.now();
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        realtime.subscribed += 1;
        realtime.subscribeMs.push(performance.now() - started);
      } else if (running && (status === "CHANNEL_ERROR" || status === "TIMED_OUT")) {
        realtime.errors += 1;
        recent.push({ at: performance.now(), ms: 0, bad: true });
      }
    });
  }

  function startFulfillment(device, peers, index) {
    let queue = [];
    const refetch = async () => {
      const response = await rpc("staff", "get_fulfillment_queue", { p_station: device.station }, device.token);
      if (response.ok) queue = response.json() ?? [];
      if (device.station !== "cucina") {
        await rpc("staff", "get_recent_fulfillment_deliveries", { p_station: device.station }, device.token);
      }
    };
    every(15, refetch);
    subscribe(device, `fulfillment-${device.station}-${index}`, ["orders", "order_fulfillment_items"], refetch);
    if (device.station === "cucina") return; // In cucina si guarda la coda: si ritira alle postazioni.
    every(8, async () => {
      // Più dispositivi sulla stessa postazione servono clienti diversi, come al banco.
      const order = queue.find((candidate) => candidate.display_number % peers === index);
      const items = (order?.items ?? [])
        .filter((item) => item.station === device.station && item.delivered_quantity < item.quantity)
        .map((item) => ({ id: item.id, qty: item.quantity - item.delivered_quantity }));
      if (items.length === 0) return;
      queue = queue.filter((candidate) => candidate !== order);
      const response = await rpc(
        "staff",
        "deliver_fulfillment_items",
        { p_order_id: order.id, p_station: device.station, p_items: items },
        device.token,
        ["order_not_available", "invalid_delivery", "kitchen_not_active"],
      );
      if (response.ok) totals.delivered += 1;
      await refetch();
    });
  }

  const taken = new Set();
  function startCash(device) {
    const deviceId = `${crypto.randomUUID()}-${device.station}`;
    let queue = [];
    let busy = false;
    const refetch = async () => {
      const response = await rpc("staff", "get_cashier_pending_orders", {}, device.token);
      if (response.ok) {
        queue = response.json() ?? [];
        totals.pendingPeak = Math.max(totals.pendingPeak, queue.length);
      }
    };
    every(30, refetch);
    every(10, () => rpc("staff", "get_cashier_claims", {}, device.token));
    subscribe(device, `orders-register-${device.station}`, ["orders"], refetch);
    every(2, async () => {
      if (busy) return;
      const target = queue.find((order) => !taken.has(order.id)); // Ogni cassa serve il cliente che ha davanti.
      if (!target) return;
      busy = true;
      taken.add(target.id);
      const args = { p_order_id: target.id, p_station: device.station, p_device_id: deviceId };
      const claimed = await rpc("staff", "claim_order_for_station", args, device.token, ["order_not_available"]);
      if (claimed.ok) {
        const renew = setInterval(
          () => running && rpc("staff", "claim_order_for_station", args, device.token),
          10_000 * TIME_SCALE,
        );
        await sleep((currentPhase?.phase.cashSeconds ?? 20) * 1000 * (0.7 + Math.random() * 0.6));
        clearInterval(renew);
        if (!running) return;
        const paid = await rpc("staff", "pay_order_for_station", args, device.token);
        if (paid.ok) totals.paid += 1;
      }
      busy = false;
    });
  }

  // ---------- Modifiche dello staff ----------
  async function loadTournament(token) {
    const response = await select(
      "staff",
      "tournament_snapshots",
      "tournament_snapshots?select=id,updated_at&limit=1",
      token,
    );
    return response.ok ? response.json()?.[0] : null;
  }

  async function saveTournament(token, row, publish) {
    totals.saves += 1;
    return rpc(
      "staff",
      "save_tournament",
      {
        p_id: row?.id ?? null,
        p_name: "Stress",
        p_expected_updated_at: row?.updated_at ?? null,
        p_size: TEAMS.length,
        p_teams: TEAMS,
        p_matches: MATCHES,
        p_overrides: {},
        p_publish: publish,
      },
      token,
      ["save_conflict"],
    );
  }

  function startEditors(devices) {
    const managers = devices.filter((device) => device.kind === "tournament");
    for (const manager of managers) {
      every(30, async () => {
        const row = (manager.row ??= await loadTournament(manager.token));
        const saved = await saveTournament(manager.token, row, false);
        if (saved.ok) manager.row = saved.json();
        else {
          totals.conflicts += 1;
          manager.row = null; // Come chiede l'app: ricarica, poi riprova.
        }
      });
    }
    const editor = devices.find((device) => device.kind === "spare");
    every(60, async () => {
      const rows = await select("staff", "menu_items", "menu_items?select=*&name=like.*STRESS*&limit=1", editor.token);
      const item = rows.ok ? rows.json()?.[0] : null;
      if (!item) return;
      await rpc(
        "staff",
        "bulk_upsert_menu_items",
        {
          p_created: [],
          p_updated: [
            {
              ...item,
              price: Number(item.price) === 5 ? 5.5 : 5,
              original_available_portions: item.available_portions,
            },
          ],
          p_deleted: [],
        },
        editor.token,
        ["stock_changed_retry"],
      );
    });
    every(120, () =>
      rpc("staff", "save_program", { p_days: 2, p_created: [], p_updated: [], p_deleted: [] }, editor.token),
    );
  }

  // ---------- Esecuzione ----------
  const accounts = SKIP_EXTERNAL
    ? Object.fromEntries(ROLES.map((role) => [role, { email: `${role}@example.test`, password: "selftest" }]))
    : JSON.parse(readFileSync(STAFF_FILE, "utf8"));
  const tokens = {};
  for (const role of ROLES) {
    const login = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: PUBLIC_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email: accounts[role].email, password: accounts[role].password }),
    });
    if (!login.ok) throw new Error(`Accesso ${role} non riuscito: HTTP ${login.status}`);
    tokens[role] = (await login.json()).access_token;
    await sleep(1000);
  }

  if (!SKIP_EXTERNAL) {
    await psql(`truncate public.orders cascade;
update public.order_events set opens_at = now() - interval '1 minute', closes_at = now() + interval '6 hours',
  manual_closed = false, permanently_closed_at = null, final_report = null, max_pending_orders = 1000 where is_current;
update public.menu_items set available_portions = 100000, stock_capacity = 100000;`);
  }

  const devices = STAFF_DEVICES.map((device) => ({ ...device, token: tokens[device.role] }));
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  const startedAt = new Date().toISOString();

  const watchdog = setInterval(() => {
    sentThisSecond = 0;
    // Andamento ogni 5 s: mostra se un blocco nasce da lentezza crescente o da uno stop netto.
    if (++tick.seconds % 5 === 0) {
      timeline.push({ s: tick.seconds, phase: currentPhase?.phase.label ?? null, in_flight: inFlight, ...tick });
      tick.done = 0;
      tick.bad = 0;
    }
    const horizon = performance.now() - 30_000 * Math.max(TIME_SCALE, 0.1);
    while (recent.length > 0 && recent[0].at < horizon) recent.shift();
    const bad = recent.filter((entry) => entry.bad).length;
    if (recent.length >= 50 && bad / recent.length > STOP_ERROR_RATE) {
      stop(`errori al ${((bad / recent.length) * 100).toFixed(1)}% negli ultimi 30 s`);
    }
    const sorted = recent.map((entry) => entry.ms).sort((a, b) => a - b);
    if (sorted.length >= 50 && sorted[Math.floor(sorted.length * 0.95)] > STOP_P95_MS) {
      stop("tempi di risposta oltre 10 s al 95° percentile");
    }
    if (previousEgressMb + egressBytes / 1e6 >= EGRESS_BUDGET_MB) stop("budget di traffico in uscita raggiunto");
    if (loopDelay.percentile(99) / 1e6 > 1000 && TIME_SCALE === 1) stop("generatore saturo: misura non valida");
  }, 1000);

  const fulfillment = devices.filter((device) => device.kind === "fulfillment");
  const seen = {};
  for (const device of devices) {
    if (!running) break;
    if (device.kind === "fulfillment") {
      const peers = fulfillment.filter((other) => other.station === device.station).length;
      seen[device.station] = (seen[device.station] ?? -1) + 1;
      startFulfillment(device, peers, seen[device.station]);
    } else if (device.kind === "cash") startCash(device);
    else if (device.kind === "spare") {
      every(30, () => rpc("staff", "get_order_event_admin_state", {}, device.token));
    }
    await sleep(300); // Lo staff non accede tutto nello stesso istante.
  }

  const completed = [];
  for (const phase of phases) {
    if (!running) break;
    currentPhase = { phase, stats: {} };
    phaseStats.push(currentPhase);
    console.log(`Fase: ${phase.label}`);
    const stops = [
      openLoop((phase.devices * (phase.pollsPerDevice ?? 1)) / 30, publicPoll),
      openLoop((phase.devices * (phase.opensPerDeviceHour ?? 0)) / 3600, openApp),
      openLoop((phase.ordersPerMin ?? 0) / 60, submitOrder),
    ];
    if (phase.spike) {
      stops.push(openLoop(phase.spike.count / phase.spike.seconds, ACTIONS[phase.spike.action]));
      setTimeout(() => stops.pop()?.(), phase.spike.seconds * 1000 * TIME_SCALE);
    }
    if (phase.publish) {
      const manager = devices.find((device) => device.kind === "tournament");
      await saveTournament(manager.token, await loadTournament(manager.token), true);
    }
    if (phase.edits) startEditors(devices);
    if (phase.reconnectAfterSeconds && !SKIP_EXTERNAL) {
      setTimeout(
        () => {
          for (const device of devices) {
            if (!device.client) continue;
            void device.client.removeAllChannels().then(() => {
              for (const sub of device.subscriptions) {
                openChannel(device, sub.channelName, sub.tables, sub.onEvent);
              }
            });
          }
        },
        phase.reconnectAfterSeconds * 1000 * TIME_SCALE,
      );
    }
    const phaseEnd = performance.now() + phase.seconds * 1000 * TIME_SCALE;
    while (running && performance.now() < phaseEnd) await new Promise((resolve) => setTimeout(resolve, 200));
    for (const stopLoop of stops) stopLoop();
    if (running) completed.push(phase.label);
  }

  // Si fermano i generatori e si lasciano finire le richieste in corso, senza crearne di nuove.
  running = false;
  clearTimers();
  clearInterval(watchdog);
  loopDelay.disable();
  const drainEnd = performance.now() + 30_000;
  while (inFlight > 0 && performance.now() < drainEnd) await new Promise((resolve) => setTimeout(resolve, 100));
  await Promise.all(devices.filter((device) => device.client).map((device) => device.client.removeAllChannels()));

  const quantile = (values, fraction) => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]);
  };
  const summarize = (entries) => {
    const ms = entries.flatMap((entry) => entry.ms);
    const sum = (key) => entries.reduce((total, entry) => total + entry[key], 0);
    const requests = sum("ok") + sum("expected") + sum("errors");
    return {
      requests,
      ok: sum("ok"),
      expected_business_errors: sum("expected"),
      errors: sum("errors"),
      error_rate: requests === 0 ? 0 : sum("errors") / requests,
      p50_ms: quantile(ms, 0.5),
      p95_ms: quantile(ms, 0.95),
      p99_ms: quantile(ms, 0.99),
      bytes: sum("bytes"),
    };
  };
  const report = phaseStats.map(({ phase, stats }) => {
    const entries = Object.values(stats);
    const of = (group) => entries.filter((entry) => entry.group === group);
    return {
      label: phase.label,
      devices: phase.devices,
      orders_per_minute: phase.ordersPerMin ?? 0,
      completed: completed.includes(phase.label),
      public: summarize(of("public")),
      staff: summarize(of("staff")),
      order: summarize(of("order")),
      endpoints: entries.map((entry) => ({
        group: entry.group,
        endpoint: entry.endpoint,
        statuses: entry.statuses,
        ...summarize([entry]),
      })),
    };
  });

  let inconsistencies = null;
  if (!SKIP_EXTERNAL) {
    const rules = await psql(invariantSql);
    const counts = JSON.parse(
      await psql(
        `select json_build_object('orders', count(*), 'paid', count(*) filter (where paid_at is not null)) from public.orders`,
      ),
    );
    inconsistencies = JSON.parse(rules || "[]");
    if (Number(counts.orders) < totals.submitted) {
      inconsistencies.push({ rule: "ordini_confermati_mancanti", detail: `${counts.orders} su ${totals.submitted}` });
    }
    if (Number(counts.paid) < totals.paid) {
      inconsistencies.push({ rule: "pagamenti_confermati_mancanti", detail: `${counts.paid} su ${totals.paid}` });
    }
  }

  const totalEgressMb = previousEgressMb + egressBytes / 1e6;
  writeFileSync(EGRESS_FILE, JSON.stringify({ mb: totalEgressMb }));
  const result = {
    scenario: name,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    stop_reason: stopReason,
    phases_completed: completed.length,
    phases_total: phases.length,
    phases: report,
    totals,
    realtime: {
      messages: realtime.messages,
      subscribed: realtime.subscribed,
      errors: realtime.errors,
      subscribe_p95_ms: quantile(realtime.subscribeMs, 0.95),
      delay_p95_ms: quantile(realtime.delayMs, 0.95),
    },
    generator: {
      event_loop_p99_ms: Math.round(loopDelay.percentile(99) / 1e6),
      capped_by_rate_limit: capped,
      dropped_by_in_flight_limit: saturated,
    },
    egress_mb_this_run: Math.round(egressBytes / 1e6),
    egress_mb_total: Math.round(totalEgressMb),
    inconsistencies,
    timeline: timeline.map(({ seconds, ...point }) => point),
  };
  const file = join(RESULTS_DIR, `${name}-${startedAt.replaceAll(":", "-")}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2));

  for (const row of report) {
    const line = (group) =>
      `${group.requests} rich., err ${(group.error_rate * 100).toFixed(2)}%, p95 ${group.p95_ms} ms`;
    console.log(
      `${row.completed ? "OK  " : "STOP"} ${row.label}\n  pubblico: ${line(row.public)}\n  staff:    ${line(row.staff)}\n  ordini:   ${line(row.order)}`,
    );
  }
  console.log(JSON.stringify({ ...result, phases: undefined, file }, null, 2));
  assert.ok(existsSync(file));
  if (stopReason || (inconsistencies?.length ?? 0) > 0) process.exitCode = 2;
}

const [command, argument] = process.argv.slice(2);
const commands = { check, "prepare-gateway": prepareGateway, setup, run: () => runScenario(argument) };
if (!commands[command]) {
  console.error(`Comandi: ${Object.keys(commands).join(", ")}. Scenari: ${Object.keys(SCENARIOS).join(", ")}`);
  process.exit(1);
}
try {
  await commands[command]();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
// Realtime lascia aperti timer interni: a lavoro finito si esce comunque.
setTimeout(() => process.exit(), 1000).unref?.();
