import { supabase } from "./supabaseClient";

const serviceWorkerUrl = `${import.meta.env.BASE_URL}service-worker.js`;

function getVapidPublicKey() {
  return import.meta.env.VITE_WEB_PUSH_PUBLIC_KEY?.trim();
}

export function isPushSupported() {
  return typeof window !== "undefined"
    && "Notification" in window
    && "serviceWorker" in navigator
    && "PushManager" in window;
}

export function urlBase64ToUint8Array(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid_vapid_public_key");
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

export async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) throw new Error("push_unsupported");
  return navigator.serviceWorker.register(serviceWorkerUrl, { scope: import.meta.env.BASE_URL });
}

export async function getExistingPushSubscription() {
  if (!isPushSupported()) return null;
  const registration = await registerServiceWorker();
  return registration.pushManager.getSubscription();
}

async function saveSubscription(subscription: PushSubscription) {
  const serialized = subscription.toJSON();
  const p256dh = serialized.keys?.p256dh;
  const auth = serialized.keys?.auth;
  if (!serialized.endpoint || !p256dh || !auth) throw new Error("invalid_push_subscription");

  const { error } = await supabase.rpc("upsert_push_subscription", {
    p_endpoint: serialized.endpoint,
    p_p256dh: p256dh,
    p_auth: auth,
    p_source: "tournament",
    p_user_agent: navigator.userAgent.slice(0, 500),
  });
  if (error) throw new Error(error.message);
}

export async function syncExistingPushSubscription() {
  const subscription = await getExistingPushSubscription();
  if (!subscription) return false;
  await saveSubscription(subscription);
  return true;
}

export async function subscribeToPushNotifications() {
  if (!isPushSupported()) throw new Error("push_unsupported");
  const vapidPublicKey = getVapidPublicKey();
  if (!vapidPublicKey) throw new Error("push_not_configured");

  const registration = await registerServiceWorker();
  let subscription = await registration.pushManager.getSubscription();
  let createdSubscription = false;
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    });
    createdSubscription = true;
  }

  try {
    await saveSubscription(subscription);
    window.dispatchEvent(new Event("lag:push-subscription-changed"));
  } catch (error) {
    if (createdSubscription) await subscription.unsubscribe().catch(() => false);
    throw error;
  }
  return registration;
}
