// @ts-check
// A terminal's line written out again as the output that draws it: each cell's character with its colours and style.
// A cell nothing was written in goes out as a space, not as a cursor move: under ConPTY spaces are often such cells,
// and a move right after a full row doesn't wrap as a printed character does, so a wrapped line lost its first letters.
// xterm's cells don't say an underline's kind or colour, or a link (OSC 8): those come back as a plain underline and
// text (Termilly still finds the addresses and paths in it).

/** SGR parameters: plain, the styles, and how a colour is given. */
const SGR = Object.freeze({
  plain: 0, bold: 1, dim: 2, italic: 3, underline: 4, blink: 5, inverse: 7, invisible: 8, strikethrough: 9, overline: 53,
  fgExtended: 38, bgExtended: 48, palette: 5, rgb: 2,
});
/** The 16 basic colours: 30-37 and 90-97 for text, 40-47 and 100-107 for the background (bold brightens only these). */
const BASIC = Object.freeze({ fg: 30, fgBright: 90, bg: 40, bgBright: 100, bright: 8 });
/** How xterm's cells say how their colour was given (getFgColorMode, getBgColorMode). */
const COLOUR_MODE = Object.freeze({ basic: 0x1000000, palette: 0x2000000, rgb: 0x3000000 });
/** How the 24 bits of an RGB colour split into red, green and blue. */
const RED_SHIFT = 16;
const GREEN_SHIFT = 8;
const CHANNEL = 0xff;
const SPACE = ' ';

/**
 * A cell's colours and style as an SGR sequence, starting from plain.
 * @param {any} cell xterm's IBufferCell
 */
function styleOf(cell) {
  /** @type {number[]} */
  const p = [SGR.plain];
  if (cell.isBold()) p.push(SGR.bold);
  if (cell.isDim()) p.push(SGR.dim);
  if (cell.isItalic()) p.push(SGR.italic);
  if (cell.isUnderline()) p.push(SGR.underline);
  if (cell.isBlink()) p.push(SGR.blink);
  if (cell.isInverse()) p.push(SGR.inverse);
  if (cell.isInvisible()) p.push(SGR.invisible);
  if (cell.isStrikethrough()) p.push(SGR.strikethrough);
  if (cell.isOverline()) p.push(SGR.overline);
  p.push(...colour(cell.getFgColorMode(), cell.getFgColor(), BASIC.fg, BASIC.fgBright, SGR.fgExtended));
  p.push(...colour(cell.getBgColorMode(), cell.getBgColor(), BASIC.bg, BASIC.bgBright, SGR.bgExtended));
  return `\x1b[${p.join(';')}m`;
}

/**
 * A colour's SGR parameters, given as the cell had it: a basic colour, one of the 256, or RGB; none for the default.
 * @param {number} mode
 * @param {number} value
 * @param {number} basic the first basic colour's parameter
 * @param {number} bright the first bright basic colour's parameter
 * @param {number} extended 38 for text, 48 for the background
 * @returns {number[]}
 */
function colour(mode, value, basic, bright, extended) {
  if (mode === COLOUR_MODE.basic) return [value < BASIC.bright ? basic + value : bright + value - BASIC.bright];
  if (mode === COLOUR_MODE.palette) return [extended, SGR.palette, value];
  if (mode === COLOUR_MODE.rgb) return [extended, SGR.rgb, (value >> RED_SHIFT) & CHANNEL, (value >> GREEN_SHIFT) & CHANNEL, value & CHANNEL];
  return [];
}

/**
 * Where a row's content ends: after its last cell with a character or a colour of its own.
 * @param {any} line xterm's IBufferLine
 * @param {any} cell a cell to read into
 */
function contentEnd(line, cell) {
  for (let x = line.length - 1; x >= 0; x--) {
    line.getCell(x, cell);
    if (cell.getChars() || !cell.isAttributeDefault()) return x + 1;
  }
  return 0;
}

/**
 * The output that draws rows [from, to) of a buffer, one line (a row and the rows it wrapped onto): every row but the
 * last filled to the edge, so writing it wraps onto the next row as the line did, and a blank last row still given a
 * space so the wrap happens. Ends with plain style.
 * @param {any} buffer xterm's buffer
 * @param {number} from
 * @param {number} to
 */
export function lineOutput(buffer, from, to) {
  const cell = buffer.getNullCell();
  let out = '';
  let style = '';
  for (let y = from; y < to; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    const end = y < to - 1 ? line.length : contentEnd(line, cell);
    if (!end && y > from) {
      out += `\x1b[${SGR.plain}m${SPACE}`;
      style = '';
    }
    for (let x = 0; x < end; x++) {
      line.getCell(x, cell);
      if (!cell.getWidth()) continue; // the second half of a wide character
      const s = styleOf(cell);
      if (s !== style) out += s;
      style = s;
      out += cell.getChars() || SPACE;
    }
  }
  return `${out}\x1b[${SGR.plain}m`;
}
