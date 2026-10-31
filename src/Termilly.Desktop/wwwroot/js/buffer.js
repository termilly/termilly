// @ts-check
// Reading a terminal's buffer (xterm.js's) as the lines a program printed, rather than the rows the screen shows.

import { platform, PLATFORM } from './host.js';

/** What waits on a password, a host key question or a passphrase rather than a command. */
const NOT_A_PROMPT = /pass(word|phrase)|yes\/no|verification code|otp|login:|\(y\/n\)/i;

/**
 * Whether the cursor sits after what looks like a shell's prompt (a line ending in $, #, % or >), not a password,
 * host key or passphrase question, nor a full-screen program. For shells that don't mark their prompt.
 * @param {any} term xterm
 */
export function atPrompt(term) {
  const buffer = term.buffer.active;
  if (buffer.type === 'alternate') return false;
  const line = (buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) ?? '').trimEnd();
  return /[$#%>]$/.test(line) && !NOT_A_PROMPT.test(line);
}

/**
 * The line that starts on buffer row `y`, with the rows it wrapped onto (up to row `end`) joined on, trimmed. Null
 * when row `y` isn't there or goes on a line that started above it.
 * @param {any} buffer xterm's buffer
 * @param {number} y
 * @param {number} end
 * @returns {string | null}
 */
export function lineFrom(buffer, y, end) {
  const line = buffer.getLine(y);
  if (!line || line.isWrapped) return null;
  let text = line.translateToString(true);
  for (let next = y + 1; next < end && buffer.getLine(next)?.isWrapped; next++) text += buffer.getLine(next).translateToString(true);
  return text;
}

/**
 * Whether buffer row y's line goes on in row y + 1. The terminal marks the rows it wrapped. On Windows, ConPTY
 * ends some programs' long lines (Git Bash's, for one) with a real line break at the edge instead, so there a row
 * filled to the last column with more text after it counts as wrapped too. A line exactly as wide as the terminal
 * (a ruler) would be joined to the next; that's rare in command output.
 * @param {any} buffer xterm's buffer
 * @param {number} y
 * @param {number} cols
 */
export function continuesOnNextRow(buffer, y, cols) {
  const next = buffer.getLine(y + 1);
  if (!next) return false;
  if (next.isWrapped) return true;
  if (platform !== PLATFORM.windows) return false;
  const last = buffer.getLine(y)?.getCell(cols - 1);
  const filled = !!last && (last.getWidth() === 0 || last.getChars().trim() !== '');
  return filled && next.translateToString(true).trim() !== '';
}
