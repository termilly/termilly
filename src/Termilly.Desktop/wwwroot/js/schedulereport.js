// @ts-check
// A run's report as text. What's kept is what the terminal printed, colours and cursor moves and all: a hidden terminal plays
// it back and its screen is read, which is the only way to see what a pseudo console's repainting really left there.

/** The size it's played at: wide enough for a hidden shell's lines (ScheduleRunner.Columns). */
const COLUMNS = 160;
const ROWS = 50;
const SCROLLBACK = 50000;

/**
 * @param {string} output as the terminal printed it
 * @param {number} [columns]
 * @returns {Promise<string>}
 */
export function plainText(output, columns = COLUMNS) {
  if (!output) return Promise.resolve('');
  const term = new Terminal({ cols: columns, rows: ROWS, scrollback: SCROLLBACK, allowProposedApi: true });
  return new Promise(resolve => {
    term.write(output, () => {
      const buffer = term.buffer.active;
      /** @type {string[]} */
      const rows = [];
      for (let y = 0; y < buffer.length; y++) {
        const line = buffer.getLine(y);
        if (!line) continue;
        // A line that goes on in the next row keeps what ends this one: a space there is part of the text.
        const text = line.translateToString(!buffer.getLine(y + 1)?.isWrapped);
        if (line.isWrapped && rows.length) rows[rows.length - 1] += text;
        else rows.push(text);
      }
      term.dispose();
      while (rows.length && !rows[rows.length - 1].trim()) rows.pop();
      resolve(rows.join('\n'));
    });
  });
}
