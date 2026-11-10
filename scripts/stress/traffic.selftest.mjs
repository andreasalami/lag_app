// Prova traffic.mjs contro un server finto locale: tetto di richieste, regole di stop e rifiuto
// della produzione. Non tocca né Supabase né la rete.
//   node scripts/stress/traffic.selftest.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = new URL("./traffic.mjs", import.meta.url).pathname;
const CATALOG = {
  accepting: true,
  event_id: "00000000-0000-4000-8000-000000000000",
  items: [
    { id: "00000000-0000-4000-8000-000000000001", category: "bevande", subcategory: "birre" },
    { id: "00000000-0000-4000-8000-000000000002", category: "cibo", subcategory: "primi" },
  ],
};

async function withServer(behaviour, run) {
  const seen = { requests: 0, perSecond: new Map(), origins: new Set() };
  const server = createServer((request, response) => {
    request.resume();
    seen.requests += 1;
    const second = Math.floor(Date.now() / 1000);
    seen.perSecond.set(second, (seen.perSecond.get(second) ?? 0) + 1);
    if (request.url.includes("submit-order")) seen.origins.add(request.headers.origin);
    const status = request.url.startsWith("/auth/") ? 200 : behaviour(seen.requests);
    response.writeHead(status, { "Content-Type": "application/json" });
    if (request.url.startsWith("/auth/")) response.end('{"access_token":"selftest"}');
    else if (request.url.includes("get_ordering_catalog")) response.end(JSON.stringify(CATALOG));
    else if (request.url.includes("get_cashier") || request.url.includes("fulfillment")) response.end("[]");
    else response.end('{"order_id":"x"}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`, seen);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

function traffic(args, env) {
  const dir = mkdtempSync(join(tmpdir(), "lag-traffic-selftest-"));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: {
        ...process.env,
        STRESS_SUPABASE_PUBLIC_KEY: "selftest",
        STRESS_SUPABASE_SECRET_KEY: "selftest",
        STRESS_DB_URL: "",
        STRESS_SKIP_EXTERNAL: "1",
        STRESS_RESULTS_DIR: dir,
        ...env,
      },
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => {
      const files = readdirSync(dir).filter((name) => name.includes(args[1] ?? "?"));
      const result = files[0] ? JSON.parse(readFileSync(join(dir, files[0]), "utf8")) : null;
      rmSync(dir, { recursive: true, force: true });
      resolve({ code, output, result });
    });
  });
}

// La produzione e gli indirizzi estranei vengono rifiutati prima di qualunque richiesta.
{
  const production = await traffic(["run", "baseline"], {
    STRESS_SUPABASE_URL: "https://avsqjsobnzhpikhsoorm.supabase.co",
    STRESS_DB_URL: "postgresql://postgres.avsqjsobnzhpikhsoorm:x@host:5432/postgres",
    STRESS_SKIP_EXTERNAL: "0",
  });
  assert.equal(production.code, 1);
  assert.match(production.output, /produzione/);
  const pooledProduction = await traffic(["check"], {
    STRESS_SUPABASE_URL: "https://altroprogetto.supabase.co",
    STRESS_DB_URL: "postgresql://postgres.avsqjsobnzhpikhsoorm:x@host:5432/postgres",
    STRESS_SKIP_EXTERNAL: "0",
  });
  assert.equal(pooledProduction.code, 1);
  assert.match(pooledProduction.output, /produzione/);
  const foreign = await traffic(["check"], { STRESS_SUPABASE_URL: "https://example.org", STRESS_SKIP_EXTERNAL: "0" });
  assert.equal(foreign.code, 1);
  console.log("PASS  produzione e indirizzi estranei rifiutati");
}

// Server sano: tutte le fasi finiscono, il pubblico sale coi gradini e il tetto regge.
await withServer(
  () => 200,
  async (url, seen) => {
    const { code, result, output } = await traffic(["run", "ramp"], {
      STRESS_SUPABASE_URL: url,
      STRESS_TIME_SCALE: "0.04",
    });
    assert.equal(code, 0, output);
    assert.equal(result.stop_reason, null);
    assert.equal(result.phases_completed, 6);
    const requests = result.phases.map((phase) => phase.public.requests);
    assert.ok(requests.at(-1) > requests[0] * 3, `il pubblico deve salire coi gradini: ${requests}`);
    assert.ok(result.phases.every((phase) => phase.public.errors === 0));
    assert.ok(Math.max(...seen.perSecond.values()) <= 260, `tetto superato: ${Math.max(...seen.perSecond.values())}`);
    assert.ok(seen.origins.has("https://lag-stress.test"), "il gateway deve ricevere l'origine ammessa");
    console.log(`PASS  rampa completa, picco ${Math.max(...seen.perSecond.values())} richieste al secondo`);
  },
);

// Primo 429: si ferma subito e non arriva agli ultimi gradini.
await withServer(
  (count) => (count > 200 ? 429 : 200),
  async (url) => {
    const { code, result, output } = await traffic(["run", "ramp"], {
      STRESS_SUPABASE_URL: url,
      STRESS_TIME_SCALE: "0.04",
    });
    assert.equal(code, 2, output);
    assert.match(result.stop_reason, /429/);
    assert.ok(result.phases_completed < 6);
    console.log(`PASS  429 ferma il test: "${result.stop_reason}"`);
  },
);

// Errori oltre l'1%: si ferma anche senza 429 o 503.
await withServer(
  (count) => (count > 300 && count % 10 === 0 ? 500 : 200),
  async (url) => {
    const { code, result, output } = await traffic(["run", "ramp"], {
      STRESS_SUPABASE_URL: url,
      STRESS_TIME_SCALE: "0.04",
    });
    assert.equal(code, 2, output);
    assert.match(result.stop_reason, /errori/);
    console.log(`PASS  errori ripetuti fermano il test: "${result.stop_reason}"`);
  },
);

// Budget di traffico finito: si ferma prima di consumare la quota.
await withServer(
  () => 200,
  async (url) => {
    const { code, result } = await traffic(["run", "ramp"], {
      STRESS_SUPABASE_URL: url,
      STRESS_TIME_SCALE: "0.04",
      STRESS_EGRESS_BUDGET_MB: "0.01",
    });
    assert.equal(code, 2);
    assert.match(result.stop_reason, /budget/);
    console.log("PASS  il budget di traffico ferma il test");
  },
);
