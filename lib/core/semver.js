/**
 * Dependency-free semantic-version implementation for the plugin updater.
 *
 * DSH's boot-time compatibility gate (`evaluatePluginCompatibility` in
 * `@deepseek-ai/dsh-app-boot`) calls `semver.satisfies(runtime, range, {
 * includePrerelease: true })`, so this module implements the same semantics:
 * caret/tilde/x/hyphen ranges, `||`, partial versions, build metadata, and
 * prerrerelease gating with the `includePrerelease` switch. Version
 * *selection* (whether a prerelease may be offered as an update) is a separate
 * policy implemented in `pick.js` — it must not be expressed through
 * `satisfies`, because `includePrerelease` there only widens range matching.
 */

const NUM = /^(0|[1-9]\d*)$/
const PRERELEASE_ID = /^[0-9A-Za-z-]+$/

/** @typedef {{ major:number, minor:number, patch:number, prerelease:(string|number)[], build:string[] }} SemVer */

/**
 * Parse a semantic version.
 * @param {unknown} value
 * @returns {SemVer|null} null for anything that is not a valid SemVer
 */
export function parse(value) {
  if (typeof value !== 'string') return null
  let text = value.trim()
  if (text === '') return null
  if (text[0] === 'v' || text[0] === 'V') text = text.slice(1)
  const plus = text.indexOf('+')
  let build = []
  if (plus !== -1) {
    const buildText = text.slice(plus + 1)
    text = text.slice(0, plus)
    if (buildText === '') return null
    build = buildText.split('.')
    if (build.some(part => !PRERELEASE_ID.test(part))) return null
  }
  const dash = text.indexOf('-')
  let prerelease = []
  if (dash !== -1) {
    const preText = text.slice(dash + 1)
    text = text.slice(0, dash)
    if (preText === '') return null
    const parts = preText.split('.')
    for (const part of parts) {
      if (!PRERELEASE_ID.test(part)) return null
      // Numeric identifiers lose leading zeros and compare numerically.
      prerelease.push(NUM.test(part) ? Number(part) : part)
    }
  }
  const core = text.split('.')
  if (core.length !== 3) return null
  const [major, minor, patch] = core
  if (!NUM.test(major) || !NUM.test(minor) || !NUM.test(patch)) return null
  return { major: Number(major), minor: Number(minor), patch: Number(patch), prerelease, build }
}

/**
 * Normalized string form of a version (no `v` prefix, build metadata kept).
 * @param {SemVer} version
 */
export function format(version) {
  const core = `${version.major}.${version.minor}.${version.patch}`
  const pre = version.prerelease.length === 0 ? '' : `-${version.prerelease.join('.')}`
  const build = version.build.length === 0 ? '' : `+${version.build.join('.')}`
  return `${core}${pre}${build}`
}

/** @param {unknown} value @returns {string|null} canonical version or null */
export function valid(value) {
  const parsed = parse(value)
  return parsed === null ? null : format(parsed)
}

/** @param {unknown} value @returns {boolean} */
export function isPrerelease(value) {
  const parsed = parse(value)
  return parsed !== null && parsed.prerelease.length > 0
}

/**
 * Compare two parsed versions.
 * @param {SemVer} a @param {SemVer} b @returns {number} <0, 0, >0
 */
export function compare(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  return comparePrerelease(a.prerelease, b.prerelease)
}

function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0
  // A stable version is greater than any prerelease of the same core.
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const left = a[index]
    const right = b[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    if (left === right) continue
    const leftNumeric = typeof left === 'number'
    const rightNumeric = typeof right === 'number'
    if (leftNumeric && rightNumeric) return left < right ? -1 : 1
    if (leftNumeric) return -1
    if (rightNumeric) return 1
    return left < right ? -1 : 1
  }
  return 0
}

/**
 * Compare two version strings.
 * @param {string} a @param {string} b @returns {number}
 * @throws when either string is not a valid SemVer
 */
export function compareStrings(a, b) {
  const left = parse(a)
  const right = parse(b)
  if (left === null) throw new Error(`invalid version: ${String(a)}`)
  if (right === null) throw new Error(`invalid version: ${String(b)}`)
  return compare(left, right)
}

/** @returns {boolean} */
export function gt(a, b) { return compareStrings(a, b) > 0 }
/** @returns {boolean} */
export function gte(a, b) { return compareStrings(a, b) >= 0 }
/** @returns {boolean} */
export function lt(a, b) { return compareStrings(a, b) < 0 }
/** @returns {boolean} */
export function lte(a, b) { return compareStrings(a, b) <= 0 }
/** @returns {boolean} */
export function eq(a, b) {
  const left = parse(a)
  const right = parse(b)
  if (left === null || right === null) return false
  return compare(left, right) === 0
}

/**
 * Sort version strings ascending.
 * @param {string[]} versions
 * @returns {string[]} a new array; invalid entries are dropped
 */
export function sortVersions(versions) {
  return versions
    .filter(version => parse(version) !== null)
    .sort((a, b) => compareStrings(a, b))
}

const ANY = Object.freeze({ any: true })

/**
 * Parse one comparator token (`^1.2.3`, `>=1.2`, `1.x`, `*`, `1.2.3`).
 * @param {string} token
 * @returns {{ any:true } | { op:string, version:SemVer, prerelease:boolean } | null}
 */
function parseComparator(token, includePrerelease = false) {
  const match = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(token)
  if (match === null) return null
  const op = match[1] ?? '='
  const raw = match[2].trim()
  if (raw === '' || raw === '*' || raw === 'x' || raw === 'X') return ANY
  // A `-` inside a single comparator is a prerelease, never a range: check it
  // before splitting the core so `1.2.3-rc.1` is not read as four fields.
  if (raw.includes('-')) {
    const parsed = parse(raw)
    if (parsed === null) return null
    return { op, version: parsed, prerelease: parsed.prerelease.length > 0 }
  }
  const parts = raw.split('.')
  if (parts.length > 3) return null
  const fields = []
  for (const part of parts) {
    if (part === '' || part === 'x' || part === 'X' || part === '*') {
      fields.push(null)
      continue
    }
    if (!/^(0|[1-9]\d*)$/.test(part)) return null
    fields.push(Number(part))
  }
  while (fields.length < 3) fields.push(null)
  const [major, minor, patch] = fields
  if (major === null) return ANY
  const lower = { major, minor: minor ?? 0, patch: patch ?? 0, prerelease: [], build: [] }
  if (op !== '=' && op !== '^' && op !== '~') return { op, version: lower, prerelease: false }
  if (minor === null || patch === null) {
    // Partial version (x-range): `1.2` = `1.2.x`, `^1.2` = `>=1.2.0 <2.0.0`,
    // `~1.2` = `>=1.2.0 <1.3.0`, `1` = `1.x`, `^0.2` = `>=0.2.0 <0.3.0`.
    let upper
    if (minor === null) {
      // `1`, `1.x` → `>=1.0.0 <2.0.0-0`
      upper = exclusiveUpper(major + 1, 0, 0)
    } else if (op === '^') {
      // `^1.2` → `<2.0.0-0`; `^0.2` → `<0.3.0-0`; `^0.0` → `<0.1.0-0`
      upper = major !== 0 ? exclusiveUpper(major + 1, 0, 0) : exclusiveUpper(0, minor + 1, 0)
    } else {
      // `1.2`, `1.2.x`, `~1.2` → `<1.3.0-0`
      upper = exclusiveUpper(major, minor + 1, 0)
    }
    // With includePrerelease the desugared lower bound is `M.m.p-0` (node-semver
    // appends `-0` there), so `1.2` also matches `1.2.0-rc.1`.
    const partialLower = includePrerelease
      ? { ...lower, prerelease: [0] }
      : lower
    return { range: [[{ op: '>=', version: partialLower, prerelease: false }, { op: '<', version: upper, prerelease: false }]], partial: true }
  }
  return { op, version: lower, prerelease: false }
}

/**
 * Expand one whitespace-separated comparator set into primitive comparators.
 * @param {string} text
 * @returns {{comparators:{op:string,version:SemVer,prerelease:boolean}[], prereleaseOk:boolean}|null}
 */
function parseSet(text, includePrerelease = false) {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed === '*' || trimmed === 'x' || trimmed === 'X') {
    return { comparators: [], prereleaseOk: false }
  }
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(trimmed)
  if (hyphen !== null) {
    const lowRaw = parseComparator(`>=${hyphen[1]}`)
    const highPartial = hyphen[2]
    // With includePrerelease the lower bound is `x.y.z-0` and a full upper
    // bound becomes the exclusive `<next.patch-0` form, mirroring node-semver.
    const low = lowRaw !== null && lowRaw.any !== true && includePrerelease &&
      lowRaw.version !== undefined && lowRaw.version.prerelease.length === 0
      ? { ...lowRaw, version: { ...lowRaw.version, prerelease: [0] } }
      : lowRaw
    // `1.2.3 - 2.3.4` keeps the inclusive form; a partial upper bound
    // (`1.2 - 2.3`) means "up to, not including 2.4.0-0".
    const highIsX = /[xX*]/.test(highPartial)
    const highParts = highIsX || highPartial.includes('-') ? null : highPartial.split('.')
    let high
    if (highParts !== null && highParts.length === 3 && !includePrerelease) {
      high = parseComparator(`<=${highPartial}`)
    } else if (highParts !== null && highParts.length === 3) {
      const patch = Number(highParts[2])
      high = { op: '<', version: exclusiveUpper(Number(highParts[0]), Number(highParts[1]), patch + 1), prerelease: false }
    } else {
      const parts = highPartial.split('.').map(part => (/^(0|[1-9]\d*)$/.test(part) ? Number(part) : null))
      if (parts[0] === null) return null
      const upper = parts.length === 1 || parts[1] === null
        ? exclusiveUpper(parts[0] + 1, 0, 0)
        : exclusiveUpper(parts[0], parts[1] + 1, 0)
      high = { op: '<', version: upper, prerelease: false }
    }
    if (low === null || low.any === true || high === null || high.any === true) return null
    return {
      comparators: [low, high],
      prereleaseOk: low.prerelease || high.prerelease,
    }
  }
  const tokens = trimmed.split(/\s+/)
  const comparators = []
  let prereleaseOk = false
  for (const token of tokens) {
    const parsed = parseComparator(token, includePrerelease)
    if (parsed === null) return null
    if (parsed.any === true) continue
    if (parsed.range !== undefined) {
      for (const group of parsed.range) for (const inner of group) comparators.push(inner)
      continue
    }
    comparators.push(parsed)
    if (parsed.prerelease) prereleaseOk = true
  }
  return { comparators, prereleaseOk }
}

/**
 * Synthetic exclusive upper bound `M.m.p-0` — the smallest possible version of
 * that core tuple, which is exactly what node-semver writes for caret, tilde,
 * x-range and hyphen upper bounds. Without the `-0` sentinel a bound like
 * `<2.0.0` would happily accept `2.0.0-rc.1`, and compatibility checks would
 * then recommend a version the host refuses to load.
 * @param {number} major @param {number} minor @param {number} patch
 * @returns {{major:number,minor:number,patch:number,prerelease:number[],build:number[]}}
 */
function exclusiveUpper(major, minor, patch) {
  return { major, minor, patch, prerelease: [0], build: [] }
}

/**
 * Expand a range into OR-ed comparator sets.
 * @param {string} range
 * @returns {{comparators:{op:string,version:SemVer,prerelease:boolean}[], prereleaseOk:boolean}[]|null}
 */
function parseRange(range, includePrerelease = false) {
  const sets = []
  for (const alternative of String(range).split('||')) {
    const set = parseSet(alternative, includePrerelease)
    if (set === null) return null
    sets.push(set)
  }
  return sets
}

/** @param {number} a @param {number} b -1/0/1 */
function cmpNumber(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

/** @param {SemVer} version @param {SemVer} bound */
function primitivePass(version, bound, op) {
  const result = compare(version, bound)
  switch (op) {
    case '>': return result > 0
    case '>=': return result >= 0
    case '<': return result < 0
    case '<=': return result <= 0
    case '=': return result === 0
    default: return false
  }
}

/**
 * Expand caret/tilde operators against a full version.
 * @param {{op:string,version:SemVer}} comparator
 * @returns {{op:string,version:SemVer}[]}
 */
function expandComparator(comparator) {
  const { op, version } = comparator
  const lower = { op: '>=', version }
  if (op === '=') return [{ op: '=', version }]
  if (op === '~') {
    // `~0.0.3` is `>=0.0.3 <0.1.0-0`, exactly like `~1.2.3` is `<1.3.0-0`.
    const upper = exclusiveUpper(version.major, version.minor + 1, 0)
    return [lower, { op: '<', version: upper }]
  }
  if (op === '^') {
    let upper
    if (version.major !== 0) upper = exclusiveUpper(version.major + 1, 0, 0)
    else if (version.minor !== 0) upper = exclusiveUpper(0, version.minor + 1, 0)
    else upper = exclusiveUpper(0, 0, version.patch + 1)
    return [lower, { op: '<', version: upper }]
  }
  return [{ op, version }]
}

/**
 * Test a version against a range.
 * @param {string} version
 * @param {string} range
 * @param {{ includePrerelease?: boolean }} [options]
 * @returns {boolean}
 */
export function satisfies(version, range, options = {}) {
  const parsed = parse(version)
  if (parsed === null) return false
  if (typeof range !== 'string' || range.trim() === '') return false
  const includePrerelease = options.includePrerelease === true
  const sets = parseRange(range, includePrerelease)
  if (sets === null) return false
  for (const set of sets) {
    const comparators = []
    for (const comparator of set.comparators) {
      for (const expanded of expandComparator(comparator)) comparators.push(expanded)
    }
    let pass = true
    for (const comparator of comparators) {
      if (comparator.range !== undefined) continue
      if (!primitivePass(parsed, comparator.version, comparator.op)) {
        pass = false
        break
      }
    }
    if (!pass) continue
    if (parsed.prerelease.length > 0 && !includePrerelease) {
      // Classic SemVer gating: a prerelease only matches when a comparator
      // names a prerelease of the same major.minor.patch tuple.
      const allowed = comparators.some(comparator =>
        comparator.version !== undefined &&
        comparator.version.prerelease.length > 0 &&
        comparator.version.major === parsed.major &&
        comparator.version.minor === parsed.minor &&
        comparator.version.patch === parsed.patch)
      if (!allowed) continue
    }
    return true
  }
  return false
}

/**
 * Highest version satisfying a range.
 * @param {string[]} versions
 * @param {string} range
 * @param {{ includePrerelease?: boolean }} [options]
 * @returns {string|null}
 */
export function maxSatisfying(versions, range, options = {}) {
  let best = null
  for (const version of versions) {
    if (!satisfies(version, range, options)) continue
    if (best === null || compareStrings(version, best) > 0) best = version
  }
  return best
}

/**
 * Highest version in a list, ignoring range semantics (prerelease included).
 * @param {string[]} versions @returns {string|null}
 */
export function maxVersion(versions) {
  const sorted = sortVersions(versions)
  return sorted.length === 0 ? null : sorted[sorted.length - 1]
}

/** Whether two version strings denote the same release (build metadata ignored). */
export function sameRelease(a, b) {
  const left = parse(a)
  const right = parse(b)
  if (left === null || right === null) return false
  return compare(left, right) === 0
}

export const __internal = { parseRange, parseSet, cmpNumber }
