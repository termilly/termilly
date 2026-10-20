# Contributing to Termilly

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Before you start

- **Bugs and ideas:** open an [issue](https://github.com/termilly/termilly/issues). For a bug, say what you did, what you expected and what happened, with your Termilly version (Settings › About) and system. If Termilly crashed, Settings › About lists the crash log to attach.
- **Bigger changes:** open an issue first, so we can agree on the approach before you spend time on it.
- **Security problems:** report them privately, as [SECURITY.md](SECURITY.md) describes, never in a public issue.

## Setting up

You need the .NET 10 SDK and Node.js 24. On Windows the WebView2 runtime is needed too; it comes with Windows 11 and current Windows 10. On Linux, WebKitGTK 4.1 (`sudo apt install libwebkit2gtk-4.1-0` on Ubuntu 24.04).

```sh
git clone https://github.com/termilly/termilly.git
cd termilly
npm ci
dotnet build Termilly.slnx                   # on Linux: dotnet build src/Termilly.Linux
dotnet run --project src/Termilly.Desktop    # on Linux: dotnet run --project src/Termilly.Linux
```

To try it without touching your own Termilly's data, set `TERMILLY_DATA_DIR` to an empty folder before you start it.

## Before you open a pull request

Both of these must pass; CI runs them on Windows and Linux for every pull request.

```sh
dotnet test Termilly.slnx                    # on Linux: dotnet test tests/Termilly.Core.Tests
npm run check
```

The build treats analyzer and code-style warnings as errors. `npm run check` runs ESLint, the type check, the JavaScript tests, and checks that the generated files are up to date, that there are no import cycles, magic values, anonymous objects or copied code, and that nothing is too long.

**Generated files:** `wwwroot/js/protocol.js`, `wwwroot/js/constants.js` and `wwwroot/types/host.d.ts` come from the C# messages and constants. After changing those, run `node scripts/protocol.mjs` and `node scripts/constants.mjs` instead of editing them by hand.

## Code style

[docs/coding-standards.md](docs/coding-standards.md) has the rules. In short:

- Write code that reads like the code around it: its naming, idioms and comment density.
- Comments explain why, not what.
- No magic numbers or strings; shared values live in one place.
- C# classes are `internal sealed`, data types `sealed record`.
- The page is plain JavaScript modules with `// @ts-check` and JSDoc types. No framework, no bundler.
- Text people see is short and plain. No em dashes, and labels never end in "…".

Keep a pull request to one change, with tests for what it fixes or adds. Describe what changed and how you checked it, and include a screenshot for anything visible.

## Contributor License Agreement

Before your first pull request can be merged, you sign the [Contributor License Agreement](CLA.md). The CLA Assistant bot asks you to on the pull request; signing takes one click and covers all your later contributions.

You keep the copyright to your work. The CLA gives the project the right to use it, including in future versions under other license terms, which keeps open-core features possible later. What's open stays under the Apache License 2.0.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE), as well as under the terms of the CLA.
