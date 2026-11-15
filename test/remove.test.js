import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { uninstallPlugin, reinstallPlugin } from '../lib/core/remove.js'

const NAME = 'demo-plugin'
const OTHER = 'other-plugin'
const SELF = 'dsh-plugin-update-manager'

const MANIFEST = {
  name: 'qa-profile',
  private: true,
  dependencies: {
    [NAME]: '1.0.0',
    [OTHER]: '2.5.0',
    '@deepseek-ai/dsh-market': '1.73.6',
  },
  dsh: { profile: { bundles: [NAME, OTHER, 'keep-me'] } },
}
const LOCK = 'lockfileVersion: 9\n\nimporters:\n  .:\n    dependencies:\n      demo-plugin:\n        specifier: 1.0.0\n        version: 1.0.0\n'

/** @param {import('node:test').TestContext} t */
async function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-updater-remove-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = path.join(root, 'profile')
  const stateDir = path.join(root, 'state')
  const pluginDir = path.join(dir, 'node_modules', NAME)
  const otherDir = path.join(dir, 'node_modules', OTHER)
  fs.mkdirSync(pluginDir, { recursive: true })
  fs.mkdirSync(otherDir, { recursive: true })
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(MANIFEST, null, 2) + '\n')
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), LOCK)
  fs.writeFileSync(
    path.join(pluginDir, 'package.json'),
    JSON.stringify({ name: NAME, version: '1.0.0', engines: { dsh: '>=0.2.1-rc.1 <0.4.0' } }, null, 2) + '\n',
  )
  fs.writeFileSync(path.join(otherDir, 'package.json'), JSON.stringify({ name: OTHER, version: '2.5.0' }, null, 2) + '\n')

  const entry = {
    name: NAME,
    specifier: '1.0.0',
    kind: 'registry',
    installedVersion: '1.0.0',
    manifest: { name: NAME, version: '1.0.0', engines: { dsh: '>=0.2.1-rc.1 <0.4.0' } },
    bundleId: NAME,
    moduleDir: pluginDir,
  }
  const profile = {
    name: 'qa-profile',
    dir,
    isLocal: true,
    runtimeVersion: '0.2.1-rc.4',
    // A profile-provided manager keeps the probes away from PATH pnpm/corepack.
    packageManager: { command: process.execPath, args: ['-e', 'process.exit(0)'] },
    dshHome: root,
    manifestPath: path.join(dir, 'package.json'),
    manifest: structuredClone(MANIFEST),
    bundles: [...MANIFEST.dsh.profile.bundles],
    packages: [entry],
  }
  return { root, dir, stateDir, entry, profile }
}

async function withFake(mode, run) {
  const previous = process.env.DSH_UPDATER_FAKE_PM
  process.env.DSH_UPDATER_FAKE_PM = mode
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.DSH_UPDATER_FAKE_PM
    else process.env.DSH_UPDATER_FAKE_PM = previous
  }
}

function readManifest(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
}

function readBytes(dir) {
  return {
    manifest: fs.readFileSync(path.join(dir, 'package.json'), 'latin1'),
    lock: fs.readFileSync(path.join(dir, 'pnpm-lock.yaml'), 'latin1'),
    installed: fs.readFileSync(path.join(dir, 'node_modules', NAME, 'package.json'), 'latin1'),
    other: fs.readFileSync(path.join(dir, 'node_modules', OTHER, 'package.json'), 'latin1'),
  }
}

function exists(target) {
  try {
    fs.accessSync(target)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// uninstall
// ---------------------------------------------------------------------------

test('uninstall: removes the dependency, its bundle entry and node_modules', async (t) => {
  const fixture = await makeFixture(t)
  const progress = []
  const result = await withFake('success', () => uninstallPlugin({
    profile: fixture.profile,
    entry: fixture.entry,
    stateDir: fixture.stateDir,
    onProgress: step => progress.push(step.phase),
  }))

  assert.equal(result.ok, true, JSON.stringify(result.error))
  assert.equal(result.name, NAME)
  assert.equal(result.fromVersion, '1.0.0')
  assert.equal(result.needsRestart, true)
  assert.equal(result.rolledBack, false)
  assert.equal(result.error, null)

  const manifest = readManifest(fixture.dir)
  assert.equal(Object.hasOwn(manifest.dependencies, NAME), false)
  assert.equal(manifest.dependencies[OTHER], '2.5.0')
  assert.equal(manifest.dependencies['@deepseek-ai/dsh-market'], '1.73.6')
  // Remaining bundle entries keep their order, including the untouched tail.
  assert.deepEqual(manifest.dsh.profile.bundles, [OTHER, 'keep-me'])
  assert.equal(exists(path.join(fixture.dir, 'node_modules', NAME)), false)
  assert.equal(exists(path.join(fixture.dir, 'node_modules', OTHER)), true)

  assert.equal(typeof result.backupDir, 'string')
  assert.equal(result.backupDir.startsWith(path.join(fixture.stateDir, 'backups')), true)
  assert.equal(result.backupDir.endsWith('-uninstall'), true)
  assert.equal(exists(path.join(result.backupDir, 'package.json')), true)
  assert.ok(result.log.length > 0)
  assert.ok(progress.includes('backup'))
  assert.ok(progress.includes('remove'))
})

test('uninstall: builtin and local plugins are not managed', async (t) => {
  const fixture = await makeFixture(t)
  const builtin = await withFake('success', () => uninstallPlugin({
    profile: fixture.profile,
    entry: { name: '@deepseek-ai/dsh-base', kind: 'builtin', installedVersion: '1.0.0' },
    stateDir: fixture.stateDir,
  }))
  assert.equal(builtin.ok, false)
  assert.equal(builtin.error.code, 'not-managed')

  const local = await withFake('success', () => uninstallPlugin({
    profile: fixture.profile,
    entry: { name: 'linky', kind: 'local', installedVersion: '0.0.0' },
    stateDir: fixture.stateDir,
  }))
  assert.equal(local.ok, false)
  assert.equal(local.error.code, 'not-managed')
})

test('uninstall: refuses to remove the updater itself', async (t) => {
  const fixture = await makeFixture(t)
  const result = await withFake('success', () => uninstallPlugin({
    profile: fixture.profile,
    entry: { name: SELF, kind: 'registry', installedVersion: '1.0.0' },
    stateDir: fixture.stateDir,
  }))
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'self-operation')
  assert.equal(result.rolledBack, false)
  // Nothing was touched.
  assert.deepEqual(readManifest(fixture.dir), MANIFEST)
})

test('uninstall: a package manager failure rolls the profile back byte for byte', async (t) => {
  const fixture = await makeFixture(t)
  const before = readBytes(fixture.dir)
  const result = await withFake('fail', () => uninstallPlugin({
    profile: fixture.profile,
    entry: fixture.entry,
    stateDir: fixture.stateDir,
  }))
  const after = readBytes(fixture.dir)

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'uninstall-failed')
  assert.equal(result.rolledBack, true)
  assert.equal(after.manifest, before.manifest)
  assert.equal(after.lock, before.lock)
  assert.equal(after.installed, before.installed)
  assert.equal(after.other, before.other)
  assert.deepEqual(readManifest(fixture.dir).dsh.profile.bundles, MANIFEST.dsh.profile.bundles)
})

test('uninstall: an aborted signal is reported as cancelled without touching the profile', async (t) => {
  const fixture = await makeFixture(t)
  const before = readBytes(fixture.dir)
  const controller = new AbortController()
  controller.abort()
  const result = await withFake('success', () => uninstallPlugin({
    profile: fixture.profile,
    entry: fixture.entry,
    stateDir: fixture.stateDir,
    signal: controller.signal,
  }))
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'cancelled')
  assert.equal(result.rolledBack, false)
  assert.equal(readBytes(fixture.dir).manifest, before.manifest)
})

// ---------------------------------------------------------------------------
// reinstall
// ---------------------------------------------------------------------------

test('reinstall: installs the exact requested version and keeps bundles verbatim', async (t) => {
  const fixture = await makeFixture(t)
  const result = await withFake('success', () => reinstallPlugin({
    profile: fixture.profile,
    entry: fixture.entry,
    version: '1.2.0',
    installSpec: `${NAME}@1.2.0`,
    installKind: 'registry',
    stateDir: fixture.stateDir,
  }))

  assert.equal(result.ok, true, JSON.stringify(result.error))
  assert.equal(result.toVersion, '1.2.0')
  assert.equal(result.fromVersion, '1.0.0')
  assert.equal(result.needsRestart, true)
  assert.equal(result.rolledBack, false)

  const manifest = readManifest(fixture.dir)
  assert.equal(manifest.dependencies[NAME], '1.2.0')
  assert.equal(manifest.dependencies[OTHER], '2.5.0')
  assert.deepEqual(manifest.dsh.profile.bundles, MANIFEST.dsh.profile.bundles)
  const installed = JSON.parse(fs.readFileSync(path.join(fixture.dir, 'node_modules', NAME, 'package.json'), 'utf8'))
  assert.equal(installed.version, '1.2.0')
})

test('reinstall: an install failure restores the whole pre-reinstall profile', async (t) => {
  const fixture = await makeFixture(t)
  const before = readBytes(fixture.dir)
  const result = await withFake('fail', () => reinstallPlugin({
    profile: fixture.profile,
    entry: fixture.entry,
    version: '1.2.0',
    installSpec: `${NAME}@1.2.0`,
    installKind: 'registry',
    stateDir: fixture.stateDir,
  }))
  const after = readBytes(fixture.dir)

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'reinstall-failed')
  assert.equal(result.rolledBack, true)
  assert.equal(after.manifest, before.manifest)
  assert.equal(after.lock, before.lock)
  assert.equal(after.installed, before.installed)
  assert.equal(after.other, before.other)
  assert.deepEqual(readManifest(fixture.dir).dsh.profile.bundles, MANIFEST.dsh.profile.bundles)
})

test('reinstall: invalid versions and not-managed targets are rejected up front', async (t) => {
  const fixture = await makeFixture(t)
  const before = readBytes(fixture.dir)

  const invalid = await withFake('success', () => reinstallPlugin({
    profile: fixture.profile,
    entry: fixture.entry,
    version: 'not-a-version',
    stateDir: fixture.stateDir,
  }))
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error.code, 'reinstall-failed')

  const builtin = await withFake('success', () => reinstallPlugin({
    profile: fixture.profile,
    entry: { name: '@deepseek-ai/dsh-base', kind: 'builtin', installedVersion: '1.0.0' },
    stateDir: fixture.stateDir,
  }))
  assert.equal(builtin.ok, false)
  assert.equal(builtin.error.code, 'not-managed')

  const self = await withFake('success', () => reinstallPlugin({
    profile: fixture.profile,
    entry: { name: SELF, kind: 'registry', installedVersion: '1.0.0' },
    stateDir: fixture.stateDir,
  }))
  assert.equal(self.ok, false)
  assert.equal(self.error.code, 'self-operation')

  assert.equal(readBytes(fixture.dir).manifest, before.manifest)
})
