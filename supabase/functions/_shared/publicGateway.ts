import { createClient } from "@supabase/supabase-js";

// CORS is a browser restriction; only Siteverify authorizes anonymous creation.
export async function handlePublicRequest(request: Request, action: "order" | "push") {
  const origins = (Deno.env.get("ORDER_ALLOWED_ORIGINS") ?? "").split(",").map(value => value.trim()).filter(Boolean);
  const origin = request.headers.get("origin") ?? "";
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store", "Vary": "Origin", "Access-Control-Allow-Origin": origins.includes(origin) ? origin : "null", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
  const reply = (status: number, error: string) => new Response(JSON.stringify({ error }), { status, headers });
  if (!origins.includes(origin)) return reply(403, "origin_not_allowed");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "POST") return reply(405, "method_not_allowed");
  const secret = Deno.env.get("TURNSTILE_SECRET_KEY");
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!secret || !url || !serviceKey) return reply(503, "ordering_gateway_unconfigured");
  try {
    // Bound actual streamed bytes, including requests with no Content-Length.
    const reader = request.body?.getReader();
    if (!reader) return reply(400, "invalid_body");
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 20000) { await reader.cancel(); return reply(413, "invalid_body_size"); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let body;
    try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { return reply(400, "invalid_body"); }
    if (!body || typeof body !== "object" || typeof body.turnstileToken !== "string" || !body.turnstileToken || body.turnstileToken.length > 2048) return reply(400, "challenge_required");
    const verification = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret, response: body.turnstileToken }),
      signal: AbortSignal.timeout(10000), redirect: "error",
    });
    if (!verification.ok) return reply(503, "challenge_unavailable");
    const proof = await verification.json();
    if (proof.success !== true || proof.action !== action || proof.hostname !== new URL(origin).hostname) return reply(403, "challenge_failed");
    const args = action === "order" ? body.order : body.subscription;
    if (!args || typeof args !== "object") return reply(400, "invalid_order");
    const client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    // Explicit fields prevent calling arbitrary functions or forwarding extra arguments.
    const { data, error } = action === "order" ? await client.rpc("submit_public_order", {
      p_alias: args.p_alias, p_notes: args.p_notes, p_items: args.p_items,
      p_client_request_id: args.p_client_request_id, p_qr_token: args.p_qr_token,
      p_bot_field: args.p_bot_field ?? "", p_expected_event_id: args.p_expected_event_id,
      p_recovery_token: args.p_recovery_token ?? null,
      p_preparation_mode: args.p_preparation_mode ?? "immediate",
    }) : await client.rpc("upsert_push_subscription", {
      p_endpoint: args.p_endpoint, p_p256dh: args.p_p256dh, p_auth: args.p_auth,
      p_source: "tournament", p_user_agent: null,
    });
    if (error) return reply(400, error.code === "P0001" ? error.message : "order_request_failed");
    return new Response(JSON.stringify(data), { headers });
  } catch { return reply(503, "order_outcome_unknown"); }
}
