import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import { runUpdate, classifyPnpmFailure, failureDetail } from '../lib/core/update.js'
import * as semver from '../lib/core/semver.js'

const RUNTIME = '0.2.1-rc.4'
const NAME = 'demo-plugin'
const OLD_VERSION = '1.0.0'
const NEW_VERSION = '1.2.0'

const LOCKFILE = 'lockfileVersion: 9\n\nimporters:\n  .:\n    dependencies:\n      demo-plugin:\n        specifier: 1.0.0\n        version: 1.0.0\n'

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function bytesOf(file) {
  return readFileSync(file)
}

/**
 * Build a throwaway profile:
 *   <root>/profile/package.json
 *   <root>/profile/pnpm-lock.yaml
 *   <root>/profile/node_modules/demo-plugin/package.json
 *   <root>/profile/node_modules/other-plugin/package.json
 *   <root>/state                          (stateDir)
 */
function makeProfile(t, { withLockfile = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-updater-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const dir = join(root, 'profile')
  const stateDir = join(root, 'state')
  mkdirSync(join(dir, 'node_modules', NAME), { recursive: true })
  mkdirSync(join(dir, 'node_modules', 'other-plugin'), { recursive: true })
  mkdirSync(stateDir, { recursive: true })

  const manifest = {
    name: 'test-profile',
    private: true,
    dependencies: {
      [NAME]: OLD_VERSION,
      'other-plugin': '2.5.0',
      '@deepseek-ai/dsh-market': '1.73.6',
    },
    dsh: {
      profile: {
        bundles: [NAME, 'other-plugin'],
      },
    },
  }
  const manifestPath = join(dir, 'package.json')
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  if (withLockfile) writeFileSync(join(dir, 'pnpm-lock.yaml'), LOCKFILE)

  writeFileSync(
    join(dir, 'node_modules', NAME, 'package.json'),
    `${JSON.stringify({ name: NAME, version: OLD_VERSION, engines: { dsh: '>=0.2.1-rc.1 <0.4.0' } }, null, 2)}\n`,
  )
  writeFileSync(
    join(dir, 'node_modules', 'other-plugin', 'package.json'),
    `${JSON.stringify({ name: 'other-plugin', version: '2.5.0' }, null, 2)}\n`,
  )

  const profile = {
    name: 'test-profile',
    dir,
    isLocal: true,
    runtimeVersion: RUNTIME,
    packageManager: null,
    dshHome: root,
    manifestPath,
    manifest,
    bundles: [NAME, 'other-plugin'],
    packages: [],
  }
  const entry = {
    name: NAME,
    specifier: OLD_VERSION,
    kind: 'registry',
    installedVersion: OLD_VERSION,
    manifest: { name: NAME, version: OLD_VERSION, engines: { dsh: '>=0.2.1-rc.1 <0.4.0' } },
    bundleId: NAME,
    moduleDir: join(dir, 'node_modules', NAME),
  }
  const target = {
    version: NEW_VERSION,
    installSpec: `${NAME}@${NEW_VERSION}`,
    installKind: 'registry',
  }
  return { root, dir, stateDir, manifestPath, profile, entry, target }
}

/** Run a case with DSH_UPDATER_FAKE_PM set for the duration of the call. */
async function withFakePm(t, mode, run) {
  const previous = process.env.DSH_UPDATER_FAKE_PM
  process.env.DSH_UPDATER_FAKE_PM = mode
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_UPDATER_FAKE_PM
    else process.env.DSH_UPDATER_FAKE_PM = previous
  })
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.DSH_UPDATER_FAKE_PM
    else process.env.DSH_UPDATER_FAKE_PM = previous
  }
}

function assertUntouchedBytes(a, b, label) {
  assert.deepEqual(bytesOf(a), bytesOf(b), `${label} changed bytes`)
}

function snapshotProfile(fixture) {
  return {
    manifest: bytesOf(fixture.manifestPath),
    lockfile: bytesOf(join(fixture.dir, 'pnpm-lock.yaml')),
    installed: bytesOf(join(fixture.dir, 'node_modules', NAME, 'package.json')),
    other: bytesOf(join(fixture.dir, 'node_modules', 'other-plugin', 'package.json')),
  }
}

test('update: success installs the target version and needs a restart', async (t) => {
  const fixture = makeProfile(t)
  const before = snapshotProfile(fixture)

  const result = await withFakePm(t, 'success', () =>
    runUpdate({
      profile: fixture.profile,
      entry: fixture.entry,
      target: fixture.target,
      runtimeVersion: RUNTIME,
      stateDir: fixture.stateDir,
    }),
  )

  assert.equal(result.ok, true, JSON.stringify(result.error))
  assert.equal(result.name, NAME)
  assert.equal(result.fromVersion, OLD_VERSION)
  assert.equal(result.toVersion, NEW_VERSION)
  assert.equal(result.needsRestart, true)
  assert.equal(result.rolledBack, false)
  assert.equal(result.error, null)
  assert.equal(typeof result.durationMs, 'number')
  assert.ok(Array.isArray(result.log) && result.log.length > 0, 'log should describe the steps')

  assert.ok(result.backupDir, 'backupDir must be reported')
  assert.ok(existsSync(result.backupDir), `backupDir missing: ${result.backupDir}`)
  assert.ok(dirname(result.backupDir).endsWith(join('backups')), result.backupDir)
  assert.ok(result.backupDir.includes(`${NAME}@`), result.backupDir)
  assert.deepEqual(bytesOf(join(result.backupDir, 'package.json')), before.manifest)
  assert.deepEqual(bytesOf(join(result.backupDir, 'pnpm-lock.yaml')), before.lockfile)
  assert.deepEqual(
    bytesOf(join(result.backupDir, 'node_modules', NAME, 'package.json')),
    before.installed,
  )

  const installed = readJson(join(fixture.dir, 'node_modules', NAME, 'package.json'))
  assert.equal(installed.version, NEW_VERSION)

  const manifest = readJson(fixture.manifestPath)
  assert.deepEqual(manifest.dependencies['other-plugin'], '2.5.0')
  assert.deepEqual(manifest.dependencies['@deepseek-ai/dsh-market'], '1.73.6')
  assert.deepEqual(manifest.dsh.profile.bundles, [NAME, 'other-plugin'])
  // A successful install rewrites this one dependency pin (pnpm add --save-exact)
  // and must leave every other manifest field alone.
  assert.equal(manifest.dependencies[NAME], NEW_VERSION)

  assert.deepEqual(bytesOf(join(fixture.dir, 'node_modules', 'other-plugin', 'package.json')), before.other)
})

test('update: version-mismatch rolls the profile back byte for byte', async (t) => {
  const fixture = makeProfile(t)
  const before = snapshotProfile(fixture)

  const result = await withFakePm(t, 'mismatch', () =>
    runUpdate({
      profile: fixture.profile,
      entry: fixture.entry,
      target: fixture.target,
      runtimeVersion: RUNTIME,
      stateDir: fixture.stateDir,
    }),
  )

  assert.equal(result.ok, false)
  assert.ok(result.error, 'error is required on failure')
  assert.equal(result.error.code, 'version-mismatch')
  assert.equal(typeof result.error.message, 'string')
  assert.ok(result.error.message.length > 0)
  assert.equal(result.rolledBack, true)

  assert.deepEqual(bytesOf(fixture.manifestPath), before.manifest)
  assert.deepEqual(bytesOf(join(fixture.dir, 'pnpm-lock.yaml')), before.lockfile)
  assert.deepEqual(bytesOf(join(fixture.dir, 'node_modules', NAME, 'package.json')), before.installed)
  assert.deepEqual(bytesOf(join(fixture.dir, 'node_modules', 'other-plugin', 'package.json')), before.other)

  const manifest = readJson(fixture.manifestPath)
  assert.deepEqual(manifest.dsh.profile.bundles, [NAME, 'other-plugin'])
  assert.equal(manifest.dependencies[NAME], OLD_VERSION)
})

test('update: install failure rolls the profile back', async (t) => {
  const fixture = makeProfile(t)
  const before = snapshotProfile(fixture)

  const result = await withFakePm(t, 'fail', () =>
    runUpdate({
      profile: fixture.profile,
      entry: fixture.entry,
      target: fixture.target,
      runtimeVersion: RUNTIME,
      stateDir: fixture.stateDir,
    }),
  )

  assert.equal(result.ok, false)
  assert.ok(result.error)
  assert.equal(result.error.code, 'install-failed')
  assert.equal(result.rolledBack, true)

  assert.deepEqual(bytesOf(fixture.manifestPath), before.manifest)
  assert.deepEqual(bytesOf(join(fixture.dir, 'pnpm-lock.yaml')), before.lockfile)
  assert.deepEqual(bytesOf(join(fixture.dir, 'node_modules', NAME, 'package.json')), before.installed)
})

test('update: an aborted signal cancels without touching the profile', async (t) => {
  const fixture = makeProfile(t)
  const before = snapshotProfile(fixture)

  const controller = new AbortController()
  controller.abort()

  const result = await withFakePm(t, 'success', () =>
    runUpdate({
      profile: fixture.profile,
      entry: fixture.entry,
      target: fixture.target,
      runtimeVersion: RUNTIME,
      stateDir: fixture.stateDir,
      signal: controller.signal,
    }),
  )

  assert.equal(result.ok, false)
  assert.ok(result.error)
  assert.equal(result.error.code, 'cancelled')
  assert.equal(result.rolledBack, false)

  assert.deepEqual(bytesOf(fixture.manifestPath), before.manifest)
  assert.deepEqual(bytesOf(join(fixture.dir, 'pnpm-lock.yaml')), before.lockfile)
  assert.deepEqual(bytesOf(join(fixture.dir, 'node_modules', NAME, 'package.json')), before.installed)
})

test('update: missing lockfile is not an error and is absent from the backup', async (t) => {
  const fixture = makeProfile(t, { withLockfile: false })
  assert.equal(existsSync(join(fixture.dir, 'pnpm-lock.yaml')), false)

  const result = await withFakePm(t, 'success', () =>
    runUpdate({
      profile: fixture.profile,
      entry: fixture.entry,
      target: fixture.target,
      runtimeVersion: RUNTIME,
      stateDir: fixture.stateDir,
    }),
  )

  assert.equal(result.ok, true, JSON.stringify(result.error))
  assert.ok(result.backupDir && existsSync(result.backupDir))
  assert.equal(existsSync(join(result.backupDir, 'pnpm-lock.yaml')), false)
  assert.equal(readJson(join(fixture.dir, 'node_modules', NAME, 'package.json')).version, NEW_VERSION)
})

test('update: progress callback reports recovery-relevant phases', async (t) => {
  const fixture = makeProfile(t)
  const phases = []
  const result = await withFakePm(t, 'fail', () =>
    runUpdate({
      profile: fixture.profile,
      entry: fixture.entry,
      target: fixture.target,
      runtimeVersion: RUNTIME,
      stateDir: fixture.stateDir,
      onProgress: (step) => phases.push(step.phase),
    }),
  )

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'install-failed')
  assert.ok(phases.length > 0, 'onProgress should have fired')
  for (const phase of phases) assert.equal(typeof phase, 'string')
})

// ---------------------------------------------------------------------------
// pnpm failure classification (update.js defect: error.detail plumbing).
//
// `classifyPnpmFailure` / `failureDetail` are exported by update.js for tests
// and diagnostics: this sandbox forbids child_process.spawn (EPERM), so the
// real-spawn path cannot be exercised here. The real `pnpm add` failure path
// (ERR_PNPM_IGNORED_BUILDS with a real corepack pnpm) was validated end-to-end
// by the Lead against a real CLI host.
// ---------------------------------------------------------------------------

const PNPM_FAILURE_CASES = [
  ['ERR_PNPM_IGNORED_BUILDS: ignored build scripts for: esbuild', 'ignored-builds'],
  ['ERR_PNPM_OUTDATED_LOCKFILE: lockfile is not up to date with package.json', 'lockfile-outdated'],
  [
    'ERR_PNPM_BROKEN_LOCKFILE: Cannot read properties of undefined (reading lockfile)',
    'lockfile-broken',
  ],
  ['ERR_PNPM_UNEXPECTED_STORE: unexpected store location', 'unexpected-store'],
  ['ERR_PNPM_TARBALL_URL_MISMATCH: tarball url differs from lockfile', 'tarball-url-mismatch'],
  ['ERR_PNPM_RELEASE_AGE: minimumReleaseAge is 1440', 'release-age-violation'],
  ['ERR_PNPM_ADDING_TO_ROOT: unable to add to root workspace', 'workspace-root'],
]

test('update: pnpm failure classifier maps errors to actionable classes', () => {
  for (const [output, expectedClass] of PNPM_FAILURE_CASES) {
    const classified = classifyPnpmFailure(output)
    assert.ok(classified, expectedClass)
    assert.equal(classified.class, expectedClass, `${output} -> ${classified.class}`)
    assert.equal(typeof classified.hint, 'string')
    assert.ok(classified.hint.length > 0)
    assert.ok(classified.tail.length <= 800)

    const detail = failureDetail(output)
    assert.equal(typeof detail, 'string')
    assert.ok(detail.startsWith(`${expectedClass}: `), detail)
    assert.ok(detail.includes(classified.hint), detail)
    assert.ok(detail.endsWith(classified.tail), detail)
  }

  assert.equal(classifyPnpmFailure(''), null)
  assert.equal(classifyPnpmFailure(undefined), null)
  assert.equal(failureDetail(''), undefined)
  assert.equal(classifyPnpmFailure('some unrelated pnpm explosion').class, 'unknown')
})

test('update: failure keeps pnpm detail under error.detail and does not request a restart', async (t) => {
  const fixture = makeProfile(t)
  const before = snapshotProfile(fixture)

  const result = await withFakePm(t, 'mismatch', () =>
    runUpdate({
      profile: fixture.profile,
      entry: fixture.entry,
      target: fixture.target,
      runtimeVersion: RUNTIME,
      stateDir: fixture.stateDir,
    }),
  )

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'version-mismatch')
  assert.equal(result.needsRestart, false, 'failed update must not request a restart')
  assert.equal(result.rolledBack, true)
  assert.equal(result.detail, undefined, 'detail must live under error.detail, not the result root')
  assert.equal(result.error.detail, `expected=${NEW_VERSION} actual=0.0.0-mismatch`)
  assert.ok(result.log.some((line) => typeof line === 'string' && line.length > 0))

  assert.deepEqual(bytesOf(fixture.manifestPath), before.manifest)
  assert.deepEqual(bytesOf(join(fixture.dir, 'pnpm-lock.yaml')), before.lockfile)
  assert.deepEqual(bytesOf(join(fixture.dir, 'node_modules', NAME, 'package.json')), before.installed)
  assert.deepEqual(bytesOf(join(fixture.dir, 'node_modules', 'other-plugin', 'package.json')), before.other)
})

// ---------------------------------------------------------------------------
// GitHub source-tarball preflight: pnpm 12 runs `prepare` for git-hosted
// packages and its default allowBuilds:[] rejects them with
// ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED, so runUpdate must fail fast *before*
// backing up or spawning anything.
// ---------------------------------------------------------------------------

test('update: source-tarball targets are rejected before touching the profile', async (t) => {
  const fixture = makeProfile(t)
  const before = snapshotProfile(fixture)

  const result = await withFakePm(t, 'success', () =>
    runUpdate({
      profile: fixture.profile,
      entry: fixture.entry,
      target: { ...fixture.target, installSpec: 'github:owner/repo#v1.2.3', installKind: 'source-tarball' },
      runtimeVersion: RUNTIME,
      stateDir: fixture.stateDir,
    }),
  )

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'github-source-needs-build')
  assert.ok(result.error.message.includes('npm'), result.error.message)
  assert.equal(result.needsRestart, false)
  assert.equal(result.rolledBack, false)
  assert.equal(result.backupDir, null)
  // Nothing on disk may move: no backup, no package.json rewrite.
  assert.deepEqual(bytesOf(fixture.manifestPath), before.manifest)
  assert.deepEqual(bytesOf(join(fixture.dir, 'pnpm-lock.yaml')), before.lockfile)
  assert.deepEqual(bytesOf(join(fixture.dir, 'node_modules', NAME, 'package.json')), before.installed)
})

test('update: a github: installSpec without installKind is treated as source-tarball', async (t) => {
  const fixture = makeProfile(t)
  const before = snapshotProfile(fixture)

  const target = { ...fixture.target, installSpec: 'github:owner/repo#v1.2.3' }
  delete target.installKind
  const result = await withFakePm(t, 'success', () =>
    runUpdate({
      profile: fixture.profile,
      entry: fixture.entry,
      target,
      runtimeVersion: RUNTIME,
      stateDir: fixture.stateDir,
    }),
  )

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'github-source-needs-build')
  assert.equal(result.needsRestart, false)
  assert.equal(result.rolledBack, false)
  assert.deepEqual(bytesOf(fixture.manifestPath), before.manifest)
})

// ---------------------------------------------------------------------------
// Regressions for real pnpm 12 output captured from the desktop update failure.
// ---------------------------------------------------------------------------

test('update: git-hosted prepare rejection classifies as git-dep-prepare-not-allowed', () => {
  // Verbatim pnpm 12 output from the reported failure.
  const output = `[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED]
  \u00d7 adding a new package
  \u2570\u2500\u25b6 The git-hosted package "dshmarket@1.73.15" needs to execute build
      scripts but is not in the "allowBuilds" allowlist.
  help: Add the package to "allowBuilds" in your project's pnpm-workspace.yaml
        to allow it to run scripts. For example:
        allowBuilds:
          dshmarket@https://codeload.github.com/dsh-market/dsh-market/tar.gz/
        ed92edf9422a021e9e3460c9185f89500e6dc69d: true`

  const classified = classifyPnpmFailure(output)
  assert.ok(classified)
  assert.equal(classified.class, 'git-dep-prepare-not-allowed')
  assert.ok(classified.hint.includes('allowBuilds'), classified.hint)
  assert.ok(classified.hint.includes('npm 国内镜像'), classified.hint)

  const detail = failureDetail(output)
  assert.ok(detail.startsWith('git-dep-prepare-not-allowed: '), detail)
})

test('update: EPERM rename during install classifies as windows-file-locked', () => {
  // Desktop-host lock on profile node_modules: pnpm renames the package dir
  // aside before swapping, and the rename is denied while DSH is running.
  const output = `[ERR_PNPM_EPERM] EPERM: operation not permitted, rename 'D:\\Users\\Administrator\\.dsh\\profiles\\desktop\\node_modules\\.pnpm\\demo-plugin@1.0.0\\node_modules\\demo-plugin' -> 'D:\\Users\\Administrator\\.dsh\\profiles\\desktop\\node_modules\\.pnpm\\demo-plugin@1.0.0\\node_modules\\demo-plugin_tmp_41212_13'
    at async Object.rename (node:internal/fs/promises:786:7)`
  assert.ok(output.includes('_tmp_41212_13'))

  const classified = classifyPnpmFailure(output)
  assert.ok(classified)
  assert.equal(classified.class, 'windows-file-locked')
  assert.ok(classified.hint.includes('完全退出'), classified.hint)
  assert.ok(classified.hint.includes('刷新页面无效'), classified.hint)
})

test('update: EPERM rename of profile package.json classifies as profile-file-locked', () => {
  // `pnpm add` rewrites the profile's package.json; when the desktop host or
  // an antivirus holds it, the rename is denied and the message names
  // package.json instead of node_modules.
  const output = `[ERR_PNPM_EPERM] EPERM: operation not permitted, rename 'C:\\\\Users\\\\Administrator\\\\.dsh\\\\profiles\\\\desktop\\\\package.json' -> 'C:\\\\Users\\\\Administrator\\\\.dsh\\\\profiles\\\\desktop\\\\package.json_tmp_123'`

  const classified = classifyPnpmFailure(output)
  assert.ok(classified)
  assert.equal(classified.class, 'profile-file-locked')
  assert.ok(classified.hint.includes('package.json'), classified.hint)
})
