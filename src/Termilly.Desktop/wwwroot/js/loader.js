// @ts-check
// Start-up loader for Linux. On Windows the window draws its own over the page (MainWindow.xaml) and this one
// stays hidden. A classic script, run as soon as the body starts, so it shows before the rest of the page loads;
// main.js removes it when the first terminal is ready.
(() => {
  // A classic script can't import, so its values are named here.
  /** The loader's element (index.html). */
  const LOADER_ID = 'loader';
  /** The logo's sizes in pixels, one per display scale, and its size at 100%. */
  const MARK_SIZES_PX = [48, 60, 72, 84, 96];
  const MARK_BASE_PX = 48;
  /** How long each letter of "Loading" takes to type, and how long each step of the dots shows, in milliseconds. */
  const LETTER_MS = 85;
  const DOTS_MS = 320;
  /** The dot steps: none, one, two, three. */
  const DOT_STEPS = 4;
  /** The longest the loader shows, in milliseconds, in case the page never gets as far as a terminal. */
  const MAX_SHOWN_MS = 12000;
  /** The host's window message and its drag action (protocol.js's PAGE.window and main.js's WINDOW_ACTION.drag). */
  const WINDOW_MESSAGE = 'window';
  const DRAG_ACTION = 'drag';

  // Its timer is kept on the element. The markup always has it.
  const loader = /** @type {HTMLElement & { timer?: number }} */ (document.getElementById(LOADER_ID));
  if (window.chrome?.webview) {
    loader.remove();
    return;
  }
  document.documentElement.dataset.platform = 'linux';
  loader.hidden = false;
  // The logo drawn at each display scale (only the Linux build ships these), shown 1:1 so it stays sharp.
  /** @type {HTMLImageElement} */ (loader.querySelector('img')).srcset = MARK_SIZES_PX.map(size => `assets/loader/mark-${size}.png ${size / MARK_BASE_PX}x`).join(', ');

  // "L", "Lo", … "Loading", then the dots cycle: "Loading", "Loading.", "Loading..", "Loading...".
  const word = 'Loading';
  const text = /** @type {HTMLElement} */ (loader.querySelector('.loader-text'));
  let typed = 0;
  let dots = 0;
  const step = () => {
    if (typed < word.length) {
      text.textContent = word.slice(0, ++typed);
      loader.timer = setTimeout(step, typed === word.length ? DOTS_MS : LETTER_MS);
      return;
    }
    dots = (dots + 1) % DOT_STEPS;
    text.textContent = word + '.'.repeat(dots);
    loader.timer = setTimeout(step, DOTS_MS);
  };
  loader.timer = setTimeout(step, LETTER_MS);
  // As on Windows: shown at most 12 seconds, in case the page never gets as far as a terminal.
  setTimeout(() => {
    clearTimeout(loader.timer);
    loader.remove();
  }, MAX_SHOWN_MS);

  loader.addEventListener('mousedown', e => {
    if (e.button === 0) window.external.sendMessage(JSON.stringify({ type: WINDOW_MESSAGE, action: DRAG_ACTION }));
  });
})();
