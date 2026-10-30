// @ts-check
// The chat view of a terminal that runs Claude Code: the conversation as Claude Code writes it down (PhoneChat.cs),
// its own stream, so it wraps to the phone's width whatever the PC's terminal is. What you asked, what Claude said
// (code blocks, `code` and **bold** kept), a line per tool it ran; and a box to message Claude, when typing is allowed.

/** Who said it (ChatTranscript.Roles). */
const ROLE = Object.freeze({ you: 'you', claude: 'claude', tool: 'tool' });
/** Within this of the bottom, new messages keep the view at the bottom (px). */
const STICK = 80;
/** A message to Claude goes in, then Enter after this, as the PC's own send does (api.js). */
const ENTER_AFTER_MS = 200;
/** Text with lines in it goes in as a paste, so a new line isn't Enter. */
const PASTE = Object.freeze({ start: '\x1b[200~', end: '\x1b[201~' });
const FENCE = '```';

/** @param {unknown} text */
const esc = text => String(text ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

/** `code` and **bold** in a part of Claude's text that's not a code block (already escaped). */
const inline = (/** @type {string} */ html) => html
  .replace(/`([^`\n]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');

/** Claude's text: code blocks as blocks, the rest as paragraphs. */
const prose = (/** @type {string} */ text) => text.split(FENCE)
  .map((part, i) => i % 2 ? `<pre>${esc(part.replace(/^[^\n]*\n/, ''))}</pre>` : inline(esc(part.trim())))
  .filter(Boolean).join('');

/** @param {{ role: string, text: string }} e */
function entry(e) {
  if (e.role === ROLE.tool) {
    const gap = e.text.indexOf('  ');
    return gap < 0 ? `<div class="msg tool"><b>${esc(e.text)}</b></div>`
      : `<div class="msg tool"><b>${esc(e.text.slice(0, gap))}</b> ${esc(e.text.slice(gap + 2))}</div>`;
  }
  return e.role === ROLE.you ? `<div class="msg you">${esc(e.text)}</div>` : `<div class="msg claude">${prose(e.text)}</div>`;
}

/**
 * The chat view, and its box to message Claude.
 * @param {{ type: (data: string) => boolean }} terminal Types into the terminal (false when it didn't: typing is off,
 *   or a production terminal wasn't confirmed).
 */
export function chatView(terminal) {
  const list = document.createElement('div');
  list.className = 'chat';
  list.innerHTML = '<p class="chat-empty">The conversation shows here once Claude has been asked something.</p>';

  /**
   * New messages, or all of them (reset).
   * @param {{ role: string, text: string }[]} entries
   * @param {boolean} reset
   */
  function add(entries, reset) {
    const atBottom = reset || list.scrollHeight - list.scrollTop - list.clientHeight < STICK;
    if (reset) list.innerHTML = entries.length ? '' : list.innerHTML;
    if (entries.length) list.querySelector('.chat-empty')?.remove();
    list.insertAdjacentHTML('beforeend', entries.map(entry).join(''));
    if (atBottom) list.scrollTop = list.scrollHeight;
  }

  /** @param {boolean} typing */
  const compose = typing => typing
    ? '<form class="tv-foot chat-compose"><textarea rows="1" placeholder="Message Claude" enterkeyhint="send"></textarea><button class="btn primary">Send</button></form>'
    : '<p class="tv-foot tv-note">Typing from the phone is off: Settings › Phone › Allow typing, on the PC.</p>';

  /** Sends what's in the box: in, then Enter. */
  function submit(/** @type {HTMLFormElement} */ form) {
    const box = /** @type {HTMLTextAreaElement} */ (form.querySelector('textarea'));
    const text = box.value.trim();
    if (!text || !terminal.type(text.includes('\n') ? PASTE.start + text + PASTE.end : text)) return;
    box.value = '';
    setTimeout(() => terminal.type('\r'), ENTER_AFTER_MS);
  }

  return { list, add, compose, submit };
}
