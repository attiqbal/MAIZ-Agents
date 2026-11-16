// MAIZ Agents service worker. It does two things only: shows a notification when the server pushes one,
// and opens the right page when the notification is tapped. It caches nothing, so pages are always fresh.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

const HOME = "/app.html";
const clip = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");
/** Only paths on this site are ever opened from a notification. */
const safePath = (link) => (typeof link === "string" && /^\/[\w\-./#?=&]*$/.test(link) && !link.startsWith("//") ? link : HOME);

self.addEventListener("push", (event) => {
  let message = {};
  try { message = event.data ? event.data.json() : {}; } catch { message = {}; }
  const title = clip(message.title, 120) || "MAIZ Agents";
  const tag = clip(message.tag, 60);
  event.waitUntil(self.registration.showNotification(title, {
    body: clip(message.body, 300),
    icon: "/apple-touch-icon.png",
    badge: "/apple-touch-icon.png",
    ...(tag ? { tag } : {}),
    data: { link: safePath(message.link) },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const link = safePath(event.notification.data && event.notification.data.link);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
    if (open) {
      await open.focus();
      if ("navigate" in open) await open.navigate(link);
      return;
    }
    await self.clients.openWindow(link);
  })());
});
