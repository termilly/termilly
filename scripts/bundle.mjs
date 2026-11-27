// Writes the page as one file: js/main.js in a build's wwwroot (`node scripts/bundle.mjs <wwwroot>`), the whole module
// graph of src/Termilly.Desktop/wwwroot/js/main.js. Loading the 250-odd modules one by one took the page about two
// seconds at every start (each file is a request of its own to the webview); one file takes a fraction of that. The
// source files stay as they are; the build runs this after it copies them (scripts/BundlePage.targets).
//
// The end-to-end tests reach into modules by file name (testdriver.js t.import): the bundle hands the driver the
// modules it already ran, so a test sees the page's own state, not a second copy of a module.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scripts = path.join(repo, 'src/Termilly.Desktop/wwwroot/js');
const entry = path.join(scripts, 'main.js');
/** What testdriver.js takes the page's modules with. */
const REGISTER = 'registerModules';

const target = process.argv[2];
if (!target) {
  console.error('Usage: node scripts/bundle.mjs <wwwroot of the build>');
  process.exit(1);
}
const outfile = path.join(path.resolve(target), 'js/main.js');

const options = { bundle: true, format: 'esm', logLevel: 'warning', absWorkingDir: scripts };

// The modules main.js runs, and only those: one it doesn't import mustn't start running because of the tests.
const graph = await esbuild.build({ ...options, entryPoints: [entry], write: false, metafile: true });
const modules = Object.keys(graph.metafile.inputs).map(file => path.relative(scripts, path.resolve(scripts, file)).replaceAll('\\', '/'));

// The start-up log first, so it notes when the page started to run; then main.js, so everything runs in the order it
// does unbundled; then the modules for the test driver.
const lines = ["import './startuplog.js';", "import './main.js';", `import { ${REGISTER} } from './testdriver.js';`];
modules.forEach((file, i) => lines.push(`import * as m${i} from './${file}';`));
lines.push(`${REGISTER}({ ${modules.map((file, i) => `${JSON.stringify(file)}: m${i}`).join(', ')} });`);

await esbuild.build({
  ...options,
  stdin: { contents: lines.join('\n'), resolveDir: scripts, sourcefile: 'page.js', loader: 'js' },
  outfile,
  sourcemap: 'linked',
  sourceRoot: '',
});
console.log(`Page bundled: ${modules.length} modules in ${path.relative(repo, outfile)} (${Math.round(fs.statSync(outfile).size / 1024)} KB).`);
