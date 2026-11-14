import test from 'node:test'
import assert from 'node:assert/strict'

import { evaluateManifest, describeUnmet } from '../lib/core/compat.js'

const RUNTIME = '0.2.1-rc.4'
const DSH_RANGE = '>=0.2.1-rc.1 <0.4.0'
const DSH_PEER = { '@deepseek-ai/dsh': DSH_RANGE }

test('no dsh requirement at all -> compatible, source none', () => {
  const result = evaluateManifest({ name: 'plain', version: '1.0.0' }, RUNTIME)
  assert.equal(result.compatible, true)
  assert.equal(result.source, 'none')
  assert.deepEqual(result.unmet, [])

  const withUnrelatedPeer = evaluateManifest(
    { peerDependencies: { react: '>=18', '@other/dsh': '^1.0.0' } },
    RUNTIME,
  )
  assert.equal(withUnrelatedPeer.compatible, true)
  assert.equal(withUnrelatedPeer.source, 'none')
})

test('engines.dsh decides alone and ignores peerDependencies', () => {
  // engines.dsh satisfied, peer would fail -> engines wins.
  const satisfied = evaluateManifest(
    { engines: { dsh: DSH_RANGE }, peerDependencies: { '@deepseek-ai/dsh': '>=9.0.0' } },
    RUNTIME,
  )
  assert.equal(satisfied.compatible, true)
  assert.equal(satisfied.source, 'engines')
  assert.deepEqual(satisfied.unmet, [])

  // engines.dsh unsatisfied, peer would pass -> still incompatible.
  const unsatisfied = evaluateManifest(
    { engines: { dsh: '>=0.4.0 <0.5.0' }, peerDependencies: DSH_PEER },
    RUNTIME,
  )
  assert.equal(unsatisfied.compatible, false)
  assert.equal(unsatisfied.source, 'engines')
  assert.equal(unsatisfied.unmet.length, 1)
  assert.equal(unsatisfied.unmet[0].name, 'engines.dsh')
  assert.equal(unsatisfied.unmet[0].range, '>=0.4.0 <0.5.0')
  assert.equal(unsatisfied.unmet[0].actual, RUNTIME)
})

test('engines.dsh empty or invalid range -> incompatible', () => {
  for (const range of ['', '   ', 'not-a-range', '>=1.0.0 <']) {
    const result = evaluateManifest({ engines: { dsh: range } }, RUNTIME)
    assert.equal(result.compatible, false, `range ${JSON.stringify(range)}`)
    assert.equal(result.source, 'engines')
    assert.equal(result.unmet.length, 1)
  }
})

test('peer fallback: all @deepseek-ai/dsh* peers must match', () => {
  const ok = evaluateManifest(
    {
      peerDependencies: {
        '@deepseek-ai/dsh': DSH_RANGE,
        '@deepseek-ai/dsh-client-ui-primitives': '>=0.2.0 <0.3.0',
        react: '>=19.0.0',
      },
    },
    RUNTIME,
  )
  assert.equal(ok.compatible, true)
  assert.equal(ok.source, 'peers')
  assert.deepEqual(ok.unmet, [])

  const oneFails = evaluateManifest(
    {
      peerDependencies: {
        '@deepseek-ai/dsh': DSH_RANGE,
        '@deepseek-ai/dsh-client-ui-primitives': '^0.9.0',
      },
    },
    RUNTIME,
  )
  assert.equal(oneFails.compatible, false)
  assert.equal(oneFails.source, 'peers')
  assert.equal(oneFails.unmet.length, 1)
  assert.equal(oneFails.unmet[0].name, '@deepseek-ai/dsh-client-ui-primitives')
  assert.equal(oneFails.unmet[0].range, '^0.9.0')
  assert.equal(oneFails.unmet[0].actual, RUNTIME)

  // An unrelated peer is ignored, even if it looks unsatisfied.
  const unrelated = evaluateManifest(
    { peerDependencies: { react: '^99.0.0', '@deepseek-ai/dsh': DSH_RANGE } },
    RUNTIME,
  )
  assert.equal(unrelated.compatible, true)
})

test('peer ranges that use the workspace protocol mean "this runtime"', () => {
  for (const protocol of ['workspace:^', 'workspace:~', 'workspace:*']) {
    const result = evaluateManifest(
      { peerDependencies: { '@deepseek-ai/dsh': protocol } },
      RUNTIME,
    )
    assert.equal(result.compatible, true, protocol)
    assert.equal(result.source, 'peers')
  }
})

test('peer prereleases match with includePrerelease semantics', () => {
  // 0.2.1-rc.4 satisfies >=0.2.1-rc.1 <0.4.0 (contract case).
  assert.equal(evaluateManifest({ peerDependencies: DSH_PEER }, '0.2.1-rc.4').compatible, true)
  // A prerelease inside a caret range is accepted because the host evaluates
  // with includePrerelease:true.
  assert.equal(evaluateManifest({ peerDependencies: { '@deepseek-ai/dsh': '^0.2.0' } }, '0.2.1-rc.4').compatible, true)
  // 0.4.0-rc.1 is outside <0.4.0 only if the upper bound excludes prereleases;
  // the literal range `<0.4.0` accepts it, and so does the host.
  assert.equal(
    evaluateManifest({ peerDependencies: { '@deepseek-ai/dsh': '>=0.2.1 <0.4.0' } }, '0.4.0-rc.1').compatible,
    true,
  )
})

test('multiple failing peers are all reported', () => {
  const result = evaluateManifest(
    {
      peerDependencies: {
        '@deepseek-ai/dsh': '^0.9.0',
        '@deepseek-ai/dsh-app-boot': '^0.9.0',
      },
    },
    RUNTIME,
  )
  assert.equal(result.compatible, false)
  assert.equal(result.source, 'peers')
  assert.equal(result.unmet.length, 2)
  assert.deepEqual(
    result.unmet.map((item) => item.name).sort(),
    ['@deepseek-ai/dsh', '@deepseek-ai/dsh-app-boot'],
  )
})

test('invalid arguments return incompatible instead of throwing', () => {
  for (const manifest of [null, undefined, 'nope', 42, []]) {
    const result = evaluateManifest(manifest, RUNTIME)
    assert.equal(result.compatible, false)
    assert.equal(result.source, 'none')
    assert.equal(result.unmet.length, 1)
    assert.equal(result.unmet[0].name, '(manifest)')
  }

  for (const runtime of [null, undefined, '', 'not-a-version', 42]) {
    const result = evaluateManifest({ peerDependencies: DSH_PEER }, runtime)
    assert.equal(result.compatible, false, `runtime ${JSON.stringify(runtime)}`)
    assert.equal(result.source, 'none')
    assert.equal(result.unmet[0].name, '(manifest)')
  }
})

test('describeUnmet', () => {
  assert.equal(describeUnmet([]), '')
  assert.equal(describeUnmet(null), '')
  const text = describeUnmet([
    { name: '@deepseek-ai/dsh', range: '^1.0.0', actual: '0.2.1-rc.4' },
    { name: 'engines.dsh', range: '>=0.4.0', actual: '0.2.1-rc.4' },
  ])
  assert.equal(typeof text, 'string')
  assert.match(text, /@deepseek-ai\/dsh/)
  assert.match(text, /\^1\.0\.0/)
  assert.match(text, /0\.2\.1-rc\.4/)
  assert.match(text, /engines\.dsh/)
  // A single unmet entry is also described.
  assert.match(
    describeUnmet([{ name: '@deepseek-ai/dsh', range: '^1.0.0', actual: '0.2.1' }]),
    /@deepseek-ai\/dsh/,
  )
})
