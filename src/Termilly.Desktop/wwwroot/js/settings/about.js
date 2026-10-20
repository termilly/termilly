// @ts-check
// Settings › About: the version and updates, the guided tour, the data folder and a memory report.

import { PAGE, HOST } from '../protocol.js';
import { send, onHost } from '../host.js';
import { state, tabTitle } from '../store.js';
import { escapeHtml, ICONS } from '../ui.js';
import { updateAboutHtml, checkForUpdates, onUpdateStatus } from '../update.js';
import { startTour } from '../tour.js';
import { row, toggle, group } from './controls.js';
import { SECTION, closeSettings, redrawIfShowing } from './page.js';

/**
 * What the host says about itself: its version, data folder and the crash logs written to lately.
 * @type {{ version: string | null, dataDir: string, crashes?: Array<{ path: string, at: number }> }}
 */
let about = { version: '', dataDir: '' };

const BYTES_PER_MB = 1024 * 1024;
/** Below this many megabytes, one decimal. */
const FINE_MB = 10;
/** The bytes a terminal's buffer takes per cell (xterm's cell size). */
const CELL_BYTES = 12;

const mb = (/** @type {number} */ bytes) =>
  `${(bytes / BYTES_PER_MB).toFixed(bytes < FINE_MB * BYTES_PER_MB ? 1 : 0)} MB`;

/** @type {import('./page.js').Section} */
const ABOUT = {
  id: SECTION.about,
  label: 'About', icon: ICONS.info,
  html: () => `
    <div class="about-head"><img src="assets/mark-40.png" srcset="assets/mark-40.png 1x" width="40" height="40" alt="">
      <div><div class="about-name">Termilly</div><div class="set-desc">Version ${escapeHtml(about.version ?? '')}</div></div></div>`
    + group('Updates', row('Check for updates', 'At start and twice a day, Termilly looks at termilly.com for a newer version and says so in the title bar. It never downloads or installs anything by itself.', toggle('interface.checkForUpdates'), { keywords: 'update version new release download' })
      + row('Check now', updateAboutHtml(), '<button class="btn small" data-action="checkUpdates">Check now</button>', { keywords: 'update version' }))
    + group('', row('Guided tour', 'A short walk past the things you’ll use every day.', '<button class="btn small" data-action="startTour">Take the tour</button>'))
    + group('', row('Data folder', `<code class="path">${escapeHtml(about.dataDir ?? '')}</code>`,
      '<button class="btn small" data-action="openDataDir">Open folder</button>'))
    + crashesHtml()
    + group('Memory', `<div id="memory-report" class="memory-report"><p class="set-desc">How much memory Termilly and each terminal use right now.</p></div>
        <button class="btn small" data-action="measureMemory">Measure</button>`),
  actions: {
    measureMemory: () => send(PAGE.memoryMeasure),
    checkUpdates: checkForUpdates,
    openDataDir: () => send(PAGE.dataDirOpen),
    showCrash: el => send(PAGE.openPath, { path: el.dataset.path }),
    startTour() {
      closeSettings();
      startTour();
    },
  },
};

export default ABOUT;

/** A row for each crash log written to lately, with a button that shows the file to attach to a bug report. */
function crashesHtml() {
  const crashes = about.crashes ?? [];
  if (!crashes.length) return '';
  return group('Crash logs', crashes.map(c => row(escapeHtml(c.path.split(/[\\/]/).pop() ?? ''),
    `Written ${escapeHtml(new Date(c.at).toLocaleString())}. Attach it to a bug report so we can see what went wrong.`,
    `<button class="btn small" data-action="showCrash" data-path="${escapeHtml(c.path)}">Show file</button>`)).join(''));
}

onHost(HOST.settings, m => { about = m.about ?? about; });
onUpdateStatus(() => redrawIfShowing(SECTION.about));

/**
 * The host's numbers (processes' working sets) next to the page's: its JavaScript heap, and each terminal's
 * buffer (lines × columns × the cell size).
 */
onHost(HOST.memory, m => {
  const report = document.getElementById('memory-report');
  if (!report) return;
  // performance.memory is Chromium's own (WebView2 has it), so the DOM's types don't know it.
  const heap = /** @type {Performance & { memory?: { usedJSHeapSize: number } }} */ (performance).memory
    ?.usedJSHeapSize ?? 0;
  const rows = [...state.tabs.values()].map(tab => {
    const buffer = tab.view?.term?.buffer.normal;
    const lines = buffer?.length ?? 0;
    const cells = lines * (tab.view?.term?.cols ?? 0);
    return { name: tabTitle(tab), ws: state.workspaces.find(w => w.id === tab.wsId)?.name ?? '', lines, buffer: cells * CELL_BYTES, processes: m.sessions?.[tab.id] ?? 0 };
  }).sort((a, b) => b.buffer + b.processes - (a.buffer + a.processes));
  const total = rows.reduce((n, r) => n + r.processes, 0);
  report.innerHTML = `
    <div class="mem-summary">
      <span><b>${mb(m.app ?? 0)}</b> app</span><span><b>${mb(m.webView ?? 0)}</b> WebView2</span>
      <span><b>${mb(heap)}</b> page heap</span><span><b>${mb(total)}</b> shells</span>
    </div>
    <table class="mem-table"><thead><tr><th>Terminal</th><th>Lines</th><th>Buffer</th><th>Shell processes</th></tr></thead><tbody>
      ${rows.map(r => `<tr><td>${escapeHtml(r.name)} <span class="mem-ws">${escapeHtml(r.ws)}</span></td><td>${r.lines.toLocaleString()}</td><td>${mb(r.buffer)}</td><td>${mb(r.processes)}</td></tr>`).join('')}
    </tbody></table>`;
});
