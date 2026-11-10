// Solo per il progetto di test: lo copia `traffic.mjs prepare-gateway`, non va mai in produzione.
// Il gateway è quello reale; cambia soltanto la risposta di Turnstile, che non si può risolvere
// in automatico. Il ritardo imita Siteverify: il tempo vero di Cloudflare resta fuori dal test.
import { handlePublicRequest } from "../_shared/publicGateway.ts";

if ((Deno.env.get("SUPABASE_URL") ?? "").includes("avsqjsobnzhpikhsoorm")) {
  throw new Error("Funzione di test pubblicata sul progetto di produzione");
}

// Il progetto di test ha solo le chiavi nuove: il gateway legge ancora SUPABASE_SERVICE_ROLE_KEY,
// che porta la chiave legacy. Qui si usa la chiave secret; in produzione resta da risolvere.
if (!Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) {
  const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
  const key = keys.default ?? Object.values(keys)[0];
  if (typeof key === "string") Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", key);
  console.warn("SUPABASE_SERVICE_ROLE_KEY assente: uso SUPABASE_SECRET_KEYS");
}

const hostname = new URL(Deno.env.get("ORDER_ALLOWED_ORIGINS") ?? "https://lag-stress.test").hostname;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (!String(input).startsWith("https://challenges.cloudflare.com/")) return realFetch(input, init);
  await new Promise((resolve) => setTimeout(resolve, 150));
  return Response.json({ success: true, action: "order", hostname });
};

Deno.serve((request: Request) => handlePublicRequest(request, "order"));
