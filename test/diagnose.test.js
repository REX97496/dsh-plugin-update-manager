import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { diagnoseStartup, MAX_FILES, TAIL_BYTES } from '../lib/core/diagnose.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.join(HERE, 'fixtures', 'logs')

/** Read a checked-in log fixture (copied into a temp dir by tests, never scanned in place). */
function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8')
}

/** Create a temp dir removed after the test. */
function tempDir(t, prefix = 'dsh-updater-diag-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/**
 * Write log files into a fresh temp logs dir. Files get descending mtimes in the
 * order given, so `files[0]` is always the newest one.
 *
 * @param {import('node:test').TestContext} t
 * @param {Array<{ name: string, content: string }>} files
 * @returns {string} the logs directory
 */
function setupLogs(t, files) {
  const dir = tempDir(t)
  const now = Date.now()
  files.forEach((file, index) => {
    const filePath = path.join(dir, file.name)
    fs.writeFileSync(filePath, file.content)
    const mtime = new Date(now - index * 2000)
    fs.utimesSync(filePath, mtime, mtime)
  })
  return dir
}

/** A minimal profile object shaped like `loadProfile()` output. */
function profileWith(names, options = {}) {
  const installed = options.installedBy ?? {}
  return {
    name: 'desktop',
    dir: options.dir ?? path.join('C:', 'dsh-home', 'profiles', 'desktop'),
    dshHome: options.dshHome ?? path.join('C:', 'dsh-home'),
    runtimeVersion: '0.2.1-rc.4',
    runtimeSource: 'app-boot',
    manifest: { name: 'desktop', dependencies: Object.fromEntries(names.map(name => [name, '^1.0.0'])) },
    packages: names.map(name => ({
      name,
      installedVersion: installed[name] ?? '1.0.0',
      kind: 'registry',
    })),
    bundles: names,
  }
}

/** Find one diagnostic by plugin + code. */
function findItem(result, plugin, code) {
  return result.items.find(item => item.plugin === plugin && item.code === code)
}

test('exports the documented scan limits', () => {
  assert.equal(MAX_FILES, 3)
  assert.equal(TAIL_BYTES, 4 * 1024 * 1024)
})

test('classifies real startup log entries and drops unattributable ones', async (t) => {
  const logsDir = setupLogs(t, [{ name: 'startup-real.jsonl', content: readFixture('startup-real.jsonl') }])
  const result = await diagnoseStartup({
    logsDir,
    profile: profileWith(['dsh-skills-manager', 'dsh-ego-browser', 'whale_craft', 'video-preview']),
  })

  assert.equal(result.scanned.length, 1)
  assert.equal(result.scanned[0], 'startup-real.jsonl')

  // `without inject` from both the kernel event and the stderr child collapses to
  // one item per plugin+code; the later occurrence wins.
  const inject = findItem(result, 'dsh-skills-manager', 'missing-inject')
  assert.ok(inject, 'missing-inject item present')
  assert.equal(inject.severity, 'error')
  assert.equal(inject.title, '插件 API 不兼容')
  assert.match(inject.detail, /cannot get property "webServer" without inject/)
  assert.equal(result.items.filter(item => item.code === 'missing-inject').length, 1)

  // ERR_MODULE_NOT_FOUND resolves the package name from the message.
  const missing = findItem(result, 'dsh-ego-browser', 'missing-dependency')
  assert.ok(missing, 'missing-dependency item present')
  assert.match(missing.summary, /依赖没有安装完整/)

  // `failed to import` is a broken-package item without a reinstall command.
  const broken = findItem(result, 'whale_craft', 'broken-package')
  assert.ok(broken, 'broken-package item present')
  assert.equal(broken.fixes.some(fix => fix.kind === 'command'), false)

  // Info-level lines and "waiting for service" lines are not failures.
  assert.equal(result.items.some(item => item.plugin === 'video-preview'), false)
  // A host-wide error that mentions no installed package is dropped, not shown.
  assert.equal(result.items.some(item => item.plugin === 'experimental-inspector'), false)
  // The malformed JSON line degrades to plain text without crashing.
  assert.equal(result.items.some(item => item.detail.startsWith('{"time"')), false)
  // Only the three real failures remain.
  assert.equal(result.items.length, 3)
})

test('expands an HMR "did not activate" summary into one item per plugin', async (t) => {
  const logsDir = setupLogs(t, [{ name: 'startup-summary.jsonl', content: readFixture('startup-summary.jsonl') }])
  const result = await diagnoseStartup({
    logsDir,
    profile: profileWith(['dsh-skills-manager', 'whale_craft']),
    sinceMs: 0,
  })

  assert.equal(result.items.length, 2)
  assert.ok(findItem(result, 'dsh-skills-manager', 'missing-inject'))
  assert.ok(findItem(result, 'whale_craft', 'broken-package'))
})

test('plain-text log lines classify incompatible rebuilds without a cache', async (t) => {
  const logsDir = setupLogs(t, [{ name: 'desktop-next-fixture.log', content: readFixture('desktop-next-fixture.log') }])
  const profile = profileWith(['dsh-skills-manager', 'dsh-office'])
  const result = await diagnoseStartup({ logsDir, profile })

  const incompatible = findItem(result, 'dsh-skills-manager', 'incompatible')
  assert.ok(incompatible, 'incompatible item present')
  assert.equal(incompatible.severity, 'error')
  assert.equal(incompatible.fixes.some(fix => fix.kind === 'update'), false)
  assert.ok(incompatible.fixes.some(fix => fix.kind === 'text'))

  const syntax = findItem(result, 'dsh-office', 'broken-package')
  assert.ok(syntax, 'plain-text SyntaxError attributed by package name')
  const command = syntax.fixes.find(fix => fix.kind === 'command')
  assert.ok(command, 'reinstall command offered')
  assert.equal(command.command, 'corepack pnpm add dsh-office@1.0.0 --save-exact --force')
  assert.equal(command.cwd, profile.dir)
})

test('offers a compatible update when the cache knows compatibleMax', async (t) => {
  const logsDir = setupLogs(t, [{ name: 'desktop-next-fixture.log', content: readFixture('desktop-next-fixture.log') }])
  const profile = profileWith(['dsh-skills-manager', 'dsh-office'])

  const withUpdate = await diagnoseStartup({
    logsDir,
    profile,
    cache: { 'dsh-skills-manager': { compatibleMax: '0.2.9' } },
  })
  const fix = findItem(withUpdate, 'dsh-skills-manager', 'incompatible').fixes.find(item => item.kind === 'update')
  assert.ok(fix, 'update fix present')
  assert.equal(fix.version, '0.2.9')
  assert.match(fix.label, /更新到 0\.2\.9/)

  // Already on the newest compatible version: no update suggestion.
  const sameVersion = await diagnoseStartup({
    logsDir,
    profile: profileWith(['dsh-skills-manager', 'dsh-office'], { installedBy: { 'dsh-skills-manager': '0.2.9' } }),
    cache: { 'dsh-skills-manager': { compatibleMax: '0.2.9' } },
  })
  const noFix = findItem(sameVersion, 'dsh-skills-manager', 'incompatible')
  assert.equal(noFix.fixes.some(item => item.kind === 'update'), false)
})

test('missing dependency from a link: plugin points the install at the plugin root', async (t) => {
  const pluginRoot = tempDir(t, 'dsh-xyz-plugin-')
  fs.writeFileSync(path.join(pluginRoot, 'package.json'), JSON.stringify({ name: 'dsh-xyz', version: '1.0.0' }))
  fs.mkdirSync(path.join(pluginRoot, 'lib'))
  const importedFrom = path.join(pluginRoot, 'lib', 'index.js')

  const line = JSON.stringify({
    time: '2026-11-14T07:59:25.129Z',
    source: 'host.kernel.include',
    level: 'error',
    message: `Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/schemastery' imported from ${importedFrom}`,
  })
  const logsDir = setupLogs(t, [{ name: 'link-plugin.jsonl', content: `${line}\n` }])
  const result = await diagnoseStartup({ logsDir, profile: profileWith(['dsh-xyz']) })

  const item = findItem(result, 'dsh-xyz', 'missing-dependency')
  assert.ok(item)
  const command = item.fixes.find(fix => fix.kind === 'command')
  assert.equal(command.label, '在插件目录安装依赖')
  assert.equal(command.cwd, pluginRoot)
  assert.equal(command.command, 'corepack pnpm install --config.strict-dep-builds=false')
})

test('missing dependency without a path falls back to the profile directory', async (t) => {
  const line = JSON.stringify({
    time: '2026-11-14T07:59:25.129Z',
    source: 'host.kernel.dsh-xyz',
    level: 'error',
    message: "Error: Cannot find module 'left-pad'",
  })
  const logsDir = setupLogs(t, [{ name: 'profile-dep.jsonl', content: `${line}\n` }])
  const profile = profileWith(['dsh-xyz'])
  const result = await diagnoseStartup({ logsDir, profile })

  const item = findItem(result, 'dsh-xyz', 'missing-dependency')
  assert.ok(item)
  const command = item.fixes.find(fix => fix.kind === 'command')
  assert.equal(command.label, '在 profile 目录重装依赖')
  assert.equal(command.cwd, profile.dir)
})

test('ignored build scripts offer pnpm approve-builds', async (t) => {
  const line = JSON.stringify({
    time: '2026-11-14T07:59:25.129Z',
    source: 'host.kernel.dsh-office',
    level: 'error',
    message: 'ERR_PNPM_IGNORED_BUILDS  Ignored build scripts: protobufjs@7.6.6',
  })
  const logsDir = setupLogs(t, [{ name: 'ignored-builds.jsonl', content: `${line}\n` }])
  const profile = profileWith(['dsh-office'])
  const result = await diagnoseStartup({ logsDir, profile })

  const item = findItem(result, 'dsh-office', 'ignored-builds')
  assert.ok(item)
  assert.equal(item.severity, 'error')
  const command = item.fixes.find(fix => fix.kind === 'command')
  assert.equal(command.command, 'pnpm approve-builds')
  assert.equal(command.cwd, profile.dir)
})

test('built-in plugins only get an explanatory fix', async (t) => {
  const line = JSON.stringify({
    time: '2026-11-14T07:59:25.129Z',
    source: 'host.kernel.@deepseek-ai/dsh-builtin-x',
    level: 'error',
    message: 'Error: cannot get property "webServer" without inject',
  })
  const logsDir = setupLogs(t, [{ name: 'builtin.jsonl', content: `${line}\n` }])
  const result = await diagnoseStartup({ logsDir, profile: profileWith(['@deepseek-ai/dsh-builtin-x']) })

  const item = findItem(result, '@deepseek-ai/dsh-builtin-x', 'missing-inject')
  assert.ok(item)
  assert.equal(item.fixes.length, 1)
  assert.equal(item.fixes[0].kind, 'text')
  assert.equal(item.fixes[0].label, '内置插件')
})

test('duplicate registration gets a single text fix', async (t) => {
  const line = JSON.stringify({
    time: '2026-11-14T07:59:25.129Z',
    source: 'host.kernel.dsh-office',
    level: 'error',
    message: 'Error: service "office.sidebar" already registered by another plugin',
  })
  const logsDir = setupLogs(t, [{ name: 'duplicate.jsonl', content: `${line}\n` }])
  const result = await diagnoseStartup({ logsDir, profile: profileWith(['dsh-office']) })

  const item = findItem(result, 'dsh-office', 'duplicate-registration')
  assert.ok(item)
  assert.deepEqual(item.fixes.map(fix => fix.kind), ['text'])
  assert.match(item.fixes[0].label, /重复注册/)
})

test('unknown kernel errors keep the plugin and suggest reporting', async (t) => {
  const line = JSON.stringify({
    time: '2026-11-14T07:59:25.129Z',
    source: 'host.kernel.dsh-office',
    level: 'error',
    message: 'Error: something odd happened while wiring the sidebar',
  })
  const logsDir = setupLogs(t, [{ name: 'unknown.jsonl', content: `${line}\n` }])
  const result = await diagnoseStartup({ logsDir, profile: profileWith(['dsh-office']) })

  const item = findItem(result, 'dsh-office', 'unknown')
  assert.ok(item)
  assert.equal(item.title, '插件加载出错')
  assert.equal(item.fixes[0].kind, 'text')
  assert.match(item.fixes[0].detail, /反馈给插件作者/)
})

test('dedupes plugin+code keeping the newest occurrence', async (t) => {
  const older = JSON.stringify({
    time: '2026-11-14T01:00:00.000Z',
    source: 'host.kernel.dsh-office',
    level: 'error',
    message: 'Error: cannot get property "webServer" without inject MARKER-OLD',
  })
  const newer = JSON.stringify({
    time: '2026-11-14T02:00:00.000Z',
    source: 'host.kernel.dsh-office',
    level: 'error',
    message: 'Error: cannot get property "webServer" without inject MARKER-NEW',
  })
  const logsDir = setupLogs(t, [{ name: 'dedupe.jsonl', content: `${older}\n${newer}\n` }])
  const result = await diagnoseStartup({ logsDir, profile: profileWith(['dsh-office']), sinceMs: 0 })

  assert.equal(result.items.length, 1)
  assert.match(result.items[0].detail, /MARKER-NEW/)
  assert.equal(result.items[0].at, '2026-11-14T02:00:00.000Z')
})

test('truncates detail to 2000 chars and redacts secrets', async (t) => {
  const line = JSON.stringify({
    time: '2026-11-14T07:59:25.129Z',
    source: 'host.kernel.dsh-office',
    level: 'error',
    message: `token=supersecret Error: cannot get property "webServer" without inject ${'A'.repeat(3000)}`,
  })
  const logsDir = setupLogs(t, [{ name: 'long.jsonl', content: `${line}\n` }])
  const result = await diagnoseStartup({ logsDir, profile: profileWith(['dsh-office']) })

  const item = result.items[0]
  // Redaction runs after truncation and can shorten the excerpt, so the cap is
  // an upper bound rather than an exact length.
  assert.ok(item.detail.length <= 2000)
  assert.ok(item.detail.length > 1900)
  assert.ok(item.detail.endsWith('…'))
  assert.match(item.detail, /token=\*\*\*/)
  assert.equal(item.detail.includes('supersecret'), false)
  assert.ok(item.summary.length <= 160)
})

test('merges dsh- aliases so one plugin yields one name', async (t) => {
  const entries = [
    {
      time: '2026-11-14T03:00:00.000Z',
      source: 'host.kernel.ego-browser',
      level: 'error',
      message: 'Error: cannot get property "webServer" without inject',
    },
    {
      time: '2026-11-14T03:00:01.000Z',
      source: 'host.kernel.include',
      level: 'error',
      message: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@scope/missing' imported from C:\\plugins\\dsh-ego-browser\\lib\\index.js",
    },
  ]
  const logsDir = setupLogs(t, [{ name: 'aliases.jsonl', content: entries.map(entry => JSON.stringify(entry)).join('\n') + '\n' }])
  const result = await diagnoseStartup({
    logsDir,
    profile: profileWith(['ego-browser', 'dsh-ego-browser']),
    sinceMs: 0,
  })

  assert.equal(result.items.length, 2)
  assert.ok(findItem(result, 'dsh-ego-browser', 'missing-inject'))
  assert.ok(findItem(result, 'dsh-ego-browser', 'missing-dependency'))
  assert.equal(result.items.some(item => item.plugin === 'ego-browser'), false)
})

test('returns empty items when the log directory does not exist', async (t) => {
  const missingDir = path.join(tempDir(t), 'no-logs-here')
  const result = await diagnoseStartup({ logsDir: missingDir, profile: profileWith(['dsh-office']) })

  assert.equal(result.items.length, 0)
  assert.equal(result.scanned.length, 0)
  assert.ok(result.errors.length >= 1)
  assert.equal(typeof result.errors[0].file, 'string')
  assert.equal(typeof result.errors[0].message, 'string')
})

test('reports a missing dshHome instead of guessing a logs dir', async () => {
  const result = await diagnoseStartup({})

  assert.equal(result.items.length, 0)
  assert.equal(result.scanned.length, 0)
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0].message, /无法确定日志目录/)
})

test('scans the newest MAX_FILES logs and honours limitFiles', async (t) => {
  const files = ['a.jsonl', 'b.jsonl', 'c.jsonl', 'd.jsonl'].map(name => ({
    name,
    content: `${JSON.stringify({ time: '2026-11-14T07:59:25.129Z', level: 'info', message: 'benign' })}\n`,
  }))
  const logsDir = setupLogs(t, files)
  const profile = profileWith([])

  const defaultScan = await diagnoseStartup({ logsDir, profile })
  assert.equal(defaultScan.scanned.length, MAX_FILES)
  assert.deepEqual(defaultScan.scanned, ['a.jsonl', 'b.jsonl', 'c.jsonl'])

  const single = await diagnoseStartup({ logsDir, profile, limitFiles: 1 })
  assert.deepEqual(single.scanned, ['a.jsonl'])

  const clamped = await diagnoseStartup({ logsDir, profile, limitFiles: 99 })
  assert.equal(clamped.scanned.length, MAX_FILES)
})

test('sinceMs filters out older lines only when explicitly provided', async (t) => {
  const lines = [
    { time: '2026-11-14T01:00:00.000Z', source: 'host.kernel.dsh-office', level: 'error', message: 'Error: cannot get property "webServer" without inject OLD' },
    { time: '2026-11-14T02:00:00.000Z', source: 'host.kernel.dsh-office', level: 'error', message: 'Error: cannot get property "webServer" without inject NEW' },
  ]
  const logsDir = setupLogs(t, [{ name: 'window.jsonl', content: lines.map(line => JSON.stringify(line)).join('\n') + '\n' }])
  const profile = profileWith(['dsh-office'])

  const filtered = await diagnoseStartup({ logsDir, profile, sinceMs: Date.parse('2026-11-14T01:30:00.000Z') })
  assert.equal(filtered.items.length, 1)
  assert.match(filtered.items[0].detail, /NEW/)

  // Without sinceMs the file-level window is used, so both lines are read.
  const unfiltered = await diagnoseStartup({ logsDir, profile })
  assert.match(unfiltered.items[0].detail, /NEW/)
})

test('handles a non-object input and empty logs without throwing', async (t) => {
  const logsDir = tempDir(t)
  assert.deepEqual((await diagnoseStartup(null)).items, [])
  const empty = await diagnoseStartup({ logsDir, profile: profileWith([]) })
  assert.deepEqual(empty.items, [])
  assert.deepEqual(empty.scanned, [])
})
