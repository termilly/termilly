// @ts-check
// Settings › Serial: line settings for each COM port, network consoles (raw TCP or Telnet / RFC 2217), and the
// serial actions in a terminal's menu (Break, hex view, what Enter sends). The host does the work (SerialConsole.cs).

import { PAGE } from './protocol.js';
import { send } from './host.js';
import { state, GROUPS } from './store.js';
import { modal, DIALOG_ERROR } from './dialogs.js';
import { CONNECTION_DIALOG, isPort } from './ssh.js';
import { SEPARATOR } from './popups.js';
import { escapeHtml, ICONS } from './ui.js';
import { updateSettings } from './preferences.js';
import { PROFILE_SOURCE, PROFILE_ID_PREFIX } from './constants.js';
import { find, field, targetOf, showError } from './dom.js';

/** What Enter sends on a serial line. */
const LINE_ENDING = Object.freeze({ cr: 'CR', lf: 'LF', crlf: 'CRLF' });
const LINE_ENDINGS = Object.values(LINE_ENDING);

/** How a network console talks: Telnet (with RFC 2217 for the line), or raw TCP. */
const PROTOCOL = Object.freeze({ telnet: 'telnet', raw: 'raw' });
/** Telnet's port, a new network console's. */
const TELNET_PORT = 23;

/** A COM port row's fields (data-serial-field): the port's saved settings. */
const PORT_FIELD = Object.freeze({
  baud: 'baud', dataBits: 'dataBits', parity: 'parity', stopBits: 'stopBits', flow: 'flow', lineEnding: 'lineEnding', log: 'log',
});

/** The network console dialog's fields (their names). */
const CONSOLE_FIELD = Object.freeze({
  name: 'name', host: 'host', port: 'port', protocol: 'protocol', baud: 'baud', lineEnding: 'lineEnding',
});

/** What the section's buttons do (data-serial). */
const SERIAL_ACTION = Object.freeze({ add: 'add', edit: 'edit', remove: 'remove' });


const BAUDS = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
const DEFAULTS = { baud: 115200, dataBits: 8, parity: 'none', stopBits: '1', flow: 'none', lineEnding: LINE_ENDING.cr, log: false };

let rerender = () => {};
/** @param {() => void} fn */
export const setSerialRerender = fn => { rerender = fn; };

const ports = () => state.profiles.filter(p => p.id.startsWith(PROFILE_ID_PREFIX.serialPort)).map(p => p.name);
/** @param {string} port */
const savedPort = port => ({ port, ...DEFAULTS, ...(state.settings.shells.serialPorts ?? []).find(s => s.port.toUpperCase() === port.toUpperCase()) });
const consoles = () => state.settings.shells.networkConsoles ?? [];

/** The settings group this section saves: COM ports and network consoles. */
const GROUP = GROUPS.shells;

/** @param {Record<string, any>} patch */
function save(patch) {
  updateSettings(GROUP, patch);
  rerender();
}

/**
 * @param {string} field
 * @param {Array<Array<string | number>>} options
 * @param {string | number} value
 */
const select = (field, options, value) =>
  `<select class="field small" data-serial-field="${field}">${options.map(([v, l]) => `<option value="${v}"${String(v) === String(value) ? ' selected' : ''}>${l}</option>`).join('')}</select>`;

/** @param {typeof import('./settings/controls.js').group} group */
export function serialSectionHtml(group) {
  const portRows = ports().map(port => {
    const s = savedPort(port);
    const profile = state.profiles.find(p => p.id === `${PROFILE_ID_PREFIX.serialPort}${port.toLowerCase()}`);
    return `<div class="serial-row" data-port="${escapeHtml(port)}">
      <span class="ssh-main"><span class="ssh-name">${escapeHtml(port)}</span><span class="ssh-sub">${escapeHtml(profile?.description ?? '')}</span></span>
      <span class="serial-fields">
        ${select(PORT_FIELD.baud, BAUDS.map(b => [b, b]), s.baud)}
        ${select(PORT_FIELD.dataBits, [[8, '8'], [7, '7'], [6, '6'], [5, '5']], s.dataBits)}
        ${select(PORT_FIELD.parity, [['none', 'N'], ['even', 'E'], ['odd', 'O'], ['mark', 'M'], ['space', 'S']], s.parity)}
        ${select(PORT_FIELD.stopBits, [['1', '1'], ['1.5', '1.5'], ['2', '2']], s.stopBits)}
        ${select(PORT_FIELD.flow, [['none', 'No flow control'], ['rts/cts', 'RTS/CTS'], ['xon/xoff', 'XON/XOFF']], s.flow)}
        ${select(PORT_FIELD.lineEnding, LINE_ENDINGS.map(e => [e, `Enter: ${e}`]), s.lineEnding)}
        <label class="paste-never"><input type="checkbox" data-serial-field="${PORT_FIELD.log}"${s.log ? ' checked' : ''}> Log</label>
      </span>
    </div>`;
  }).join('');
  return group('COM ports', `${portRows || '<p class="set-desc">No COM ports on this PC right now. Plug in a USB serial adapter and reopen Settings.</p>'}
      <p class="set-desc">They open from the + menu (Serial). Changes apply to terminals opened after them. Logs go to Documents\\Termilly\\logs, one timestamped line at a time.
        In a terminal’s menu: Send Break, Hex view, and what Enter sends. An unplugged adapter is retried until it’s back.</p>`)
    + group('Network consoles', `
      ${consoles().map(c => `
        <div class="ssh-row" data-console="${escapeHtml(c.id)}">
          <span class="badge small" data-icon="serial">IO</span>
          <span class="ssh-main"><span class="ssh-name">${escapeHtml(c.name)}</span><span class="ssh-sub">${escapeHtml(`${c.host}:${c.port} · ${c.protocol === PROTOCOL.telnet ? `Telnet${c.baud ? ` · ${c.baud} baud (RFC 2217)` : ''}` : 'raw TCP'}`)}</span></span>
          <button class="btn small" data-serial="${SERIAL_ACTION.edit}">Edit</button>
          <button class="btn small" data-serial="${SERIAL_ACTION.remove}" title="Remove">${ICONS.trash}</button>
        </div>`).join('')}
      <button class="btn small" data-serial="${SERIAL_ACTION.add}">${ICONS.plus}<span>Add network console</span></button>
      <p class="set-desc">A console server’s port, or a device on the network: raw TCP, or Telnet (with RFC 2217 to set the line speed).</p>`);
}

/** @param {NetworkConsole | null | undefined} existing */
function consoleDialog(existing) {
  // A new one has no tags yet.
  const c = existing ?? /** @type {NetworkConsole} */ ({ id: `n${Date.now().toString(36)}`, name: '', host: '', port: TELNET_PORT, protocol: PROTOCOL.telnet, baud: null, lineEnding: LINE_ENDING.cr, log: false });
  return modal(CONNECTION_DIALOG, `
    <h3>${existing ? 'Edit network console' : 'New network console'}</h3>
    <div class="dialog-grid">
      <label class="dialog-field">Name<input class="field" name="name" value="${escapeHtml(c.name)}" autofocus placeholder="switch-a console"></label>
      <label class="dialog-field">Host<input class="field" name="host" value="${escapeHtml(c.host)}" placeholder="10.0.0.20"></label>
      <label class="dialog-field">Port<input class="field" name="port" value="${c.port}" inputmode="numeric"></label>
      <label class="dialog-field">Protocol<select class="field" name="protocol"><option value="${PROTOCOL.telnet}"${c.protocol === PROTOCOL.telnet ? ' selected' : ''}>Telnet</option><option value="${PROTOCOL.raw}"${c.protocol === PROTOCOL.raw ? ' selected' : ''}>Raw TCP</option></select></label>
      <label class="dialog-field">Line speed (RFC 2217)<input class="field" name="baud" value="${c.baud ?? ''}" placeholder="leave as is" inputmode="numeric"></label>
      <label class="dialog-field">Enter sends<select class="field" name="lineEnding">${LINE_ENDINGS.map(e => `<option${e === c.lineEnding ? ' selected' : ''}>${e}</option>`).join('')}</select></label>
    </div>
    <label class="paste-never"><input type="checkbox" name="log"${c.log ? ' checked' : ''}> Log to a file with timestamps</label>
    <p class="dialog-error" hidden></p>
    <div class="dialog-actions"><button class="btn" data-cancel>Cancel</button><button class="btn primary" data-ok>Save</button></div>`, (dialog, /** @type {(result: NetworkConsole | null) => void} */ close) => {
    const submit = () => {
      const get = /** @param {string} n */ n => field(dialog, `[name=${n}]`).value.trim();
      /** @type {NetworkConsole} */
      const value = {
        id: c.id, name: get(CONSOLE_FIELD.name), host: get(CONSOLE_FIELD.host), port: Number(get(CONSOLE_FIELD.port)),
        protocol: get(CONSOLE_FIELD.protocol), baud: get(CONSOLE_FIELD.baud) ? Number(get(CONSOLE_FIELD.baud)) : null,
        lineEnding: get(CONSOLE_FIELD.lineEnding), log: field(dialog, '[name=log]').checked, tags: c.tags ?? [],
      };
      const error = find(dialog, DIALOG_ERROR);
      if (!value.name || !/^[A-Za-z0-9.\-:[\]]+$/.test(value.host) || !isPort(value.port)) {
        showError(error, 'A name, a host (no spaces) and a port from 1 to 65535 are needed.');
        return;
      }
      close(value);
    };
    return { submit };
  }).then(value => {
    if (value) save({ networkConsoles: [...consoles().filter(x => x.id !== value.id), value] });
  });
}

/** @param {Event} e */
export function handleSerialClick(e) {
  const button = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-serial]'));
  if (!button) return false;
  const c = consoles().find(x => x.id === /** @type {HTMLElement | null} */ (button.closest('[data-console]'))?.dataset.console);
  if (button.dataset.serial === SERIAL_ACTION.add) consoleDialog(null);
  else if (button.dataset.serial === SERIAL_ACTION.edit) consoleDialog(c);
  else if (button.dataset.serial === SERIAL_ACTION.remove) save({ networkConsoles: consoles().filter(x => x !== c) });
  return true;
}

/** @param {Event} e */
export function handleSerialChange(e) {
  // An input or a select: both have a value (and only the checkbox is read as checked).
  const field = /** @type {HTMLInputElement | null} */ (targetOf(e).closest('[data-serial-field]'));
  const row = /** @type {HTMLElement | null} */ (field?.closest('[data-port]'));
  if (!row) return false;
  // A port's row holds its fields, so there's a field here.
  const port = /** @type {string} */ (row.dataset.port);
  const key = /** @type {string} */ (/** @type {HTMLInputElement} */ (field).dataset.serialField);
  const value = key === PORT_FIELD.log ? /** @type {HTMLInputElement} */ (field).checked
    : /** @type {string[]} */ ([PORT_FIELD.baud, PORT_FIELD.dataBits]).includes(key) ? Number(/** @type {HTMLInputElement} */ (field).value) : /** @type {HTMLInputElement} */ (field).value;
  const next = { ...savedPort(port), [key]: value };
  save({ serialPorts: [...(state.settings.shells.serialPorts ?? []).filter(s => s.port.toUpperCase() !== port.toUpperCase()), next] });
  return true;
}

/**
 * A serial terminal's view (tab.serial): hex or text, and what Enter sends (null: the port's saved choice).
 * @typedef {{ hex: boolean, eol: string | null }} SerialView
 */

/**
 * A serial terminal's view, kept here: whether it shows hex, and what Enter sends (null: the port's saved choice).
 * @param {Tab} tab
 */
const serialOf = tab => (tab.serial ??= { hex: false, eol: null });

/**
 * A terminal's menu items when it's a serial port or network console.
 * @param {Tab} tab
 * @returns {import('./popups.js').MenuEntry[]}
 */
export function serialMenuItems(tab) {
  const profile = state.profiles.find(p => p.id === tab.profile);
  if (profile?.source !== PROFILE_SOURCE.serial) return [];
  return [
    { label: 'Send Break', action: () => send(PAGE.serialBreak, { id: tab.id }) },
    {
      label: 'Hex view', checked: !!tab.serial?.hex,
      action: () => { serialOf(tab).hex = !serialOf(tab).hex; send(PAGE.serialHex, { id: tab.id, on: serialOf(tab).hex }); },
    },
    {
      label: 'Enter sends',
      submenu: () => LINE_ENDINGS.map(eol => ({
        label: eol, checked: (tab.serial?.eol ?? savedPort(profile.name).lineEnding) === eol,
        action: () => { serialOf(tab).eol = eol; send(PAGE.serialEol, { id: tab.id, eol }); },
      })),
    },
    SEPARATOR,
  ];
}
