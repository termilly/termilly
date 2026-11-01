// @ts-check
// The terminal view's Smart Clip sheet: the PC's text clips, pinned first, each as its first line (a secret's masked).
// From the key bar's clips a tap asks the PC to paste the clip into the terminal, its whole text staying on the PC;
// from Paste from Smart Clip in Claude's + the clip's text comes to the message box, to edit or copy (never a
// secret's). Phone/PhoneClips.cs answers both.

import { SHEET_CLASS } from './snippets.js';

/** @typedef {{ id: string, kind: string, text: string, lines: number, pinned: boolean }} PhoneClip */

/** What each kind is called under its line. */
const KIND = Object.freeze({ text: 'Text', command: 'Command', path: 'Path', url: 'Link', secret: 'Secret' });
const PINNED = 'Pinned';
const SECRET = 'secret';

/** @param {unknown} text */
const esc = text => String(text ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

/** @param {PhoneClip} c */
const metaOf = c => [/** @type {Record<string, string>} */ (KIND)[c.kind] ?? KIND.text, c.lines > 1 ? `${c.lines} lines` : '', c.pinned ? PINNED : '']
  .filter(Boolean).join(' · ');

/**
 * The Smart Clip sheet, over the terminal view.
 * @param {HTMLElement} view
 * @param {{ list: () => PhoneClip[], paste: (id: string) => void, fill: (id: string) => void }} terminal
 */
export function clipSheet(view, terminal) {
  const sheet = document.createElement('div');
  sheet.className = SHEET_CLASS;
  sheet.hidden = true;
  /** Whether a pick fills the message box rather than the terminal. */
  let intoBox = false;

  const close = () => { sheet.hidden = true; };

  function listHtml() {
    const shown = terminal.list();
    return `<div class="tv-sheet-head"><b>Smart Clip</b><button class="tv-sheet-close" data-clip-close aria-label="Close">✕</button></div>`
      + (shown.length ? `<div class="tv-sheet-list">${shown.map(c => {
        const kept = intoBox && c.kind === SECRET;
        return `<button class="snip clip-${esc(c.kind)}" data-clip="${esc(c.id)}"${kept ? ' disabled' : ''}><b>${esc(c.text)}</b>
          <span>${esc(kept ? `${metaOf(c)} · stays on the PC` : metaOf(c))}</span></button>`;
      }).join('')}</div>`
        : '<p class="muted">Nothing to paste yet. What you copy on the PC shows here (text and links).</p>');
  }

  sheet.addEventListener('click', e => {
    const target = /** @type {HTMLElement} */ (e.target);
    if (target.closest('[data-clip-close]')) return close();
    const id = target.closest('[data-clip]')?.getAttribute('data-clip');
    if (!id) return;
    close();
    if (intoBox) terminal.fill(id);
    else terminal.paste(id);
  });

  return {
    element: sheet,
    /** @param {boolean} [box] fill the message box (Claude's +) rather than paste into the terminal */
    open(box = false) {
      intoBox = box;
      sheet.innerHTML = listHtml();
      sheet.hidden = false;
    },
    close,
  };
}
