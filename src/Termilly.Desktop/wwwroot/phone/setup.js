// @ts-check
// The phone's setup page (plain http, Phone/PhoneServer.cs): the steps for this phone's system (both when it can't
// tell), and a live check that the phone trusts Termilly's certificate: until it does, "Open Termilly" stays off, so
// nobody walks into the "not private" warning.

/** How often the trust check runs while the page is open. */
const CHECK_EVERY_MS = 2000;

const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
const android = /Android/.test(navigator.userAgent);
const app = `https://${location.host}/`;
const open = /** @type {HTMLAnchorElement} */ (document.getElementById('open'));
const trust = /** @type {HTMLElement} */ (document.querySelector('[data-trust]'));
open.href = app;
for (const el of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-os]'))) {
  el.hidden = (ios && el.dataset.os === 'android') || (android && el.dataset.os === 'ios');
}

/** The app's address answers over HTTPS only once the phone trusts the certificate: an untrusted one makes fetch fail. */
async function check() {
  let trusted;
  try {
    await fetch(`${app}api/me`, { mode: 'no-cors', cache: 'no-store' });
    trusted = true;
  } catch {
    trusted = false;
  }
  trust.textContent = trusted ? 'This phone trusts Termilly.' : 'Not yet: this phone doesn’t trust Termilly. Finish step 1 first.';
  trust.classList.toggle('ok', trusted);
  open.setAttribute('aria-disabled', String(!trusted));
  if (!trusted) setTimeout(check, CHECK_EVERY_MS);
}

open.addEventListener('click', e => {
  if (open.getAttribute('aria-disabled') === 'true') e.preventDefault();
});
check();
