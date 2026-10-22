// @ts-check
// The guided tour (starts once after the first start, where its first card offers Start or Skip; again from the
// palette or Settings › About): a card next to each thing worth knowing, with the thing itself lit up. Steps that ask you to try something notice when you have
// ("✓ That's it"), but Next is always yours to press. Nothing is blocked: you can click and type as usual meanwhile.

import { state, GROUPS } from './store.js';
import { platform, PLATFORM } from './host.js';
import { closeAll, anyOpen } from './popups.js';
import { focusedTab, restoreFocus } from './panes.js';
import { escapeHtml, keysHtml } from './ui.js';
import { updateSettings } from './preferences.js';
import { find, targetOf } from './dom.js';
import { SECOND_MS } from './util.js';

/**
 * Where the card sits: on a side of its target, in the middle of the window (no target), or inside a target too
 * big to sit beside.
 */
const SIDE = Object.freeze({
  below: 'below', above: 'above', right: 'right', left: 'left', center: 'center', inside: 'inside',
});
/** The card's buttons, by their data-tour. */
const ACTION = Object.freeze({ next: 'next', back: 'back', skip: 'skip' });
/** The light's class once a step was tried: what you opened is no longer dimmed. */
const TRIED = 'tried';
/** The follow loop's record of a step without a target. */
const NO_TARGET = 'none';
/** How often the card and light follow their target, which moves (menus open, panes split, the window resizes). */
const FOLLOW_MS = 150;
/** How close the card may come to the window's edges. */
const EDGE_PX = 8;
/** How far the card keeps from an open menu, or past the end of its target, when it slides beside one. */
const CLEARANCE_PX = 8;
/** How far the card sits from its target (before the lit area's padding). */
const GAP_PX = 14;
/** How far in from a too-big target's corner the card sits. */
const INSIDE_PX = 16;
/** Closer than this to the card's ends, the arrow would point past its corner: it's hidden. */
const ARROW_END_PX = 12;
/** The arrow stays at least this far from the card's ends. */
const ARROW_INSET_PX = 18;

/**
 * A rectangle on the screen, as getBoundingClientRect gives (or two of them joined).
 * @typedef {{ left: number, top: number, right: number, bottom: number }} Box
 */

/**
 * A step of the tour: its card's title and text, and optionally the element it points at (with `extra` lit too),
 * which side the card goes, something to try with the check that it happened, and a line of shortcuts.
 * @typedef {{ title: string, text: string, target?: string, side?: string, pad?: number, extra?: string,
 *   try?: string, done?: () => boolean, hint?: string }} TourStep
 */

/** @param {string} selector */
const visible = selector => {
  const el = document.querySelector(selector);
  if (!el || el.closest('[hidden]')) return null;
  const r = el.getBoundingClientRect();
  return r.width && r.height ? el : null;
};
const shown = (/** @type {string} */ selector) => !!visible(selector);

/**
 * Each step: where (a selector, or null for a card in the middle), what it is, and optionally something to try with
 * a check that it happened. `pad` widens the lit area.
 * @type {TourStep[]}
 */
const STEPS = [
  {
    title: 'Welcome to Termilly',
    text: 'A two-minute tour of what you’ll use every day. Each card points at the real thing - try it as you go, then press <b>Next</b>. Leave any time with <b>Skip</b>; the tour is in the command palette if you want it back.',
  },
  {
    target: '#ws-list', side: SIDE.right,
    title: 'Workspaces',
    text: 'One workspace per project or task, each with its own terminals and layout. Click one to switch; right-click for rename, colour, export as a layout file, or moving its terminals to tabs.',
    hint: `Switch with ${keysHtml('Ctrl Alt 1–9')} · show or hide this sidebar with ${keysHtml('Ctrl Shift B')}`,
  },
  {
    target: '#ws-add', side: SIDE.right, pad: 4,
    title: 'Make a workspace',
    text: 'Pick a name, a colour and a start folder. If the folder has a <code>.termilly.yml</code>, Termilly offers to open its whole layout.',
    try: 'Click + to see the dialog (Cancel is fine).',
    done: () => shown('.dialog.new-workspace'),
  },
  {
    target: '.ws-layer.active .pane.focused .pane-body', side: SIDE.left,
    title: 'Your terminal',
    text: `${platform === PLATFORM.linux ? 'bash, zsh, PowerShell' : 'PowerShell, cmd, Git Bash, WSL'} or SSH. After each command a green or red bar marks how it ended (hover it for the exit code and time). A spinner next to the title means it’s still running.`,
    try: 'Click in and run <code>Start-Sleep 2</code>.',
    done: () => !!focusedTab()?.lastCommand,
    hint: `Jump between prompts with ${keysHtml('Ctrl Shift ↑')} ${keysHtml('↓')} · hints for links and paths ${keysHtml('Ctrl Shift E')}`,
  },
  {
    target: '.ws-layer.active .pane.focused .pane-header', side: SIDE.below,
    title: 'The terminal’s menu',
    text: 'Right-click a terminal’s title bar for everything about it: rename, tags (a <code>prod</code> tag warns before broadcasting), “Alert me when it finishes”, copy the last command’s output, broadcast input, and for SSH terminals the file browser.',
    try: 'Right-click this title bar.',
    done: () => anyOpen(),
  },
  {
    target: '#new-button', side: SIDE.below, pad: 4,
    title: 'Open terminals',
    text: 'Every shell Termilly found, your SSH hosts and connections, serial ports, and containers and pods when Docker or kubectl is there. “New agent in worktree” starts Claude Code on its own git branch.',
    try: 'Click + to open the list.',
    done: () => shown('#profile-menu'),
    hint: `New terminal ${keysHtml('Ctrl Shift T')} · shell number n ${keysHtml('Ctrl Shift 1–9')}`,
  },
  {
    target: '.toolbar [data-command="splitRight"]', side: SIDE.below, pad: 4,
    extra: '.toolbar [data-command="splitDown"]',
    title: 'Split',
    text: 'Put terminals side by side or one above the other. Drag a title bar to move a terminal anywhere - onto another, or onto a workspace in the sidebar.',
    hint: `${keysHtml('Alt Shift =')} right · ${keysHtml('Alt Shift -')} down · move focus ${keysHtml('Alt ←↑→↓')}`,
  },
  {
    target: '#search-button', side: SIDE.below,
    title: 'Search everything',
    text: 'One box for open terminals, closed ones (with their output), workspaces and every command Termilly has. Filters narrow it: <code>failed</code>, <code>in:folder</code>, <code>tag:prod</code>.',
    try: `Open it with a click or ${keysHtml('Ctrl Shift F')}, then Esc.`,
    done: () => shown('#palette-layer'),
    hint: `Go to a workspace, folder or SSH host ${keysHtml('Ctrl Shift O')} · commands you ran ${keysHtml('Ctrl Shift H')}`,
  },
  {
    target: '#inbox-button', side: SIDE.below, pad: 4,
    title: 'Notification center',
    text: `When Claude Code (or a build) waits for you, errors or finishes while you’re elsewhere, its terminal gets a ring and lands here. ${platform === PLATFORM.linux ? 'The desktop' : 'Windows'} notifies you too when Termilly isn’t in front.`,
    try: 'Open the notification center.',
    done: () => shown('#inbox'),
    hint: `${keysHtml('Ctrl Shift A')} opens it · ${keysHtml('Ctrl Shift J')} jumps to the next one`,
  },
  {
    target: '#settings-button', side: SIDE.below, pad: 4,
    title: 'Settings',
    text: 'Fonts and theme, SSH connections and port forwards, triggers, the drop-down window, keeping shells running after you close Termilly, history sync, plugins - and phone check-in, off until you turn it on.',
    hint: `${keysHtml('Ctrl ,')} · every shortcut is in Settings › Keyboard`,
  },
  {
    title: 'You’re set',
    text: `That’s the tour. A few more to remember: ${keysHtml('Ctrl Shift `')} a floating scratch terminal and ${keysHtml('Ctrl Shift I')} type into every terminal of the workspace. Run the tour again from the palette: “Take the tour”.`,
  },
];

let index = -1;
/** @type {HTMLElement | null} */
let card = null;
/** @type {HTMLElement | null} */
let light = null;
/** @type {number | null} */
let timer = null;
let lastBox = '';

export const tourActive = () => index >= 0;

export function startTour() {
  stopTour(false);
  closeAll();
  index = 0;
  light = document.createElement('div');
  light.className = 'tour-light';
  card = document.createElement('section');
  card.className = 'tour-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-live', 'polite');
  document.body.append(light, card);
  card.addEventListener('click', onClick);
  card.addEventListener('keydown', onKey);
  timer = setInterval(follow, FOLLOW_MS);
  render();
}

/** Ends the tour; it counts as seen either way, so it isn't offered again. */
export function stopTour(markSeen = true) {
  clearInterval(/** @type {number | undefined} */ (timer));
  card?.remove();
  light?.remove();
  card = light = null;
  if (index >= 0 && markSeen) markTourSeen();
  index = -1;
  restoreFocus();
}

function markTourSeen() {
  if (state.settings.uiState.tourSeen) return;
  updateSettings(GROUPS.uiState, { tourSeen: true });
}

/** @param {number} to */
function go(to) {
  if (to < 0) return;
  if (to >= STEPS.length) return stopTour();
  closeAll(); // a menu opened while trying the last step would cover the next one
  index = to;
  render();
}

/** Only while the tour runs, so with its card and light. */
function render() {
  const step = STEPS[index];
  const last = index === STEPS.length - 1;
  /** @type {HTMLElement} */ (card).dataset.done = String(false);
  /** @type {HTMLElement} */ (light).classList.remove(TRIED);
  /** @type {HTMLElement} */ (card).innerHTML = `
    <div class="tour-top"><span class="tour-count">${index + 1} of ${STEPS.length}</span>
      <button class="tour-skip" data-tour="${ACTION.skip}">${last ? 'Close' : 'Skip tour'}</button></div>
    <h3>${escapeHtml(step.title)}</h3>
    <p>${step.text}</p>
    ${step.try ? `<p class="tour-try"><span class="tour-try-mark"></span><span class="tour-try-text">${step.try}</span></p>` : ''}
    ${step.hint ? `<p class="tour-hint">${step.hint}</p>` : ''}
    <div class="tour-actions">
      ${index > 0 ? `<button class="btn" data-tour="${ACTION.back}">Back</button>` : ''}
      <button class="btn primary" data-tour="${ACTION.next}">${last ? 'Finish' : index === 0 ? 'Start' : 'Next'}</button>
    </div>`;
  lastBox = '';
  follow();
  find(/** @type {HTMLElement} */ (card), `[data-tour="${ACTION.next}"]`).focus({ preventScroll: true });
}

/** Keeps the light on the target and the card next to it, and notices a tried step. */
function follow() {
  if (!card) return;
  const step = STEPS[index];
  const el = step.target ? visible(step.target) : null;
  if (step.done && card.dataset.done !== String(true) && step.done()) {
    card.dataset.done = String(true);
    const text = card.querySelector('.tour-try-text');
    if (text) text.innerHTML = 'That’s it. Press <b>Next</b> when you’re ready.';
    /** @type {HTMLElement} */ (light).classList.add(TRIED); // what you opened is no longer dimmed
  }
  /** @type {Box | undefined} */
  let rect = el?.getBoundingClientRect();
  const extra = step.extra && visible(step.extra)?.getBoundingClientRect();
  if (rect && extra) {
    rect = { left: Math.min(rect.left, extra.left), top: Math.min(rect.top, extra.top), right: Math.max(rect.right, extra.right), bottom: Math.max(rect.bottom, extra.bottom) };
  }
  const avoid = openPopovers();
  const box = [rect ? `${rect.left},${rect.top},${rect.right},${rect.bottom}` : NO_TARGET,
    ...avoid.map(a => `${a.left},${a.top},${a.right},${a.bottom}`)].join('|');
  if (box === lastBox) return;
  lastBox = box;
  if (!rect) {
    /** @type {HTMLElement} */ (light).hidden = true;
    card.dataset.side = SIDE.center;
    card.style.left = `${Math.round((innerWidth - card.offsetWidth) / 2)}px`;
    card.style.top = `${Math.round((innerHeight - card.offsetHeight) / 2.4)}px`;
    return;
  }
  const pad = step.pad ?? 2;
  /** @type {HTMLElement} */ (light).hidden = false;
  Object.assign(/** @type {HTMLElement} */ (light).style, {
    left: `${rect.left - pad}px`, top: `${rect.top - pad}px`,
    width: `${rect.right - rect.left + pad * 2}px`, height: `${rect.bottom - rect.top + pad * 2}px`,
  });
  place(rect, step.side ?? SIDE.below, pad, avoid);
}

/** Open menus, popovers, the palette and dialogs: the card keeps clear of them, so what you opened stays readable. */
const OPENED = '.popover:not([hidden]), .palette-layer:not([hidden]) .palette, .settings-layer:not([hidden]) .settings, .modal-layer .dialog';
const openPopovers = () => [...document.querySelectorAll(OPENED)]
  .filter(el => !el.contains(card)).map(el => el.getBoundingClientRect()).filter(r => r.width && r.height);

/**
 * @param {Box} a
 * @param {Box} b
 */
const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

/**
 * Puts the card next to the target: on the asked side if it fits, else another, sliding along that side; a spot
 * that covers an open menu or the target is used only when there's no other.
 * @param {Box} r
 * @param {string} side
 * @param {number} pad
 * @param {DOMRect[]} avoid
 */
function place(r, side, pad, avoid) {
  const w = /** @type {HTMLElement} */ (card).offsetWidth;
  const h = /** @type {HTMLElement} */ (card).offsetHeight;
  const gap = GAP_PX + pad;
  /** @type {Record<string, string>} */
  const opposite = { below: SIDE.above, above: SIDE.below, right: SIDE.left, left: SIDE.right };
  const sides = [side, opposite[side],
    ...[SIDE.below, SIDE.right, SIDE.left, SIDE.above].filter(s => s !== side && s !== opposite[side])];
  /** @type {Array<{ side: string, left: number, top: number, covers: number }>} */
  const candidates = [];
  for (const s of sides) {
    const fits = s === SIDE.below ? r.bottom + gap + h < innerHeight - EDGE_PX
      : s === SIDE.above ? r.top - gap - h > EDGE_PX
        : s === SIDE.right ? r.right + gap + w < innerWidth - EDGE_PX
          : r.left - gap - w > EDGE_PX;
    if (!fits) continue;
    const across = s === SIDE.below || s === SIDE.above;
    // Centred on the target first, then lined up with either end of it, then just beside an open menu.
    const slides = across
      ? [(r.left + r.right) / 2 - w / 2, r.left, r.right - w, r.right + CLEARANCE_PX, r.left - w - CLEARANCE_PX,
        ...avoid.flatMap(m => [m.left - w - CLEARANCE_PX, m.right + CLEARANCE_PX])]
      : [(r.top + r.bottom) / 2 - h / 2, r.top, r.bottom - h,
        ...avoid.flatMap(m => [m.top - h - CLEARANCE_PX, m.bottom + CLEARANCE_PX])];
    for (const slide of slides) {
      const left = Math.max(EDGE_PX,
        Math.min(across ? slide : s === SIDE.right ? r.right + gap : r.left - gap - w, innerWidth - w - EDGE_PX));
      const top = Math.max(EDGE_PX,
        Math.min(across ? (s === SIDE.below ? r.bottom + gap : r.top - gap - h) : slide, innerHeight - h - EDGE_PX));
      const box = { left, top, right: left + w, bottom: top + h };
      candidates.push({ side: s, left, top, covers: avoid.reduce((sum, a) => sum + overlap(box, a), 0) + overlap(box, r) });
    }
  }
  // A target bigger than the screen allows (a whole terminal): the card sits in its corner.
  const inside = {
    side: SIDE.inside, left: Math.max(EDGE_PX, r.right - w - INSIDE_PX), top: Math.max(EDGE_PX, r.top + INSIDE_PX),
  };
  // The first spot that covers nothing; else the one covering least (a big palette leaves no clear spot).
  const best = candidates.find(c => c.covers === 0) ?? candidates.sort((a, b) => a.covers - b.covers)[0] ?? inside;
  /** @type {HTMLElement} */ (card).style.left = `${Math.round(best.left)}px`;
  /** @type {HTMLElement} */ (card).style.top = `${Math.round(best.top)}px`;
  /** @type {HTMLElement} */ (card).dataset.side = best.side;
  pointArrow(best, r, w, h);
}

/**
 * Points the card's arrow at the target's middle, wherever along the side the card ended up.
 * @param {{ side: string, left: number, top: number }} at where the card is
 * @param {Box} r the target
 * @param {number} w the card's width
 * @param {number} h the card's height
 */
function pointArrow(at, r, w, h) {
  const across = at.side === SIDE.below || at.side === SIDE.above;
  const middle = across ? (r.left + r.right) / 2 - at.left : (r.top + r.bottom) / 2 - at.top;
  const length = across ? w : h;
  /** @type {HTMLElement} */ (card).style
    .setProperty('--arrow', `${Math.round(Math.max(ARROW_INSET_PX, Math.min(middle, length - ARROW_INSET_PX)))}px`);
  // Slid past the target entirely: an arrow would point at nothing.
  /** @type {HTMLElement} */ (card).classList
    .toggle('no-arrow', middle < ARROW_END_PX || middle > length - ARROW_END_PX);
}

/** @param {MouseEvent} e */
function onClick(e) {
  const action = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-tour]'))?.dataset.tour;
  if (action === ACTION.next) go(index + 1);
  else if (action === ACTION.back) go(index - 1);
  else if (action === ACTION.skip) stopTour();
}

/** @param {KeyboardEvent} e */
function onKey(e) {
  // Only while the card has focus: the terminal and app keep their keys.
  if (e.key === 'Escape') stopTour();
  else if (e.key === 'ArrowRight') go(index + 1);
  else if (e.key === 'ArrowLeft') go(index - 1);
  else return;
  e.preventDefault();
  e.stopPropagation();
}

addEventListener('resize', () => { lastBox = ''; follow(); });

/**
 * After the first start: once nothing else has been on screen for a couple of seconds (the recovery-code dialog,
 * a restore prompt), starts the tour at its welcome card, which offers Start or Skip. Either marks it seen.
 */
export function offerTourOnce() {
  if (state.settings.uiState.tourSeen) return;
  let quiet = 0;
  const waitForQuiet = setInterval(() => {
    if (state.settings.uiState.tourSeen || tourActive()) return clearInterval(waitForQuiet);
    const busy = document.querySelector('.modal-layer:not([hidden]), .dialog') || !document.querySelector('.ws-layer.active .pane');
    quiet = busy ? 0 : quiet + 1;
    if (quiet < 2) return;
    clearInterval(waitForQuiet);
    startTour();
  }, SECOND_MS);
}
