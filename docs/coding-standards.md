# Coding standards

How Termilly's code is written, and the checks that keep it that way. Most of these rules are enforced: the build
fails on analyzer and style warnings, and `npm run check` fails on anything new beyond its baselines. The rest is
review. When the code and this page disagree, the code is usually right and this page needs fixing.

## The parts

| Project | What it is |
| --- | --- |
| `src/Termilly.Desktop` | The app: WPF and WebView2 on Windows. Hosts the page (`wwwroot`), runs the shells, keeps settings, history and the vault. |
| `src/Termilly.Linux` | The same app on Linux, with Photino instead of WPF. Shares Desktop's code; only the platform services differ. |
| `src/Termilly.Host` | The background process that keeps shells running when the window closes (`termilly-host`). |
| `src/Termilly.Pty` | Pseudo consoles: ConPTY on Windows, a Unix PTY on Linux, and the protocol to the host. |
| `src/Termilly.Agent` | `termilly` and `termilly-hook`: the CLI, the MCP server and Claude Code's hooks. |
| `src/Shared` | Constants the projects above share (hook events, pipe names, API names), linked into each. |
| `installer/TermillySetup` | The Windows setup program (.NET Framework 4.8, so it runs with nothing installed). |

## Writing

- Comments say why, in plain English sentences. What the code does should be readable from the code; a comment
  explains the reason, the constraint or the surprise. No em dashes; a plain hyphen or a new sentence instead.
- Names say what a thing is in the words a user would use: `startCwd`, `rerunOffer`, `hiddenScrollback`.
- UI text: labels, buttons and menu entries never end in an ellipsis; text people read uses curly quotes and
  apostrophes, as the rest of the UI does. Icons are drawn on the pixel grid at the size they show, so they stay sharp.

## No magic values, and nothing written twice

- A number other than 0, 1 or 2 is a named constant, defined once where it belongs. A string that names something
  (a mode, a key, a message type, a state) is a constant too, used from there everywhere.
- Values the page and the host share are written once, in C#: `scripts/constants.mjs` writes `js/constants.js` (a
  setting's choices, agent states, profile sources) and `types/host.d.ts` (the shapes of settings and profiles) from
  the C# classes, and `scripts/protocol.mjs` writes `js/protocol.js` from the message records. Never edit those files;
  change the C# and run the script.
- Code isn't copied: a second copy becomes a function both use. `jscpd` reports copies.

## C#

- File-scoped namespaces, `var`, braces on every block, no `this.` (`.editorconfig`; the build enforces it).
  Analyzers run at `latest-recommended` with warnings as errors. A rule is turned off only for the files that need
  it, in a section of `.editorconfig` with its reason.
- Types are `internal` (tests see them through `InternalsVisibleTo`) and `sealed`; data is a `sealed record`.
- A closed set of values is a static class of `const string` fields with an `All` list for checking, as in
  `Settings/SettingValues.cs`. A method returning more than two values returns a named record, not a tuple.
- Services come from the container (`Services/Composition.cs`, Microsoft.Extensions.DependencyInjection): each
  feature takes what it needs in its constructor. What differs between Windows and Linux is behind an interface in
  `Platform/Platform.cs` (`IFileDialogs`, `INotifier`, `ISystemTheme`…), registered by each app with `AddPlatform`.
- A program Termilly runs goes through `IProcessRunner`; files are written with `AppPaths.WriteAtomically`.
- Exceptions are filtered, not swallowed: `catch (Exception e) when (Storage.IsFileError(e))`, and nothing is
  caught that isn't expected and handled.
- `[GeneratedRegex]` for regular expressions, `Lock` for locks.
- The page's messages are records in `Messaging/` (`IPageMessage`, `IHostMessage`); a feature registers what it
  does with each of its messages (`IMessageHandler`). Messages to the page are sent as records, never as anonymous
  objects; nor is anything else the app writes (`scripts/check-anonymous.mjs`).
- Settings are groups of records (`Settings/SettingGroups.cs`), each with its defaults and its own `Normalize`. A change
  to their shape needs a migration in `Settings/SettingsMigration.cs` and a version bump.

## The page (JavaScript)

- ES modules, no build step and no framework. Every file starts with `// @ts-check`, and TypeScript checks them in
  strict mode through JSDoc (`jsconfig.json`): every function's parameters have types, and shapes used in more than one
  place have a `@typedef` (or a global type in `types/`).
- Modules are in layers, and a module never imports one in a higher layer, so there are no import cycles
  (`scripts/check-cycles.mjs`). Bottom to top:
  1. foundation: `protocol`, `constants`, `util`, `dom`, `host` and the pure helpers;
  2. state: `store`, `preferences`, `themes`;
  3. UI primitives: `ui`, `popups`, `dialogs`;
  4. the terminal core: `terminals`, `commands`, `triggers`;
  5. `panes`, `workspaces`;
  6. features;
  7. the chrome: header, sidebar, palette, settings and the windows;
  8. `main`.
  When a lower module needs a higher one, it emits an event (`EVENTS` in `store.js`) or takes a registration
  (`setHeaderBuilder`, `onApply`).
- A terminal (`Tab`, `types/model.d.ts`) has its own fields, and a group per feature (`tab.log`, `tab.results`,
  `tab.start`…) that only that feature's module writes, through an accessor of its own (`logOf(tab)`). Other modules
  read a group, or call the module.
- Elements the markup always has are found with `dom.js` (`byId`, `find`, `field`, `targetOf`); where an element may
  be missing, query for it and check.
- User content (names, tags, output, anything from a file or a server) goes into markup through `escapeHtml`, and
  into a `style` attribute through `cssColor`.
- Settings change through `preferences.js` (`updateSettings(GROUPS.x, patch)`, `setSetting('group.key', value)`) and
  are read with `getSetting` or `state.settings.group.key`.
- Functions stay short: no function over 50 lines. Long markup goes in a function of its own, apart from what wires it
  up.

## The checks

- `dotnet test Termilly.slnx`: the build (analyzers and style included) and the tests, the setup program's too
  (`tests/TermillySetup.Tests`, .NET Framework like setup itself). On Linux,
  `src/Termilly.Linux` builds and `tests/Termilly.Core.Tests` runs.
- `npm run check`: ESLint, the type check, the JavaScript tests, the generated files being up to date (`protocol`,
  `constants`), import cycles, anonymous objects in C#, magic values, sizes (a function over 50 lines, a C# class over 400) and copies.
- `scripts/baselines/` lists what the magic-value and size checks found when they began. A baseline only ever
  shrinks: the checks fail on anything new, and on a count that went down until the baseline is updated
  (`--update`). The aim is zero.
- CI runs all of it on every pull request (`.github/workflows/ci.yml`).
