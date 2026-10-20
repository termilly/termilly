# Termilly plugins (API version 1)

A plugin is a folder in `%LOCALAPPDATA%\Termilly\plugins\` (Settings › Plugins › Open folder) with a `plugin.json`.
After adding or changing one, press **Reload**. Examples are in `samples/plugins/`.

## plugin.json

```json
{
  "apiVersion": 1,
  "id": "acme.my-plugin",
  "name": "My plugin",
  "version": "1.0.0",
  "description": "What it does.",
  "themes": [ { "id": "night", "name": "Acme Night", "light": false, "colors": { "background": "#101010", "foreground": "#e0e0e0", "red": "#ff5555" } } ],
  "main": "main.js"
}
```

- `apiVersion`: the plugin API the plugin was written for. A plugin for another version is disabled, with the
  reason shown, and isn't loaded at all.
- `id`: lower-case letters, digits, dots and dashes. It must be unique.
- `themes` (optional): terminal colours. The keys are xterm's (`background`, `foreground`, `cursor`,
  `cursorAccent`, `selectionBackground`, `black` … `brightWhite`) and the values are `#rgb`, `#rrggbb` or
  `rgb()`/`rgba()`. Colours you leave out come from the dark theme, or from the light theme when `"light": true`.
  Pick one in Settings › Plugins › Terminal colours.
- `main` (optional): a script in the plugin's folder, at most 256 KB.

## The script

The script runs in a sandboxed frame. It has its own opaque origin and no network access (`default-src 'none'`),
and it can't reach Termilly's page or files. All it gets is a frozen global `termilly`:

| | |
|---|---|
| `termilly.apiVersion` | `1` |
| `termilly.registerCommand({ id, label, keywords }, handler)` | Adds a palette command. `handler({ pane })` gets the focused terminal's id (or null). |
| `termilly.call(method, args)` | The same methods as the `termilly` CLI; returns a Promise. |
| `termilly.setStatus(pane, text)` | Shorthand for `call('status', { pane, text })`: a status next to the terminal's title. |

Methods for `call`:
- `list`: the terminals.
- `state {pane}`: one terminal, with its last command.
- `status {pane, text}`: sets the status shown next to the terminal's title.
- `open {profile, cwd, name, workspace, command}`: opens a terminal.
- `send {pane, text, enter}`: types into a terminal.

`open` and `send` need Settings › Terminal › "Let scripts and agents type", the same rule as the CLI.

If the script throws (while loading, or in a handler) or doesn't finish loading within 3 seconds, the plugin is
stopped. Settings › Plugins then shows it as disabled, with the error. The rest of Termilly carries on.
