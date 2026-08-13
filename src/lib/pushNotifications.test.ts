import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeToPushNotifications, urlBase64ToUint8Array } from "./pushNotifications";

const rpc = vi.hoisted(() => vi.fn());

vi.mock("./supabaseClient", () => ({
  supabase: { rpc },
}));

function mockPushBrowser(existingSubscription: PushSubscription | null, newSubscription?: PushSubscription) {
  const registration = {
    pushManager: {
      getSubscription: vi.fn().mockResolvedValue(existingSubscription),
      subscribe: vi.fn().mockResolvedValue(newSubscription),
    },
  };
  const register = vi.fn().mockResolvedValue(registration);
  vi.stubGlobal("navigator", { serviceWorker: { register }, userAgent: "Vitest phone" });
  vi.stubGlobal("window", {
    Notification: {},
    PushManager: function PushManager() {},
    dispatchEvent: vi.fn(),
  });
  vi.stubEnv("VITE_WEB_PUSH_PUBLIC_KEY", "B".repeat(87));
  return registration;
}

function mockSubscription() {
  return {
    toJSON: () => ({
      endpoint: "https://push.example.test/device/one",
      keys: { p256dh: "A".repeat(87), auth: "B".repeat(22) },
    }),
    unsubscribe: vi.fn().mockResolvedValue(true),
  } as unknown as PushSubscription;
}

afterEach(() => {
  rpc.mockReset();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("urlBase64ToUint8Array", () => {
  it("decodifica una chiave base64url senza padding", () => {
    expect(Array.from(urlBase64ToUint8Array("AQID-v8"))).toEqual([1, 2, 3, 250, 255]);
  });

  it("rifiuta caratteri estranei al formato base64url", () => {
    expect(() => urlBase64ToUint8Array("chiave non valida")).toThrow("invalid_vapid_public_key");
  });
});

describe("subscribeToPushNotifications", () => {
  it("non cancella una sottoscrizione esistente se il salvataggio temporaneamente fallisce", async () => {
    const subscription = mockSubscription();
    mockPushBrowser(subscription);
    rpc.mockResolvedValue({ error: { message: "database_unavailable" } });

    await expect(subscribeToPushNotifications("tournament")).rejects.toThrow("database_unavailable");
    expect(subscription.unsubscribe).not.toHaveBeenCalled();
  });

  it("annulla una nuova sottoscrizione se non riesce a salvarla", async () => {
    const subscription = mockSubscription();
    mockPushBrowser(null, subscription);
    rpc.mockResolvedValue({ error: { message: "database_unavailable" } });

    await expect(subscribeToPushNotifications("announcements")).rejects.toThrow("database_unavailable");
    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
  });
});
