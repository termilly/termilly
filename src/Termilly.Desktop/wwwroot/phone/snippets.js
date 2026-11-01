// @ts-check
// The terminal view's snippets (its key bar's snip): the PC's saved commands (js/phone.js sends them while typing from
// the phone is allowed), the global ones and the terminal's workspace's. One with {{placeholders}} asks for their
// values first; then the command is typed, with Enter unless the snippet says not to.

/** A sheet over the terminal view (Clipboard's too, clips.js). */
export const SHEET_CLASS = 'tv-sheet';

/** {{name}} or {{name=default}} in a snippet's command (as js/snippets.js reads them). */
const PLACEHOLDER = /\{\{\s*([A-Za-z_][\w.-]*)\s*(?:=([^}]*))?\}\}/g;

/** @typedef {{ ws: string | null, name: string, description: string, command: string, enter: boolean, fields: { name: string, def: string }[] }} PhoneSnippet */

/**
 * Text as typed: each line ends with Enter. A bare new line is Ctrl+Enter to PowerShell's PSReadLine, which opens a
 * line above, so the lines would run in reverse (as the PC's own sendSnippet says, js/snippets.js).
 * @param {string} text
 */
export const asTyped = text => text.replace(/\r?\n/g, '\r');

/** @param {unknown} text */
const esc = text => String(text ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

/**
 * The command with the values typed for its placeholders (an empty one takes the default).
 * @param {string} command
 * @param {Record<string, string>} values
 */
const fill = (command, values) => command.replace(PLACEHOLDER, (_, name, def) => values[name] || def || '');

/**
 * The snippet sheet, over the terminal view.
 * @param {HTMLElement} view
 * @param {{ list: () => PhoneSnippet[], type: (text: string) => void }} terminal
 */
export function snippetSheet(view, terminal) {
  const sheet = document.createElement('div');
  sheet.className = SHEET_CLASS;
  sheet.hidden = true;
  /** @type {PhoneSnippet[]} */
  let shown = [];

  const close = () => { sheet.hidden = true; };

  function listHtml() {
    shown = terminal.list();
    return `<div class="tv-sheet-head"><b>Snippets</b><button class="tv-sheet-close" data-snip-close aria-label="Close">✕</button></div>`
      + (shown.length ? `<div class="tv-sheet-list">${shown.map((s, i) => `<button class="snip" data-snip="${i}"><b>${esc(s.name)}</b>
          <span>${esc(s.description || s.command)}</span></button>`).join('')}</div>`
        : '<p class="muted">No snippets yet. Add them on the PC, in its Snippets window.</p>');
  }

  /** @param {PhoneSnippet} s */
  function formHtml(s) {
    return `<div class="tv-sheet-head"><b>${esc(s.name)}</b><button class="tv-sheet-close" data-snip-close aria-label="Close">✕</button></div>
      <form class="snip-form" data-snip-run>${s.fields.map(f => `<label>${esc(f.name)}<input name="${esc(f.name)}" value="${esc(f.def)}" autocapitalize="off" autocomplete="off" spellcheck="false"></label>`).join('')}
      <p class="mono snip-preview">${esc(s.command)}</p><button class="button" type="submit">Run</button></form>`;
  }

  /** @param {PhoneSnippet} s @param {Record<string, string>} values */
  function run(s, values) {
    close();
    terminal.type(asTyped(fill(s.command, values)) + (s.enter ? '\r' : ''));
  }

  sheet.addEventListener('click', e => {
    const target = /** @type {HTMLElement} */ (e.target);
    if (target.closest('[data-snip-close]')) return close();
    const pick = target.closest('[data-snip]')?.getAttribute('data-snip');
    const s = pick === null || pick === undefined ? null : shown[Number(pick)];
    if (!s) return;
    if (!s.fields.length) return run(s, {});
    sheet.innerHTML = formHtml(s);
    /** @type {HTMLInputElement | null} */ (sheet.querySelector('input'))?.focus();
    /** @type {HTMLFormElement} */ (sheet.querySelector('form')).onsubmit = ev => {
      ev.preventDefault();
      run(s, Object.fromEntries(new FormData(/** @type {HTMLFormElement} */ (ev.target)).entries().map(([k, v]) => [k, String(v)])));
    };
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
