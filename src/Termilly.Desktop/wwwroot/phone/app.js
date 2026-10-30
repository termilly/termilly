// @ts-check
// Termilly on a phone (Phone/PhoneServer.cs, docs/phone.md): pairing this phone with the code Settings shows, and its
// alerts (Web Push through the phone's own push service, encrypted for this phone alone).

const app = /** @type {HTMLElement} */ (document.getElementById('app'));

/** What the PC says about this phone. */
/** @typedef {{ paired: boolean, locked?: boolean, pushKey?: string, alerts?: boolean }} Me */

/** The PC's API for the app (PhoneServer.Api). */
const API = Object.freeze({ me: '/api/me', pair: '/api/pair', push: '/api/push', pushOff: '/api/push/off', pushTest: '/api/push/test' });
/** The PC's answer to a phone that isn't paired. */
const FORBIDDEN = 403;
/** What the app's buttons do (data-do). */
const DO = Object.freeze({ retry: 'retry', on: 'on', off: 'off', test: 'test' });
/** Alerts need a service worker; a browser without one gets none. */
const hasWorker = 'serviceWorker' in navigator;

const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
/** Opened from the Home Screen, where iPhone keeps the app's own storage (and its alerts). */
const standalone = matchMedia('(display-mode: standalone)').matches || /** @type {any} */ (navigator).standalone === true;

/**
 * @param {string} path
 * @param {object} [body]
 */
async function call(path, body) {
  const response = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  if (!response.ok) throw new Error(response.status === FORBIDDEN ? 'not allowed' : `error ${response.status}`);
  return response.json();
}

/** @param {string} html */
const show = html => { app.innerHTML = `<h1>Termilly</h1>${html}`; };

/** The VAPID key as the push manager takes it. @param {string} key base64url */
function keyBytes(key) {
  const raw = atob(key.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

async function render() {
  /** @type {Me} */
  let me;
  try {
    me = await call(API.me);
  } catch {
    show(`<p>Can't reach your PC. Is Termilly running, with Settings › Phone on, and this phone on the same Wi-Fi?</p><button class="button" data-do="${DO.retry}">Try again</button>`);
    return;
  }
  if (me.locked) return show(`<p>Termilly is locked on your PC. Unlock it there, then come back.</p><button class="button" data-do="${DO.retry}">Try again</button>`);
  if (!me.paired && ios && !standalone) {
    return show('<p>Add Termilly to your Home Screen first: <b>Share › Add to Home Screen</b>. Then open it from there and pair it.</p>');
  }
  if (!me.paired) {
    return show(`<p>On your PC, open <b>Settings › Phone</b> and press <b>Show a code</b>. Type it here:</p>
      <form data-form="pair"><input class="code" name="code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" maxlength="9" placeholder="ABCD2345" required>
      <button class="button" type="submit">Pair</button></form><p class="error" data-error></p>`);
  }
  const canAlert = hasWorker && 'PushManager' in window && 'Notification' in window;
  show(`<p>Paired with your PC.</p>
    <section class="card"><h2>Alerts</h2>
      ${!canAlert ? `<p>${ios ? 'Alerts need iOS 16.4 or later, and Termilly opened from the Home Screen.' : 'This browser can\'t take alerts.'}</p>`
    : me.alerts ? `<p>On. Termilly tells this phone when an agent needs you, even when it's locked.</p>
      <button class="button" data-do="${DO.test}">Send a test alert</button> <button class="button quiet" data-do="${DO.off}">Turn off</button>`
      : `<p>Get an alert on this phone when an agent needs you, even when it's locked.</p><button class="button" data-do="${DO.on}">Turn on alerts</button>`}
      <p class="muted" data-note></p>
    </section>`);
}

/** Alerts on: the phone's permission, a push subscription with Termilly's key, and the PC told where to send. */
async function turnOn() {
  const note = /** @type {HTMLElement} */ (app.querySelector('[data-note]'));
  try {
    if (await Notification.requestPermission() !== 'granted') {
      note.textContent = 'Alerts are blocked for Termilly in this phone\'s settings.';
      return;
    }
    /** @type {Me} */
    const me = await call(API.me);
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription() ?? await registration.pushManager.subscribe({
      userVisibleOnly: true, applicationServerKey: keyBytes(/** @type {string} */ (me.pushKey)),
    });
    await call(API.push, subscription.toJSON());
    await render();
  } catch (e) {
    note.textContent = `Alerts didn't turn on: ${/** @type {Error} */ (e).message}`;
  }
}

async function test() {
  const note = /** @type {HTMLElement} */ (app.querySelector('[data-note]'));
  const { inSeconds } = await call(API.pushTest, {});
  note.textContent = `Lock your phone now: the alert comes in ${inSeconds} seconds.`;
}

async function turnOff() {
  const registration = await navigator.serviceWorker.ready;
  await (await registration.pushManager.getSubscription())?.unsubscribe();
  await call(API.pushOff, {});
  await render();
}

app.addEventListener('click', e => {
  const action = /** @type {HTMLElement} */ (e.target).closest('[data-do]')?.getAttribute('data-do');
  if (action === DO.retry) render();
  else if (action === DO.on) turnOn();
  else if (action === DO.off) turnOff();
  else if (action === DO.test) test();
});

app.addEventListener('submit', async e => {
  e.preventDefault();
  const form = /** @type {HTMLFormElement} */ (e.target);
  const code = /** @type {HTMLInputElement} */ (form.elements.namedItem('code')).value;
  try {
    await call(API.pair, { code });
    await render();
  } catch {
    /** @type {HTMLElement} */ (app.querySelector('[data-error]')).textContent = `That code didn't work: ${code} is wrong or old. Show a new one on the PC.`;
  }
});

if (hasWorker) navigator.serviceWorker.register('/sw.js');
render();
