# Termilly Setup

`TermillySetup.exe` installs Termilly on Windows 10 (1903+) and 11, 64-bit. It's a WPF program on .NET Framework 4.8, which every supported Windows already has, so setup itself needs nothing installed first. It looks like Termilly: same colours, controls and logo, in Termilly's dark theme.

## Building

```powershell
powershell -ExecutionPolicy Bypass -File installer\build.ps1            # dist\TermillySetup-<version>.exe, about 270 MB
powershell -ExecutionPolicy Bypass -File installer\build.ps1 -NoPrereqs # dist\TermillySetup-<version>-online.exe, about 10 MB
```

The script:

1. Builds Termilly (Release). The version comes from `Directory.Build.props`.
2. Downloads the .NET 10 Desktop Runtime and WebView2 standalone installers into `installer\.cache`. It does this once (`-Refresh` gets newer ones) and checks they're signed by Microsoft.
3. Builds the setup program.
4. Appends the payload to it:
   - a zip of `app/`, `prereqs/` and `version.txt`;
   - then a footer: offset, SHA-256 and `TMLYPAY1`.

**Signing.** Sign the finished exe afterwards (`signtool sign /fd sha256 /tr <timestamp> /td sha256 …`). Setup still finds its payload behind the signature.

## Release builds (GitHub Actions)

`.github/workflows/release.yml` builds both installers on clean machines: Windows setup (full and online) on
`windows-latest` and the `.deb` (`linux/build-deb.sh`) on Ubuntu 24.04, each after the tests pass on its system.
Start it from **Actions › Release › Run workflow** (or `gh workflow run release.yml --ref <branch>`).

- **Without "publish"**: a test build. The installers can be downloaded from the run's page for one day.
- **With "publish"**: also creates the GitHub Release `v<version>` with the installers and `SHA256SUMS`, and the
  same installers under fixed names (`TermillySetup.exe`, `TermillySetup-online.exe`, `termilly_amd64.deb`). Its notes
  are the version's section of `CHANGELOG.md`. It stops early if `v<version>` is already released, so bump
  `<Version>` in `Directory.Build.props` first. Every version stays downloadable there.

**termilly.com/downloads** is filled by hand: the server only lets the maintainer in, so the workflow can't reach
it. After a release, run `deploy/publish-release.sh` from the termilly-site repo (`--dry-run` first). It downloads the
release from GitHub and checks it, uploads it to `/downloads/<version>/` and, under the fixed names, `/downloads/latest/`
(what the site's download buttons link to), then writes `latest.json`, signed with the release signing key, which tells
running Termillys an update is out (the app checks the signature first). Last, it removes every older version from
the server, so it holds only the newest one; `--prune` does just that step.

## What it does

- **Prerequisites.** It installs only what's missing:
  - It downloads the .NET 10 Desktop Runtime and WebView2 from Microsoft first.
  - It gives up after 15 s without a connection or 20 s without progress.
  - It then uses the copies inside setup.
  - Every installer must be Authenticode-signed by Microsoft before it runs.
  - .NET installs machine-wide, so Windows asks for administrator permission once.
- **Install.**
  - Default: for the current user, in `%LOCALAPPDATA%\Programs\Termilly`, with no admin.
  - "All users": restarts elevated and uses Program Files.
  - Files are unpacked next to the old ones and swapped in. A failure puts the old install back.
- **Windows integration.** All of it is optional:
  - Start menu and desktop shortcuts.
  - "Open in Termilly" on folders, folder backgrounds and drives (`Termilly.exe --open "%V"`).
  - The `termilly` command on PATH, on by default (`bin\termilly.cmd`, so `agent\claude.exe` stays off PATH):
    `termilly` starts Termilly, `termilly <folder>` or `termilly .` opens it there, and `termilly list`, `state`,
    `open`… are the scripting commands.
  - Agent integration and sign-in shells, written into Termilly's own settings.
  - An Apps & features entry.
- **Uninstall.**
  - Setup keeps a copy of its program part (about 200 KB, no payload) in the install folder for Apps & features.
  - It removes everything it added, plus Termilly's sign-in entry and toast registration.
  - It keeps `%LOCALAPPDATA%\Termilly` unless asked to remove it.
- **Log.** Everything goes to `%TEMP%\TermillySetup-*\setup.log`.

## Without the wizard

```
TermillySetup.exe --quiet [--all-users] [--dir PATH] [--desktop] [--no-path] [--sign-in] [--offline]
                          [--no-start-menu] [--no-explorer] [--no-agent] [--start]
TermillySetup.exe --uninstall --quiet [--remove-data]
```

Exit codes: 0 done, 1 failed (see the log), 740 run it as administrator (for all users). `--start` starts
Termilly when it's done, installed or not: an update from inside Termilly runs setup this way, after closing it.
