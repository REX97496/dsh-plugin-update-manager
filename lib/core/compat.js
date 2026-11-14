/**
 * DSH host compatibility gate.
 *
 * Mirrors `evaluatePluginCompatibility` in `@deepseek-ai/dsh-app-boot`:
 *   - when `engines.dsh` is present it is the *only* requirement that counts,
 *     every `@deepseek-ai/dsh*` peer is ignored;
 *   - otherwise every peer dependency named `@deepseek-ai/dsh` or
 *     `@deepseek-ai/dsh-*` must accept the running DSH version;
 *   - `workspace:^`, `workspace:~` and `workspace:*` mean "the current
 *     runtime version" (the package will be published with a concrete range);
 *   - ranges are matched with `includePrerelease: true`, so a `-rc` runtime
 *     is evaluated exactly like the host does at plugin load time.
 *
 * Unlike the host implementation this module never throws: malformed input is
 * reported as an incompatible result so callers can keep rendering a row.
 *
 * @module core/compat
 */

import * as semver from './semver.js'

const DSH_PACKAGE = '@deepseek-ai/dsh'
const DSH_PREFIX = '@deepseek-ai/dsh-'
const WORKSPACE_RANGES = new Set(['workspace:^', 'workspace:~', 'workspace:*'])
const MANIFEST_PLACEHOLDER = '(manifest)'

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Turn a manifest/peer value into the string we report and evaluate.
 * @param {unknown} value
 * @returns {string}
 */
function asRange(value) {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  return String(value)
}

/**
 * Host semantics for a single range: empty/invalid ranges never satisfy.
 * @param {string} actual
 * @param {string} range
 * @returns {boolean}
 */
function satisfies(actual, range) {
  return semver.satisfies(actual, range, { includePrerelease: true })
}

/**
 * @param {string} actual
 * @returns {{compatible: false, source: 'none', unmet: Array<{name: string, range: string, actual: string}>}}
 */
function invalidResult(actual) {
  return {
    compatible: false,
    source: 'none',
    unmet: [{ name: MANIFEST_PLACEHOLDER, range: '', actual }],
  }
}

/**
 * Evaluate a plugin manifest against a DSH runtime version.
 *
 * @param {unknown} manifest Parsed `package.json` of the plugin.
 * @param {string} runtimeVersion Running DSH version, e.g. `0.2.1-rc.4`.
 * @returns {{
 *   compatible: boolean,
 *   source: 'engines'|'peers'|'none',
 *   unmet: Array<{name: string, range: string, actual: string}>
 * }} `source` tells which rule decided the outcome; `unmet` lists failing
 * requirements (empty when compatible).
 */
export function evaluateManifest(manifest, runtimeVersion) {
  const actual = typeof runtimeVersion === 'string' ? runtimeVersion.trim() : ''

  if (!isRecord(manifest) || semver.valid(actual) === null) {
    return invalidResult(actual)
  }

  const engines = isRecord(manifest.engines) ? manifest.engines : null
  if (engines !== null && Object.prototype.hasOwnProperty.call(engines, 'dsh')) {
    const range = asRange(engines.dsh)
    if (!satisfies(actual, range)) {
      return { compatible: false, source: 'engines', unmet: [{ name: 'engines.dsh', range, actual }] }
    }
    return { compatible: true, source: 'engines', unmet: [] }
  }

  const peers = isRecord(manifest.peerDependencies) ? manifest.peerDependencies : null
  /** @type {Array<{name: string, range: string, actual: string}>} */
  const unmet = []
  let evaluated = 0

  if (peers !== null) {
    for (const [name, value] of Object.entries(peers)) {
      if (name !== DSH_PACKAGE && !name.startsWith(DSH_PREFIX)) continue
      const declared = asRange(value)
      const range = WORKSPACE_RANGES.has(declared.trim()) ? actual : declared
      evaluated += 1
      if (!satisfies(actual, range)) {
        unmet.push({ name, range: declared, actual })
      }
    }
  }

  if (unmet.length > 0) return { compatible: false, source: 'peers', unmet }
  return { compatible: true, source: evaluated > 0 ? 'peers' : 'none', unmet: [] }
}

/**
 * Render unmet requirements as one English sentence, for logs and update
 * journals. Returns `''` when there is nothing unmet.
 *
 * @param {Array<{name?: string, range?: string, actual?: string}>|null|undefined} unmet
 * @returns {string}
 */
export function describeUnmet(unmet) {
  if (!Array.isArray(unmet) || unmet.length === 0) return ''
  const items = unmet.filter(isRecord)
  if (items.length === 0) return ''

  const parts = items.map((item) => {
    const name = typeof item.name === 'string' && item.name !== '' ? item.name : DSH_PACKAGE
    const range = typeof item.range === 'string' ? item.range.trim() : ''
    return range === ''
      ? `${name} declares an invalid or empty DSH version range`
      : `${name} requires "${range}"`
  })

  let actual = ''
  for (const item of items) {
    if (typeof item.actual === 'string' && item.actual !== '') {
      actual = item.actual
      break
    }
  }

  const runtime = actual === '' ? 'the current DSH runtime version is unknown' : `the current DSH runtime is ${actual}`
  return `Unmet DSH requirements: ${parts.join('; ')}; ${runtime}.`
}
