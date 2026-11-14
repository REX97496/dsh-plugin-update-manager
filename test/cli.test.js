import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { main, parseArgs, USAGE } from '../lib/cli.js'

const RUNTIME_RANGE = '>=0.2.1-rc.1 <0.4.0'
const INCOMPATIBLE_RANGE = '>=0.4.0 <0.5.0'

/**
 * Minimal npm registry stub serving one abbreviated metadata document.
 *
 * @param {import('node:test').TestContext} t
 * @param {string} name
 * @param {Record<string, unknown>} versions
 * @param {string} latest
 */
async function startRegistry(t, name, versions, latest) {
  const requests = []
  const body = { name, 'dist-tags': { latest }, versions }
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers })
    const text = JSON.stringify(body)
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
    res.end(text)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return { base: `http://127.0.0.1:${port}`, requests }
}

/**
 * Temporary profile shaped like a real desktop profile: one registry package
 * plus one linked local package. The plugin config lives under the fake DSH
 * home so `loadConfig(stateDir)` sees the stub registry.
 *
 * @param {import('node:test').TestContext} t
 * @param {string} registryUrl
 */
function makeProfile(t, registryUrl) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-updater-cli-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const dir = path.join(root, 'profile')
  fs.mkdirSync(path.join(dir, 'node_modules', 'demo-plugin'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'node_modules', '@local', 'linked'), { recursive: true })

  const manifest = {
    name: 'test-profile',
    private: true,
    dependencies: {
      'demo-plugin': '1.0.0',
      '@local/linked': 'link:../linked',
    },
    dsh: { profile: { bundles: ['demo-plugin', '@local/linked'] } },
  }
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  fs.writeFileSync(
    path.join(dir, 'node_modules', 'demo-plugin', 'package.json'),
    `${JSON.stringify({ name: 'demo-plugin', version: '1.0.0', engines: { dsh: RUNTIME_RANGE } }, null, 2)}\n`,
  )
  fs.writeFileSync(
    path.join(dir, 'node_modules', '@local', 'linked', 'package.json'),
    `${JSON.stringify({ name: '@local/linked', version: '9.9.9' }, null, 2)}\n`,
  )

  const stateDir = path.join(root, 'plugin-updater')
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(
    path.join(stateDir, 'config.json'),
    `${JSON.stringify({ customRegistry: registryUrl, defaultSource: 'npm-mirror' }, null, 2)}\n`,
  )

  return { root, dir, stateDir }
}

/** @param {import('node:test').TestContext} t */
function withFakePm(t) {
  const before = process.env.DSH_UPDATER_FAKE_PM
  process.env.DSH_UPDATER_FAKE_PM = 'success'
  t.after(() => {
    if (before === undefined) delete process.env.DSH_UPDATER_FAKE_PM
    else process.env.DSH_UPDATER_FAKE_PM = before
  })
}

/**
 * @param {import('node:test').TestContext} t
 * @param {{root: string, dir: string}} fixture
 * @param {string[]} args
 */
async function runMain(t, fixture, args) {
  const stdout = []
  const stderr = []
  const argv = args.includes('--profile-dir') ? args : [...args, '--profile-dir', fixture.dir]
  const code = await main(argv, {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    env: { ...process.env, DSH_HOME: fixture.root, DSH_RUNTIME_VERSION: '0.2.1-rc.4' },
  })
  return { code, stdout, stderr }
}

/**
 * @param {string[]} lines
 */
function parseJsonLines(lines) {
  return lines.map((line) => JSON.parse(line))
}

/** @param {string} dir */
function installedVersion(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', 'demo-plugin', 'package.json'), 'utf8')).version
}

/** @param {string} dir */
function profileManifest(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
}

const VERSIONS = {
  '1.0.0': { name: 'demo-plugin', version: '1.0.0', engines: { dsh: RUNTIME_RANGE }, dist: { tarball: 'https://example.test/demo-plugin-1.0.0.tgz' } },
  '1.2.0': { name: 'demo-plugin', version: '1.2.0', engines: { dsh: RUNTIME_RANGE }, dist: { tarball: 'https://example.test/demo-plugin-1.2.0.tgz' } },
  '2.0.0': { name: 'demo-plugin', version: '2.0.0', engines: { dsh: INCOMPATIBLE_RANGE }, dist: { tarball: 'https://example.test/demo-plugin-2.0.0.tgz' } },
}

test('cli: parseArgs handles update name@version, flags and inline scoped names', () => {
  const simple = parseArgs(['update', 'demo-plugin@1.2.0'])
  assert.equal(simple.command, 'update')
  assert.equal(simple.name, 'demo-plugin')
  assert.equal(simple.version, '1.2.0')
  assert.deepEqual(simple.errors, [])

  const scoped = parseArgs(['update', '@scope/demo@2.0.0', '--json', '--source', 'github', '--allow-incompatible'])
  assert.equal(scoped.name, '@scope/demo')
  assert.equal(scoped.version, '2.0.0')
  assert.equal(scoped.json, true)
  assert.equal(scoped.source, 'github')
  assert.equal(scoped.allowIncompatible, true)
  assert.deepEqual(scoped.errors, [])

  const flagVersion = parseArgs(['update', 'demo-plugin', '--version', '1.2.0', '--profile-dir', '/tmp/p'])
  assert.equal(flagVersion.name, 'demo-plugin')
  assert.equal(flagVersion.version, '1.2.0')
  assert.equal(flagVersion.profileDir, '/tmp/p')

  const check = parseArgs(['check'])
  assert.equal(check.command, 'check')
  assert.deepEqual(check.errors, [])

  const badVersion = parseArgs(['update', 'demo-plugin@1.2'])
  assert.ok(badVersion.errors.some((message) => message.includes('版本号不合法')), badVersion.errors.join('；'))

  const missingVersion = parseArgs(['update', 'demo-plugin'])
  assert.ok(missingVersion.errors.some((message) => message.includes('需要版本号')), missingVersion.errors.join('；'))

  const unknownOption = parseArgs(['update', 'demo-plugin@1.0.0', '--wat'])
  assert.ok(unknownOption.errors.some((message) => message.includes('未知选项')), unknownOption.errors.join('；'))

  const badSource = parseArgs(['check', '--source', 'ftp'])
  assert.ok(badSource.errors.some((message) => message.includes('未知的版本源')), badSource.errors.join('；'))
})

test('cli: --help prints usage and exits 0', async (t) => {
  const stdout = []
  const code = await main(['--help'], { stdout: (line) => stdout.push(line), stderr: () => {} })
  assert.equal(code, 0)
  assert.equal(stdout.join('\n'), USAGE)
})

test('cli: invalid version exits 2 without touching the profile', async (t) => {
  const stdout = []
  const stderr = []
  const code = await main(['update', 'demo-plugin', '--version', '1.2'], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    env: { ...process.env },
  })
  assert.equal(code, 2)
  assert.ok(stderr.join('\n').includes('版本号不合法'), stderr.join('\n'))
})

test('cli: unknown package and non-registry dependency exit 2', async (t) => {
  const registry = await startRegistry(t, 'demo-plugin', VERSIONS, '1.2.0')
  const fixture = makeProfile(t, registry.base)

  const missing = await runMain(t, fixture, ['update', 'missing-plugin@1.2.0'])
  assert.equal(missing.code, 2)
  assert.ok(missing.stderr.join('\n').includes('找不到包'), missing.stderr.join('\n'))

  const local = await runMain(t, fixture, ['update', '@local/linked@1.0.0'])
  assert.equal(local.code, 2)
  assert.ok(local.stderr.join('\n').includes('local'), local.stderr.join('\n'))
})

test('cli: check resolves candidates without installing', async (t) => {
  const registry = await startRegistry(t, 'demo-plugin', VERSIONS, '1.2.0')
  const fixture = makeProfile(t, registry.base)

  const result = await runMain(t, fixture, ['check', 'demo-plugin'])
  assert.equal(result.code, 0)
  const output = result.stdout.join('\n')
  assert.ok(output.includes('已安装 1.0.0'), output)
  assert.ok(output.includes('1.2.0'), output)
  assert.ok(output.includes('update-latest'), output)
  for (const line of result.stdout) assert.ok(line.startsWith('[plugin-updater]'), line)
  assert.equal(installedVersion(fixture.dir), '1.0.0')
})

test('cli: check --json emits one JSON object per line', async (t) => {
  const registry = await startRegistry(t, 'demo-plugin', VERSIONS, '1.2.0')
  const fixture = makeProfile(t, registry.base)

  const result = await runMain(t, fixture, ['check', 'demo-plugin', '--json'])
  assert.equal(result.code, 0)
  const events = parseJsonLines(result.stdout)
  assert.ok(events.every((event) => typeof event.event === 'string'))
  const checked = events.find((event) => event.event === 'check')
  assert.ok(checked, JSON.stringify(events))
  assert.equal(checked.latestVersion, '1.2.0')
  assert.equal(checked.compatibleMax, '1.2.0')
  assert.equal(checked.status, 'update-latest')
  assert.equal(checked.target, '1.2.0')
})

test('cli: successful update prints the restart hint and updates the profile', async (t) => {
  withFakePm(t)
  const registry = await startRegistry(t, 'demo-plugin', VERSIONS, '1.2.0')
  const fixture = makeProfile(t, registry.base)

  const result = await runMain(t, fixture, ['update', 'demo-plugin@1.2.0'])
  assert.equal(result.code, 0, result.stderr.join('\n'))
  assert.equal(installedVersion(fixture.dir), '1.2.0')
  assert.equal(profileManifest(fixture.dir).dependencies['demo-plugin'], '1.2.0')
  const output = result.stdout.join('\n')
  assert.ok(output.includes('需要重启 DSH'), output)
  for (const line of result.stdout) assert.ok(line.startsWith('[plugin-updater]'), line)
})

test('cli: successful update in --json mode emits step and success events', async (t) => {
  withFakePm(t)
  const registry = await startRegistry(t, 'demo-plugin', VERSIONS, '1.2.0')
  const fixture = makeProfile(t, registry.base)

  const result = await runMain(t, fixture, ['update', 'demo-plugin', '--version', '1.2.0', '--json'])
  assert.equal(result.code, 0, result.stderr.join('\n'))
  const events = parseJsonLines(result.stdout)
  assert.ok(events.some((event) => event.event === 'step' && typeof event.phase === 'string'), JSON.stringify(events))
  const success = events.find((event) => event.event === 'success')
  assert.ok(success, JSON.stringify(events))
  assert.equal(success.toVersion, '1.2.0')
  assert.equal(success.needsRestart, true)
  assert.equal(installedVersion(fixture.dir), '1.2.0')
})

test('cli: incompatible target exits 2 unless --allow-incompatible is given', async (t) => {
  withFakePm(t)
  const registry = await startRegistry(t, 'demo-plugin', VERSIONS, '2.0.0')
  const fixture = makeProfile(t, registry.base)

  const blocked = await runMain(t, fixture, ['update', 'demo-plugin@2.0.0'])
  assert.equal(blocked.code, 2)
  const message = blocked.stderr.join('\n')
  assert.ok(message.includes('不兼容'), message)
  assert.ok(message.includes('--allow-incompatible'), message)
  assert.equal(installedVersion(fixture.dir), '1.0.0')

  const forced = await runMain(t, fixture, ['update', 'demo-plugin@2.0.0', '--allow-incompatible'])
  assert.equal(forced.code, 0, forced.stderr.join('\n'))
  assert.equal(installedVersion(fixture.dir), '2.0.0')
})
