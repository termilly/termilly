// @ts-check
// The terminal view's Smart Clip sheet (its key bar's clips, or Paste from Smart Clip in Claude's +): the PC's text
// clips, pinned first, each as its first line (a secret's masked). A tap asks the PC to paste that clip into the
// terminal; its whole text stays on the PC (Features/Phone.cs, js/smartclip.js).

import { SHEET_CLASS } from './snippets.js';

/** @typedef {{ id: string, kind: string, text: string, lines: number, pinned: boolean }} PhoneClip */

/** What each kind is called under its line. */
const KIND = Object.freeze({ text: 'Text', command: 'Command', path: 'Path', url: 'Link', secret: 'Secret' });
const PINNED = 'Pinned';

/** @param {unknown} text */
const esc = text => String(text ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

/** @param {PhoneClip} c */
const metaOf = c => [/** @type {Record<string, string>} */ (KIND)[c.kind] ?? KIND.text, c.lines > 1 ? `${c.lines} lines` : '', c.pinned ? PINNED : '']
  .filter(Boolean).join(' · ');

/**
 * The Smart Clip sheet, over the terminal view.
 * @param {HTMLElement} view
 * @param {{ list: () => PhoneClip[], paste: (id: string) => void }} terminal
 */
export function clipSheet(view, terminal) {
  const sheet = document.createElement('div');
  sheet.className = SHEET_CLASS;
  sheet.hidden = true;

  const close = () => { sheet.hidden = true; };

  function listHtml() {
    const shown = terminal.list();
    return `<div class="tv-sheet-head"><b>Smart Clip</b><button class="tv-sheet-close" data-clip-close aria-label="Close">✕</button></div>`
      + (shown.length ? `<div class="tv-sheet-list">${shown.map(c => `<button class="snip clip-${esc(c.kind)}" data-clip="${esc(c.id)}"><b>${esc(c.text)}</b>
          <span>${esc(metaOf(c))}</span></button>`).join('')}</div>`
        : '<p class="muted">Nothing to paste yet. What you copy on the PC shows here (text and links).</p>');
  }

  sheet.addEventListener('click', e => {
    const target = /** @type {HTMLElement} */ (e.target);
    if (target.closest('[data-clip-close]')) return close();
    const id = target.closest('[data-clip]')?.getAttribute('data-clip');
    if (!id) return;
    close();
    terminal.paste(id);
  });

  return {
    element: sheet,
    open() {
      sheet.innerHTML = listHtml();
      sheet.hidden = false;
    },
    close,
  };
}
