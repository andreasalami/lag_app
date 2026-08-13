// @deno-types="npm:@types/web-push@3.6.4"
import webpush from "web-push";
import { createClient } from "@supabase/supabase-js";

type BroadcastKind = "announcement" | "tournament";
type PushRow = { id: string; endpoint: string; p256dh: string; auth: string };
type DeliveryResult = { id: string; delivered: boolean; expired: boolean };

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const VAPID_PUBLIC_KEY = Deno.env.get("WEB_PUSH_VAPID_PUBLIC_KEY") ?? "";
const VAPID_PRIVATE_KEY = Deno.env.get("WEB_PUSH_VAPID_PRIVATE_KEY") ?? "";
const VAPID_SUBJECT = Deno.env.get("WEB_PUSH_VAPID_SUBJECT") ?? "";
const ALLOWED_ORIGINS = new Set((Deno.env.get("PUSH_ALLOWED_ORIGINS")
  ?? "https://andreasalami.github.io,http://localhost:5173")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean));
const MAX_SUBSCRIPTIONS_PER_BROADCAST = 5000;
const SEND_CONCURRENCY = 20;

function headersFor(request: Request) {
  const origin = request.headers.get("origin");
  return {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.has(origin) ? origin : "null",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
    "Vary": "Origin",
  };
}

function json(request: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: headersFor(request) });
}

function statusCodeOf(error: unknown) {
  if (!error || typeof error !== "object" || !("statusCode" in error)) return null;
  return Number((error as { statusCode?: unknown }).statusCode) || null;
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, operation: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: headersFor(request) });
  const origin = request.headers.get("origin");
  if (origin && !ALLOWED_ORIGINS.has(origin)) return json(request, { error: "origin_not_allowed" }, 403);
  if (request.method !== "POST") return json(request, { error: "method_not_allowed" }, 405);
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY
    || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) {
    return json(request, { error: "push_not_configured" }, 500);
  }

  const authorization = request.headers.get("Authorization");
  const token = authorization?.replace(/^Bearer\s+/i, "");
  if (!token) return json(request, { error: "not_authorized" }, 401);

  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: authData, error: authError } = await authClient.auth.getUser(token);
  if (authError || !authData.user) return json(request, { error: "not_authorized" }, 401);

  const { data: profile, error: profileError } = await serviceClient
    .from("profiles")
    .select("role")
    .eq("id", authData.user.id)
    .single();
  if (profileError || !profile) return json(request, { error: "not_authorized" }, 403);

  let body: { kind?: unknown; title?: unknown; message?: unknown };
  try {
    body = await request.json();
  } catch {
    return json(request, { error: "invalid_payload" }, 400);
  }
  const kind = body.kind as BroadcastKind;
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!(["announcement", "tournament"] as BroadcastKind[]).includes(kind)
    || title.length < 2 || title.length > 80 || message.length < 2 || message.length > 240) {
    return json(request, { error: "invalid_payload" }, 400);
  }
  const allowed = profile.role === "admin"
    || (kind === "tournament" && profile.role === "tournament_manager")
    || (kind === "announcement" && profile.role === "staff");
  if (!allowed) return json(request, { error: "not_authorized" }, 403);

  const { count, error: countError } = await serviceClient
    .from("push_subscriptions")
    .select("id", { count: "exact", head: true });
  if (countError) return json(request, { error: "subscriptions_unavailable" }, 500);
  const subscriberCount = count ?? 0;
  if (subscriberCount > MAX_SUBSCRIPTIONS_PER_BROADCAST) {
    return json(request, { error: "too_many_subscriptions", limit: MAX_SUBSCRIPTIONS_PER_BROADCAST }, 409);
  }

  const subscriptions: PushRow[] = [];
  const pageSize = 500;
  for (let start = 0; start < subscriberCount; start += pageSize) {
    const { data, error } = await serviceClient
      .from("push_subscriptions")
      .select("id,endpoint,p256dh,auth")
      .order("id")
      .range(start, Math.min(start + pageSize - 1, subscriberCount - 1));
    if (error) return json(request, { error: "subscriptions_unavailable" }, 500);
    subscriptions.push(...((data ?? []) as PushRow[]));
  }

  const broadcastId = crypto.randomUUID();
  const payload = JSON.stringify({
    title,
    body: message,
    section: kind === "announcement" ? "annunci" : "tornei",
    tag: `lag-${kind}-${broadcastId}`,
  });
  const deliveryResults = await mapConcurrent(subscriptions, SEND_CONCURRENCY, async (subscription): Promise<DeliveryResult> => {
    try {
      await webpush.sendNotification({
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      }, payload, {
        TTL: 1800,
        urgency: "high",
        topic: broadcastId.replaceAll("-", "").slice(0, 32),
        vapidDetails: {
          subject: VAPID_SUBJECT,
          publicKey: VAPID_PUBLIC_KEY,
          privateKey: VAPID_PRIVATE_KEY,
        },
      });
      return { id: subscription.id, delivered: true, expired: false };
    } catch (error) {
      const statusCode = statusCodeOf(error);
      return { id: subscription.id, delivered: false, expired: statusCode === 404 || statusCode === 410 };
    }
  });

  const expiredIds = deliveryResults.filter((result) => result.expired).map((result) => result.id);
  for (let start = 0; start < expiredIds.length; start += 100) {
    await serviceClient.from("push_subscriptions").delete().in("id", expiredIds.slice(start, start + 100));
  }
  const successCount = deliveryResults.filter((result) => result.delivered).length;
  const failureCount = deliveryResults.length - successCount;
  const { error: auditError } = await serviceClient.from("push_broadcasts").insert({
    id: broadcastId,
    kind,
    title,
    message,
    sent_by: authData.user.id,
    subscriber_count: subscriberCount,
    success_count: successCount,
    failure_count: failureCount,
  });
  if (auditError) console.error("push_audit_failed", auditError.message);

  return json(request, {
    broadcast_id: broadcastId,
    subscribers: subscriberCount,
    sent: successCount,
    failed: failureCount,
    removed: expiredIds.length,
  });
});
