/* Sofia's Resto-Lounge — guest notifications service worker (scope /r/).
 * Only shows Web Push notifications about a guest's reservation; it does not cache or intercept requests.
 * The staff app has its own service worker (scope /), which is not affected. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = data.title || "Sofia's Resto-Lounge";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: data.icon || '/brand/sofia-icon-192.png',
      badge: '/brand/sofia-icon-64.png',
      dir: data.dir || 'auto',
      lang: data.lang || '',
      tag: data.tag || undefined,
      renotify: Boolean(data.tag),
      data: { url: data.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin);
  if (target.origin !== self.location.origin) return; // only ever open the restaurant's own pages
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const w of windows) if (w.url === target.href && 'focus' in w) return w.focus();
      return self.clients.openWindow(target.href);
    }),
  );
});

// The browser rotated the subscription: tell the restaurant the new address (the old one authorises the change).
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const old = event.oldSubscription;
      const key = old && old.options && old.options.applicationServerKey;
      if (!old || !key) return;
      const next = event.newSubscription || (await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
      await fetch('/api/v1/public/push/renew', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ oldEndpoint: old.endpoint, subscription: next.toJSON() }),
      });
    })(),
  );
});
