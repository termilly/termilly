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

// A tap opens the app on the alert's terminal: the app already running is told which (app.js), else it starts there.
// Opening it there is what makes the news seen, on the PC too.
sw.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(sw.clients.matchAll({ type: 'window' }).then(async open => {
    if (!open.length) return sw.clients.openWindow(url);
    const client = await open[0].focus();
    client.postMessage({ open: new URL(url, sw.location.origin).searchParams.get('open') });
  }));
});
