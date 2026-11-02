// Tests for command lines built from separate words (src/Termilly.Desktop/wwwroot/js/quoting.js): what
// `termilly open -- claude "a prompt"` types into each shell.
// Run with: node --test tests/js/quoting.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandLine, quotePath, wslLinuxPath } from '../../src/Termilly.Desktop/wwwroot/js/quoting.js';

// The prompt that broke: PowerShell read "(in a single message)" as code when it arrived unquoted.
const prompt = 'Spawn 3 subagents in parallel (in a single message). Run: 1..10 | ForEach-Object { $_ }';

test('PowerShell gets the prompt as one single-quoted argument', () => {
  assert.equal(commandLine(['claude', prompt], 'powershell'), `claude '${prompt}'`);
});

test('a single quote inside is doubled for PowerShell', () => {
  assert.equal(commandLine(['claude', "it's done"], 'powershell'), "claude 'it''s done'");
});

test('bash, WSL and ssh get POSIX single quotes', () => {
  for (const shell of ['bash', 'wsl', 'ssh']) {
    assert.equal(commandLine(['claude', "it's (fine)"], shell), `claude 'it'\\''s (fine)'`);
  }
});

test('cmd gets double quotes, with inner quotes escaped for the program', () => {
  assert.equal(commandLine(['claude', 'say "hi" now'], 'cmd'), 'claude "say \\"hi\\" now"');
});

test('plain words and paths stay unquoted', () => {
  assert.equal(commandLine(['npm', 'run', 'dev'], 'powershell'), 'npm run dev');
  assert.equal(commandLine(['code', 'C:\\dev\\api', '--reuse-window'], 'cmd'), 'code C:\\dev\\api --reuse-window');
});

// A WSL distribution's files as Windows reaches them (the Files panel of a WSL terminal), as Linux has them.
test('a \\\\wsl.localhost path is the Linux path in its distribution', () => {
  assert.equal(wslLinuxPath(String.raw`\\wsl.localhost\Ubuntu\home\me\my dir`), '/home/me/my dir');
  assert.equal(wslLinuxPath(String.raw`\\wsl$\Ubuntu-24.04\etc\ `.trim()), '/etc');
  assert.equal(wslLinuxPath(String.raw`\\wsl.localhost\Ubuntu`), '/');
  assert.equal(wslLinuxPath(String.raw`C:\Users\me`), null);
  assert.equal(wslLinuxPath(String.raw`\\server\share\x`), null);
});

test('a WSL terminal gets a path in its distribution as Linux has it, a Windows path under /mnt', () => {
  assert.equal(quotePath(String.raw`\\wsl.localhost\Ubuntu\home\me\x`, 'wsl'), "'/home/me/x'");
  assert.equal(quotePath(String.raw`C:\dev\x`, 'wsl'), "'/mnt/c/dev/x'");
});
