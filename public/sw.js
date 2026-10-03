// Service worker minimal : il ne sert qu'aux notifications push.
// Pas de cache offline volontairement, le dashboard doit toujours afficher les
// donnees fraiches du serveur.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    data = { title: "DROP.ctrl", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "DROP.ctrl";
  const options = {
    body: data.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    // meme tag = les notifications se remplacent au lieu de s'empiler
    tag: data.tag || "drop",
    renotify: true,
    data: { url: data.url || "/" },
  };

  // Une seule notification par sujet : la nouvelle ("+5 nouveaux colis")
  // remplace la precedente ("+3") au lieu de s'empiler. Le tag suffit sur la
  // plupart des appareils ; on ferme aussi l'ancienne a la main, pour ceux
  // (iPhone) qui l'ignorent.
  event.waitUntil(
    self.registration
      .getNotifications({ tag: options.tag })
      .then((anciennes) => anciennes.forEach((n) => n.close()))
      .catch(() => {})
      .then(() => self.registration.showNotification(title, options))
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow ? self.clients.openWindow(url) : undefined;
    })
  );
});
