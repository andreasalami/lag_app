import { handlePublicRequest } from "../_shared/publicGateway.ts";
const handleOrderRequest = (request: Request) => handlePublicRequest(request, "order");
const handlePushRequest = (request: Request) => handlePublicRequest(request, "push");

function equal(actual: unknown, expected: unknown) { if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`); }
Deno.test("gateway rejects bypasses and verifies proof before any database write", async () => {
  const originalFetch = globalThis.fetch;
  const names = ["ORDER_ALLOWED_ORIGINS", "TURNSTILE_SECRET_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
  const previous = names.map(name => Deno.env.get(name));
  ["https://example.org", "test-secret", "https://database.example.org", "test-service-key"].forEach((value, i) => Deno.env.set(names[i], value));
  let writes = 0;
  let proof: Record<string, unknown> = { success: true, action: "order", hostname: "example.org" };
  globalThis.fetch = (input, init) => {
    const url = String(input);
    if (url === "https://challenges.cloudflare.com/turnstile/v0/siteverify") {
      equal(JSON.parse(String(init?.body)).secret, "test-secret");
      return Promise.resolve(Response.json(proof));
    }
    if (url === "https://database.example.org/rest/v1/rpc/submit_public_order") {
      writes++;
      const args = JSON.parse(String(init?.body));
      equal(args.arbitrary, undefined);
      return Promise.resolve(Response.json({ order_id: "fixture" }));
    }
    if (url === "https://database.example.org/rest/v1/rpc/upsert_push_subscription") {
      writes++;
      equal(JSON.parse(String(init?.body)).p_source, "tournament");
      return Promise.resolve(Response.json(null));
    }
    throw new Error("Unexpected network destination");
  };
  const request = (body: unknown, origin = "https://example.org") => new Request("https://edge.example.org", { method: "POST", headers: { origin }, body: JSON.stringify(body) });
  const body = { turnstileToken: "proof", order: { p_alias: "Test", arbitrary: "discard" } };
  try {
    equal((await handleOrderRequest(request(body, "https://attacker.example"))).status, 403);
    equal((await handleOrderRequest(request({}))).status, 400);
    equal((await handleOrderRequest(request({ turnstileToken: "x".repeat(2100) }))).status, 400);
    equal((await handleOrderRequest(request({ padding: "x".repeat(20001) }))).status, 413);
    for (const invalid of [{ success: false }, { success: true, action: "push", hostname: "example.org" }, { success: true, action: "order", hostname: "attacker.example" }]) {
      proof = invalid;
      equal((await handleOrderRequest(request(body))).status, 403);
    }
    equal(writes, 0);
    proof = { success: true, action: "order", hostname: "example.org" };
    equal((await handleOrderRequest(request(body))).status, 200);
    equal(writes, 1);
    equal((await handlePushRequest(request({ turnstileToken: "proof", subscription: {} }))).status, 403);
    proof = { success: true, action: "push", hostname: "example.org" };
    equal((await handlePushRequest(request({ turnstileToken: "proof", subscription: { p_source: "attacker" } }))).status, 200);
    equal(writes, 2);
    globalThis.fetch = () => Promise.reject(new Error("offline"));
    equal((await handleOrderRequest(request(body))).status, 503);
    equal(writes, 2);
    Deno.env.delete("TURNSTILE_SECRET_KEY");
    equal((await handleOrderRequest(request(body))).status, 503);
  } finally {
    globalThis.fetch = originalFetch;
    names.forEach((name, i) => previous[i] === undefined ? Deno.env.delete(name) : Deno.env.set(name, previous[i]!));
  }
});
