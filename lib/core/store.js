/**
 * Persistent state for the plugin updater.
 *
 * Everything the plugin remembers lives under `$DSH_HOME/plugin-updater/`:
 *
 *   config.json  user settings (sources, prerelease policy, throttle, ignores)
 *   cache.json   last check results per package (so an offline start can still
 *                show "what we knew" plus its timestamp)
 *   update-log.jsonl  one line per update attempt (append-only, best effort)
 *
 * This is the only module that touches the filesystem for state; core modules
 * receive plain objects. All writes are atomic (tmp file + rename) so a crash
 * mid-write cannot leave unparsable JSON, and every read is defensive: a
 * corrupt file degrades to defaults instead of breaking the Settings page.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** @typedef {ReturnType<typeof normalizeConfig>} UpdaterConfig */

/** Source ids understood by the whole plugin. */
export const SOURCE_IDS = ['npm-official', 'npm-mirror', 'github', 'github-mirror']

/** Default GitHub acceleration prefixes, tried in order. */
export const DEFAULT_GITHUB_MIRRORS = [
  'https://gh-proxy.com',
  'https://ghfast.top',
  'https://ghproxy.net',
]

export const DEFAULT_CONFIG = Object.freeze({
  /** Source used unless a package overrides it. */
  defaultSource: 'npm-mirror',
  /** Optional custom npm registry; empty = use the selected source's registry. */
  customRegistry: '',
  /** GitHub mirror prefixes, in fallback order (only for the github-mirror source). */
  githubMirrorPrefixes: [...DEFAULT_GITHUB_MIRRORS],
  /** Offer prerelease candidates even when the installed version is stable. */
  allowPrerelease: false,
  /** Minimum time between checks of the same package, in hours. */
  checkIntervalHours: 6,
  /** Package names whose notifications are ignored (never auto-checked/flagged). */
  ignore: [],
  /** Per-package source override: { "<pkg>": "<source id>" }. */
  perPackageSource: {},
  /** Optional explicit HTTP(S) proxy for metadata requests; empty = read the
   * standard HTTPS_PROXY / HTTP_PROXY environment variables. */
  proxyUrl: '',
  /** Per-request network timeout. */
  requestTimeoutMs: 8000,
  /** Parallel version lookups. */
  concurrency: 4,
  /** Hard cap for one check sweep. */
  totalTimeoutMs: 30000,
  /** Legacy switch kept so older config files still normalize; the startup
   * sweep is governed by `checkOnStartup` instead. */
  autoCheckOnStart: true,
  /** Startup check policy: 'force' checks every boot, 'throttle' honours
   * `checkIntervalHours` like a normal background check. */
  checkOnStartup: 'force',
})

/** @param {unknown} value */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {unknown} value @param {number} fallback @param {number} min @param {number} max */
function numberIn(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/**
 * Coerce arbitrary on-disk config into a valid one.
 * Unknown fields are dropped; invalid values fall back to defaults.
 * @param {unknown} raw
 */
export function normalizeConfig(raw) {
  const input = isPlainObject(raw) ? raw : {}
  const source = SOURCE_IDS.includes(/** @type {string} */ (input.defaultSource))
    ? /** @type {string} */ (input.defaultSource)
    : DEFAULT_CONFIG.defaultSource
  const mirrors = Array.isArray(input.githubMirrorPrefixes)
    ? input.githubMirrorPrefixes
        .filter(prefix => typeof prefix === 'string' && /^https?:\/\//.test(prefix.trim()))
        .map(prefix => prefix.trim().replace(/\/+$/, ''))
    : []
  const ignore = Array.isArray(input.ignore)
    ? input.ignore.filter(name => typeof name === 'string' && name.trim() !== '').map(name => name.trim())
    : []
  const perPackageSource = {}
  if (isPlainObject(input.perPackageSource)) {
    for (const [name, value] of Object.entries(input.perPackageSource)) {
      if (typeof name === 'string' && SOURCE_IDS.includes(/** @type {string} */ (value))) perPackageSource[name] = value
    }
  }
  const customRegistry = typeof input.customRegistry === 'string' ? input.customRegistry.trim().replace(/\/+$/, '') : ''
  const proxyUrl = typeof input.proxyUrl === 'string' ? input.proxyUrl.trim() : ''
  return {
    defaultSource: source,
    customRegistry: /^https?:\/\/[^\s]+$/.test(customRegistry) ? customRegistry : '',
    githubMirrorPrefixes: mirrors.length === 0 ? [...DEFAULT_GITHUB_MIRRORS] : mirrors,
    allowPrerelease: input.allowPrerelease === true,
    checkIntervalHours: numberIn(input.checkIntervalHours, DEFAULT_CONFIG.checkIntervalHours, 0.05, 24 * 30),
    ignore: [...new Set(ignore)],
    perPackageSource,
    proxyUrl: /^https?:\/\/[^\s]+$/.test(proxyUrl) ? proxyUrl : '',
    requestTimeoutMs: numberIn(input.requestTimeoutMs, DEFAULT_CONFIG.requestTimeoutMs, 1000, 60000),
    concurrency: Math.round(numberIn(input.concurrency, DEFAULT_CONFIG.concurrency, 1, 16)),
    totalTimeoutMs: numberIn(input.totalTimeoutMs, DEFAULT_CONFIG.totalTimeoutMs, 5000, 300000),
    autoCheckOnStart: input.autoCheckOnStart !== false,
    checkOnStartup: input.checkOnStartup === 'throttle' ? 'throttle' : 'force',
  }
}

/**
 * Resolve `$DSH_HOME` without trusting a single source.
 * @param {{ dshHome?: string, profileDir?: string }} [hints]
 * @returns {string}
 */
export function resolveDshHome(hints = {}) {
  if (typeof hints.dshHome === 'string' && hints.dshHome.trim() !== '') return path.resolve(hints.dshHome)
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv)
  if (typeof hints.profileDir === 'string' && hints.profileDir.trim() !== '') {
    // <home>/profiles/<name> → <home>
    return path.dirname(path.dirname(path.resolve(hints.profileDir)))
  }
  return path.join(os.homedir(), '.dsh')
}

/**
 * Directory holding this plugin's state.
 * @param {{ dshHome?: string, profileDir?: string }} [hints]
 */
export function stateDir(hints = {}) {
  return path.join(resolveDshHome(hints), 'plugin-updater')
}

/** Read + parse JSON, returning undefined on any problem. @param {string} file */
function readJson(file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    if (text.trim() === '') return undefined
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Write JSON atomically (tmp in the same directory + rename). @param {string} file @param {unknown} value */
export function writeJsonAtomic(file, value) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try {
    fs.renameSync(temp, file)
  } catch (error) {
    try { fs.unlinkSync(temp) } catch { /* best effort */ }
    throw error
  }
}

/** @param {string} dir */
export function loadConfig(dir) {
  return normalizeConfig(readJson(path.join(dir, 'config.json')))
}

/** @param {string} dir @param {UpdaterConfig} config */
export function saveConfig(dir, config) {
  const normalized = normalizeConfig(config)
  writeJsonAtomic(path.join(dir, 'config.json'), normalized)
  return normalized
}

/** @param {unknown} raw */
export function normalizeCache(raw) {
  const input = isPlainObject(raw) ? raw : {}
  const packages = {}
  if (isPlainObject(input.packages)) {
    for (const [name, value] of Object.entries(input.packages)) {
      if (!isPlainObject(value)) continue
      packages[name] = value
    }
  }
  return {
    version: 1,
    lastCheckAt: typeof input.lastCheckAt === 'string' ? input.lastCheckAt : null,
    runtimeVersion: typeof input.runtimeVersion === 'string' ? input.runtimeVersion : null,
    packages,
  }
}

/** @typedef {ReturnType<typeof normalizeCache>} UpdaterCache */

/** @param {string} dir */
export function loadCache(dir) {
  return normalizeCache(readJson(path.join(dir, 'cache.json')))
}

/** @param {string} dir @param {UpdaterCache} cache */
export function saveCache(dir, cache) {
  writeJsonAtomic(path.join(dir, 'cache.json'), cache)
}

/**
 * Append one update attempt to the log. Never throws: a failed log write must
 * not turn a successful update into a reported failure.
 * @param {string} dir @param {unknown} entry
 */
export function appendUpdateLog(dir, entry) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, 'update-log.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8')
  } catch {
    /* best effort */
  }
}

/**
 * Read the tail of the update log (newest last, at most `limit` entries).
 * @param {string} dir @param {number} [limit]
 */
export function readUpdateLog(dir, limit = 100) {
  try {
    const file = path.join(dir, 'update-log.jsonl')
    const text = fs.readFileSync(file, 'utf8')
    const lines = text.split('\n').filter(line => line.trim() !== '')
    const slice = lines.slice(Math.max(0, lines.length - limit))
    return slice.map(line => {
      try { return JSON.parse(line) } catch { return { unparsable: line } }
    })
  } catch {
    return []
  }
}
