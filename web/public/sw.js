// Service worker: show Web Push alerts, open the desk on tap.
self.addEventListener("push", (e) => {
  let p = {};
  try { p = e.data.json(); } catch { /* no payload */ }
  e.waitUntil(self.registration.showNotification(p.title || "agent-desk", {
    body: p.body || "",
    tag: p.tag,
    icon: "./icon-192.png",
    data: { url: p.url || "" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const hash = e.notification.data?.url || "";
  e.waitUntil((async () => {
    const all = await clients.matchAll({ type: "window", includeUncontrolled: true });
    if (all.length) {
      const c = all[0];
      await c.focus();
      c.postMessage({ type: "open", hash });
    } else {
      await clients.openWindow("./" + hash);
    }
  })());
});
