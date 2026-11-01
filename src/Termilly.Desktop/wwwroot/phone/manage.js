// @ts-check
// Managing terminals from the phone (design A, "Plus and sheets"): a + in the title opens the New terminal page (a
// shell or a remote place, then where: the workspace and a folder, each on its own page, as Settings' pages); the Remote section under the workspaces opens a place in the PC's current
// workspace; a terminal swiped left shows More (rename, move) and Close; Add SSH host saves one on the PC. All of it
// only while the PC allows typing from the phone (js/phonemanage.js does it on the PC).

import { TOUCH } from './gestures.js';

/** @typedef {{ id: string, name: string, description: string, icon: string, badge: string, source: string, remote: boolean, production: boolean }} Place */
/** @typedef {{ id: string, name: string, color: string, cwd: string | null }} Ws */
/** @typedef {{ id: string, ws: string, title: string, icon: string, badge: string, activity: string | null, waiting: unknown, production: boolean }} Term */
/** @typedef {{ typing?: boolean, places?: Place[], activeWs?: string, workspaces: Ws[], terminals: Term[] }} Snap */

/** What the PC does for the phone (js/phonemanage.js ACTION). */
const ACTION = Object.freeze({ open: 'open', close: 'close', rename: 'rename', move: 'move', addHost: 'addHost' });
const OP = 'manage';
/** What the module's buttons do (data-m). */
const M = Object.freeze({
  new: 'new', pick: 'pick', openNew: 'open-new', toWs: 'to-ws', pickWs: 'pick-ws', toFolder: 'to-folder', toNew: 'to-new', place: 'place', more: 'more', close: 'close', closeNow: 'close-now', rename: 'rename',
  renameNow: 'rename-now', move: 'move', moveTo: 'move-to', host: 'host', saveHost: 'save-host', sign: 'sign', all: 'all', cancel: 'cancel', go: 'go',
});
/** The sheets it shows, and the pages (New terminal and its Workspace and Folder pages). */
const SHEET = Object.freeze({ new: 'new', newWs: 'new-ws', newFolder: 'new-folder', more: 'more', rename: 'rename', move: 'move', host: 'host', confirm: 'confirm' });
/** The ones drawn as a page over the home, above the tab bar, rather than as a sheet. */
const PAGES = [SHEET.new, SHEET.newWs, SHEET.newFolder];
/** How a host signs in, as the phone offers it (ssh.js IDENTITY): nothing secret is typed on the phone. */
const SIGN_IN = Object.freeze({ agent: 'agent', key: 'key', password: 'wincred' });
const SIGN = [[SIGN_IN.agent, 'Keys'], [SIGN_IN.key, 'Key file'], [SIGN_IN.password, 'Password']];
/** The sheets' fields (name=). */
const FIELD = Object.freeze({ name: 'name', host: 'host', user: 'user', port: 'port', keyPath: 'keyPath', jump: 'jump', tags: 'tags', ws: 'ws', cwd: 'cwd' });
/** Remote places listed before Show all. */
const REMOTE_SHOWN = 6;
/** How far a row slides open, and how far a finger moves before it's a swipe (px). */
const SWIPE = Object.freeze({ open: 148, slop: 10 });
/** Activities that make closing a terminal ask first (the PC's spinner, an agent waiting). */
const BUSY = ['spin', 'needs', 'percent'];
const PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';

/** @param {unknown} text */
const esc = text => String(text ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
/** @param {{ icon: string, badge: string }} p */
const badgeHtml = p => `<span class="badge${p.icon === 'claude' ? ' claude' : ''}" data-icon="${esc(p.icon)}">${p.icon === 'claude' ? '✻' : esc(p.badge)}</span>`;

/**
 * @param {{ snap: () => Snap, send: (message: object) => void, toast: (text: string) => void, openTerminal: (id: string) => void, render: () => void }} app
 */
export function manager(app) {
  const layer = document.createElement('div');
  document.body.append(layer);
  layer.addEventListener('click', e => click(/** @type {HTMLElement} */ (e.target)));
  // Done on the keyboard in the Folder field goes back to New terminal with it.
  layer.addEventListener('keydown', e => { if (e.key === 'Enter' && sheet?.kind === SHEET.newFolder) { e.preventDefault(); backToNew(); } });
  // A tab tapped while a page or sheet shows leaves it.
  document.addEventListener('click', e => { if (sheet && /** @type {HTMLElement} */ (e.target).closest('[data-tab]')) open(null); }, true);
  /**
   * The sheet or page shown; a sheet opened over a page keeps that page (from) to go back to.
   * @typedef {{ kind: string, id?: string, profile?: string, ws?: string, cwd?: string, then?: () => void, title?: string, text?: string, error?: string, from?: Shown }} Shown
   * @type {Shown | null}
   */
  let sheet = null;
  /** A terminal the phone opened, to show once the PC lists it. */
  let pending = '';
  /** The row swiped open (its terminal's id). */
  let swiped = '';
  let showAll = false;

  const snap = app.snap;
  const allowed = () => !!snap().typing;
  const places = () => snap().places ?? [];
  const term = (/** @type {string | undefined} */ id) => snap().terminals.find(t => t.id === id);
  const wsOf = (/** @type {string | undefined} */ id) => snap().workspaces.find(w => w.id === id);
  const send = (/** @type {object} */ m) => app.send({ op: OP, ...m });

  // ---- The home's parts ----

  /** The + in the title: New terminal. */
  const addButton = () => (allowed() ? `<button class="add-btn" data-m="${M.new}" aria-label="New terminal">${PLUS}</button>` : '');

  /** @param {Place} p */
  const placeRow = p => `<button class="row" data-m="${M.place}" data-p="${esc(p.id)}">${badgeHtml(p)}<div class="r-text"><div class="r-name">${esc(p.name)}${p.production ? ' <span class="prod">prod</span>' : ''}</div>${p.description ? `<div class="r-line">${esc(p.description)}</div>` : ''}</div><span class="chev">›</span></button>`;

  /** The Remote section under the workspaces: WSL, SSH hosts, serial ports and the rest, as on the PC. */
  function remoteHtml() {
    if (!allowed()) return '';
    const list = places().filter(p => p.remote);
    const shown = showAll ? list : list.slice(0, REMOTE_SHOWN);
    return `<div class="section-row"><span class="section">Remote</span><button class="link" data-m="${M.host}">Add SSH host</button></div>
      ${list.length ? `<div class="list">${shown.map(placeRow).join('')}</div>` : '<p class="muted hint">No SSH hosts, WSL or serial ports on the PC yet.</p>'}
      ${list.length > REMOTE_SHOWN ? `<button class="link more-link" data-m="${M.all}">${showAll ? 'Show fewer' : `Show all ${list.length}`}</button>` : ''}`;
  }

  /**
   * A terminal's row, with what a swipe shows under it.
   * @param {Term} t
   * @param {string} row
   */
  const rowWrap = (t, row) => (allowed()
    ? `<div class="swipe${t.id === swiped ? ' open' : ''}" data-swipe="${esc(t.id)}"><div class="swipe-acts"><button data-m="${M.more}" data-id="${esc(t.id)}">More</button><button class="red" data-m="${M.close}" data-id="${esc(t.id)}">Close</button></div>${row}</div>`
    : row);

  // ---- Sheets ----

  /** @param {string} title @param {string} action @param {string} label */
  const head = (title, action, label) => `<div class="m-head"><button data-m="${M.cancel}">Cancel</button><h2>${esc(title)}</h2>${action ? `<button class="strong" data-m="${action}">${label}</button>` : '<span></span>'}</div>`;

  // ---- The New terminal page ----

  /** The place chosen (the first shell until one is ticked). */
  const chosenPlace = () => places().find(p => p.id === sheet?.profile) ?? places().find(p => !p.remote);
  /** The workspace it opens in (the PC's current one until another is picked). */
  const chosenWs = () => wsOf(sheet?.ws ?? snap().activeWs) ?? snap().workspaces[0];
  /** @param {string} to @param {string} label */
  const pageBack = (to, label) => `<button class="back-row" data-m="${to}">‹ ${label}</button>`;

  function newHtml() {
    const chosen = chosenPlace(), ws = chosenWs(), remote = places().filter(p => p.remote);
    const opt = (/** @type {Place} */ p) => `<button class="row opt${p.id === chosen?.id ? ' on' : ''}" data-m="${M.pick}" data-p="${esc(p.id)}">${badgeHtml(p)}
      <div class="r-text"><div class="r-name">${esc(p.name)}${p.production ? ' <span class="prod">prod</span>' : ''}</div>${p.remote && p.description ? `<div class="r-line">${esc(p.description)}</div>` : ''}</div>
      <span class="tick">${p.id === chosen?.id ? '✓' : ''}</span></button>`;
    return `<div class="page-head">${pageBack(M.cancel, 'Terminals')}<h1 class="page-title">New terminal</h1></div>
      <div class="section">Shell</div><div class="list">${places().filter(p => !p.remote).map(opt).join('')}</div>
      <div class="section-row"><span class="section">Remote</span><button class="link" data-m="${M.host}">Add SSH host</button></div>
      ${remote.length ? `<div class="list">${remote.map(opt).join('')}</div>` : '<p class="muted hint">No SSH hosts, WSL or serial ports on the PC yet.</p>'}
      <div class="section">Where</div><div class="list">
        <button class="row" data-m="${M.toWs}"><span class="r-text">Workspace</span><span class="more-value"><span class="dot" style="background:${esc(ws?.color)}"></span> ${esc(ws?.name)}</span><span class="chev">›</span></button>
        <button class="row" data-m="${M.toFolder}"><span class="r-text">Folder</span><span class="more-value">${esc(sheet?.cwd || 'Workspace folder')}</span><span class="chev">›</span></button></div>
      <div class="m-dock"><button class="btn primary" data-m="${M.openNew}"${chosen ? '' : ' disabled'}>Open ${esc(chosen?.name ?? '')}</button></div>`;
  }

  function newWsHtml() {
    const ws = chosenWs();
    return `<div class="page-head">${pageBack(M.toNew, 'New terminal')}<h1 class="page-title">Workspace</h1></div><div class="list">${snap().workspaces.map(w =>
      `<button class="row opt${w.id === ws?.id ? ' on' : ''}" data-m="${M.pickWs}" data-ws="${esc(w.id)}"><span class="dot" style="background:${esc(w.color)}"></span>
        <div class="r-text"><div class="r-name">${esc(w.name)}</div>${w.cwd ? `<div class="r-line">${esc(w.cwd)}</div>` : ''}</div><span class="tick">${w.id === ws?.id ? '✓' : ''}</span></button>`).join('')}</div>`;
  }

  const newFolderHtml = () => `<div class="page-head">${pageBack(M.toNew, 'New terminal')}<h1 class="page-title">Folder</h1></div>
    <div class="form"><label class="f-row"><span>Folder</span><input name="${FIELD.cwd}" value="${esc(sheet?.cwd ?? '')}" placeholder="${esc(chosenWs()?.cwd ?? 'The workspace folder')}" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="done"></label></div>
    <p class="hint muted">Empty: the workspace's own folder.</p>`;

  function hostHtml() {
    const field = (/** @type {string} */ name, /** @type {string} */ label, /** @type {string} */ hint, mode = '') =>
      `<label class="f-row"><span>${label}</span><input name="${name}" placeholder="${esc(hint)}" autocapitalize="off" autocorrect="off" spellcheck="false"${mode}></label>`;
    return `${head('New SSH host', M.saveHost, 'Save')}
      <div class="form">${field(FIELD.name, 'Name', 'build-box')}${field(FIELD.host, 'Host', '10.0.0.5 or host.example.com')}${field(FIELD.user, 'User', 'ssh decides')}${field(FIELD.port, 'Port', '22', ' inputmode="numeric"')}</div>
      <div class="section">Sign in with</div>
      <div class="seg" data-sign="${SIGN_IN.agent}">${SIGN.map(([id, label], i) => `<button class="${i ? '' : 'on'}" data-m="${M.sign}" data-v="${id}">${label}</button>`).join('')}</div>
      <div class="form key-file" hidden>${field(FIELD.keyPath, 'Key file', 'C:\\Users\\you\\.ssh\\id_ed25519')}</div>
      <p class="hint muted" data-sign-note>Your keys from ssh-agent, or the default ones in .ssh on the PC.</p>
      <div class="form">${field(FIELD.jump, 'Jump hosts', 'bastion')}${field(FIELD.tags, 'Tags', 'prod db')}</div>
      <p class="error" data-error>${esc(sheet?.error ?? '')}</p>`;
  }

  function moreHtml() {
    const t = term(sheet?.id);
    if (!t) return '';
    return `<div class="grabber"></div><div class="s-head">${badgeHtml(t)}<h2>${esc(t.title)}</h2></div>
      <button class="ibtn" data-m="${M.rename}" data-id="${esc(t.id)}">Rename</button>
      ${snap().workspaces.length > 1 ? `<button class="ibtn" data-m="${M.move}" data-id="${esc(t.id)}">Move to workspace</button>` : ''}
      <button class="ibtn red" data-m="${M.close}" data-id="${esc(t.id)}">Close terminal</button>
      <button class="ibtn" data-m="${M.cancel}">Cancel</button>`;
  }

  function renameHtml() {
    const t = term(sheet?.id);
    return `${head('Rename', M.renameNow, 'Save')}<div class="form"><label class="f-row"><span>Name</span><input name="${FIELD.name}" value="${esc(t?.title)}" maxlength="80" enterkeyhint="done"></label></div>
      <p class="hint muted">Empty: the shell's own name again.</p>`;
  }

  function moveHtml() {
    const t = term(sheet?.id);
    return `${head('Move to', '', '')}<div class="list">${snap().workspaces.filter(w => w.id !== t?.ws).map(w =>
      `<button class="row" data-m="${M.moveTo}" data-ws="${esc(w.id)}"><span class="dot" style="background:${esc(w.color)}"></span><div class="r-text"><div class="r-name">${esc(w.name)}</div></div></button>`).join('')}</div>`;
  }

  const confirmHtml = () => `<div class="grabber"></div><h2 class="c-title">${esc(sheet?.title)}</h2><p class="muted">${esc(sheet?.text)}</p>
    <button class="ibtn red" data-m="${M.go}">${esc(sheet?.title?.split(' ')[0] ?? 'OK')}</button><button class="ibtn" data-m="${M.cancel}">Cancel</button>`;

  const SHEETS = { [SHEET.new]: newHtml, [SHEET.newWs]: newWsHtml, [SHEET.newFolder]: newFolderHtml, [SHEET.host]: hostHtml, [SHEET.more]: moreHtml, [SHEET.rename]: renameHtml, [SHEET.move]: moveHtml, [SHEET.confirm]: confirmHtml };

  /**
   * A page, above the tab bar.
   * @param {Shown} shown
   */
  const pageHtml = shown => {
    const now = sheet;
    sheet = shown;
    const html = `<div class="m-page"><div class="m-in">${SHEETS[shown.kind]()}</div></div>`;
    sheet = now;
    return html;
  };

  /** Draws the sheet or page shown (or none); only on the phone's own steps, so what's typed in it stays. */
  function draw() {
    const tabbar = /** @type {HTMLElement | null} */ (document.querySelector('.tabbar'));
    layer.style.setProperty('--tabbar', `${tabbar?.offsetHeight ?? 0}px`);
    if (!sheet) layer.innerHTML = '';
    else if (PAGES.includes(sheet.kind)) layer.innerHTML = pageHtml(sheet);
    else layer.innerHTML = `${sheet.from ? pageHtml(sheet.from) : ''}<div class="dim" data-m="${M.cancel}"></div><div class="sheet m-sheet${sheet.kind === SHEET.host ? ' tall' : ''}">${SHEETS[sheet.kind]()}</div>`;
    const first = /** @type {HTMLInputElement | null} */ (layer.querySelector(`input[name=${FIELD.name}]`));
    if (sheet?.kind === SHEET.rename && first) first.select();
  }
  /** The page shown, for a sheet opened over it to go back to. */
  const page = () => (sheet && PAGES.includes(sheet.kind) ? sheet : sheet?.from);
  /** @param {typeof sheet} next */
  const open = next => { sheet = next; draw(); };

  /** @param {string} name */
  const value = name => /** @type {HTMLInputElement | null} */ (layer.querySelector(`[name=${name}]`))?.value.trim() ?? '';

  /** Back to New terminal from its Workspace or Folder page; the folder typed there stays. */
  function backToNew() {
    const cwd = sheet?.kind === SHEET.newFolder ? value(FIELD.cwd) : sheet?.cwd;
    open({ ...sheet, kind: SHEET.new, cwd });
  }

  /**
   * Asks first, then does it.
   * @param {string} title @param {string} text @param {() => void} then
   */
  const confirm = (title, text, then) => open({ kind: SHEET.confirm, title, text, then, from: page() });

  /** @param {Place | undefined} p @param {string | undefined} ws @param {string} cwd */
  function openOn(p, ws, cwd) {
    if (!p) return;
    const go = () => { send({ action: ACTION.open, profile: p.id, ws, cwd }); open(null); };
    if (p.production) confirm(`Open ${p.name}?`, 'It\'s tagged prod: what you type there runs on production.', go);
    else go();
  }

  /** @param {Term | undefined} t */
  function close(t) {
    if (!t) return;
    const go = () => { send({ action: ACTION.close, pane: t.id }); swiped = ''; open(null); };
    if (BUSY.includes(t.activity ?? '') || t.waiting) confirm(`Close ${t.title}?`, 'It\'s still busy. Closing ends it on the PC too.', go);
    else go();
  }

  /** @param {HTMLElement} target */
  function sign(target) {
    const seg = /** @type {HTMLElement} */ (target.parentElement);
    seg.dataset.sign = target.dataset.v;
    for (const b of seg.children) b.classList.toggle('on', b === target);
    /** @type {HTMLElement} */ (layer.querySelector('.key-file')).hidden = target.dataset.v !== SIGN_IN.key;
    /** @type {HTMLElement} */ (layer.querySelector('[data-sign-note]')).textContent = target.dataset.v === SIGN_IN.password
      ? 'The PC asks for the password the first time and keeps it; it never goes through the phone.'
      : target.dataset.v === SIGN_IN.key ? 'A key file on the PC.' : 'Your keys from ssh-agent, or the default ones in .ssh on the PC.';
  }

  function saveHost() {
    send({
      action: ACTION.addHost, name: value(FIELD.name), host: value(FIELD.host), user: value(FIELD.user), port: value(FIELD.port),
      identity: /** @type {HTMLElement} */ (layer.querySelector('[data-sign]')).dataset.sign, keyPath: value(FIELD.keyPath), jump: value(FIELD.jump), tags: value(FIELD.tags),
    });
  }

  /**
   * A tap on one of its buttons; false when it's not one.
   * @param {HTMLElement} el
   */
  function click(el) {
    const target = /** @type {HTMLElement | null} */ (el.closest('[data-m]'));
    if (!target) {
      // A tap anywhere closes a row swiped open, rather than opening what's under it.
      if (!swiped) return false;
      swiped = '';
      slideAll();
      return true;
    }
    const id = target.dataset.id;
    switch (target.dataset.m) {
      case M.new: open({ kind: SHEET.new }); break;
      case M.pick: open({ ...sheet, kind: SHEET.new, profile: target.dataset.p }); break;
      case M.toWs: open({ ...sheet, kind: SHEET.newWs }); break;
      case M.pickWs: open({ ...sheet, kind: SHEET.new, ws: target.dataset.ws }); break;
      case M.toFolder: open({ ...sheet, kind: SHEET.newFolder }); break;
      case M.toNew: backToNew(); break;
      case M.openNew: openOn(chosenPlace(), chosenWs()?.id, sheet?.cwd ?? ''); break;
      case M.place: openOn(places().find(p => p.id === target.dataset.p), snap().activeWs, ''); break;
      case M.all: showAll = !showAll; app.render(); break;
      case M.more: open({ kind: SHEET.more, id }); break;
      case M.close: close(term(id)); break;
      case M.rename: open({ kind: SHEET.rename, id }); break;
      case M.renameNow: send({ action: ACTION.rename, pane: sheet?.id, name: value(FIELD.name) }); open(null); break;
      case M.move: open({ kind: SHEET.move, id }); break;
      case M.moveTo: send({ action: ACTION.move, pane: sheet?.id, ws: target.dataset.ws }); open(null); break;
      case M.host: open({ kind: SHEET.host, from: page() }); break;
      case M.sign: sign(target); break;
      case M.saveHost: saveHost(); break;
      case M.go: sheet?.then?.(); break;
      case M.cancel: open(sheet?.from ?? null); break;
      default: return false;
    }
    return true;
  }

  /**
   * The PC's answer to something asked: an opened terminal is shown once listed; a saved host closes its sheet; a
   * failure is said in the sheet, or in a note.
   * @param {{ ok: boolean, op?: string, action?: string, id?: string, error?: string }} m
   * @returns {boolean} whether it was one of these
   */
  function answered(m) {
    if (m.op !== OP) return false;
    if (!m.ok) {
      const error = layer.querySelector('[data-error]');
      if (error) error.textContent = m.error ?? 'That didn\'t go through.';
      else app.toast(m.error ?? 'That didn\'t go through.');
    } else if (m.action === ACTION.open && m.id) {
      pending = m.id;
      changed();
    } else if (m.action === ACTION.addHost) {
      app.toast('Saved on the PC.');
      open(sheet?.from ?? null);
    }
    return true;
  }

  /** The PC's news came in: a terminal opened from here is shown once it's there. */
  function changed() {
    if (pending && term(pending)) {
      const id = pending;
      pending = '';
      app.openTerminal(id);
    }
  }

  // ---- Swiping a row ----

  function slideAll() {
    for (const el of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-swipe]'))) {
      el.classList.toggle('open', el.dataset.swipe === swiped);
      /** @type {HTMLElement} */ (el.lastElementChild).style.transform = '';
    }
  }

  /** @param {HTMLElement} home */
  function swipe(home) {
    /** @type {{ el: HTMLElement, x: number, y: number, dx: number, on: boolean | null } | null} */
    let drag = null;
    home.addEventListener(TOUCH.start, e => {
      const el = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-swipe]'));
      drag = el && e.touches.length === 1 ? { el, x: e.touches[0].clientX, y: e.touches[0].clientY, dx: 0, on: null } : null;
    }, { passive: true });
    home.addEventListener(TOUCH.move, e => {
      if (!drag) return;
      const dx = e.touches[0].clientX - drag.x, dy = e.touches[0].clientY - drag.y;
      if (drag.on === null && Math.hypot(dx, dy) > SWIPE.slop) drag.on = Math.abs(dx) > Math.abs(dy);
      if (!drag.on) return;
      e.preventDefault();
      const start = drag.el.dataset.swipe === swiped ? -SWIPE.open : 0;
      drag.dx = dx;
      /** @type {HTMLElement} */ (drag.el.lastElementChild).style.transform = `translateX(${Math.max(-SWIPE.open * 1.2, Math.min(0, start + dx))}px)`;
    }, { passive: false });
    home.addEventListener(TOUCH.end, e => {
      if (!drag?.on) { drag = null; return; }
      e.preventDefault(); // not a tap on the row
      const wasOpen = drag.el.dataset.swipe === swiped;
      const opened = wasOpen ? drag.dx < SWIPE.open / 2 : drag.dx < -SWIPE.open / 2;
      swiped = opened ? /** @type {string} */ (drag.el.dataset.swipe) : '';
      drag = null;
      slideAll();
    });
  }

  return { addButton, remoteHtml, rowWrap, click, answered, changed, swipe, get swiping() { return !!swiped; } };
}
