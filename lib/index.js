/**
 * Host half of dsh-plugin-update-manager.
 *
 * Responsibilities, in order of importance:
 *
 *  1. Own the authoritative in-memory model of "which installed plugin is on
 *     which version, and what could it become" — built from the profile
 *     manifest plus cached check results.
 *  2. Serve that model to the client half over `/plugin-updater/api/*`, and
 *     accept the three mutations the UI needs: check, update, config.
 *  3. Run the checks: bounded concurrency, per-request timeout, 6-hour
 *     per-package throttle, optional background sweep after boot.
 *  4. Serialize updates: at most one package manager process at a time; every
 *     other request is queued, never dropped.
 *
 * The plugin never touches DSH internals: the profile is read as a file, the
 * update runs the profile's package manager, and all memory lives under
 * `$DSH_HOME/plugin-updater/`.
 */

import { randomUUID } from 'node:crypto'
import * as store from './core/store.js'
import { loadProfile } from './core/profile.js'
import { listVersions, SourceError, SOURCE_IDS } from './core/sources.js'
import { pickTargets } from './core/pick.js'
import { runUpdate } from './core/update.js'
import { diagnoseStartup } from './core/diagnose.js'
import { probeRestartPlan, requestRestart } from './core/restart.js'

/** Plugin identity for the loader row. */
export const name = 'dsh-plugin-update-manager'

/** Routes require the web server; everything else is optional. */
export const inject = ['webServer']

/** Route prefix owned by this plugin (a duplicate prefix fails the plugin tree). */
const API_PREFIX = '/plugin-updater/api'

/** Upper bound for one JSON request body. */
const MAX_BODY_BYTES = 1 << 20

/** Delay before the first background sweep, so boot and first paint are untouched. */
const STARTUP_CHECK_DELAY_MS = 6000

/** Delay before the first log scan (startup diagnostics), after the check starts. */
const STARTUP_DIAGNOSE_DELAY_MS = 9000

/** How long a completed diagnostics scan may be reused before rescanning. */
const DIAGNOSTICS_TTL_MS = 60_000

/** Statuses for which the UI offers an update button. */
const UPDATABLE = new Set(['update-latest', 'update-compatible', 'switch-compatible'])

/** @typedef {ReturnType<typeof store.normalizeConfig>} UpdaterConfig */

/** One HTTP failure with the wire code and status to report. */
class ApiError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

function now() {
  return new Date().toISOString()
}

/** @param {unknown} value */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve(value)
    }
    req.on('data', chunk => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        finish(new ApiError('bad-request', 'request body too large', 413))
        req.destroy()
        return
      }
      chunks.push(Buffer.from(chunk))
    })
    req.on('error', error => finish(new ApiError('bad-request', `request stream failed: ${error.message}`)))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') return finish(undefined, {})
      try {
        const parsed = JSON.parse(text)
        if (!isObject(parsed)) return finish(new ApiError('bad-request', 'request body must be a JSON object'))
        finish(undefined, parsed)
      } catch {
        finish(new ApiError('bad-request', 'request body is not valid JSON'))
      }
    })
  })
}

function writeJson(res, status, payload) {
  const text = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function writeOk(res, value) {
  writeJson(res, 200, { ok: true, value })
}

function writeError(res, error) {
  const api = error instanceof ApiError
    ? error
    : new ApiError('internal', error instanceof Error ? error.message : String(error), 500)
  writeJson(res, api.status, { ok: false, error: { code: api.code, message: api.message } })
}

/**
 * Same-origin guard for mutations. The routes are mounted on the local web
 * server, which is also reachable from other local processes; a browser page
 * from another origin must not be able to make the plugin spawn installs.
 * Requests without an `Origin` header (curl, server-side fetches) are allowed:
 * the server already binds loopback and DSH's own connection service admits
 * requests before they get here.
 */
function originAllowed(req) {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  const host = req.headers.host
  if (typeof host !== 'string') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** Turn a source failure into the row-level error shape. */
function errorOf(error) {
  if (error instanceof SourceError) {
    return { code: error.code, message: error.message }
  }
  if (error instanceof ApiError) return { code: error.code, message: error.message }
  const message = error instanceof Error ? error.message : String(error)
  return { code: 'unknown', message }
}

/** One Chinese sentence per source failure code, for the row tooltip. */
function sourceErrorMessage(error) {
  if (!(error instanceof SourceError)) return error instanceof Error ? error.message : String(error)
  switch (error.code) {
    case 'timeout': return '请求超时（8 秒），已保留上次结果'
    case 'network': return `网络不可达：${error.detail ?? error.message}`
    case 'not-found': return '包不存在或当前源找不到该包（404）'
    case 'private': return '私有包或需要登录，无法从当前源读取'
    case 'rate-limit': return 'GitHub API 限流，请稍后重试或切换源'
    case 'invalid-repo': return '插件 manifest 里没有可用的 repository 地址'
    case 'bad-response': return '源返回了无法解析的数据'
    default: return error.message
  }
}

/**
 * Mount the plugin.
 * @param {any} ctx host plugin context (webServer required, profileContext optional)
 * @param {any} [config] loader config (unused: settings live in config.json)
 */
export function apply(ctx, config) {
  void config
  /** Identifies this host process instance; changes on every remount/restart. */
  const bootId = randomUUID()
  const logs = []
  const log = message => {
    logs.push(`${now()} ${message}`)
    if (logs.length > 500) logs.shift()
    try { ctx.logger?.info?.(`[plugin-updater] ${message}`) } catch { /* logger is optional */ }
  }

  /** @type {any} */
  let profileContext
  const adoptProfileContext = value => {
    if (isObject(value) && typeof value.dir === 'string') profileContext = value
  }
  // Optional service: the desktop host publishes the profile name/dir and the
  // exact package manager invocation it uses itself. Never required, because
  // the CLI and headless profiles do not publish it.
  if (typeof ctx.get === 'function') adoptProfileContext(ctx.get('profileContext'))
  try {
    ctx.inject(['profileContext'], sctx => { adoptProfileContext(sctx.profileContext) })
  } catch { /* optional service unavailable */ }

  /** Resolved once per apply, refreshed when the profile changes on disk. */
  let profileCache = null
  let restartPlan = null
  let profileLoadedAt = 0
  const PROFILE_TTL_MS = 5000

  async function getProfile(force = false) {
    const fresh = profileCache !== null && Date.now() - profileLoadedAt < PROFILE_TTL_MS
    if (fresh && !force) return profileCache
    const loaded = await loadProfile({ profileContext })
    profileCache = loaded
    profileLoadedAt = Date.now()
    return loaded
  }

  const dir = store.stateDir({ profileDir: profileContext?.dir })
  let cfg = store.loadConfig(dir)
  /** @type {any} */
  let cache = store.loadCache(dir)

  /** Last completed startup-diagnostics scan (null until the first scan finishes). */
  /** @type {any} */
  let diagnostics = null
  let diagnosticsAt = 0
  /** In-flight scan so concurrent /diagnose calls share one log read. */
  /** @type {Promise<any>|null} */
  let diagnosis = null

  /** Drop the cached scan; the next /diagnose (or the 60s TTL) rescans. */
  function invalidateDiagnostics() {
    diagnostics = null
    diagnosticsAt = 0
  }

  /**
   * Run the startup diagnostics, reusing the cached result unless `force` is set.
   * @param {boolean} force
   * @returns {Promise<any>}
   */
  async function runDiagnose(force = false) {
    if (!force && diagnostics !== null && Date.now() - diagnosticsAt < DIAGNOSTICS_TTL_MS) {
      return diagnostics
    }
    if (diagnosis !== null) return diagnosis
    diagnosis = (async () => {
      try {
        const profile = await getProfile()
        const result = await diagnoseStartup({
          profile,
          dshHome: profile.dshHome || dir,
          cache: cache.packages ?? {},
        })
        diagnostics = result
        diagnosticsAt = Date.now()
        state.updatedAt = now()
        log(`diagnostics: ${result.items.length} issue(s) across ${result.scanned.length} log file(s)`)
        return result
      } catch (error) {
        const failed = {
          checkedAt: now(),
          scanned: [],
          items: [],
          errors: [{ file: '', message: errorOf(error).message }],
        }
        diagnostics = failed
        diagnosticsAt = Date.now()
        log(`diagnostics failed: ${errorOf(error).message}`)
        return failed
      } finally {
        diagnosis = null
      }
    })()
    return diagnosis
  }

  /** @type {Map<string, any>} */
  const rows = new Map()
  /** @type {Map<string, any>} */
  const operations = new Map()
  /** @type {any[]} */
  const queue = []
  /** @type {string|null} */
  let activeOperationId = null
  let checking = false
  let checkSweep = null
  /** @type {Set<AbortController>} */
  const inFlight = new Set()

  const state = {
    checking: false,
    lastCheckAt: cache.lastCheckAt ?? null,
    updatedAt: now(),
  }

  function rememberOperation(op) {
    operations.set(op.id, op)
    // Bound the history: the UI only needs the recent tail.
    if (operations.size > 50) {
      const oldest = [...operations.values()].filter(candidate => candidate.state !== 'running' && candidate.state !== 'queued')
        .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))[0]
      if (oldest) operations.delete(oldest.id)
    }
  }

  function publicOperation(op) {
    return {
      id: op.id,
      kind: op.kind,
      state: op.state,
      name: op.name ?? null,
      names: op.names ?? null,
      startedAt: op.startedAt,
      endedAt: op.endedAt ?? null,
      message: op.message ?? '',
      result: op.result ?? null,
    }
  }

  function rowOperation(rowName) {
    for (const op of operations.values()) {
      if (op.state !== 'running') continue
      if (op.kind === 'update' && op.name === rowName) {
        return { id: op.id, kind: 'update', phase: op.phase ?? 'preparing', message: op.message ?? '', progress: op.progress ?? null, startedAt: op.startedAt }
      }
      if (op.kind === 'update-all' && op.name === rowName) {
        return { id: op.id, kind: 'update', phase: op.phase ?? 'preparing', message: op.message ?? '', progress: op.progress ?? null, startedAt: op.startedAt }
      }
    }
    for (const op of operations.values()) {
      if (op.state !== 'queued') continue
      if (op.kind === 'update' && op.name === rowName) {
        return { id: op.id, kind: 'update', phase: 'queued', message: '排队中', progress: null, startedAt: op.startedAt }
      }
      if (op.kind === 'update-all' && Array.isArray(op.names) && op.names.includes(rowName)) {
        return { id: op.id, kind: 'update', phase: 'queued', message: '排队中', progress: null, startedAt: op.startedAt }
      }
    }
    return null
  }

  const pendingRestart = new Map()

  /**
   * True only when an update succeeded and the new version needs a restart.
   * Failed updates record `lastUpdate` here too, which must not light up the
   * "restart required" affordance.
   */
  function awaitingRestart(name) {
    return typeof pendingRestart.get(name)?.toVersion === 'string'
  }

  /**
   * Effective source for one package: per-package override, else the default.
   * @param {string} pkg
   */
  function sourceFor(pkg) {
    const override = cfg.perPackageSource[pkg]
    return SOURCE_IDS.includes(override) ? override : cfg.defaultSource
  }

  /** Whether a cached result may be reused (throttle + identity + policy). */
  function cacheFresh(pkg, entry, effectiveSource) {
    if (!isObject(cache.packages[pkg])) return false
    const cached = cache.packages[pkg]
    if (cached.source !== effectiveSource) return false
    if (cached.installedVersion !== entry.installedVersion) return false
    if (cached.allowPrerelease !== cfg.allowPrerelease) return false
    if (typeof cached.checkedAt !== 'string') return false
    const age = Date.now() - Date.parse(cached.checkedAt)
    return Number.isFinite(age) && age >= 0 && age < cfg.checkIntervalHours * 3600_000
  }

  /** Build the row payload from the cached result for one package. */
  function rowFromCache(entry, effectiveSource) {
    const cached = cache.packages[entry.name]
    if (!isObject(cached)) {
      return {
        name: entry.name,
        source: effectiveSource,
        status: entry.kind === 'local' ? 'local' : entry.kind === 'builtin' ? 'builtin' : 'error',
        installedVersion: entry.installedVersion,
        latestVersion: null,
        compatibleMax: null,
        installedCompatible: false,
        bundleId: entry.bundleId ?? null,
        kind: entry.kind,
        reason: {
          code: entry.kind === 'local' ? 'local-dependency' : entry.kind === 'builtin' ? 'builtin-package' : 'no-candidates',
          message: entry.kind === 'local'
            ? '本地插件（link:/file:），不参与版本检查'
            : entry.kind === 'builtin'
              ? '宿主内置插件，只能随 DSH 更新'
              : '尚未检查',
          unmet: [],
        },
        target: null,
        altTarget: null,
        checkedAt: null,
        stale: true,
        error: entry.kind === 'registry' ? { code: 'not-checked', message: '尚未检查' } : null,
        operation: rowOperation(entry.name),
        pendingRestart: awaitingRestart(entry.name),
        lastUpdate: pendingRestart.get(entry.name)?.lastUpdate ?? null,
        ignored: cfg.ignore.includes(entry.name),
      }
    }
    return {
      name: entry.name,
      source: cached.source,
      status: cached.status,
      installedVersion: entry.installedVersion,
      latestVersion: cached.latestVersion ?? cached.latest ?? null,
      compatibleMax: cached.compatibleMax ?? null,
      installedCompatible: cached.installedCompatible === true,
      bundleId: entry.bundleId ?? null,
      kind: entry.kind,
      reason: cached.reason ?? { code: 'ok', message: '', unmet: [] },
      target: cached.target ?? null,
      altTarget: cached.altTarget ?? null,
      checkedAt: cached.checkedAt ?? null,
      stale: typeof cached.checkedAt !== 'string' || Date.now() - Date.parse(cached.checkedAt) > cfg.checkIntervalHours * 3600_000,
      error: cached.error ?? null,
      operation: rowOperation(entry.name),
      pendingRestart: awaitingRestart(entry.name),
      lastUpdate: pendingRestart.get(entry.name)?.lastUpdate ?? null,
      ignored: cfg.ignore.includes(entry.name),
    }
  }

  function restartCapability() {
    if (restartPlan === null) restartPlan = probeRestartPlan()
    if (restartPlan.kind === 'desktop') {
      return { supported: true, mode: 'desktop', message: '重启会先弹出桌面版确认框，确认后应用与页面会一起重开。' }
    }
    if (restartPlan.kind === 'cli') {
      return { supported: true, mode: 'cli', message: '当前是命令行宿主：重启会终止本进程并用同样的命令重新拉起。' }
    }
    return {
      supported: false,
      mode: 'none',
      message: '当前宿主没有重启接口：请完全退出 DSH 桌面版（含系统托盘图标）后重新打开，新版本才会生效。',
    }
  }

  async function buildState() {
    let profile
    try {
      profile = await getProfile()
    } catch (error) {
      profile = { name: 'unknown', dir: '', isLocal: false, runtimeVersion: 'unknown', runtimeSource: 'unknown', packages: [], bundles: [], packageManager: null, dshHome: '' }
      log(`profile load failed: ${errorOf(error).message}`)
    }
    const packages = Array.isArray(profile.packages) ? profile.packages : []
    const list = packages.map(entry => rowFromCache(entry, sourceFor(entry.name)))
    return {
      bootId,
      profile: {
        name: profile.name ?? 'unknown',
        dir: profile.dir ?? '',
        isLocal: profile.isLocal === true,
        runtimeVersion: profile.runtimeVersion ?? 'unknown',
        runtimeSource: profile.runtimeSource ?? 'unknown',
      },
      config: cfg,
      lastCheckAt: state.lastCheckAt,
      checking: state.checking,
      rows: list,
      operations: [...operations.values()].map(publicOperation).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))),
      activeOperationId,
      capabilities: (() => {
        const capability = restartCapability()
        return { restart: capability.supported, restartMode: capability.mode, restartHint: capability.message }
      })(),
      diagnostics,
      updatedAt: state.updatedAt,
      logs: logs.slice(-50),
    }
  }

  async function persistCache() {
    try {
      cache.lastCheckAt = state.lastCheckAt
      cache.runtimeVersion = profileCache?.runtimeVersion ?? cache.runtimeVersion ?? null
      store.saveCache(dir, cache)
    } catch (error) {
      log(`cache write failed: ${errorOf(error).message}`)
    }
  }

  /** Check one package and store its result. */
  async function checkOne(entry, profile, signal) {
    const effectiveSource = sourceFor(entry.name)
    const startedAt = Date.now()
    const result = await listVersions({
      name: entry.name,
      source: effectiveSource,
      config: cfg,
      manifest: entry.manifest,
      signal,
    })
    const picked = pickTargets({
      installedVersion: entry.installedVersion,
      installedManifest: entry.manifest,
      candidates: result.versions,
      latest: result.latest,
      runtimeVersion: profile.runtimeVersion,
      allowPrerelease: cfg.allowPrerelease,
      kind: entry.kind,
    })
    const installSpecs = {}
    const installKinds = {}
    for (const candidate of result.versions) {
      if (candidate && typeof candidate.version === 'string' && typeof candidate.installSpec === 'string') {
        installSpecs[candidate.version] = candidate.installSpec
        if (typeof candidate.installKind === 'string') installKinds[candidate.version] = candidate.installKind
      }
    }
    const warnings = Array.isArray(result.warnings) ? result.warnings : []
    const record = {
      source: effectiveSource,
      checkedAt: now(),
      fetchedAt: result.fetchedAt ?? now(),
      installedVersion: entry.installedVersion,
      allowPrerelease: cfg.allowPrerelease,
      runtimeVersion: profile.runtimeVersion,
      repo: result.repo ?? null,
      registryUrl: result.registryUrl ?? null,
      warnings,
      installSpecs,
      installKinds,
      ...picked,
      error: null,
      durationMs: Date.now() - startedAt,
    }
    cache.packages[entry.name] = record
    return record
  }

  /**
   * Run one check sweep with bounded concurrency and a hard deadline.
   * @param {{ force?: boolean, names?: string[], reason?: string }} options
   */
  async function runCheck(options = {}) {
    if (checking) return { started: false, reason: 'already-running' }
    const force = options.force === true
    const only = Array.isArray(options.names) ? options.names.filter(name => typeof name === 'string') : null
    checking = true
    state.checking = true
    state.updatedAt = now()
    const controller = new AbortController()
    inFlight.add(controller)
    checkSweep = { controller }
    const deadline = Date.now() + cfg.totalTimeoutMs
    const logStartedAt = Date.now()
    try {
      const profile = await getProfile(true)
      const entries = (profile.packages ?? []).filter(entry => entry.kind === 'registry')
      const targets = entries.filter(entry => {
        if (only !== null && !only.includes(entry.name)) return false
        return true
      })
      let cursor = 0
      let done = 0
      let skipped = 0
      let failed = 0
      const progressUpdate = () => { state.updatedAt = now() }
      const worker = async () => {
        while (true) {
          if (controller.signal.aborted) return
          if (Date.now() > deadline) return
          const index = cursor
          cursor += 1
          if (index >= targets.length) return
          const entry = targets[index]
          if (!force && cacheFresh(entry.name, entry, sourceFor(entry.name))) {
            skipped += 1
            continue
          }
          if (cfg.ignore.includes(entry.name)) {
            skipped += 1
            continue
          }
          const remaining = Math.max(500, deadline - Date.now())
          const perPackage = new AbortController()
          const onAbort = () => perPackage.abort()
          controller.signal.addEventListener('abort', onAbort, { once: true })
          const timer = setTimeout(() => perPackage.abort(), Math.min(remaining, cfg.requestTimeoutMs * 4))
          try {
            await checkOne(entry, profile, perPackage.signal)
            done += 1
          } catch (error) {
            failed += 1
            const previous = isObject(cache.packages[entry.name]) ? cache.packages[entry.name] : {}
            cache.packages[entry.name] = {
              ...previous,
              source: sourceFor(entry.name),
              installedVersion: entry.installedVersion,
              allowPrerelease: cfg.allowPrerelease,
              runtimeVersion: profile.runtimeVersion,
              error: { code: errorOf(error).code, message: sourceErrorMessage(error) },
              checkedAt: previous.checkedAt ?? null,
            }
            log(`check ${entry.name} failed: ${errorOf(error).message}`)
          } finally {
            clearTimeout(timer)
            controller.signal.removeEventListener('abort', onAbort)
            progressUpdate()
          }
        }
      }
      const workers = Array.from({ length: Math.max(1, Math.min(cfg.concurrency, targets.length)) }, () => worker())
      await Promise.all(workers)
      state.lastCheckAt = now()
      cache.lastCheckAt = state.lastCheckAt
      log(`check sweep done in ${Date.now() - logStartedAt}ms: ${done} checked, ${skipped} throttled, ${failed} failed`)
      await persistCache()
      return { started: true, checked: done, skipped, failed }
    } finally {
      checking = false
      state.checking = false
      state.updatedAt = now()
      inFlight.delete(controller)
      checkSweep = null
    }
  }

  /** Queue one update (serialized behind the active operation). */
  function enqueueUpdate(pkg, version) {
    const op = {
      id: randomUUID(),
      kind: 'update',
      state: 'queued',
      name: pkg,
      version,
      startedAt: now(),
      message: '排队中',
      log: [],
    }
    rememberOperation(op)
    queue.push(op)
    state.updatedAt = now()
    drainQueue().catch(error => log(`queue drain failed: ${errorOf(error).message}`))
    return op
  }

  /** Queue a sequential "update everything updatable" run. */
  function enqueueUpdateAll(names) {
    const op = {
      id: randomUUID(),
      kind: 'update-all',
      state: 'queued',
      names,
      startedAt: now(),
      message: '排队中',
      results: [],
      log: [],
    }
    rememberOperation(op)
    queue.push(op)
    state.updatedAt = now()
    drainQueue().catch(error => log(`queue drain failed: ${errorOf(error).message}`))
    return op
  }

  async function drainQueue() {
    if (activeOperationId !== null) return
    const op = queue.shift()
    if (op === undefined) return
    activeOperationId = op.id
    op.state = 'running'
    state.updatedAt = now()
    try {
      if (op.kind === 'update') await runOneUpdate(op)
      else if (op.kind === 'update-all') await runUpdateAll(op)
    } catch (error) {
      op.state = 'failed'
      op.message = errorOf(error).message
      op.endedAt = now()
      log(`operation ${op.id} failed: ${op.message}`)
    } finally {
      activeOperationId = null
      state.updatedAt = now()
      // An update rewrites the profile; the next diagnostics scan must see it.
      if (op.kind === 'update' || op.kind === 'update-all') invalidateDiagnostics()
      // Drain the next queued operation even if this one threw.
      if (queue.length > 0) drainQueue().catch(error => log(`queue drain failed: ${errorOf(error).message}`))
    }
  }

  /**
   * Resolve `{ installSpec, installKind }` for one target version from the cached sweep.
   * Falls back to a registry spec (`<name>@<version>`) when the cache has no entry, so a
   * missing/stale sweep can never turn into a `github:` (git-hosted) install.
   */
  function installTargetFor(pkg, version) {
    const cached = cache.packages[pkg]
    const spec = isObject(cached) && isObject(cached.installSpecs) && typeof cached.installSpecs[version] === 'string'
      ? cached.installSpecs[version]
      : null
    const kind = isObject(cached) && isObject(cached.installKinds) && typeof cached.installKinds[version] === 'string'
      ? cached.installKinds[version]
      : null
    const fallback = typeof version === 'string' ? `${pkg}@${version}` : null
    return { installSpec: spec ?? fallback, installKind: kind }
  }

  /**
   * Make sure the candidate list used to build the install spec belongs to the *current*
   * source and is not older than a minute. Prevents "switched source, then update" from
   * resolving a stale spec (e.g. a `github:` spec left over from a GitHub sweep).
   */
  async function refreshCandidateForUpdate(pkg) {
    const cached = cache.packages[pkg]
    const source = sourceFor(pkg)
    const checkedAt = isObject(cached) && typeof cached.checkedAt === 'string' ? Date.parse(cached.checkedAt) : NaN
    const fresh = isObject(cached) && cached.source === source && Number.isFinite(checkedAt) && Date.now() - checkedAt < 60_000
    if (fresh) return
    try {
      await runCheck({ force: true, names: [pkg] })
    } catch (error) {
      log(`refresh ${pkg} before update failed: ${errorOf(error).message}`)
    }
  }

  async function runOneUpdate(op) {
    const profile = await getProfile(true)
    const entry = (profile.packages ?? []).find(candidate => candidate.name === op.name)
    if (entry === undefined) throw new ApiError('not-found', `插件 ${op.name} 不在当前 profile 中`)
    if (entry.kind !== 'registry') throw new ApiError('bad-request', `${op.name} 是本地/内置插件，不能通过 npm 更新`)
    const controller = new AbortController()
    inFlight.add(controller)
    op.phase = 'preparing'
    op.message = '准备更新'
    op.controller = controller
    const startedAt = Date.now()
    try {
      await refreshCandidateForUpdate(op.name)
      const installTarget = installTargetFor(op.name, op.version)
      const result = await runUpdate({
        profile,
        entry,
        target: {
          version: op.version,
          installSpec: installTarget.installSpec,
          installKind: installTarget.installKind ?? op.installKind ?? null,
        },
        runtimeVersion: profile.runtimeVersion,
        stateDir: dir,
        signal: controller.signal,
        timeoutMs: 10 * 60 * 1000,
        onProgress: step => {
          op.phase = step.phase
          op.message = step.message
          op.progress = step.progress ?? null
          state.updatedAt = now()
        },
      })
      op.result = result
      op.endedAt = now()
      if (result.ok) {
        op.state = 'succeeded'
        op.message = `已更新 ${result.fromVersion ?? '?'} → ${result.toVersion ?? op.version}，重启 DSH 后生效`
        const finishedAt = now()
        pendingRestart.set(op.name, {
          toVersion: result.toVersion,
          at: finishedAt,
          lastUpdate: {
            ok: true,
            fromVersion: result.fromVersion,
            toVersion: result.toVersion,
            at: finishedAt,
            message: op.message,
          },
        })
        cache.packages[op.name] = { ...(cache.packages[op.name] ?? {}), installedVersion: result.toVersion, checkedAt: null, status: 'latest' }
        store.appendUpdateLog(dir, {
          ok: true,
          name: op.name,
          fromVersion: result.fromVersion,
          toVersion: result.toVersion,
          source: sourceFor(op.name),
          durationMs: Date.now() - startedAt,
          packageManager: result.packageManager,
        })
        // Re-check this one package so the row goes back to a computed state.
        runCheck({ force: true, names: [op.name] }).catch(() => {})
      } else {
        op.state = result.rolledBack ? 'rolled-back' : 'failed'
        op.message = result.error?.message ?? '更新失败'
        store.appendUpdateLog(dir, {
          ok: false,
          name: op.name,
          fromVersion: result.fromVersion,
          toVersion: op.version,
          code: result.error?.code ?? 'unknown',
          message: result.error?.message ?? '',
          detail: result.error?.detail ?? '',
          durationMs: Date.now() - startedAt,
        })
        pendingRestart.set(op.name, {
          ...(pendingRestart.get(op.name) ?? {}),
          lastUpdate: {
            ok: false,
            fromVersion: result.fromVersion,
            toVersion: op.version,
            at: now(),
            message: result.error?.message ?? '更新失败',
            code: result.error?.code ?? 'unknown',
            detail: typeof result.error?.detail === 'string' ? result.error.detail : null,
          },
        })
      }
      cache.packages[op.name] = {
        ...(cache.packages[op.name] ?? {}),
        error: result.ok
          ? null
          : {
            code: result.error?.code ?? 'unknown',
            message: result.error?.message ?? '更新失败',
            detail: typeof result.error?.detail === 'string' ? result.error.detail : null,
          },
      }
      await persistCache()
    } catch (error) {
      op.state = 'failed'
      op.message = errorOf(error).message
      op.endedAt = now()
      log(`update ${op.name} failed: ${op.message}`)
    } finally {
      inFlight.delete(controller)
      delete op.controller
    }
  }

  async function runUpdateAll(op) {
    op.state = 'running'
    op.results = []
    for (const name of op.names) {
      await refreshCandidateForUpdate(name)
      const cached = cache.packages[name]
      const version = cached?.target?.version
      if (typeof version !== 'string') {
        op.results.push({ name, ok: false, message: '目标版本缺失，已跳过' })
        continue
      }
      op.name = name
      op.phase = 'preparing'
      op.message = `正在更新 ${name}`
      state.updatedAt = now()
      const profile = await getProfile(true)
      const entry = (profile.packages ?? []).find(candidate => candidate.name === name)
      if (entry === undefined) {
        op.results.push({ name, ok: false, message: '插件已不在 profile 中' })
        continue
      }
      const controller = new AbortController()
      inFlight.add(controller)
      try {
        const installTarget = installTargetFor(name, version)
        const result = await runUpdate({
          profile,
          entry,
          target: { version, installSpec: installTarget.installSpec, installKind: installTarget.installKind },
          runtimeVersion: profile.runtimeVersion,
          stateDir: dir,
          signal: controller.signal,
          timeoutMs: 10 * 60 * 1000,
          onProgress: step => {
            op.phase = step.phase
            op.message = `${name}: ${step.message}`
            op.progress = step.progress ?? null
            state.updatedAt = now()
          },
        })
        op.results.push({
          name,
          ok: result.ok,
          fromVersion: result.fromVersion,
          toVersion: result.toVersion,
          message: result.ok ? '成功' : result.error?.message ?? '失败',
        })
        if (result.ok) {
          const finishedAt = now()
          pendingRestart.set(name, {
            toVersion: result.toVersion,
            at: finishedAt,
            lastUpdate: {
              ok: true,
              fromVersion: result.fromVersion,
              toVersion: result.toVersion,
              at: finishedAt,
              message: `已更新 ${result.fromVersion ?? '?'} → ${result.toVersion ?? version}`,
            },
          })
          cache.packages[name] = { ...(cache.packages[name] ?? {}), installedVersion: result.toVersion, checkedAt: null, error: null }
        } else {
          pendingRestart.set(name, {
            ...(pendingRestart.get(name) ?? {}),
            lastUpdate: {
              ok: false,
              fromVersion: result.fromVersion,
              toVersion: version,
              at: now(),
              message: result.error?.message ?? '更新失败',
              code: result.error?.code ?? 'unknown',
              detail: typeof result.error?.detail === 'string' ? result.error.detail : null,
            },
          })
          cache.packages[name] = {
            ...(cache.packages[name] ?? {}),
            error: {
              code: result.error?.code ?? 'unknown',
              message: result.error?.message ?? '更新失败',
              detail: typeof result.error?.detail === 'string' ? result.error.detail : null,
            },
          }
        }
      } catch (error) {
        op.results.push({ name, ok: false, message: errorOf(error).message })
      } finally {
        inFlight.delete(controller)
        await persistCache()
      }
    }
    await persistCache()
    const failed = op.results.filter(item => !item.ok)
    op.state = failed.length === 0 ? 'succeeded' : 'failed'
    op.message = failed.length === 0
      ? `已更新 ${op.results.length} 个插件，重启 DSH 后生效`
      : `${op.results.length - failed.length} 个成功，${failed.length} 个失败`
    op.result = {
      ok: failed.length === 0,
      total: op.results.length,
      succeeded: op.results.length - failed.length,
      failed: failed.length,
      items: op.results.map(item => ({ ...item })),
    }
    op.endedAt = now()
    op.name = null
    runCheck({ force: true }).catch(() => {})
  }

  /** Handle one API request. */
  async function handle(req, res) {
    if (!originAllowed(req)) return writeError(res, new ApiError('forbidden', 'cross-origin request rejected', 403))
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (!url.pathname.startsWith(API_PREFIX)) return writeError(res, new ApiError('not-found', 'unknown route', 404))
    const route = url.pathname.slice(API_PREFIX.length).replace(/\/+$/, '') || '/'
    const method = (req.method ?? 'GET').toUpperCase()

    if (method === 'OPTIONS') {
      res.writeHead(204, { allow: 'GET, POST, OPTIONS' })
      res.end()
      return
    }

    try {
      if (route === '/state' && method === 'GET') {
        return writeOk(res, await buildState())
      }
      if (route === '/log' && method === 'GET') {
        const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') ?? 100) || 100))
        return writeOk(res, { entries: store.readUpdateLog(dir, limit) })
      }
      if (method !== 'POST') throw new ApiError('method-error', `${method} is not supported on ${route}`, 405)
      const body = await readJsonBody(req)

      if (route === '/check') {
        const names = Array.isArray(body.names) ? body.names.filter(name => typeof name === 'string') : undefined
        const force = body.force === true
        if (checking) return writeOk(res, { started: false, reason: 'already-running' })
        // Fire and forget: the UI polls /state for progress.
        runCheck({ force, names }).catch(error => log(`check failed: ${errorOf(error).message}`))
        return writeOk(res, { started: true, ids: [] })
      }

      if (route === '/diagnose') {
        const result = await runDiagnose(body.force === true)
        return writeOk(res, result)
      }

      if (route === '/update') {
        const target = typeof body.name === 'string' ? body.name : ''
        const version = typeof body.version === 'string' ? body.version : ''
        if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(target)) {
          throw new ApiError('bad-request', 'invalid package name')
        }
        if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
          throw new ApiError('bad-request', 'invalid version')
        }
        const profile = await getProfile()
        const entry = (profile.packages ?? []).find(candidate => candidate.name === target)
        if (entry === undefined) throw new ApiError('not-found', `插件 ${target} 不在当前 profile 中`)
        if (entry.kind !== 'registry') throw new ApiError('bad-request', `${target} 是本地/内置插件，不能通过 npm 更新`)
        const cached = cache.packages[target]
        const known = isObject(cached) && isObject(cached.target) && cached.target.version === version
        const knownAlt = isObject(cached) && isObject(cached.altTarget) && cached.altTarget.version === version
        const specExists = isObject(cached) && isObject(cached.installSpecs) && typeof cached.installSpecs[version] === 'string'
        if (!known && !knownAlt && !specExists) {
          throw new ApiError('bad-request', `版本 ${version} 不在最近一次检查的候选中，请先重新检查`)
        }
        const op = enqueueUpdate(target, version)
        return writeOk(res, { operationId: op.id })
      }

      if (route === '/update-all') {
        const profile = await getProfile()
        const explicit = Array.isArray(body.names) ? body.names.filter(item => typeof item === 'string') : null
        const names = (profile.packages ?? [])
          .map(entry => entry.name)
          .filter(name => {
            if (explicit !== null) return explicit.includes(name)
            const cached = cache.packages[name]
            return isObject(cached) && UPDATABLE.has(cached.status) && typeof cached.target?.version === 'string'
          })
        if (names.length === 0) return writeOk(res, { operationId: null, queued: [] })
        const op = enqueueUpdateAll(names)
        return writeOk(res, { operationId: op.id, queued: names })
      }

      if (route === '/cancel') {
        const id = typeof body.operationId === 'string' ? body.operationId : activeOperationId
        const op = id === null ? undefined : operations.get(id)
        if (op === undefined) return writeOk(res, { cancelled: false })
        op.cancelRequested = true
        if (op.controller instanceof AbortController) op.controller.abort()
        if (op.state === 'queued') {
          const index = queue.indexOf(op)
          if (index >= 0) queue.splice(index, 1)
          op.state = 'cancelled'
          op.endedAt = now()
          op.message = '已取消（未开始）'
          return writeOk(res, { cancelled: true })
        }
        return writeOk(res, { cancelled: true })
      }

      if (route === '/config') {
        const patch = isObject(body.patch) ? body.patch : body
        const previous = cfg
        cfg = store.saveConfig(dir, { ...cfg, ...patch })
        const sourceChanged = previous.defaultSource !== cfg.defaultSource
          || previous.allowPrerelease !== cfg.allowPrerelease
          || previous.customRegistry !== cfg.customRegistry
          || JSON.stringify(previous.githubMirrorPrefixes) !== JSON.stringify(cfg.githubMirrorPrefixes)
          || JSON.stringify(previous.perPackageSource) !== JSON.stringify(cfg.perPackageSource)
        if (sourceChanged) {
          // A source change invalidates cached candidates immediately.
          for (const key of Object.keys(cache.packages)) delete cache.packages[key]
          await persistCache()
          runCheck({ force: true }).catch(error => log(`check after config change failed: ${errorOf(error).message}`))
        }
        return writeOk(res, await buildState())
      }

      if (route === '/restart') {
        const restartService = typeof ctx.get === 'function' ? ctx.get('restart') : undefined
        if (restartService !== undefined && typeof restartService?.restart === 'function') {
          // A host that publishes its own restart service wins over our probe.
          restartService.restart()
          return writeOk(res, { supported: true, scheduled: true, mode: 'service', message: '正在重启 DSH' })
        }
        if (restartPlan === null) restartPlan = probeRestartPlan()
        if (restartPlan.kind === 'desktop') {
          // Answer first: the desktop main process restarts (and reloads) the UI
          // once the user confirms, so this response must already be on the wire.
          writeOk(res, {
            supported: true,
            scheduled: true,
            mode: 'desktop',
            message: '已请求桌面版重启：确认弹窗后应用会重新打开，页面随后自动恢复。',
          })
          setImmediate(() => {
            const outcome = requestRestart(restartPlan)
            log(`desktop restart request: ${outcome.message}`)
          })
          return
        }
        if (restartPlan.kind === 'cli') {
          writeOk(res, {
            supported: true,
            scheduled: true,
            mode: 'cli',
            message: '正在重启 DSH：本进程退出后会用同样的命令重新拉起，页面几秒后自动重连。',
          })
          setImmediate(() => {
            const outcome = requestRestart(restartPlan)
            log(`cli restart: ${outcome.message}`)
          })
          return
        }
        return writeOk(res, { supported: false, ...restartCapability() })
      }

      throw new ApiError('not-found', `unknown route ${route}`, 404)
    } catch (error) {
      writeError(res, error)
    }
  }

  ctx.effect(() => {
    // `register` throws on a duplicate (kind, path), which is exactly the
    // signal we want if this bundle was mounted twice.
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: (req, res) => {
        handle(req, res).catch(error => {
          try { writeError(res, error) } catch { /* response already sent */ }
        })
      },
    })
    log(`mounted ${API_PREFIX} on ${ctx.webServer.host ?? '127.0.0.1'}:${ctx.webServer.port ?? '?'}`)
    return dispose
  }, 'plugin-updater: routes')

  ctx.effect(() => {
    const timer = setTimeout(() => {
      // 'force' (default) refreshes every boot so the post-restart prompt is
      // accurate; 'throttle' reuses fresh cache entries instead.
      runCheck({ force: cfg.checkOnStartup === 'force', reason: 'startup' })
        .catch(error => log(`startup check failed: ${errorOf(error).message}`))
    }, STARTUP_CHECK_DELAY_MS)
    timer.unref?.()
    // Scan the boot logs a few seconds later, once the kernel has written them.
    const diagnoseTimer = setTimeout(() => {
      runDiagnose(false).catch(error => log(`startup diagnostics failed: ${errorOf(error).message}`))
    }, STARTUP_DIAGNOSE_DELAY_MS)
    diagnoseTimer.unref?.()
    return () => {
      clearTimeout(timer)
      clearTimeout(diagnoseTimer)
      if (checkSweep?.controller) checkSweep.controller.abort()
      for (const controller of inFlight) controller.abort()
      inFlight.clear()
    }
  }, 'plugin-updater: startup check')

  // Expose a small diagnostics surface for tests and for the host log.
  return { getState: buildState, runCheck }
}
