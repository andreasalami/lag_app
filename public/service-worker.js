const APP_SCOPE = self.registration.scope;
const DEFAULT_ICON = new URL("apple-touch-icon.png", APP_SCOPE).href;
const DEFAULT_BADGE = new URL("favicon-48.png", APP_SCOPE).href;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data?.json() ?? {};
  } catch {
    payload = { body: event.data?.text() ?? "Nuovo aggiornamento disponibile." };
  }

  const title = typeof payload.title === "string" ? payload.title : "L'Agro ai Giovani";
  const body = typeof payload.body === "string" ? payload.body : "Nuovo aggiornamento disponibile.";
  const tag = typeof payload.tag === "string" ? payload.tag : "lag-tournament";

  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: DEFAULT_ICON,
    badge: DEFAULT_BADGE,
    tag,
    renotify: true,
    data: { url: new URL("#tornei", APP_SCOPE).href },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const destination = event.notification.data?.url ?? new URL("#tornei", APP_SCOPE).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if ("focus" in client) {
        if ("navigate" in client) await client.navigate(destination);
        return client.focus();
      }
    }
    return self.clients.openWindow(destination);
  })());
});
