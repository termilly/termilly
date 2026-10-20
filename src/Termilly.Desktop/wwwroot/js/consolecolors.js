// @ts-check
// Colours from the Windows console that mean something else in a terminal. No DOM here, so tests/js can load it.

const CONSOLE_DEFAULTS = '\x1b[37m\x1b[40m';

/**
 * PSReadLine (PowerShell's line editor) ends each coloured word with ESC[37m ESC[40m: the old console's default
 * colours, white on black, not the terminal's own. In the light theme that's a black block behind every argument
 * and space. Exactly that pair means "back to the default colours", so it becomes ESC[39m ESC[49m; a program that
 * wants white on black still gets it any other way (ESC[37;40m, or with other text in between).
 * @param {string} data
 */
export const consoleDefaults = data =>
  data.includes(CONSOLE_DEFAULTS) ? data.replaceAll(CONSOLE_DEFAULTS, '\x1b[39m\x1b[49m') : data;
