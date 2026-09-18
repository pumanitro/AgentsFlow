import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { INSTALL_SETTLE_MS, cliSystem, codexCliDir, codexCliRecordPath, codexUpgradeAvailable, findOnPath, npmPackageRoot, pinCodexCli, pinnedCodexCli } from './codex-cli';

// A real npm-shaped install in a temp prefix: `bin/codex` → the package's
// launcher, which reports the version of the package.json BESIDE it. So a
// snapshot that answers `--version` proves it runs from its own copy.
const LAUNCHER = `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
if (!fs.existsSync(path.join(__dirname, '..', 'vendor', 'codex'))) process.exit(1);
console.log('codex-cli ' + pkg.version);
`;

interface Fixture { root: string; serverDir: string; globalBin: string; packageRoot: string; }

function install(f: Fixture, version: string): void {
  fs.rmSync(f.packageRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(f.packageRoot, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(f.packageRoot, 'vendor'), { recursive: true });
  fs.writeFileSync(path.join(f.packageRoot, 'package.json'), JSON.stringify({ name: '@openai/codex', version }));
  fs.writeFileSync(path.join(f.packageRoot, 'vendor', 'codex'), 'native binary');
  fs.writeFileSync(path.join(f.packageRoot, 'bin', 'codex.js'), LAUNCHER, { mode: 0o755 });
  fs.mkdirSync(path.dirname(f.globalBin), { recursive: true });
  fs.rmSync(f.globalBin, { force: true });
  fs.symlinkSync(path.join(f.packageRoot, 'bin', 'codex.js'), f.globalBin);
}

/** 2026-09-18, exactly: npm retired the old package, was killed, and never linked the new one. */
function interruptUpdate(f: Fixture, version: string): void {
  fs.rmSync(f.globalBin, { force: true });
  fs.rmSync(path.join(f.packageRoot, 'vendor', 'codex'));
  fs.writeFileSync(path.join(f.packageRoot, 'package.json'), JSON.stringify({ name: '@openai/codex', version }));
}

async function withFixture(run: (f: Fixture) => Promise<void>): Promise<void> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cli-')));
  const f: Fixture = {
    root,
    serverDir: path.join(root, 'user data', 'codex'), // a space, like "Application Support"
    globalBin: path.join(root, 'prefix', 'bin', 'codex'),
    packageRoot: path.join(root, 'prefix', 'lib', 'node_modules', '@openai', 'codex'),
  };
  const real = cliSystem.findGlobal;
  const realEnv = process.env.CODEX_BIN;
  delete process.env.CODEX_BIN;
  cliSystem.findGlobal = () => findOnPath('codex', path.dirname(f.globalBin));
  try { await run(f); }
  finally {
    cliSystem.findGlobal = real;
    if (realEnv === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = realEnv;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const record = (f: Fixture) => JSON.parse(fs.readFileSync(codexCliRecordPath(f.serverDir), 'utf8'));

test.describe('pinCodexCli — a server start', () => {
  test('clones the healthy npm install and records the clone, not the global path', () => withFixture(async (f) => {
    install(f, '1.2.3');
    const cli = await pinCodexCli(f.serverDir);
    assert.equal(cli.source, 'snapshot');
    assert.equal(cli.version, '1.2.3');
    assert.equal(cli.bin, path.join(codexCliDir(f.serverDir), '1.2.3', 'bin', 'codex.js'));
    assert.equal(await cliSystem.version(cli.bin), '1.2.3');
    assert.equal(record(f).bin, cli.bin);
  }));

  test('moves to the new version only now, and keeps the previous one to fall back on', () => withFixture(async (f) => {
    install(f, '1.2.3'); await pinCodexCli(f.serverDir);
    install(f, '1.3.0'); await pinCodexCli(f.serverDir);
    install(f, '1.4.0');
    const cli = await pinCodexCli(f.serverDir);
    assert.equal(cli.version, '1.4.0');
    assert.deepEqual(fs.readdirSync(codexCliDir(f.serverDir)).sort(), ['1.3.0', '1.4.0']);
  }));

  test('a broken global install at start falls back to the kept snapshot instead of failing', () => withFixture(async (f) => {
    install(f, '1.2.3'); await pinCodexCli(f.serverDir);
    interruptUpdate(f, '1.3.0');
    const cli = await pinCodexCli(f.serverDir);
    assert.equal(cli.source, 'fallback-snapshot');
    assert.equal(cli.version, '1.2.3');
    assert.equal(await cliSystem.version(cli.bin), '1.2.3');
  }));

  test('with no CLI that runs anywhere, the error says how to reinstall', () => withFixture(async (f) => {
    install(f, '1.2.3');
    interruptUpdate(f, '1.3.0');
    await assert.rejects(pinCodexCli(f.serverDir), /not installed or not on PATH[\s\S]*npm install -g @openai\/codex/);
    fs.symlinkSync(path.join(f.packageRoot, 'bin', 'codex.js'), f.globalBin); // linked, but the binary is a stub
    await assert.rejects(pinCodexCli(f.serverDir), /does not run[\s\S]*npm install -g @openai\/codex/);
  }));

  test('a failed copy never leaves a half-written directory under a version name', () => withFixture(async (f) => {
    install(f, '1.2.3');
    const real = cliSystem.copyTree;
    cliSystem.copyTree = async (_from, to) => { fs.mkdirSync(to, { recursive: true }); throw new Error('disk full'); };
    try {
      const cli = await pinCodexCli(f.serverDir);
      assert.equal(cli.source, 'global');
      assert.equal(cli.bin, path.join(f.packageRoot, 'bin', 'codex.js'));
      assert.deepEqual(fs.readdirSync(codexCliDir(f.serverDir)), []);
    } finally { cliSystem.copyTree = real; }
  }));

  test('a hoisted layout (native package beside the launcher, not inside it) degrades to the global path', () => withFixture(async (f) => {
    install(f, '1.2.3');
    // The clone is only the launcher's package; without the binary inside it, the copy cannot run.
    const hoisted = path.join(path.dirname(f.packageRoot), 'codex-native');
    fs.mkdirSync(hoisted, { recursive: true });
    fs.renameSync(path.join(f.packageRoot, 'vendor', 'codex'), path.join(hoisted, 'codex'));
    fs.writeFileSync(path.join(f.packageRoot, 'bin', 'codex.js'),
      LAUNCHER.replace("path.join(__dirname, '..', 'vendor', 'codex')", "path.join(__dirname, '..', '..', 'codex-native', 'codex')"), { mode: 0o755 });
    const cli = await pinCodexCli(f.serverDir);
    assert.deepEqual({ source: cli.source, bin: cli.bin }, { source: 'global', bin: path.join(f.packageRoot, 'bin', 'codex.js') });
    assert.deepEqual(fs.readdirSync(codexCliDir(f.serverDir)), []);
  }));

  test('a non-npm install (a plain binary) is pinned by its real path, not cloned', () => withFixture(async (f) => {
    const cellar = path.join(f.root, 'Cellar', 'codex', '1.2.3', 'codex');
    fs.mkdirSync(path.dirname(cellar), { recursive: true });
    fs.writeFileSync(cellar, '#!/bin/sh\necho "codex-cli 1.2.3"\n', { mode: 0o755 });
    fs.mkdirSync(path.dirname(f.globalBin), { recursive: true });
    fs.symlinkSync(cellar, f.globalBin);
    const cli = await pinCodexCli(f.serverDir);
    assert.deepEqual({ bin: cli.bin, source: cli.source }, { bin: cellar, source: 'global' });
    assert.equal(fs.existsSync(codexCliDir(f.serverDir)), false);
  }));

  test('CODEX_BIN is used verbatim: no probe, no clone, no record', () => withFixture(async (f) => {
    process.env.CODEX_BIN = '/somewhere/fake-codex';
    assert.deepEqual(await pinCodexCli(f.serverDir), { bin: '/somewhere/fake-codex', version: '', source: 'env' });
    assert.deepEqual(await pinnedCodexCli(f.serverDir), { bin: '/somewhere/fake-codex', version: '', source: 'env' });
    assert.equal(fs.existsSync(codexCliRecordPath(f.serverDir)), false);
  }));
});

test.describe('pinnedCodexCli — a chat opened against the running server', () => {
  test('an update killed half-way (no `codex` on PATH, a stub binary) cannot reach it', () => withFixture(async (f) => {
    install(f, '1.2.3');
    const started = await pinCodexCli(f.serverDir);
    interruptUpdate(f, '1.3.0');
    assert.equal(cliSystem.findGlobal(), null);
    const cli = await pinnedCodexCli(f.serverDir);
    assert.equal(cli.bin, started.bin);
    assert.equal(await cliSystem.version(cli.bin), '1.2.3');
  }));

  test('a finished update does not move it either: the server is still the old version', () => withFixture(async (f) => {
    install(f, '1.2.3');
    await pinCodexCli(f.serverDir);
    install(f, '1.3.0'); // npm deleted the 1.2.3 package on the way
    const cli = await pinnedCodexCli(f.serverDir);
    assert.equal(cli.version, '1.2.3');
    assert.equal(await cliSystem.version(cli.bin), '1.2.3');
  }));

  test('a server from before pinning is adopted on first use', () => withFixture(async (f) => {
    install(f, '1.2.3');
    assert.equal(fs.existsSync(codexCliRecordPath(f.serverDir)), false);
    const cli = await pinnedCodexCli(f.serverDir);
    assert.equal(cli.source, 'snapshot');
    assert.equal(record(f).version, '1.2.3');
  }));

  test('a record whose snapshot was deleted is re-pinned rather than trusted', () => withFixture(async (f) => {
    install(f, '1.2.3');
    await pinCodexCli(f.serverDir);
    fs.rmSync(codexCliDir(f.serverDir), { recursive: true, force: true });
    const cli = await pinnedCodexCli(f.serverDir);
    assert.equal(await cliSystem.version(cli.bin), '1.2.3');
  }));

  test('concurrent first opens share one copy', () => withFixture(async (f) => {
    install(f, '1.2.3');
    const real = cliSystem.copyTree; let copies = 0;
    cliSystem.copyTree = (from, to) => { copies++; return real(from, to); };
    try {
      const [a, b, c] = await Promise.all([pinnedCodexCli(f.serverDir), pinnedCodexCli(f.serverDir), pinnedCodexCli(f.serverDir)]);
      assert.equal(copies, 1);
      assert.ok(a.bin === b.bin && b.bin === c.bin);
    } finally { cliSystem.copyTree = real; }
  }));
});

test.describe('codexUpgradeAvailable — should the running server move to the installed CLI?', () => {
  const SETTLED = () => Date.now() + INSTALL_SETTLE_MS + 1_000;

  test('a newer, finished, working install is offered', () => withFixture(async (f) => {
    install(f, '1.3.0');
    assert.deepEqual(await codexUpgradeAvailable('1.2.3', SETTLED()), { from: '1.2.3', to: '1.3.0' });
  }));

  test('the same version is not an upgrade, and costs no process', () => withFixture(async (f) => {
    install(f, '1.2.3');
    const real = cliSystem.version; let probes = 0;
    cliSystem.version = (bin) => { probes++; return real(bin); };
    try {
      assert.equal(await codexUpgradeAvailable('1.2.3', SETTLED()), null);
      assert.equal(probes, 0);
    } finally { cliSystem.version = real; }
  }));

  test('an install npm is still writing is left alone until it has settled', () => withFixture(async (f) => {
    install(f, '1.3.0');
    assert.equal(await codexUpgradeAvailable('1.2.3', Date.now()), null);
    assert.deepEqual(await codexUpgradeAvailable('1.2.3', SETTLED()), { from: '1.2.3', to: '1.3.0' });
  }));

  test('an interrupted update is never followed, however long it has sat there', () => withFixture(async (f) => {
    install(f, '1.2.3');
    interruptUpdate(f, '1.3.0');
    assert.equal(await codexUpgradeAvailable('1.2.3', SETTLED()), null);
    fs.symlinkSync(path.join(f.packageRoot, 'bin', 'codex.js'), f.globalBin); // linked, binary still a stub
    assert.equal(await codexUpgradeAvailable('1.2.3', SETTLED()), null);
  }));

  test('a server that does not report its version is not second-guessed', () => withFixture(async (f) => {
    install(f, '1.3.0');
    assert.equal(await codexUpgradeAvailable('', SETTLED()), null);
  }));

  test('CODEX_BIN opts out', () => withFixture(async (f) => {
    install(f, '1.3.0');
    process.env.CODEX_BIN = '/somewhere/fake-codex';
    assert.equal(await codexUpgradeAvailable('1.2.3', SETTLED()), null);
  }));
});

test.describe('npmPackageRoot', () => {
  test('recognises the npm launcher layout and nothing else', () => {
    assert.equal(npmPackageRoot('/p/lib/node_modules/@openai/codex/bin/codex.js'), '/p/lib/node_modules/@openai/codex');
    assert.equal(npmPackageRoot('/opt/homebrew/Caskroom/codex/0.154.0/codex'), null);
    assert.equal(npmPackageRoot('/p/lib/node_modules/other/codex/bin/codex.js'), null);
    assert.equal(npmPackageRoot('/p/lib/node_modules/@openai/codex/bin/other.js'), null);
  });
});
