/**
 * Load the running DSH profile: where it lives, which runtime is hosting it,
 * and which packages are installed in it.
 *
 * Everything here is defensive: a missing package.json, an unreadable
 * `node_modules/<pkg>/package.json` or a missing package manager degrades to
 * `null` / empty values instead of throwing. `loadProfile()` must never take
 * the updater UI down because one plugin directory is broken.
 *
 * @module core/profile
 */

import { access, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

import * as semver from './semver.js'
import { resolveDshHome } from './store.js'

const APP_BOOT_PACKAGE = '@deepseek-ai/dsh-app-boot'
const DSH_CLI_PACKAGE = '@deepseek-ai/dsh'
const LOCAL_SPEC_PATTERN = /^(link|file|portal|workspace):/i
const WINDOWS_ABSOLUTE_PATTERN = /^[A-Za-z]:[\\/]/
const RUNTIME_PACKAGE_NAMES = [APP_BOOT_PACKAGE, DSH_CLI_PACKAGE]

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return null
}

/**
 * @param {string} file
 * @returns {Promise<unknown|null>} Parsed JSON, or null on any failure.
 */
async function readJson(file) {
  try {
    const text = await readFile(file, 'utf8')
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * @param {string} file
 * @returns {Promise<string|null>} `version` from a package.json, or null.
 */
async function readVersion(file) {
  const parsed = await readJson(file)
  if (!isRecord(parsed)) return null
  return typeof parsed.version === 'string' && parsed.version.trim() !== '' ? parsed.version.trim() : null
}

/**
 * Resolve a `file:` URL (or a bare absolute path) to a filesystem path.
 * @param {unknown} value
 * @returns {string|null}
 */
function toFilePath(value) {
  if (typeof value !== 'string' || value === '') return null
  if (!value.startsWith('file:')) return path.isAbsolute(value) ? value : null
  try {
    return fileURLToPath(value)
  } catch {
    return null
  }
}

/**
 * Walk up from a resolved module entry until a package.json is found (some
 * packages hide their package.json behind an `exports` map).
 * @param {string} entryPath
 * @returns {string|null}
 */
function findManifestAbove(entryPath) {
  let current = path.dirname(entryPath)
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(current, 'package.json')
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
  return null
}

/**
 * Normalise a CJS resolution anchor. Hosts pass `installAnchor` as an
 * absolute path to the running DSH app's package.json; accept a directory
 * too, and fall back to the profile manifest when the host omitted it.
 *
 * @param {unknown} value
 * @param {string} fallback
 * @returns {Promise<string>}
 */
async function anchorPackageFile(value, fallback) {
  const text = firstString(value)
  if (text === null) return fallback
  const candidate = path.isAbsolute(text) ? text : path.resolve(text)
  try {
    const info = await stat(candidate)
    if (info.isDirectory()) return path.join(candidate, 'package.json')
  } catch {
    // A missing path is still a usable anchor: createRequire only needs its
    // directory component (this also covers app.asar paths in plain Node).
  }
  return candidate
}

/**
 * Read a package version through Node's own resolver the way the host does.
 *
 * Builtin bundles such as `@deepseek-ai/dsh-base` are not installed into the
 * profile's node_modules: the CLI keeps them next to its own package (the
 * installation anchor) and the desktop app keeps them inside `app.asar`.
 * A plain path probe cannot see either location, so resolve from the
 * installation anchor first, then from this module's own context.
 *
 * @param {string} name Package name.
 * @param {{installAnchor?: unknown, profileDir: string}} hints
 * @returns {Promise<{version: string, path: string}|null>}
 */
async function resolveInstalledVersionViaNode(name, hints) {
  const specifier = `${name}/package.json`
  /** @type {string[]} */
  const anchors = []
  const push = (value) => {
    if (typeof value === 'string' && value !== '' && !anchors.includes(value)) anchors.push(value)
  }

  push(await anchorPackageFile(hints.installAnchor, path.join(hints.profileDir, 'package.json')))
  try {
    push(fileURLToPath(import.meta.url))
  } catch {
    // A non-file module URL cannot anchor CJS resolution.
  }

  for (const anchor of anchors) {
    try {
      const resolved = createRequire(anchor).resolve(specifier)
      const file = toFilePath(resolved)
      if (file === null) continue
      const version = await readVersion(file)
      if (version !== null) return { version, path: file }
    } catch {
      // Expected on most hosts: fall through to the next anchor.
    }
  }
  return null
}

/**
 * Resolve one runtime package (app-boot / dsh CLI) through the same resolvers
 * the host uses, then through explicit filesystem probes.
 *
 * @param {string} packageName
 * @param {string[]} anchors Absolute package.json paths used as CJS anchors.
 * @param {string[]} probeRoots Directories whose `node_modules` are probed.
 * @returns {Promise<{version: string, path: string}|null>}
 */
async function resolveRuntimePackage(packageName, anchors, probeRoots) {
  /** @type {string[]} */
  const entryCandidates = []
  const push = (value) => {
    if (typeof value === 'string' && value !== '') entryCandidates.push(value)
  }

  for (const specifier of [`${packageName}/package.json`, packageName]) {
    try {
      if (typeof import.meta.resolve === 'function') push(import.meta.resolve(specifier))
    } catch {
      // Not resolvable from the ESM graph; try the CJS resolvers next.
    }
    try {
      push(createRequire(import.meta.url).resolve(specifier))
    } catch {
      // Not resolvable from this module's location.
    }
    for (const anchor of anchors) {
      try {
        push(createRequire(anchor).resolve(specifier))
      } catch {
        // Not resolvable from this anchor.
      }
    }
  }

  for (const candidate of entryCandidates) {
    const file = toFilePath(candidate)
    if (file === null) continue
    const manifest = file.endsWith('package.json') ? file : findManifestAbove(file)
    if (manifest === null) continue
    const version = await readVersion(manifest)
    if (version !== null && semver.valid(version) !== null) return { version, path: manifest }
  }

  const segments = packageName.split('/')
  for (const root of probeRoots) {
    const manifest = path.join(root, 'node_modules', ...segments, 'package.json')
    const version = await readVersion(manifest)
    if (version !== null && semver.valid(version) !== null) return { version, path: manifest }
  }
  return null
}

/**
 * Resolve the DSH runtime version.
 *
 * Order: app-boot package.json → `@deepseek-ai/dsh` package.json →
 * `DSH_RUNTIME_VERSION` from the environment → `profileContext.runtimeVersion`
 * (defensive; the desktop host does not send it today) → 'unknown'.
 *
 * @param {{
 *   env: Record<string, string|undefined>,
 *   profileContext: Record<string, any>|null,
 *   profileDir: string,
 *   dshHome: string
 * }} context
 * @returns {Promise<{version: string, source: 'app-boot'|'dsh'|'env'|'profile-context'|'unknown'}>}
 */
async function resolveRuntimeVersion(context) {
  const anchors = [
    path.join(context.profileDir, 'package.json'),
    path.join(context.dshHome, 'package.json'),
  ]
  const probeRoots = [
    context.profileDir,
    path.join(context.dshHome, 'profiles'),
    context.dshHome,
  ]

  for (const packageName of RUNTIME_PACKAGE_NAMES) {
    const resolved = await resolveRuntimePackage(packageName, anchors, probeRoots)
    if (resolved !== null) {
      return { version: resolved.version, source: packageName === APP_BOOT_PACKAGE ? 'app-boot' : 'dsh' }
    }
  }

  const fromEnv = typeof context.env.DSH_RUNTIME_VERSION === 'string' ? context.env.DSH_RUNTIME_VERSION.trim() : ''
  if (fromEnv !== '' && semver.valid(fromEnv) !== null) return { version: fromEnv, source: 'env' }

  const fromContext = isRecord(context.profileContext) && typeof context.profileContext.runtimeVersion === 'string'
    ? context.profileContext.runtimeVersion.trim()
    : ''
  if (fromContext !== '' && semver.valid(fromContext) !== null) return { version: fromContext, source: 'profile-context' }

  return { version: 'unknown', source: 'unknown' }
}

/**
 * Normalize the host-provided package manager descriptor. The desktop host
 * describes it as "installation-owned executable and environment"; field
 * names vary between host versions, so accept the documented shape plus the
 * common aliases.
 *
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {{command: string, args: string[], env: Record<string, string>}|null}
 */
function normalizePackageManager(value, depth = 0) {
  if (depth > 2 || value === undefined || value === null) return null
  if (typeof value === 'string') {
    const command = value.trim()
    return command === '' ? null : { command, args: [], env: {} }
  }
  if (!isRecord(value)) return null

  for (const key of ['pnpm', 'npm', 'default']) {
    const nested = value[key]
    if (isRecord(nested) && (nested.command !== undefined || nested.executable !== undefined || nested.bin !== undefined)) {
      const normalized = normalizePackageManager(nested, depth + 1)
      if (normalized !== null) return normalized
    }
  }

  const command = firstString(value.command, value.executable, value.bin, value.cmd)
  if (command === null) return null

  const rawArgs = Array.isArray(value.args) ? value.args : Array.isArray(value.baseArgs) ? value.baseArgs : []
  const args = rawArgs.filter((item) => typeof item === 'string')
  const rawEnv = isRecord(value.env)
    ? value.env
    : isRecord(value.environment) ? value.environment : isRecord(value.commandsEnv) ? value.commandsEnv : {}
  /** @type {Record<string, string>} */
  const env = {}
  for (const [key, item] of Object.entries(rawEnv)) {
    if (typeof item === 'string') env[key] = item
  }
  return { command, args, env }
}

/**
 * @param {unknown} rawBundles
 * @returns {{bundles: string[], ids: Map<string, string|null>}}
 */
function normalizeBundles(rawBundles) {
  /** @type {string[]} */
  const bundles = []
  /** @type {Map<string, string|null>} */
  const ids = new Map()
  if (!Array.isArray(rawBundles)) return { bundles, ids }
  for (const row of rawBundles) {
    if (typeof row === 'string') {
      const name = row.trim()
      if (name === '') continue
      bundles.push(name)
      if (!ids.has(name)) ids.set(name, name)
      continue
    }
    if (!isRecord(row)) continue
    const name = firstString(row.name, row.package)
    const id = firstString(row.id)
    if (name === null) {
      if (id !== null) {
        bundles.push(id)
        if (!ids.has(id)) ids.set(id, id)
      }
      continue
    }
    bundles.push(name)
    if (!ids.has(name)) ids.set(name, id ?? name)
  }
  return { bundles, ids }
}

/**
 * @param {string} target
 * @returns {Promise<boolean>} True for an existing, accessible directory.
 */
async function isAccessibleDirectory(target) {
  try {
    const info = await stat(target)
    if (!info.isDirectory()) return false
    await access(target)
    return true
  } catch {
    return false
  }
}

/**
 * Decide whether a dependency specifier points at local code rather than a
 * registry package. A version range (`1.2.3`, `^1.2.3`, `latest`) stays
 * `registry` even though `node_modules/<pkg>` exists — that directory is
 * simply where the installed copy lives.
 *
 * @param {string} specifier
 * @param {boolean} moduleDirExists
 * @returns {{kind: 'local', reason: string}|null}
 */
async function detectLocal(specifier, moduleDirExists) {
  const text = typeof specifier === 'string' ? specifier.trim() : ''
  if (text !== '') {
    const protocol = LOCAL_SPEC_PATTERN.exec(text)
    if (protocol !== null) return { kind: 'local', reason: `${protocol[1].toLowerCase()}:` }
    if (path.isAbsolute(text) || WINDOWS_ABSOLUTE_PATTERN.test(text)) {
      return { kind: 'local', reason: 'absolute-path' }
    }
    if (text.startsWith('.')) return { kind: 'local', reason: 'relative-path' }
    return null
  }
  // No specifier at all: only a real installed directory makes it local.
  if (moduleDirExists) return { kind: 'local', reason: 'directory' }
  return null
}

/**
 * @param {string} name
 * @returns {string[]} Path segments (`@scope`, `pkg`).
 */
function packageSegments(name) {
  return name.split('/').filter((segment) => segment !== '')
}

/**
 * Read one installed package entry.
 *
 * @param {{
 *   name: string,
 *   specifier: string,
 *   profileDir: string,
 *   dshHome: string,
 *   bundleIds: Map<string, string|null>,
 *   installAnchor?: unknown
 * }} context
 * @returns {Promise<Record<string, any>>}
 */
async function readPackageEntry(context) {
  const segments = packageSegments(context.name)
  /** @type {string[]} */
  const roots = [
    path.join(context.profileDir, 'node_modules'),
    path.join(context.dshHome, 'profiles', 'node_modules'),
    path.join(context.dshHome, 'node_modules'),
  ]

  /** @type {string|null} */
  let moduleDir = null
  for (const root of roots) {
    const candidate = path.join(root, ...segments)
    if (await isAccessibleDirectory(candidate)) {
      moduleDir = candidate
      break
    }
  }

  /** @type {Record<string, any>|null} */
  let manifest = null
  /** @type {string|null} */
  let installedVersion = null
  if (moduleDir !== null) {
    const parsed = await readJson(path.join(moduleDir, 'package.json'))
    if (isRecord(parsed)) {
      manifest = parsed
      if (typeof parsed.version === 'string' && parsed.version.trim() !== '') installedVersion = parsed.version.trim()
    }
  }

  const local = await detectLocal(context.specifier, moduleDir !== null)
  /** @type {'local'|'builtin'|'registry'} */
  let kind
  if (local !== null) kind = 'local'
  else if (context.name.startsWith('@deepseek-ai/')) kind = 'builtin'
  else kind = 'registry'

  // Builtins live in the installation scope (CLI node_modules / app.asar),
  // not inside the profile, so the direct path probes above usually miss
  // them. Resolve the version through Node's resolver before giving up.
  // Registry packages keep the node_modules-only behaviour on purpose: a
  // resolver hit could silently report a different installation copy.
  if (kind === 'builtin' && installedVersion === null) {
    const resolved = await resolveInstalledVersionViaNode(context.name, {
      installAnchor: context.installAnchor,
      profileDir: context.profileDir,
    })
    if (resolved !== null) {
      installedVersion = resolved.version
      if (moduleDir === null) moduleDir = path.dirname(resolved.path)
    }
  }

  /** @type {Record<string, any>} */
  const entry = {
    name: context.name,
    specifier: context.specifier,
    kind,
    installedVersion,
    manifest,
    bundleId: context.bundleIds.get(context.name) ?? null,
    moduleDir,
  }
  if (local !== null) entry.reason = local.reason
  return entry
}

/**
 * @typedef {{
 *   name: string,
 *   dir: string,
 *   isLocal: boolean,
 *   runtimeVersion: string,
 *   runtimeSource: 'app-boot'|'dsh'|'env'|'profile-context'|'unknown',
 *   packageManager: {command: string, args: string[], env: Record<string, string>}|null,
 *   dshHome: string,
 *   manifestPath: string,
 *   manifest: Record<string, any>,
 *   bundles: string[],
 *   packages: Array<{
 *     name: string,
 *     specifier: string,
 *     kind: 'registry'|'local'|'builtin',
 *     installedVersion: string|null,
 *     manifest: Record<string, any>|null,
 *     bundleId: string|null,
 *     moduleDir: string|null,
 *     reason?: string
 *   }>
 * }} Profile
 */

/**
 * @param {{
 *   profileContext?: Record<string, any>|null,
 *   env?: Record<string, string|undefined>
 * }} [options]
 * @returns {Promise<Profile>}
 */
export async function loadProfile(options = {}) {
  const input = isRecord(options) ? options : {}
  const env = isRecord(input.env) ? input.env : process.env
  const profileContext = isRecord(input.profileContext) ? input.profileContext : null

  let dshHome = ''
  try {
    dshHome = resolveDshHome({
      dshHome: firstString(profileContext?.home, env.DSH_HOME) ?? undefined,
      profileDir: firstString(profileContext?.dir) ?? undefined,
    })
  } catch {
    dshHome = firstString(env.DSH_HOME) ?? path.join(os.homedir(), '.dsh')
  }

  const dir = path.resolve(firstString(profileContext?.dir) ?? path.join(dshHome, 'profiles', 'desktop'))
  const name = firstString(profileContext?.name) ?? (path.basename(dir) || 'desktop')

  /** @type {Profile} */
  const fallback = {
    name,
    dir,
    isLocal: false,
    runtimeVersion: 'unknown',
    runtimeSource: 'unknown',
    packageManager: normalizePackageManager(profileContext?.packageManager),
    dshHome,
    manifestPath: path.join(dir, 'package.json'),
    manifest: {},
    bundles: [],
    packages: [],
  }

  try {
    const manifestPath = path.join(dir, 'package.json')
    const rawManifest = await readJson(manifestPath)
    const manifest = isRecord(rawManifest) ? rawManifest : {}
    const [isLocal, runtime] = await Promise.all([
      isAccessibleDirectory(dir),
      resolveRuntimeVersion({ env, profileContext, profileDir: dir, dshHome }),
    ])

    const dependencies = isRecord(manifest.dependencies) ? manifest.dependencies : {}
    const dshSection = isRecord(manifest.dsh) ? manifest.dsh : {}
    const profileSection = isRecord(dshSection.profile) ? dshSection.profile : {}
    const { bundles, ids: bundleIds } = normalizeBundles(profileSection.bundles)

    /** @type {Array<Record<string, any>>} */
    const packages = []
    for (const [packageName, rawSpecifier] of Object.entries(dependencies)) {
      const specifier = typeof rawSpecifier === 'string' ? rawSpecifier : String(rawSpecifier ?? '')
      packages.push(await readPackageEntry({
        name: packageName,
        specifier,
        profileDir: dir,
        dshHome,
        bundleIds,
        installAnchor: firstString(profileContext?.installAnchor),
      }))
    }

    return {
      ...fallback,
      isLocal,
      runtimeVersion: runtime.version,
      runtimeSource: runtime.source,
      manifest,
      bundles,
      packages,
    }
  } catch (error) {
    if (process.env.DSH_UPDATER_DEBUG === '1') throw error
    return fallback
  }
}
