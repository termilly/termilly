// @ts-check
// Phone check-in (Settings › Phone check-in; CheckinServer.cs, docs/checkin.md): pairing a phone with a QR code, the
// paired phones, and the page's side of the phone's requests — terminal states, a terminal's recent output (the host
// redacts it) and Approve/Reject for an agent's permission prompt (only when Settings allows it; the host checks).

import { PAGE, HOST } from './protocol.js';
import { send, onHost } from './host.js';
import { state, wsById, tabTitle, profileOf, activityOf } from './store.js';
import { escapeHtml, ICONS } from './ui.js';
import { modal } from './dialogs.js';
import { RECOVERY_DIALOG } from './security.js';
import { bufferLines } from './terminals.js';
import { AGENT_STATE, CLAUDE_TOOL } from './constants.js';
import { find, targetOf } from './dom.js';

const OUTPUT_LINES = 60;

/** The pairing QR code: the size of its cells and its quiet margin, in cells of the qrcode library. */
const QR_CELL = 5;
const QR_MARGIN = 4;

/** A phone's answer to a permission prompt. */
const ANSWER = Object.freeze({ approve: 'approve', reject: 'reject' });

/** What the check-in section's buttons do (data-checkin). */
const CHECKIN_ACTION = Object.freeze({ pair: 'pair', remove: 'remove' });

/** A paired phone, as the host lists it (times in ms). */
/** @typedef {{ id: string, name: string, paired: number | null, lastSeen: number | null }} CheckinDevice */

/** The host's check-in status. */
/** @typedef {{ running: boolean, url?: string | null, error?: string | null, devices: CheckinDevice[] }} CheckinStatus */

/** @type {CheckinStatus} */
export let checkin = { running: false, devices: [] };
let rerender = () => {};
/** @type {{ show: (url: string) => void, paired: (device: CheckinDevice) => void } | null} */
let pairing = null; // { dialog, devices } while the pairing dialog is open

/** @param {() => void} fn */
export function setCheckinRerender(fn) {
  rerender = fn;
}

export const refreshCheckin = () => send(PAGE.checkinStatus);

onHost(HOST.checkinStatus, m => {
  const before = checkin.devices.length;
  checkin = m;
  if (pairing && m.devices.length > before) pairing.paired(m.devices.at(-1));
  rerender();
});

onHost(HOST.checkinPairing, m => pairing?.show(m.url));

/**
 * Waiting for an answer to a permission prompt (not a question, which needs typing).
 * @param {Tab} tab
 */
const awaitsPermission = tab => tab.agent?.state === AGENT_STATE.needsInput && tab.agent.tool && tab.agent.tool !== CLAUDE_TOOL.askUserQuestion;

/**
 * @param {string} requestId
 * @param {() => unknown} fn
 */
function reply(requestId, fn) {
  try {
    send(PAGE.apiResult, { requestId, result: fn() });
  } catch (e) {
    send(PAGE.apiResult, { requestId, error: /** @type {Error} */ (e).message });
  }
}

onHost(HOST.checkinState, m => reply(m.requestId, () => ({
  terminals: [...state.tabs.values()].filter(t => wsById(t.wsId)).map(t => {
    const activity = activityOf(t);
    return {
      id: t.id,
      title: tabTitle(t),
      workspace: wsById(t.wsId)?.name ?? '',
      profile: profileOf(t)?.name ?? '',
      kind: activity?.kind ?? (t.exited ? 'exited' : 'idle'),
      activity: activity?.title ?? (t.exited ? 'Exited' : ''),
      status: t.status ?? null,
      canAnswer: awaitsPermission(t),
    };
  }),
})));

onHost(HOST.checkinOutput, m => reply(m.requestId, () => {
  const tab = state.tabs.get(m.args?.pane);
  if (!tab) throw new Error('That terminal is gone.');
  return bufferLines(tab, OUTPUT_LINES * 2).slice(-OUTPUT_LINES);
}));

onHost(HOST.checkinAnswer, m => reply(m.requestId, () => {
  const tab = state.tabs.get(m.args?.pane);
  if (!tab || !awaitsPermission(tab)) throw new Error('That terminal isn’t waiting for an answer any more.');
  // Claude Code's permission prompt: Enter takes the highlighted "Yes", Esc says no.
  send(PAGE.input, { id: tab.id, data: m.args.choice === ANSWER.approve ? '\r' : '\x1b' });
  return { answered: m.args.choice === ANSWER.approve ? ANSWER.approve : ANSWER.reject };
}));

const when = /** @param {number | null} ms */ ms => (ms ? new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');

/**
 * @param {typeof import('./settings/controls.js').group} group
 * @param {typeof import('./settings/controls.js').row} row
 * @param {typeof import('./settings/controls.js').toggle} toggle
 */
export function checkinSectionHtml(group, row, toggle) {
  const status = checkin.error ? `<p class="set-status">${escapeHtml(checkin.error)}</p>`
    : checkin.running ? `<p class="set-desc">Listening on <span class="mono">${escapeHtml(checkin.url)}</span> (this network only).</p>` : '';
  return group('', row('Phone check-in',
    'See your terminals, waiting agents and recent output from a phone on the same Wi-Fi. Off by default; nothing listens while it’s off. Every request is encrypted with a key only paired phones have.',
    toggle('checkin.enabled')) + status
    + (checkin.running ? row('Pair a phone', 'Shows a QR code to scan with the phone’s camera.', `<button class="btn small" data-checkin="${CHECKIN_ACTION.pair}">Pair a phone</button>`) : '')
    + row('Let phones answer prompts', 'Paired phones can press Approve (Enter) or Reject (Esc) when Claude asks permission. They can never type anything else.', toggle('checkin.answer')))
    + group('Paired phones', checkin.devices.length ? checkin.devices.map(d => `
      <div class="plugin-row" data-device="${escapeHtml(d.id)}">
        <div class="plugin-text"><div class="set-name">${escapeHtml(d.name)}</div>
          <div class="set-desc">Paired ${escapeHtml(when(d.paired))} · last seen ${escapeHtml(when(d.lastSeen))}</div></div>
        <button class="btn small danger-outline" data-checkin="${CHECKIN_ACTION.remove}">Remove</button>
      </div>`).join('') : '<p class="set-desc">None. A removed phone can’t connect again until it’s paired anew.</p>')
    + '<p class="set-desc set-note">Use it on networks you trust: the page is plain http, so someone who can tamper with your Wi-Fi traffic could change it. docs/checkin.md has the details.</p>';
}

function openPairing() {
  modal(RECOVERY_DIALOG, `
    <div class="dialog-icon">${ICONS.lock}</div>
    <h3>Pair a phone</h3>
    <p class="dialog-sub">Scan this with the phone’s camera (same Wi-Fi). The code works once, for 5 minutes.</p>
    <div class="pair-qr" data-qr>Making a code…</div>
    <p class="dialog-note mono pair-url" data-url></p>
    <p class="dialog-sub" data-pair-state>Waiting for the phone…</p>
    <div class="dialog-actions"><button class="btn primary" data-ok>Done</button></div>`, (dialog, close) => {
    pairing = {
      /** @param {string} url */
      show(url) {
        const qr = /** @type {Window & { qrcode?: any }} */ (window).qrcode(0, 'M');
        qr.addData(url);
        qr.make();
        find(dialog, '[data-qr]').innerHTML = qr.createSvgTag({ cellSize: QR_CELL, margin: QR_MARGIN, scalable: true });
        find(dialog, '[data-url]').textContent = url;
      },
      /** @param {CheckinDevice} device */
      paired(device) {
        find(dialog, '[data-pair-state]').textContent = `Paired: ${device.name}. You can close this.`;
      },
    };
    send(PAGE.checkinPair);
    return { submit: () => close(true) };
  }).then(() => { pairing = null; });
}

/** @param {Event} e */
export function handleCheckinClick(e) {
  const button = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-checkin]'));
  if (!button) return false;
  if (button.dataset.checkin === CHECKIN_ACTION.pair) openPairing();
  if (button.dataset.checkin === CHECKIN_ACTION.remove) send(PAGE.checkinRemove, { device: /** @type {HTMLElement} */ (button.closest('[data-device]')).dataset.device });
  return true;
}
