// @ts-check
// A terminal's buffer written out as output that draws it again: its lines (the scrollback's latest ones too), their
// colours and styles, wrapped lines kept wrapped, the alternate screen and the cursor where they were. A phone that
// starts showing a terminal gets this (js/phone.js), then what the terminal prints from then on.

/** The lines written out at most, newest kept. */
const MAX_LINES = 1000;
const ESC = '\x1b';
/** SGR codes: the styles, in order, and where colours start (foreground, background). */
const STYLES = /** @type {const} */ ([['isBold', 1], ['isDim', 2], ['isItalic', 3], ['isUnderline', 4], ['isBlink', 5], ['isInverse', 7], ['isInvisible', 8], ['isStrikethrough', 9]]);
const COLOR = Object.freeze({ fg: 38, bg: 48, rgb: 2, palette: 5 });
const BYTE = 0xff;
const RED_SHIFT = 16;
const GREEN_SHIFT = 8;

/**
 * A colour's SGR parameters, or none for the default.
 * @param {number} base 38 or 48
 * @param {boolean} rgb
 * @param {boolean} palette
 * @param {number} value
 */
function color(base, rgb, palette, value) {
  if (rgb) return [`${base};${COLOR.rgb};${(value >> RED_SHIFT) & BYTE};${(value >> GREEN_SHIFT) & BYTE};${value & BYTE}`];
  return palette ? [`${base};${COLOR.palette};${value}`] : [];
}

/**
 * The SGR that gives a cell its look, starting from none.
 * @param {any} cell xterm's IBufferCell
 */
function sgr(cell) {
  const codes = ['0', ...STYLES.filter(([test]) => cell[test]()).map(([, code]) => String(code)),
    ...color(COLOR.fg, cell.isFgRGB(), cell.isFgPalette(), cell.getFgColor()),
    ...color(COLOR.bg, cell.isBgRGB(), cell.isBgPalette(), cell.getBgColor())];
  return `${ESC}[${codes.join(';')}m`;
}

/**
 * One buffer line: its cells up to the last one that shows something (all of them when the next line continues it).
 * @param {any} line xterm's IBufferLine
 * @param {any} cell a cell to read into
 * @param {boolean} continued
 * @param {{ look: string }} state the SGR in force
 */
function lineText(line, cell, continued, state) {
  let end = line.length;
  while (!continued && end > 0 && !line.getCell(end - 1, cell).getChars() && cell.isBgDefault()) end--;
  let out = '';
  for (let x = 0; x < end; x++) {
    line.getCell(x, cell);
    if (cell.getWidth() === 0) continue; // the second half of a wide character
    const look = sgr(cell);
    if (look !== state.look) out += look;
    state.look = look;
    out += cell.getChars() || ' ';
  }
  return out;
}

/**
 * The terminal's buffer as output: written into a terminal of the same size, it draws the same.
 * @param {any} term xterm
 */
export function screenOf(term) {
  const buffer = term.buffer.active;
  const cell = buffer.getNullCell();
  const state = { look: '' };
  const from = Math.max(0, buffer.length - MAX_LINES);
  let out = buffer.type === 'alternate' ? `${ESC}[?1049h${ESC}[H` : '';
  if (term.modes.applicationCursorKeysMode) out += `${ESC}[?1h`;
  for (let y = from; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    if (y > from && !line.isWrapped) out += '\r\n';
    out += lineText(line, cell, !!buffer.getLine(y + 1)?.isWrapped, state);
  }
  return `${out}${ESC}[0m${ESC}[${buffer.cursorY + 1};${buffer.cursorX + 1}H`;
}
