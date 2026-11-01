// @ts-check
// Settings › Phone (Features/Phone.cs, Phone/PhoneServer.cs, docs/phone.md): turning Termilly on a phone on, setting
// up a phone (Termilly's certificate, then a pairing code), the paired phones and a test alert.

import { HOST, PAGE } from '../protocol.js';
import { onHost, send } from '../host.js';
import { escapeHtml, ICONS } from '../ui.js';
import { row, toggle, group, seg } from './controls.js';
import { SETTING_VALUES } from '../constants.js';
import { SECTION, redrawIfShowing } from './page.js';
import { modal } from '../dialogs.js';

/** The QR codes: the size of their cells and their quiet margin, in cells of the qrcode library. */
const QR_CELL = 5;
const QR_MARGIN = 4;
/** A QR code's slot in the markup: its text in data-qr. */
const QR_SLOT = '[data-qr]';

/** The host's state of Termilly on a phone: running or not, its addresses, why it isn't, the paired phones. */
/** @type {import('../protocol.js').Host_phoneStatus} */
let status = { running: false, setupUrl: null, appUrl: null, error: null, devices: [] };
/** The pairing code shown, and what the test alert said. */
let code = '';
let tested = '';

/** The paired phones' window while it's open: its list, drawn again as phones pair and go. */
/** @type {HTMLElement | null} */
let phonesList = null;

const redraw = () => {
  redrawIfShowing(SECTION.phone);
  if (phonesList) phonesList.innerHTML = phonesHtml();
};

onHost(HOST.phoneStatus, m => {
  // The phone took the code (a phone paired again under its old name replaces its entry: the count can stay).
  if (m.devices.length > status.devices.length || m.devices.some(d => !status.devices.some(o => o.id === d.id))) code = '';
  status = m;
  redraw();
});

onHost(HOST.phonePairing, m => {
  code = m.code;
  redraw();
});

onHost(HOST.phoneTested, m => {
  tested = m.error ?? `Sent to ${m.sent === 1 ? 'one phone' : `${m.sent} phones`}.`;
  redraw();
});

const when = /** @param {number | undefined} ms */ ms => (ms ? new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');

/** @param {string} text */
const qrSlot = text => `<div class="pair-qr" data-qr="${escapeHtml(text)}"></div><p class="set-desc mono pair-url">${escapeHtml(text)}</p>`;

function setupHtml() {
  return group('Set up a phone',
    row('1. Get the app', 'Scan with the phone’s camera, on the same Wi-Fi. The page walks you through installing Termilly’s certificate and adding the app to the Home Screen.',
      '', { stack: true, keywords: 'phone qr setup certificate install' })
    + qrSlot(/** @type {string} */ (status.setupUrl))
    + row('2. Pair it', code ? `Open Termilly from the phone’s Home Screen and type <span class="pair-code mono">${escapeHtml(code)}</span>. It works once, for 5 minutes.`
      : 'Open Termilly from the phone’s Home Screen, then show a code to type there.',
    `<button class="btn small" data-action="pairPhone">${code ? 'New code' : 'Show a code'}</button>`, { keywords: 'phone pair code' }));
}

/** The paired phones, each with Remove (in their own window). */
function phonesHtml() {
  return status.devices.length ? status.devices.map(d => `
      <div class="plugin-row" data-device="${escapeHtml(d.id)}">
        <div class="plugin-text"><div class="set-name">${escapeHtml(d.name)}</div>
          <div class="set-desc">Paired ${escapeHtml(when(d.paired))} · last seen ${escapeHtml(when(d.lastSeen))} · alerts ${d.alerts ? 'on' : 'off'}</div></div>
        <button class="btn small danger-outline" data-remove>Remove</button>
      </div>`).join('')
    : '<p class="set-desc">None. A removed phone can’t connect again until it’s paired anew.</p>';
}

/** The paired phones' own window. */
function openPhones() {
  modal('phone-devices', `<h3>Paired phones</h3>
    <p class="dialog-sub">A phone paired again under a name it had replaces its old entry.</p>
    <div class="phone-list" data-phone-list>${phonesHtml()}</div>
    <div class="dialog-actions"><button class="btn primary" data-ok autofocus>Done</button></div>`, (dialog, close) => {
    phonesList = /** @type {HTMLElement} */ (dialog.querySelector('[data-phone-list]'));
    phonesList.addEventListener('click', e => {
      const device = /** @type {HTMLElement} */ (e.target).closest('[data-remove]')?.closest('[data-device]');
      if (device) send(PAGE.phoneRemove, { device: /** @type {HTMLElement} */ (device).dataset.device });
    });
    return { submit: () => close(true) };
  }).finally(() => { phonesList = null; });
}

/** @param {number} count */
const phonesCount = count => (count === 1 ? 'One phone' : `${count} phones`);

function devicesHtml() {
  return group('Paired phones', status.devices.length
    ? row('Paired phones', `${phonesCount(status.devices.length)}: ${escapeHtml(status.devices.map(d => d.name).join(', '))}.`,
      '<button class="btn small" data-action="managePhones">Manage</button>', { keywords: 'phone paired devices remove' })
    + row('Alerts', 'An agent’s news, as Settings › Notifications picks it. Away: Termilly isn’t in front, or the PC has been untouched for a minute.',
      seg('phone.alerts', [[SETTING_VALUES.phoneAlerts.away, 'When I’m away'], [SETTING_VALUES.phoneAlerts.always, 'Always'], [SETTING_VALUES.phoneAlerts.off, 'Off']]),
      { keywords: 'phone alert push notification away idle' })
    + row('Allow typing', 'Paired phones can type into the terminals they show. Answers to an agent work either way.', toggle('phone.allowTyping'), { keywords: 'phone type keyboard input remote' })
    + row('Smart Clip on the phone', 'With typing allowed, phones can paste your recent text clips. They get only each one’s first line, secrets masked; this PC pastes it.', toggle('phone.clips'), { keywords: 'phone smart clip clipboard paste' })
    + row('Hide details in alerts', 'Only “An agent needs you” or “An agent finished”: no terminal, workspace or message on the lock screen.', toggle('phone.hideDetails'), { keywords: 'phone alert privacy lock screen' })
    + row('Test alert', tested ? escapeHtml(tested) : 'Sends an alert to each phone that has alerts on, even when it’s locked.',
      '<button class="btn small" data-action="testPhone">Send</button>', { keywords: 'phone alert push notification test' })
    : '<p class="set-desc">None yet. A removed phone can’t connect again until it’s paired anew.</p>');
}

/** @type {import('./page.js').Section} */
const PHONE = {
  id: SECTION.phone,
  label: 'Phone', icon: ICONS.phone,
  html: () => group('', row('Termilly on your phone',
    'Your terminals and agents on your phone, served by this PC on your own network over HTTPS. Off by default: nothing listens while it’s off.',
    toggle('phone.enabled'), { keywords: 'phone mobile iphone android remote lan wifi' })
    + (status.error ? `<p class="set-status">${escapeHtml(status.error)}</p>` : ''))
    + (status.running ? setupHtml() + devicesHtml() : ''),
  refresh: () => send(PAGE.phoneStatus),
  opened: () => send(PAGE.phoneStatus),
  drawn(body) {
    for (const slot of /** @type {NodeListOf<HTMLElement>} */ (body.querySelectorAll(QR_SLOT))) {
      const qr = /** @type {Window & { qrcode?: any }} */ (window).qrcode(0, 'M');
      qr.addData(/** @type {string} */ (slot.dataset.qr));
      qr.make();
      slot.innerHTML = qr.createSvgTag({ cellSize: QR_CELL, margin: QR_MARGIN, scalable: true });
    }
  },
  actions: {
    pairPhone: () => send(PAGE.phonePair),
    testPhone: () => {
      tested = 'Sending';
      redraw();
      send(PAGE.phoneTest);
    },
    managePhones: openPhones,
  },
};

export default PHONE;
