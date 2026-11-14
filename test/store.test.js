import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  SOURCE_IDS,
  DEFAULT_GITHUB_MIRRORS,
  DEFAULT_CONFIG,
  normalizeConfig,
  resolveDshHome,
  stateDir,
  writeJsonAtomic,
  loadConfig,
  saveConfig,
  normalizeCache,
  loadCache,
  saveCache,
  appendUpdateLog,
  readUpdateLog,
} from '../lib/core/store.js'

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-updater-store-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('SOURCE_IDS and default mirrors', () => {
  assert.deepEqual(SOURCE_IDS, ['npm-official', 'npm-mirror', 'github', 'github-mirror'])
  assert.deepEqual(DEFAULT_GITHUB_MIRRORS, [
    'https://gh-proxy.com',
    'https://ghfast.top',
    'https://ghproxy.net',
  ])
  assert.equal(DEFAULT_CONFIG.defaultSource, 'npm-mirror')
  assert.equal(DEFAULT_CONFIG.allowPrerelease, false)
})

test('normalizeConfig fills defaults and drops unknown fields', () => {
  const config = normalizeConfig(undefined)
  assert.deepEqual(config, {
    defaultSource: 'npm-mirror',
    customRegistry: '',
    githubMirrorPrefixes: [...DEFAULT_GITHUB_MIRRORS],
    allowPrerelease: false,
    checkIntervalHours: 6,
    ignore: [],
    perPackageSource: {},
    proxyUrl: '',
    requestTimeoutMs: 8000,
    concurrency: 4,
    totalTimeoutMs: 30000,
    autoCheckOnStart: true,
    checkOnStartup: 'force',
  })

  const withUnknown = normalizeConfig({ defaultSource: 'github', someFutureOption: 1 })
  assert.equal(withUnknown.defaultSource, 'github')
  assert.equal('someFutureOption' in withUnknown, false)
  assert.deepEqual(Object.keys(withUnknown).sort(), Object.keys(DEFAULT_CONFIG).sort())
})

test('normalizeConfig rejects invalid enum and registry values', () => {
  assert.equal(normalizeConfig({ defaultSource: 'ftp' }).defaultSource, 'npm-mirror')
  assert.equal(normalizeConfig({ defaultSource: 42 }).defaultSource, 'npm-mirror')

  assert.equal(normalizeConfig({ customRegistry: 'registry.example.com' }).customRegistry, '')
  assert.equal(normalizeConfig({ customRegistry: 'ftp://registry.example.com' }).customRegistry, '')
  assert.equal(
    normalizeConfig({ customRegistry: ' https://registry.example.com/ ' }).customRegistry,
    'https://registry.example.com',
  )

  assert.deepEqual(normalizeConfig({ perPackageSource: { a: 'github', b: 'nope', c: 3 } }).perPackageSource, {
    a: 'github',
  })
  assert.equal(normalizeConfig({ perPackageSource: [] }).perPackageSource.constructor, Object)
})

test('normalizeConfig normalizes mirrors and ignore list', () => {
  const config = normalizeConfig({
    githubMirrorPrefixes: [' https://gh-proxy.com/ ', 'ftp://bad', '', 'https://ghfast.top'],
    ignore: [' pkg-a ', 'pkg-a', '', 'pkg-b'],
  })
  assert.deepEqual(config.githubMirrorPrefixes, ['https://gh-proxy.com', 'https://ghfast.top'])
  assert.deepEqual(config.ignore, ['pkg-a', 'pkg-b'])

  // Empty / all-invalid mirror list falls back to defaults rather than disabling mirrors.
  assert.deepEqual(normalizeConfig({ githubMirrorPrefixes: [] }).githubMirrorPrefixes, [
    ...DEFAULT_GITHUB_MIRRORS,
  ])
  assert.deepEqual(normalizeConfig({ githubMirrorPrefixes: 'nope' }).githubMirrorPrefixes, [
    ...DEFAULT_GITHUB_MIRRORS,
  ])
})

test('normalizeConfig clamps numeric fields', () => {
  const low = normalizeConfig({
    checkIntervalHours: -1,
    requestTimeoutMs: 1,
    concurrency: 0,
    totalTimeoutMs: 1,
  })
  assert.equal(low.checkIntervalHours, 0.05)
  assert.equal(low.requestTimeoutMs, 1000)
  assert.equal(low.concurrency, 1)
  assert.equal(low.totalTimeoutMs, 5000)

  const high = normalizeConfig({
    checkIntervalHours: 100000,
    requestTimeoutMs: 100000,
    concurrency: 100,
    totalTimeoutMs: 1000000,
  })
  assert.equal(high.checkIntervalHours, 24 * 30)
  assert.equal(high.requestTimeoutMs, 60000)
  assert.equal(high.concurrency, 16)
  assert.equal(high.totalTimeoutMs, 300000)

  assert.equal(normalizeConfig({ concurrency: 3.6 }).concurrency, 4)
  assert.equal(normalizeConfig({ requestTimeoutMs: 'not-a-number' }).requestTimeoutMs, 8000)
  assert.equal(normalizeConfig({ concurrency: '2' }).concurrency, 2)
  assert.equal(normalizeConfig({ checkIntervalHours: '1.5' }).checkIntervalHours, 1.5)
  // Explicit floor/round-trip pairs: the 1000ms floor is a deliberate guard,
  // not an accident of clamping -- keep it pinned so a later change is visible.
  assert.equal(normalizeConfig({ requestTimeoutMs: 120 }).requestTimeoutMs, 1000)
  assert.equal(normalizeConfig({ requestTimeoutMs: 15000 }).requestTimeoutMs, 15000)
})

test('normalizeConfig accepts only a valid proxyUrl', () => {
  assert.equal(normalizeConfig({}).proxyUrl, '')
  assert.equal(normalizeConfig({ proxyUrl: 'http://127.0.0.1:7890' }).proxyUrl, 'http://127.0.0.1:7890')
  assert.equal(normalizeConfig({ proxyUrl: 'https://proxy.example:8443' }).proxyUrl, 'https://proxy.example:8443')
  for (const bad of ['proxy.example:8080', 'ftp://x', '  ', 42, null]) {
    assert.equal(normalizeConfig({ proxyUrl: bad }).proxyUrl, '', JSON.stringify(bad))
  }
})

test('normalizeConfig checkOnStartup is an enum defaulting to force', () => {
  assert.equal(DEFAULT_CONFIG.checkOnStartup, 'force')
  assert.equal(normalizeConfig({}).checkOnStartup, 'force')
  assert.equal(normalizeConfig({ checkOnStartup: 'force' }).checkOnStartup, 'force')
  assert.equal(normalizeConfig({ checkOnStartup: 'throttle' }).checkOnStartup, 'throttle')
  for (const bad of ['always', 'false', 1, null, undefined, {}]) {
    assert.equal(normalizeConfig({ checkOnStartup: bad }).checkOnStartup, 'force', JSON.stringify(bad))
  }
})

test('normalizeConfig autoCheckOnStart is opt-out only', () => {
  assert.equal(normalizeConfig({}).autoCheckOnStart, true)
  assert.equal(normalizeConfig({ autoCheckOnStart: false }).autoCheckOnStart, false)
  assert.equal(normalizeConfig({ autoCheckOnStart: 'false' }).autoCheckOnStart, true)
  assert.equal(normalizeConfig({ allowPrerelease: 'yes' }).allowPrerelease, false)
  assert.equal(normalizeConfig({ allowPrerelease: true }).allowPrerelease, true)
})

test('resolveDshHome precedence', (t) => {
  const previous = process.env.DSH_HOME
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  })

  delete process.env.DSH_HOME
  assert.equal(resolveDshHome({ dshHome: 'C:/explicit/home' }), path.resolve('C:/explicit/home'))

  process.env.DSH_HOME = path.join(os.tmpdir(), 'dsh-home-from-env')
  assert.equal(resolveDshHome({}), path.resolve(process.env.DSH_HOME))
  // Explicit hint still wins over the environment.
  assert.equal(resolveDshHome({ dshHome: path.join(os.tmpdir(), 'hint') }), path.resolve(os.tmpdir(), 'hint'))

  delete process.env.DSH_HOME
  const profileDir = path.join(os.tmpdir(), 'home2', 'profiles', 'desktop')
  assert.equal(resolveDshHome({ profileDir }), path.resolve(path.join(os.tmpdir(), 'home2')))
  assert.equal(resolveDshHome({}), path.join(os.homedir(), '.dsh'))
})

test('stateDir lives under <dshHome>/plugin-updater', () => {
  const home = path.join(os.tmpdir(), 'dsh-home-state')
  assert.equal(stateDir({ dshHome: home }), path.join(path.resolve(home), 'plugin-updater'))
})

test('loadConfig degrades to defaults for missing or corrupt config.json', (t) => {
  const dir = tempDir(t)
  assert.deepEqual(loadConfig(dir), normalizeConfig(undefined))

  fs.writeFileSync(path.join(dir, 'config.json'), '{ not json', 'utf8')
  assert.deepEqual(loadConfig(dir), normalizeConfig(undefined))

  fs.writeFileSync(path.join(dir, 'config.json'), '', 'utf8')
  assert.deepEqual(loadConfig(dir), normalizeConfig(undefined))

  fs.writeFileSync(path.join(dir, 'config.json'), '[1,2,3]', 'utf8')
  assert.deepEqual(loadConfig(dir), normalizeConfig(undefined))
})

test('saveConfig normalizes, writes atomically and round-trips', (t) => {
  const dir = path.join(tempDir(t), 'nested', 'plugin-updater')
  const saved = saveConfig(dir, {
    defaultSource: 'github',
    requestTimeoutMs: 1,
    ignore: [' a ', 'a'],
    unknown: 'dropped',
  })
  assert.equal(saved.defaultSource, 'github')
  assert.equal(saved.requestTimeoutMs, 1000)
  assert.deepEqual(saved.ignore, ['a'])

  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))
  assert.equal(raw.defaultSource, 'github')
  assert.equal('unknown' in raw, false)
  assert.deepEqual(loadConfig(dir), saved)

  // writeJsonAtomic must not leave temp files behind.
  const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [])
})

test('writeJsonAtomic creates parent directories and overwrites safely', (t) => {
  const dir = tempDir(t)
  const file = path.join(dir, 'a', 'b', 'state.json')
  writeJsonAtomic(file, { n: 1 })
  writeJsonAtomic(file, { n: 2 })
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { n: 2 })
})

test('normalizeCache validates shape', () => {
  assert.deepEqual(normalizeCache(undefined), {
    version: 1,
    lastCheckAt: null,
    runtimeVersion: null,
    packages: {},
  })
  assert.deepEqual(normalizeCache('nope'), {
    version: 1,
    lastCheckAt: null,
    runtimeVersion: null,
    packages: {},
  })

  const cache = normalizeCache({
    version: 99,
    lastCheckAt: '2026-01-01T00:00:00.000Z',
    runtimeVersion: '0.2.1-rc.4',
    packages: {
      good: { latest: '1.2.3' },
      bad: 'nope',
      alsoBad: null,
      array: [],
    },
  })
  assert.equal(cache.version, 1)
  assert.equal(cache.lastCheckAt, '2026-01-01T00:00:00.000Z')
  assert.equal(cache.runtimeVersion, '0.2.1-rc.4')
  assert.deepEqual(Object.keys(cache.packages), ['good'])

  assert.equal(normalizeCache({ lastCheckAt: 5 }).lastCheckAt, null)
})

test('loadCache / saveCache round-trip and degrade on corruption', (t) => {
  const dir = tempDir(t)
  const empty = loadCache(dir)
  assert.deepEqual(empty.packages, {})

  const cache = { version: 1, lastCheckAt: '2026-01-01T00:00:00.000Z', runtimeVersion: '0.2.1', packages: { a: { latest: '1.0.0' } } }
  saveCache(dir, cache)
  assert.deepEqual(loadCache(dir), cache)

  fs.writeFileSync(path.join(dir, 'cache.json'), '<<<', 'utf8')
  assert.deepEqual(loadCache(dir), empty)
})

test('appendUpdateLog and readUpdateLog', (t) => {
  const dir = path.join(tempDir(t), 'plugin-updater')
  assert.deepEqual(readUpdateLog(dir), []) // missing file is not an error

  appendUpdateLog(dir, { name: 'a', ok: true })
  appendUpdateLog(dir, { name: 'b', ok: false, code: 'install-failed' })

  const all = readUpdateLog(dir)
  assert.equal(all.length, 2)
  assert.equal(all[0].name, 'a')
  assert.equal(all[1].name, 'b')
  assert.equal(all[1].code, 'install-failed')
  assert.equal(typeof all[0].at, 'string')
  assert.ok(Number.isFinite(Date.parse(all[0].at)))

  const lastOne = readUpdateLog(dir, 1)
  assert.equal(lastOne.length, 1)
  assert.equal(lastOne[0].name, 'b')

  // Corrupt lines degrade to a marker instead of throwing.
  fs.appendFileSync(path.join(dir, 'update-log.jsonl'), '{broken\n', 'utf8')
  const tolerant = readUpdateLog(dir, 10)
  assert.equal(tolerant.length, 3)
  assert.deepEqual(tolerant[2], { unparsable: '{broken' })
})

test('appendUpdateLog never throws on an unusable directory', (t) => {
  const dir = tempDir(t)
  // A file where the directory should be makes mkdir/append fail.
  const blocked = path.join(dir, 'blocked')
  fs.writeFileSync(blocked, 'x', 'utf8')
  assert.doesNotThrow(() => appendUpdateLog(blocked, { name: 'a' }))
  assert.deepEqual(readUpdateLog(blocked), [])
})
