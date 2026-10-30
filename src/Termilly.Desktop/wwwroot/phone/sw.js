// @ts-check
// The phone app's service worker: it shows the alerts Termilly sends (Web Push, Phone/WebPush.cs) even while the app
// is closed and the phone locked, and a tap on one opens the app.

const sw = /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (self));

sw.addEventListener('install', () => sw.skipWaiting());
sw.addEventListener('activate', e => e.waitUntil(sw.clients.claim()));

sw.addEventListener('push', e => {
  /** @type {{ title?: string, body?: string, tag?: string, url?: string }} */
  let alert;
  try {
    alert = e.data ? e.data.json() : {};
  } catch {
    alert = { body: e.data?.text() };
  }
  e.waitUntil(sw.registration.showNotification(alert.title || 'Termilly', {
    body: alert.body || '', tag: alert.tag, icon: 'icon-192.png', data: { url: alert.url || '/' },
  }));
});

sw.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(sw.clients.matchAll({ type: 'window' }).then(open => (open.length ? open[0].focus() : sw.clients.openWindow(e.notification.data?.url || '/'))));
});
