import test from 'node:test'
import assert from 'node:assert/strict'

import { pickTargets } from '../lib/core/pick.js'

const RUNTIME = '0.2.1-rc.4'
const COMPATIBLE = { engines: { dsh: '>=0.2.1-rc.1 <0.4.0' } }
const INCOMPATIBLE = { engines: { dsh: '>=0.4.0 <0.5.0' } }

function candidate(version, manifest = COMPATIBLE) {
  return { version, manifest: { name: 'demo', version, ...manifest } }
}

function input(overrides = {}) {
  return {
    installedVersion: '1.2.0',
    installedManifest: { name: 'demo', version: '1.2.0', ...COMPATIBLE },
    candidates: [candidate('1.2.0'), candidate('1.3.0')],
    latest: '1.3.0',
    runtimeVersion: RUNTIME,
    allowPrerelease: false,
    kind: 'registry',
    ...overrides,
  }
}

test('latest: installed equals the newest compatible version', () => {
  const result = pickTargets(
    input({ candidates: [candidate('1.2.0')], latest: '1.2.0' }),
  )
  assert.equal(result.status, 'latest')
  assert.equal(result.installedVersion, '1.2.0')
  assert.equal(result.latestVersion, '1.2.0')
  assert.equal(result.compatibleMax, '1.2.0')
  assert.equal(result.installedCompatible, true)
  assert.equal(result.target, null)
  assert.equal(result.reason.code, 'ok')
  assert.equal(typeof result.reason.message, 'string')
  assert.ok(Array.isArray(result.reason.unmet))
})

test('update-latest: a newer compatible version exists', () => {
  const result = pickTargets(input())
  assert.equal(result.status, 'update-latest')
  assert.equal(result.latestVersion, '1.3.0')
  assert.equal(result.compatibleMax, '1.3.0')
  assert.deepEqual(result.target, { version: '1.3.0', risk: 'none' })
  assert.equal(result.altTarget, null)
  assert.equal(result.reason.code, 'newer-available')
})

test('update-compatible: newest is incompatible but a newer compatible exists', () => {
  const result = pickTargets(
    input({
      installedVersion: '1.0.0',
      installedManifest: { name: 'demo', version: '1.0.0', ...COMPATIBLE },
      candidates: [candidate('1.0.0'), candidate('1.5.0'), candidate('2.0.0', INCOMPATIBLE)],
      latest: '2.0.0',
    }),
  )
  assert.equal(result.status, 'update-compatible')
  assert.equal(result.latestVersion, '2.0.0')
  assert.equal(result.compatibleMax, '1.5.0')
  assert.deepEqual(result.target, { version: '1.5.0', risk: 'none' })
  assert.deepEqual(result.altTarget, { version: '2.0.0', risk: 'latest-incompatible' })
  assert.equal(result.reason.code, 'newer-incompatible')
  assert.ok(result.reason.message.length > 0)
})

test('switch-compatible: installed version is incompatible, a compatible one exists (0.30.1 -> 0.28.2)', () => {
  const result = pickTargets(
    input({
      installedVersion: '0.30.1',
      installedManifest: { name: 'demo', version: '0.30.1', ...INCOMPATIBLE },
      candidates: [candidate('0.30.1', INCOMPATIBLE), candidate('0.28.2')],
      latest: '0.30.1',
    }),
  )
  assert.equal(result.status, 'switch-compatible')
  assert.equal(result.installedVersion, '0.30.1')
  assert.equal(result.installedCompatible, false)
  assert.equal(result.compatibleMax, '0.28.2')
  assert.equal(result.target.version, '0.28.2')
  assert.equal(result.target.risk, 'none')
  assert.equal(result.reason.code, 'installed-incompatible')
  assert.ok(result.reason.unmet.length > 0)
})

test('incompatible-no-compatible: nothing compatible at all', () => {
  const result = pickTargets(
    input({
      installedVersion: '0.30.1',
      installedManifest: { name: 'demo', version: '0.30.1', ...INCOMPATIBLE },
      candidates: [candidate('0.30.1', INCOMPATIBLE)],
      latest: '0.30.1',
    }),
  )
  assert.equal(result.status, 'incompatible-no-compatible')
  assert.equal(result.compatibleMax, null)
  assert.equal(result.installedCompatible, false)
  assert.equal(result.target, null)
  assert.equal(result.reason.code, 'no-compatible-candidate')
  assert.ok(result.reason.unmet.length > 0)
})

test('installed is compatible but the only newer candidate is incompatible -> latest', () => {
  const result = pickTargets(
    input({
      installedVersion: '1.2.0',
      candidates: [candidate('1.2.0'), candidate('2.0.0', INCOMPATIBLE)],
      latest: '2.0.0',
    }),
  )
  assert.equal(result.status, 'latest')
  assert.equal(result.compatibleMax, '1.2.0')
  assert.equal(result.target, null)
  assert.equal(result.latestVersion, '2.0.0')
})

test('prerelease filter: stable install ignores rc candidates by default', () => {
  const candidates = [candidate('1.0.0'), candidate('1.1.0-rc.1')]
  const filtered = pickTargets(
    input({
      installedVersion: '1.0.0',
      installedManifest: { name: 'demo', version: '1.0.0', ...COMPATIBLE },
      candidates,
      latest: '1.1.0-rc.1',
      allowPrerelease: false,
    }),
  )
  assert.equal(filtered.status, 'latest')
  assert.equal(filtered.target, null)
  assert.equal(filtered.compatibleMax, '1.0.0')

  const allowed = pickTargets(
    input({
      installedVersion: '1.0.0',
      installedManifest: { name: 'demo', version: '1.0.0', ...COMPATIBLE },
      candidates,
      latest: '1.1.0-rc.1',
      allowPrerelease: true,
    }),
  )
  assert.equal(allowed.status, 'update-latest')
  assert.equal(allowed.target.version, '1.1.0-rc.1')
})

test('prerelease install may be updated to a newer prerelease without the flag', () => {
  const result = pickTargets(
    input({
      installedVersion: '1.0.0-rc.1',
      installedManifest: { name: 'demo', version: '1.0.0-rc.1', ...COMPATIBLE },
      candidates: [candidate('1.0.0-rc.1'), candidate('1.0.0-rc.2')],
      latest: '1.0.0-rc.2',
      allowPrerelease: false,
    }),
  )
  assert.equal(result.status, 'update-latest')
  assert.equal(result.target.version, '1.0.0-rc.2')
})

test('local and builtin entries never get an update target', () => {
  const local = pickTargets(
    input({ kind: 'local', installedVersion: '0.0.0', candidates: [], latest: null }),
  )
  assert.equal(local.status, 'local')
  assert.equal(local.target, null)
  assert.equal(local.reason.code, 'local-dependency')

  const builtin = pickTargets(
    input({ kind: 'builtin', installedVersion: '0.2.1', candidates: [candidate('0.3.0')], latest: '0.3.0' }),
  )
  assert.equal(builtin.status, 'builtin')
  assert.equal(builtin.target, null)
  assert.equal(builtin.reason.code, 'builtin-package')
})

test('error states: no candidates and missing install', () => {
  const empty = pickTargets(input({ candidates: [], latest: null }))
  assert.equal(empty.status, 'error')
  assert.equal(empty.reason.code, 'no-candidates')

  const missing = pickTargets(
    input({ installedVersion: null, installedManifest: null, candidates: [], latest: null }),
  )
  assert.equal(missing.status, 'error')
  assert.equal(missing.reason.code, 'missing-install')
})

test('counters reflect the candidate list', () => {
  const result = pickTargets(
    input({
      installedVersion: '1.0.0',
      installedManifest: { name: 'demo', version: '1.0.0', ...COMPATIBLE },
      candidates: [candidate('1.0.0'), candidate('1.5.0'), candidate('2.0.0', INCOMPATIBLE)],
      latest: '2.0.0',
    }),
  )
  assert.equal(result.candidatesSeen, 3)
  assert.equal(result.candidatesCompatible, 2)
})

test('candidate with an unreadable manifest is never the default target', () => {
  const result = pickTargets(
    input({
      installedVersion: '1.0.0',
      installedManifest: { name: 'demo', version: '1.0.0', ...COMPATIBLE },
      candidates: [candidate('1.0.0'), { version: '2.0.0', manifest: null }],
      latest: '2.0.0',
    }),
  )
  assert.notEqual(result.target?.version, '2.0.0')
})

test('switch-compatible end to end: installed peer gate fails, older candidate passes', () => {
  // Runtime stays 0.2.1-rc.4. Installed 0.30.1 requires ^0.2.2-rc.1 -> fails.
  // Candidate 0.28.2 requires ^0.2.1-rc.1 -> passes. So the only healing move
  // is a downgrade to the compatible maximum.
  const result = pickTargets(
    input({
      installedVersion: '0.30.1',
      installedManifest: {
        name: 'demo',
        version: '0.30.1',
        peerDependencies: { '@deepseek-ai/dsh': '^0.2.2-rc.1' },
      },
      candidates: [
        { version: '0.28.2', manifest: { name: 'demo', version: '0.28.2', peerDependencies: { '@deepseek-ai/dsh': '^0.2.1-rc.1' } } },
        { version: '0.30.1', manifest: { name: 'demo', version: '0.30.1', peerDependencies: { '@deepseek-ai/dsh': '^0.2.2-rc.1' } } },
      ],
      latest: '0.30.1',
    }),
  )
  assert.equal(result.status, 'switch-compatible')
  assert.equal(result.installedCompatible, false)
  assert.equal(result.compatibleMax, '0.28.2')
  assert.equal(result.target.version, '0.28.2')
  assert.equal(result.reason.code, 'installed-incompatible')
})

test('prerelease install: a newer stable candidate wins over a newer rc when the flag is off', () => {
  // Installed is a prerelease, so the prerelease filter allows rc candidates.
  // That must not stop the picker from preferring the stable 0.2.2 when both
  // are compatible -- and a stable-only filter must not hide the upgrade.
  const prerelease = { name: 'demo', version: '0.2.1-rc.5', ...COMPATIBLE }
  const stable = { name: 'demo', version: '0.2.2', ...COMPATIBLE }
  const result = pickTargets(
    input({
      installedVersion: '0.2.1-rc.4',
      installedManifest: { name: 'demo', version: '0.2.1-rc.4', ...COMPATIBLE },
      candidates: [
        { version: '0.2.1-rc.4', manifest: { name: 'demo', version: '0.2.1-rc.4', ...COMPATIBLE } },
        { version: '0.2.1-rc.5', manifest: prerelease },
        { version: '0.2.2', manifest: stable },
      ],
      latest: '0.2.2',
      allowPrerelease: false,
    }),
  )
  assert.equal(result.status, 'update-latest')
  assert.equal(result.compatibleMax, '0.2.2')
  assert.equal(result.target.version, '0.2.2')
})
