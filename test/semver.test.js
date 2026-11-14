import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parse,
  format,
  valid,
  isPrerelease,
  compare,
  compareStrings,
  gt,
  gte,
  lt,
  lte,
  eq,
  sortVersions,
  satisfies,
  maxSatisfying,
  maxVersion,
  sameRelease,
} from '../lib/core/semver.js'

const RUNTIME = '0.2.1-rc.4'
const DSH_RANGE = '>=0.2.1-rc.1 <0.4.0'

test('parse / format / valid', () => {
  assert.deepEqual(parse('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: [], build: [] })
  assert.deepEqual(parse('v0.2.1-rc.4'), {
    major: 0,
    minor: 2,
    patch: 1,
    prerelease: ['rc', 4],
    build: [],
  })
  assert.equal(format(parse('v1.2.3+build.5')), '1.2.3+build.5')
  assert.equal(valid('v1.2.3'), '1.2.3')
  assert.equal(valid('1.2.3-rc.1+build.7'), '1.2.3-rc.1+build.7')
  // Leading zeros and short forms are not SemVer.
  assert.equal(parse('1.02.3'), null)
  assert.equal(parse('1.2'), null)
  assert.equal(parse('1.2.3.4'), null)
  assert.equal(parse(''), null)
  assert.equal(parse(null), null)
  assert.equal(parse(123), null)
  assert.equal(valid('not-a-version'), null)
})

test('isPrerelease', () => {
  assert.equal(isPrerelease('0.2.1-rc.4'), true)
  assert.equal(isPrerelease('0.2.1'), false)
  assert.equal(isPrerelease('v1.0.0-beta.1'), true)
  assert.equal(isPrerelease('garbage'), false)
})

test('prerelease ordering follows SemVer 2.0.0', () => {
  const ordered = [
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0',
  ]
  for (let i = 1; i < ordered.length; i += 1) {
    assert.equal(compareStrings(ordered[i - 1], ordered[i]), -1, `${ordered[i - 1]} < ${ordered[i]}`)
  }
  assert.equal(compareStrings(RUNTIME, '0.2.1-rc.10'), -1)
  assert.equal(compareStrings('0.2.1-rc.4', '0.2.1'), -1)
  assert.equal(compareStrings('0.2.1', '0.2.1-rc.4'), 1)
})

test('comparison helpers and build metadata', () => {
  assert.equal(gt('0.4.0', RUNTIME), true)
  assert.equal(gte('0.2.1-rc.4', RUNTIME), true)
  assert.equal(lt('0.2.1-rc.1', RUNTIME), true)
  assert.equal(lte('0.2.1-rc.4', RUNTIME), true)
  // Build metadata is ignored by precedence.
  assert.equal(eq('1.2.3+build.1', '1.2.3+build.2'), true)
  assert.equal(sameRelease('1.2.3+a', '1.2.3+b'), true)
  assert.equal(sameRelease('1.2.3', '1.2.4'), false)
  // eq is defensive; compareStrings throws.
  assert.equal(eq('nope', '1.2.3'), false)
  assert.throws(() => compareStrings('nope', '1.2.3'), /invalid version/)
  assert.equal(compare(parse('1.0.0'), parse('1.0.0')), 0)
})

test('caret ranges', () => {
  assert.equal(satisfies('1.9.9', '^1.2.3'), true)
  assert.equal(satisfies('2.0.0', '^1.2.3'), false)
  assert.equal(satisfies('1.2.2', '^1.2.3'), false)
  // ^0.x narrows to the minor line.
  assert.equal(satisfies('0.1.9', '^0.1.2'), true)
  assert.equal(satisfies('0.2.0', '^0.1.2'), false)
  assert.equal(satisfies('0.0.3', '^0.0.3'), true)
  assert.equal(satisfies('0.0.4', '^0.0.3'), false)
  // Partial caret forms.
  assert.equal(satisfies('1.5.0', '^1'), true)
  assert.equal(satisfies('2.0.0', '^1'), false)
  assert.equal(satisfies('0.2.9', '^0.2'), true)
  assert.equal(satisfies('0.3.0', '^0.2'), false)
})

test('tilde and x ranges', () => {
  assert.equal(satisfies('1.2.9', '~1.2.3'), true)
  assert.equal(satisfies('1.3.0', '~1.2.3'), false)
  assert.equal(satisfies('1.2.0', '~1.2'), true)
  assert.equal(satisfies('1.3.0', '~1.2'), false)

  assert.equal(satisfies('1.0.0', '1.x'), true)
  assert.equal(satisfies('1.99.99', '1.x'), true)
  assert.equal(satisfies('2.0.0', '1.x'), false)
  assert.equal(satisfies('1.2.9', '1.2.x'), true)
  assert.equal(satisfies('1.5.0', '1.2.x'), false)
  assert.equal(satisfies('1.0.0', '*'), true)
  assert.equal(satisfies('1.0.0', 'x'), true)
})

test('|| alternatives and hyphen ranges', () => {
  assert.equal(satisfies('1.5.0', '^1.0.0 || ^2.0.0'), true)
  assert.equal(satisfies('2.5.0', '^1.0.0 || ^2.0.0'), true)
  assert.equal(satisfies('3.0.0', '^1.0.0 || ^2.0.0'), false)

  assert.equal(satisfies('1.2.3', '1.2.3 - 2.3.4'), true)
  assert.equal(satisfies('2.3.4', '1.2.3 - 2.3.4'), true)
  assert.equal(satisfies('2.3.5', '1.2.3 - 2.3.4'), false)
  assert.equal(satisfies('1.2.2', '1.2.3 - 2.3.4'), false)
  // Partial upper bound: "1.2 - 2.3" excludes 2.4.0.
  assert.equal(satisfies('2.3.9', '1.2 - 2.3'), true)
  assert.equal(satisfies('2.4.0', '1.2 - 2.3'), false)
  assert.equal(satisfies('1.2.0', '1.2 - 2.3'), true)
})

test('prerelease gating: includePrerelease only widens range matching', () => {
  // Same (major, minor, patch) as a prerelease comparator -> allowed even
  // without includePrerelease.
  assert.equal(satisfies(RUNTIME, DSH_RANGE), true)
  assert.equal(satisfies(RUNTIME, DSH_RANGE, { includePrerelease: false }), true)
  // A prerelease of a different tuple is gated out by default.
  assert.equal(satisfies('0.3.0-rc.1', DSH_RANGE), false)
  assert.equal(satisfies('0.3.0-rc.1', DSH_RANGE, { includePrerelease: true }), true)
  assert.equal(satisfies('0.2.1-rc.4', '^0.2.0'), false)
  assert.equal(satisfies('0.2.1-rc.4', '^0.2.0', { includePrerelease: true }), true)
})

// These match node-semver (the semantics @deepseek-ai/dsh-app-boot uses via
// `semver.satisfies`). Both cases used to be real bugs in lib/core/semver.js
// (`~0.0.x` widened to <0.0.(patch+1), and synthetic upper bounds lacked the
// `-0` sentinel); fixed in lib/core/semver.js, kept here as regression tests.
test('~0.0.x widens to the next minor line (node-semver: ~0.0.3 = >=0.0.3 <0.1.0)', () => {
  assert.equal(satisfies('0.0.9', '~0.0.3'), true)
  assert.equal(satisfies('0.0.3', '~0.0.3'), true)
  assert.equal(satisfies('0.1.0', '~0.0.3'), false)
})

// node-semver writes synthetic upper bounds as `<X.Y.Z-0`, so with
// includePrerelease:true a prerelease of the NEXT release still fails. compat.js
// evaluates engines/peer ranges with includePrerelease:true, so this matters.
test('synthetic upper bounds exclude the next release prerelease', () => {
  assert.equal(satisfies('1.3.0-beta.1', '~1.2.0', { includePrerelease: true }), false)
  assert.equal(satisfies('2.0.0-rc.1', '^1.2.3', { includePrerelease: true }), false)
  assert.equal(satisfies('2.4.0-rc.1', '1.2 - 2.3', { includePrerelease: true }), false)
  // The named lower tuple itself is in range, but its own prereleases are
  // below the release bound and must stay out.
  assert.equal(satisfies('1.2.3-beta.1', '^1.2.3', { includePrerelease: true }), false)
})


test('runtime prerelease gates (regression for the -0 sentinel fix)', () => {
  assert.equal(satisfies('1.2.3-rc.1', '^1.2.3', { includePrerelease: true }), false)
  assert.equal(satisfies('0.2.1-rc.4', '>=0.2.0-rc.2 <0.4.0', { includePrerelease: true }), true)
  // includePrerelease must not let the next release line leak in.
  assert.equal(satisfies('0.4.0-rc.1', '>=0.2.0-rc.2 <0.4.0-0', { includePrerelease: true }), false)
})

test('invalid ranges and versions return false instead of throwing', () => {
  assert.equal(satisfies(RUNTIME, ''), false)
  assert.equal(satisfies(RUNTIME, '   '), false)
  assert.equal(satisfies(RUNTIME, 'not-a-range'), false)
  assert.equal(satisfies(RUNTIME, '>=1.2.3 <'), false)
  assert.equal(satisfies('not-a-version', DSH_RANGE), false)
  assert.equal(satisfies(RUNTIME, null), false)
  assert.equal(satisfies(RUNTIME, undefined), false)
})

test('maxSatisfying / maxVersion / sortVersions', () => {
  const versions = ['0.3.0', '0.2.2', '0.2.1-rc.4', 'not-a-version', '0.1.9']
  assert.equal(maxSatisfying(versions, DSH_RANGE), '0.3.0')
  assert.equal(maxSatisfying(versions, '>=0.2.1-rc.1 <0.3.0'), '0.2.2')
  assert.equal(maxSatisfying(versions, '>=9.0.0'), null)
  assert.equal(maxSatisfying(versions, ''), null)

  assert.equal(maxVersion(versions), '0.3.0')
  assert.equal(maxVersion(['1.0.0-rc.1', '1.0.0-alpha']), '1.0.0-rc.1')
  assert.equal(maxVersion([]), null)
  assert.equal(maxVersion(['nope']), null)

  assert.deepEqual(sortVersions(['1.0.0', '0.1.0', 'bad', '1.0.0-rc.1']), [
    '0.1.0',
    '1.0.0-rc.1',
    '1.0.0',
  ])
})
