// @ts-check
// detached.html's own script: tells the main page (the window that opened it, js/windows.js) it's ready for what it
// will show, and asks it before the window closes, so it can take that back first.

/** @typedef {Window & { termillyWindowReady?: (win: Window) => void, termillyWindowClose?: (name: string) => void }} MainPage */

const mainPage = /** @type {MainPage | null} */ (window.opener);
if (mainPage?.termillyWindowReady) mainPage.termillyWindowReady(window);
else window.close();

/** The host runs this when the title bar's X (or Alt+F4) is pressed. */
Object.assign(window, {
  termillyClose: () => (mainPage && !mainPage.closed && mainPage.termillyWindowClose
    ? mainPage.termillyWindowClose(window.name)
    : window.close()),
});
