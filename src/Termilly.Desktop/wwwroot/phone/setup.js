// @ts-check
// The phone's setup page (plain http, Phone/PhoneServer.cs): the app's own HTTPS address on this PC, and only the
// steps for this phone's system (both when it can't tell).

const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
const android = /Android/.test(navigator.userAgent);
const open = /** @type {HTMLAnchorElement} */ (document.getElementById('open'));
open.href = `https://${location.host}/`;
for (const el of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-os]'))) {
  el.hidden = (ios && el.dataset.os === 'android') || (android && el.dataset.os === 'ios');
}
