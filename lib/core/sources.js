/**
 * Version sources for the plugin updater.
 *
 * Two families are supported:
 *   - npm registries (`npm-official`, `npm-mirror`): one request to the
 *     registry's *abbreviated* metadata document (`install-v1+json`), which
 *     already carries `engines` / `peerDependencies` / `dist` per version;
 *   - GitHub (`github`, `github-mirror`): releases (falling back to tags),
 *     then each candidate's `package.json` from raw.githubusercontent.com so
 *     the compatibility gate can be evaluated before recommending anything.
 *
 * GitHub metadata requests are what the `github-mirror` source proxies. The
 * install spec itself is always the portable `github:<owner>/<repo>#<ref>`
 * form: mirror-prefixed URLs must never reach pnpm (pnpm 11 treats them as
 * plain tarballs and demands an integrity hash it does not have). Release
 * `.tgz` assets are still recorded in `dist` / `warnings` for display.
 *
 * @module core/sources
 */

import * as semver from './semver.js'
import { DEFAULT_GITHUB_MIRRORS, SOURCE_IDS as STORE_SOURCE_IDS } from './store.js'
import { SourceError, fetchJson } from './http.js'

export { SourceError }
export const SOURCE_IDS = STORE_SOURCE_IDS

const NPM_REGISTRIES = {
  'npm-official': 'https://registry.npmjs.org',
  'npm-mirror': 'https://registry.npmmirror.com',
}

const GITHUB_API = 'https://api.github.com'
const GITHUB_RAW = 'https://raw.githubusercontent.com'
const GITHUB_WEB = 'https://github.com'
const GITHUB_HEADERS = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'dsh-plugin-update-manager',
}
const DEFAULT_TIMEOUT_MS = 8000
const MAX_MANIFEST_FETCHES = 40
const MANIFEST_CONCURRENCY = 8
const SOURCE_TARBALL_WARNING = 'source-tarball: 该版本没有可安装的 release 资产，只能从 GitHub 源码安装；pnpm 12 会拒绝执行其构建脚本（ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED），安装大概率失败，建议改用 npm 源（如 npm 国内镜像）更新'

/**
 * Last mirror prefix known to work, keyed by the ordered prefix list. Mirrors
 * can be down for a whole check sweep; remembering the healthy one keeps the
 * second (and later) requests of the sweep off the dead prefix.
 * @type {{key: string, prefix: string}}
 */
const mirrorMemory = { key: '', prefix: '' }

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {unknown} value
 * @param {number} [fallback]
 * @returns {number}
 */
function normalizeTimeout(value, fallback = DEFAULT_TIMEOUT_MS) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}

/**
 * Small helper around a warnings array with de-duplication.
 * @returns {{list: string[], add: (message: string) => void}}
 */
function createWarnings() {
  /** @type {string[]} */
  const list = []
  const seen = new Set()
  return {
    list,
    add(message) {
      if (typeof message !== 'string' || message === '' || seen.has(message)) return
      seen.add(message)
      list.push(message)
    },
  }
}

/**
 * Detect a configured proxy broadly (scheme-agnostic) for user-facing
 * warnings. Actual routing decisions live in http.js.
 *
 * @param {Record<string, unknown>} config
 * @param {{list: string[], add: (message: string) => void}} warnings
 */
function addProxyWarning(config, warnings) {
  const configured = typeof config.proxyUrl === 'string' && config.proxyUrl.trim() !== ''
  const readEnv = (key) => {
    const value = process.env[key]
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : ''
  }
  const envValue = readEnv('HTTPS_PROXY') || readEnv('https_proxy') || readEnv('HTTP_PROXY') || readEnv('http_proxy')
  if (!configured && envValue === '') return
  const label = configured ? String(config.proxyUrl).trim() : envValue
  warnings.add(`proxy: 检测到代理配置（${label}），元数据请求将经由代理转发`)
}

/**
 * @param {string} name
 * @returns {string} Registry path segment (`@scope%2Fname` for scoped names).
 */
function encodePackageName(name) {
  return name.startsWith('@') ? name.replace('/', '%2F') : name
}

/**
 * @param {unknown} config
 * @returns {string} Normalized custom registry without a trailing slash.
 */
function customRegistry(config) {
  const value = isRecord(config) ? config.customRegistry : ''
  if (typeof value !== 'string') return ''
  const trimmed = value.trim().replace(/\/+$/, '')
  return /^https?:\/\/[^\s]+$/i.test(trimmed) ? trimmed : ''
}

/**
 * @param {number} status
 * @param {string} name
 * @returns {SourceError}
 */
function npmStatusError(status, name) {
  if (status === 404) return new SourceError('not-found', `npm registry 中不存在 ${name}（HTTP 404）`, { status })
  if (status === 401) return new SourceError('private', `无法访问 ${name}（HTTP 401，可能需要认证）`, { status })
  if (status === 403 || status === 429) {
    return new SourceError('rate-limit', `npm registry 限流（HTTP ${status}），请稍后再试`, { status })
  }
  if (status >= 500) return new SourceError('bad-response', `npm registry 服务端错误（HTTP ${status}）`, { status })
  return new SourceError('bad-response', `npm registry 响应异常（HTTP ${status}）`, { status })
}

/**
 * Build a manifest-shaped object from an abbreviated npm version document.
 *
 * @param {string} fallbackName
 * @param {string} version
 * @param {Record<string, unknown>} data
 * @returns {Record<string, unknown>}
 */
function npmManifest(fallbackName, version, data) {
  /** @type {Record<string, unknown>} */
  const manifest = {
    name: typeof data.name === 'string' && data.name !== '' ? data.name : fallbackName,
    version,
  }
  if (isRecord(data.engines)) manifest.engines = data.engines
  if (isRecord(data.peerDependencies)) manifest.peerDependencies = data.peerDependencies
  if (isRecord(data.dependencies)) manifest.dependencies = data.dependencies
  if (isRecord(data.optionalDependencies)) manifest.optionalDependencies = data.optionalDependencies
  if (isRecord(data.peerDependenciesMeta)) manifest.peerDependenciesMeta = data.peerDependenciesMeta
  if (data.repository !== undefined) manifest.repository = data.repository
  return manifest
}

/**
 * @param {unknown} distTagLatest
 * @param {Array<{version: string}>} versions
 * @returns {string|null}
 */
function chooseNpmLatest(distTagLatest, versions) {
  const tagged = typeof distTagLatest === 'string' ? semver.valid(distTagLatest) : null
  if (tagged !== null) return tagged
  let stable = null
  let any = null
  for (const item of versions) {
    if (!semver.isPrerelease(item.version) && (stable === null || semver.gt(item.version, stable))) {
      stable = item.version
    }
    if (any === null || semver.gt(item.version, any)) any = item.version
  }
  return stable ?? any
}

/**
 * @param {{
 *   name: string,
 *   source: string,
 *   config?: Record<string, unknown>,
 *   signal?: AbortSignal|null,
 *   timeoutMs?: number
 * }} options
 * @returns {Promise<{
 *   source: string,
 *   registryUrl: string,
 *   latest: string|null,
 *   versions: Array<{
 *     version: string,
 *     manifest: Record<string, unknown>,
 *     dist: {tarball: string}|null,
 *     installSpec: string,
 *     installKind: 'registry'
 *   }>,
 *   warnings: string[],
 *   fetchedAt: string
 * }>}
 */
async function listNpmVersions(options) {
  const config = isRecord(options.config) ? options.config : {}
  const registry = customRegistry(config) || NPM_REGISTRIES[options.source] || NPM_REGISTRIES['npm-official']
  const url = `${registry}/${encodePackageName(options.name)}`
  const warnings = createWarnings()
  addProxyWarning(config, warnings)

  const response = await fetchJson(url, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
    timeoutMs: normalizeTimeout(options.timeoutMs ?? config.requestTimeoutMs),
    signal: options.signal ?? null,
    config,
  })
  if (!response.ok) throw npmStatusError(response.status, options.name)
  const data = response.json
  if (!isRecord(data)) {
    throw new SourceError('bad-response', `npm registry 返回了非对象数据：${options.name}`, { status: response.status })
  }

  const versionMap = isRecord(data.versions) ? data.versions : {}
  /** @type {Array<any>} */
  const versions = []
  for (const [rawVersion, rawData] of Object.entries(versionMap)) {
    const version = semver.valid(rawVersion)
    if (version === null) continue
    const entryData = isRecord(rawData) ? rawData : {}
    const tarball = isRecord(entryData.dist) && typeof entryData.dist.tarball === 'string'
      ? entryData.dist.tarball
      : null
    versions.push({
      version,
      manifest: npmManifest(options.name, version, entryData),
      dist: tarball === null ? null : { tarball },
      installSpec: `${options.name}@${version}`,
      installKind: 'registry',
    })
  }

  const distTags = isRecord(data['dist-tags']) ? data['dist-tags'] : {}
  return {
    source: options.source,
    registryUrl: registry,
    latest: chooseNpmLatest(distTags.latest, versions),
    versions,
    warnings: warnings.list,
    fetchedAt: new Date().toISOString(),
  }
}

/**
 * @param {unknown} value
 * @returns {{owner: string, repo: string}|null}
 */
function parseGitHubRepo(value) {
  if (typeof value !== 'string') return null
  let text = value.trim()
  if (text === '') return null
  text = text.replace(/^git\+/i, '')
  if (/^github:/i.test(text)) text = text.replace(/^github:/i, '')

  let owner = ''
  let repo = ''
  const ssh = /^git@github\.com:([^/]+)\/(.+)$/i.exec(text)
  if (ssh !== null) {
    owner = ssh[1]
    repo = ssh[2]
  } else {
    const url = /^(?:https?|git|ssh):\/\/(?:[^@/]+@)?(?:www\.)?github\.com\/([^/]+)\/([^/?#]+)/i.exec(text)
    if (url !== null) {
      owner = url[1]
      repo = url[2]
    } else {
      const bare = /^([^/]+)\/([^/]+)$/.exec(text)
      if (bare !== null) {
        owner = bare[1]
        repo = bare[2]
      }
    }
  }
  if (owner === '' || repo === '') return null
  repo = repo.replace(/\.git$/i, '')
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) return null
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo)) return null
  return { owner, repo }
}

/**
 * Resolve the GitHub repository from the installed manifest, then from the
 * configured `customRepository` override.
 *
 * @param {unknown} manifest
 * @param {unknown} config
 * @returns {{owner: string, repo: string}|null}
 */
function resolveGitHubRepo(manifest, config) {
  if (isRecord(manifest)) {
    const repository = manifest.repository
    const fromString = typeof repository === 'string' ? parseGitHubRepo(repository) : null
    if (fromString !== null) return fromString
    const fromObject = isRecord(repository) ? parseGitHubRepo(repository.url) : null
    if (fromObject !== null) return fromObject
  }
  if (isRecord(config)) {
    const custom = config.customRepository ?? config.repository
    const parsed = typeof custom === 'string'
      ? parseGitHubRepo(custom)
      : isRecord(custom) ? parseGitHubRepo(custom.url) : null
    if (parsed !== null) return parsed
  }
  return null
}

/**
 * @param {unknown} tag
 * @returns {string|null} Normalized semver, or null for non-version tags.
 */
function versionFromTag(tag) {
  if (typeof tag !== 'string') return null
  const text = tag.trim()
  if (text === '') return null
  return semver.valid(/^[vV]/.test(text) ? text.slice(1) : text)
}

/**
 * @param {number} status
 * @param {Record<string, string>} headers
 * @param {string} url
 * @param {boolean} [proxied] True when the request went through a mirror prefix.
 * @returns {SourceError}
 */
function githubStatusError(status, headers, url, proxied = false) {
  if (status === 404) return new SourceError('not-found', `GitHub 资源不存在（HTTP 404）：${url}`, { status })
  if (status === 401) return new SourceError('private', `GitHub 仓库需要认证（HTTP 401）：${url}`, { status })
  if (status === 403 || status === 429) {
    // Mirrors (gh-proxy / ghfast / ghproxy) answer with bare 403/429 when they
    // are throttled or refuse the upstream request; treat that as a
    // rate-limit so the sweep can rotate to the next prefix.
    if (proxied === true) {
      return new SourceError('rate-limit', `GitHub 镜像拒绝访问（HTTP ${status}）：${url}`, { status })
    }
    const remaining = headers['x-ratelimit-remaining']
    if (status === 429 || remaining === '0') {
      return new SourceError('rate-limit', `GitHub API 限流（HTTP ${status}），请稍后再试`, { status })
    }
    return new SourceError('private', `GitHub 拒绝访问（HTTP ${status}），仓库可能不可见`, { status })
  }
  if (status >= 500) return new SourceError('bad-response', `GitHub 服务端错误（HTTP ${status}）`, { status })
  return new SourceError('bad-response', `GitHub 响应异常（HTTP ${status}）`, { status })
}

/**
 * @param {SourceError} error
 * @returns {boolean}
 */
function isMirrorRotatable(error) {
  if (error.code === 'network' || error.code === 'timeout' || error.code === 'rate-limit') return true
  return error.code === 'bad-response' && typeof error.status === 'number' && error.status >= 500
}

/**
 * @param {unknown} config
 * @returns {string[]}
 */
function mirrorPrefixList(config) {
  const raw = isRecord(config) && Array.isArray(config.githubMirrorPrefixes)
    ? config.githubMirrorPrefixes
    : DEFAULT_GITHUB_MIRRORS
  /** @type {string[]} */
  const list = []
  for (const candidate of raw) {
    if (typeof candidate !== 'string') continue
    const trimmed = candidate.trim().replace(/\/+$/, '')
    if (trimmed === '' || !/^https?:\/\/[^\s]+$/i.test(trimmed)) continue
    if (!list.includes(trimmed)) list.push(trimmed)
  }
  return list
}

/**
 * Request one GitHub URL, rotating through mirror prefixes when the source is
 * `github-mirror`. The working prefix is remembered for the rest of the sweep.
 *
 * @param {string} url Original (unproxied) absolute URL.
 * @param {{warnings: {list: string[], add: (message: string) => void}, timeoutMs: number, signal: AbortSignal|null, config: Record<string, unknown>, mirrors: {prefixes: string[], key: string}}} context
 * @returns {Promise<unknown>}
 */
async function githubFetchJson(url, context) {
  const prefixes = context.mirrors.prefixes
  const attempts = prefixes.length === 0 ? [null] : prefixes
  /** @type {SourceError|null} */
  let lastError = null

  for (let index = 0; index < attempts.length; index += 1) {
    const prefix = attempts[index]
    const target = prefix === null ? url : `${prefix}/${url}`
    try {
      const response = await fetchJson(target, {
        headers: GITHUB_HEADERS,
        timeoutMs: context.timeoutMs,
        signal: context.signal,
        config: context.config,
      })
      if (!response.ok) throw githubStatusError(response.status, response.headers, url, prefix !== null)
      if (prefix !== null) {
        mirrorMemory.key = context.mirrors.key
        mirrorMemory.prefix = prefix
        context.warnings.add(`github-mirror: 使用镜像前缀 ${prefix}`)
      }
      return response.json
    } catch (error) {
      const sourceError = error instanceof SourceError
        ? error
        : new SourceError('network', error instanceof Error ? error.message : String(error))
      lastError = sourceError
      const canRotate = prefix !== null && isMirrorRotatable(sourceError) && index < attempts.length - 1
      if (!canRotate) throw sourceError
      context.warnings.add(`github-mirror: ${prefix} 不可用（${sourceError.code}），尝试下一个镜像`)
    }
  }
  throw lastError ?? new SourceError('network', '没有可用的 GitHub 镜像')
}

/**
 * Pick the release asset to install. Prefers assets whose file name mentions
 * both the package (unscoped) and the version, then just the version, then the
 * package name, then the first archive-looking asset.
 *
 * @param {unknown} assets
 * @param {{name?: string, version?: string}} [hints]
 * @returns {{name: string, url: string}|null}
 */
function findReleaseAsset(assets, hints = {}) {
  if (!Array.isArray(assets)) return null
  const wantedVersion = typeof hints.version === 'string' ? hints.version.toLowerCase() : ''
  const rawName = typeof hints.name === 'string' ? hints.name : ''
  const wantedName = rawName.split('/').pop().toLowerCase().replace(/[^a-z0-9]/g, '')

  /** @type {Array<{name: string, url: string, score: number}>} */
  const candidates = []
  for (const asset of assets) {
    if (!isRecord(asset)) continue
    const name = typeof asset.name === 'string' ? asset.name : ''
    const url = typeof asset.browser_download_url === 'string' ? asset.browser_download_url : ''
    if (url === '' || !/\.(?:tgz|tar\.gz)$/i.test(name)) continue
    const lowered = name.toLowerCase()
    const normalized = lowered.replace(/[^a-z0-9]/g, '')
    let score = 0
    if (wantedVersion !== '' && lowered.includes(wantedVersion)) score += 2
    if (wantedName !== '' && normalized.includes(wantedName)) score += 4
    candidates.push({ name, url, score })
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => b.score - a.score)
  return { name: candidates[0].name, url: candidates[0].url }
}

/**
 * Run `worker` over `items` with bounded concurrency, preserving order.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
async function mapLimit(items, limit, worker) {
  /** @type {R[]} */
  const results = new Array(items.length)
  let next = 0
  const size = Math.max(1, Math.min(limit, items.length))
  const runners = []
  for (let runner = 0; runner < size; runner += 1) {
    runners.push((async () => {
      for (;;) {
        const index = next
        next += 1
        if (index >= items.length) return
        results[index] = await worker(items[index], index)
      }
    })())
  }
  await Promise.all(runners)
  return results
}

/**
 * @param {{
 *   name: string,
 *   source: string,
 *   config?: Record<string, unknown>,
 *   manifest?: Record<string, unknown>|null,
 *   signal?: AbortSignal|null,
 *   timeoutMs?: number
 * }} options
 * @returns {Promise<{
 *   source: string,
 *   repo: {owner: string, repo: string},
 *   latest: string|null,
 *   versions: Array<{
 *     version: string,
 *     manifest: Record<string, unknown>|null,
 *     dist: {tarball: string}|null,
 *     installSpec: string,
 *     installKind: 'tarball'|'source-tarball'
 *   }>,
 *   warnings: string[],
 *   fetchedAt: string
 * }>}
 */
async function listGithubVersions(options) {
  const config = isRecord(options.config) ? options.config : {}
  const repo = resolveGitHubRepo(options.manifest, config)
  if (repo === null) {
    throw new SourceError(
      'invalid-repo',
      `无法从 ${options.name} 的 package.json 解析 GitHub 仓库（缺少 repository 字段）`,
      { detail: 'repository' },
    )
  }

  const warnings = createWarnings()
  addProxyWarning(config, warnings)

  const prefixList = options.source === 'github-mirror' ? mirrorPrefixList(config) : []
  const mirrorKey = prefixList.join('\n')
  let prefixes = prefixList
  if (mirrorKey !== '' && mirrorMemory.key === mirrorKey && prefixList.includes(mirrorMemory.prefix)) {
    prefixes = [mirrorMemory.prefix, ...prefixList.filter((prefix) => prefix !== mirrorMemory.prefix)]
  }

  const context = {
    warnings,
    timeoutMs: normalizeTimeout(options.timeoutMs ?? config.requestTimeoutMs),
    signal: options.signal ?? null,
    config,
    mirrors: { prefixes, key: mirrorKey },
  }

  const releasesUrl = `${GITHUB_API}/repos/${repo.owner}/${repo.repo}/releases?per_page=100`
  const releases = await githubFetchJson(releasesUrl, context)

  /** @type {Array<Record<string, unknown>>} */
  let items = []
  let fromTags = false
  if (Array.isArray(releases) && releases.length > 0) {
    items = releases.filter(isRecord)
  } else {
    fromTags = true
    const tagsUrl = `${GITHUB_API}/repos/${repo.owner}/${repo.repo}/tags?per_page=100`
    const tags = await githubFetchJson(tagsUrl, context)
    items = Array.isArray(tags) ? tags.filter(isRecord) : []
  }

  /** @type {Array<{tag: string, version: string, assets: unknown[]}>} */
  const entries = []
  const seenVersions = new Set()
  for (const item of items) {
    if (fromTags !== true && item.draft === true) continue
    const tag = fromTags === true
      ? typeof item.name === 'string' ? item.name : ''
      : typeof item.tag_name === 'string' ? item.tag_name : ''
    if (tag === '') continue
    const version = versionFromTag(tag)
    if (version === null || seenVersions.has(version)) continue
    seenVersions.add(version)
    entries.push({ tag, version, assets: Array.isArray(item.assets) ? item.assets : [] })
  }

  const toInspect = entries.slice(0, MAX_MANIFEST_FETCHES)
  if (entries.length > toInspect.length) {
    warnings.add(`github: 版本较多，仅校验前 ${toInspect.length} 个（共 ${entries.length} 个）的兼容性`)
  }
  const manifests = await mapLimit(toInspect, MANIFEST_CONCURRENCY, async (entry) => {
    const manifestUrl = `${GITHUB_RAW}/${repo.owner}/${repo.repo}/${entry.tag}/package.json`
    try {
      const data = await githubFetchJson(manifestUrl, context)
      return isRecord(data) ? data : null
    } catch (error) {
      if (options.signal && options.signal.aborted) throw error
      return null
    }
  })

  const mirrorPrefix = options.source === 'github-mirror' && mirrorKey !== '' && mirrorMemory.key === mirrorKey
    ? mirrorMemory.prefix
    : ''
  let usesSourceTarball = false
  let usedMirrorForInstall = false
  const versions = entries.map((entry, index) => {
    const manifest = index < manifests.length ? manifests[index] : null
    const asset = findReleaseAsset(entry.assets, { name: options.name, version: entry.version })
    const archiveUrl = `${GITHUB_WEB}/${repo.owner}/${repo.repo}/archive/refs/tags/${entry.tag}.tar.gz`
    if (asset === null) {
      usesSourceTarball = true
      return {
        version: entry.version,
        manifest,
        dist: { tarball: archiveUrl },
        installSpec: `github:${repo.owner}/${repo.repo}#${entry.tag}`,
        installKind: 'source-tarball',
      }
    }
    // Release assets install without running `prepare`/build scripts, so they
    // work with pnpm 12's default `allowBuilds: []`. A git-hosted spec would
    // fail with ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED.
    const installUrl = mirrorPrefix === '' ? asset.url : `${mirrorPrefix}/${asset.url}`
    if (mirrorPrefix !== '') usedMirrorForInstall = true
    return {
      version: entry.version,
      manifest,
      dist: { tarball: installUrl },
      installSpec: installUrl,
      installKind: 'tarball',
    }
  })
  if (usesSourceTarball) warnings.add(SOURCE_TARBALL_WARNING)
  if (usedMirrorForInstall) {
    warnings.add(`github-mirror: 安装地址使用镜像前缀 ${mirrorPrefix}`)
  }

  const latest = versions.length === 0 ? null : semver.maxVersion(versions.map((item) => item.version))

  return {
    source: options.source,
    repo,
    latest,
    versions,
    warnings: warnings.list,
    fetchedAt: new Date().toISOString(),
  }
}

/**
 * List every known version of one package from one source.
 *
 * @param {{
 *   name: string,
 *   source: 'npm-official'|'npm-mirror'|'github'|'github-mirror'|string,
 *   config?: Record<string, unknown>,
 *   manifest?: Record<string, unknown>|null,
 *   signal?: AbortSignal|null,
 *   timeoutMs?: number
 * }} options
 * @returns {Promise<{
 *   source: string,
 *   registryUrl?: string,
 *   repo?: {owner: string, repo: string}|null,
 *   latest: string|null,
 *   versions: Array<{
 *     version: string,
 *     manifest: object|null,
 *     dist: {tarball?: string}|null,
 *     installSpec: string|null,
 *     installKind: 'registry'|'tarball'|'source-tarball'|null
 *   }>,
 *   warnings: string[],
 *   fetchedAt: string
 * }>}
 * @throws {SourceError} With `code` in `timeout|network|not-found|private|
 *   invalid-repo|rate-limit|bad-response`.
 */
export async function listVersions(options) {
  const input = isRecord(options) ? options : {}
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  const source = typeof input.source === 'string' ? input.source : ''
  if (name === '') throw new SourceError('bad-response', '缺少包名', { detail: 'name' })
  if (SOURCE_IDS.includes(source) !== true) {
    throw new SourceError('bad-response', `未知的版本源：${source}`, { detail: 'source' })
  }
  const normalized = {
    name,
    source,
    config: isRecord(input.config) ? input.config : {},
    manifest: isRecord(input.manifest) ? input.manifest : null,
    signal: input.signal instanceof AbortSignal ? input.signal : null,
    timeoutMs: input.timeoutMs,
  }
  if (source === 'npm-official' || source === 'npm-mirror') return listNpmVersions(normalized)
  return listGithubVersions(normalized)
}
