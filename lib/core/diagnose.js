/**
 * Startup diagnostics: read the DSH log tail and explain why plugins did not load.
 *
 * This module is deliberately read-only and dependency-free: it never touches the
 * network, never writes files and never throws on unreadable logs. The result is a
 * small, stable shape consumed by the client "startup issues" panel.
 *
 * @module core/diagnose
 */

import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'

import * as semver from './semver.js'

/** Hard cap on how many log files one scan reads. */
export const MAX_FILES = 3

/** How many bytes of the tail of each log file are read. */
export const TAIL_BYTES = 4 * 1024 * 1024

/** Safety cap on parsed lines per file (a 4 MB tail is normally below this). */
const MAX_LINES_PER_FILE = 20000

/** Maximum characters kept for `item.detail`. */
const MAX_DETAIL_CHARS = 2000

/** Maximum characters kept for `item.summary`. */
const MAX_SUMMARY_CHARS = 160

/** Maximum characters kept for one raw log line before parsing. */
const MAX_LINE_CHARS = 8000

/** Log line levels that can produce a diagnostic. */
const CANDIDATE_LEVELS = new Set(['error', 'warn', 'warning'])

/** Rule order follows contract §3.7: the first match wins. */
const MESSAGE_RULES = [
  {
    code: 'incompatible',
    match: (message) => /skipping profile bundle\s+"([^"]+)"/i.test(message) && /incompatible with dsh/i.test(message),
  },
  {
    code: 'missing-inject',
    match: (message) => /cannot get property\s+["']?[^"'\s]+["']?\s+without inject/i.test(message),
  },
  {
    code: 'missing-dependency',
    match: (message) => /Cannot find module|ERR_MODULE_NOT_FOUND|Failed to resolve entry/i.test(message),
  },
  {
    code: 'ignored-builds',
    match: (message) => /ERR_PNPM_IGNORED_BUILDS|Ignored build scripts/i.test(message),
  },
  {
    code: 'broken-package',
    match: (message) => /SyntaxError|Unexpected token|is not a function|ERR_PACKAGE_PATH_NOT_EXPORTED/i.test(message),
  },
  {
    code: 'duplicate-registration',
    match: (message) => /already registered|\bduplicate\b|conflict with/i.test(message),
  },
]

/** Codes whose default severity is an error even when the log line is only a warn. */
const ERROR_CODES = new Set(['incompatible', 'missing-inject', 'missing-dependency', 'broken-package', 'ignored-builds'])

/** Human titles per diagnostic code (Chinese, short). */
const TITLES = {
  incompatible: '被版本闸跳过',
  'missing-inject': '插件 API 不兼容',
  'not-activated': '插件未能激活',
  'missing-dependency': '依赖缺失',
  'ignored-builds': '构建脚本被跳过',
  'broken-package': '插件包已损坏',
  'duplicate-registration': '重复注册冲突',
  unknown: '插件加载出错',
}

/**
 * @typedef {{ kind: 'update'|'command'|'text', label: string, version?: string, command?: string, cwd?: string, detail?: string }} DiagnosticFix
 * @typedef {{ id: string, plugin: string, code: string, severity: 'error'|'warn', title: string, summary: string, detail: string, at: string|null, fixes: DiagnosticFix[] }} DiagnosticItem
 * @typedef {{ checkedAt: string, scanned: string[], items: DiagnosticItem[], errors: Array<{ file: string, message: string }> }} Diagnostics
 * @typedef {{ profile?: any, dshHome?: string, cache?: Record<string, any>|null, logsDir?: string, sinceMs?: number, limitFiles?: number }} DiagnoseInput
 */

/**
 * Scan the DSH logs and return startup diagnostics.
 *
 * @param {DiagnoseInput} [input]
 * @returns {Promise<Diagnostics>}
 */
export async function diagnoseStartup(input = {}) {
  const startedAt = Date.now()
  const checkedAt = new Date().toISOString()
  /** @type {string[]} */
  const scanned = []
  /** @type {DiagnosticItem[]} */
  const items = []
  /** @type {Array<{ file: string, message: string }>} */
  const errors = []

  const safeInput = isObject(input) ? input : {}
  const profile = isObject(safeInput.profile) ? safeInput.profile : null
  const dshHome = typeof safeInput.dshHome === 'string' && safeInput.dshHome !== ''
    ? safeInput.dshHome
    : (typeof profile?.dshHome === 'string' ? profile.dshHome : '')
  const logsDir = typeof safeInput.logsDir === 'string' && safeInput.logsDir !== ''
    ? safeInput.logsDir
    : (dshHome === '' ? '' : path.join(dshHome, 'logs'))

  if (logsDir === '') {
    return { checkedAt, scanned, items, errors: [{ file: '', message: '无法确定日志目录（缺少 dshHome）' }] }
  }

  const limitFiles = clampInteger(safeInput.limitFiles, MAX_FILES, 1, MAX_FILES)
  const hasExplicitSince = Number.isFinite(safeInput.sinceMs)
  const sinceMs = hasExplicitSince
    ? Number(safeInput.sinceMs)
    : Date.now() - process.uptime() * 1000 - 60_000
  // Only filter individual lines when the caller asked for a window; the default
  // window is a file-level filter so a fixture with a fixed old timestamp still
  // shows up as long as the file itself is fresh.
  const lineSinceMs = hasExplicitSince ? sinceMs : null

  let fileNames
  try {
    fileNames = await discoverLogFiles(logsDir, sinceMs, limitFiles)
  } catch (error) {
    return {
      checkedAt,
      scanned,
      items,
      errors: [{ file: logsDir, message: errorMessage(error) }],
    }
  }

  /** @type {Array<{ file: string, level: string, message: string, at: string|null, source: string, plugin: string|null }>} */
  const entries = []

  for (const filePath of fileNames) {
    const base = path.basename(filePath)
    let text
    try {
      text = await readTail(filePath, TAIL_BYTES)
    } catch (error) {
      errors.push({ file: base, message: errorMessage(error) })
      continue
    }
    scanned.push(base)
    const lines = text.split('\n').slice(-MAX_LINES_PER_FILE)
    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (line === '') continue
      const parsed = parseLogLine(line.slice(0, MAX_LINE_CHARS))
      if (parsed === null) continue
      if (!CANDIDATE_LEVELS.has(parsed.level)) continue
      if (parsed.message === '') continue
      if (lineSinceMs !== null && parsed.timeMs !== null && parsed.timeMs < lineSinceMs) continue
      expandEntry(parsed, entries)
    }
  }

  const profileIndex = buildProfileIndex(profile)
  /** @type {Array<{ entry: any, code: string, plugin: string }>} */
  const resolved = []
  for (const entry of entries) {
    const code = classifyMessage(entry.message, entry)
    if (code === null) continue
    const plugin = resolvePlugin(entry, code, profileIndex)
    // Contract §3.7 requires a non-empty plugin name; a line we cannot attribute
    // to a concrete package (e.g. an app.asar-only stack) is dropped rather than
    // shown as a misleading host-wide failure.
    if (plugin === null || plugin === '') continue
    resolved.push({ entry, code, plugin })
  }

  const pluginNames = new Set(resolved.map(value => value.plugin))
  /** @type {Map<string, { item: DiagnosticItem, timeMs: number }>} */
  const deduped = new Map()

  for (const value of resolved) {
    const { entry, code } = value
    const plugin = canonicalPluginName(value.plugin, pluginNames)
    const softLevel = entry.level === 'warn' || entry.level === 'warning'
    const severity = softLevel && !ERROR_CODES.has(code) ? 'warn' : 'error'
    const item = buildItem({ entry, code, plugin, severity, profile, index: profileIndex, cache: safeInput.cache })
    const key = `${plugin}::${item.code}`
    const timeMs = entry.at === null ? Number.NEGATIVE_INFINITY : Date.parse(entry.at)
    const previous = deduped.get(key)
    if (previous === undefined || !(Number.isFinite(previous.timeMs) && timeMs < previous.timeMs)) {
      deduped.set(key, { item, timeMs })
    }
  }

  const ordered = [...deduped.values()].map(value => value.item)
  ordered.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1
    const atA = a.at === null ? -Infinity : Date.parse(a.at)
    const atB = b.at === null ? -Infinity : Date.parse(b.at)
    return (Number.isFinite(atB) ? atB : -Infinity) - (Number.isFinite(atA) ? atA : -Infinity)
  })

  void startedAt
  return { checkedAt, scanned, items: ordered, errors }
}

/**
 * List the most recently modified `*.jsonl` and `desktop-next*.log` files.
 *
 * @param {string} logsDir
 * @param {number} sinceMs
 * @param {number} limitFiles
 * @returns {Promise<string[]>}
 */
async function discoverLogFiles(logsDir, sinceMs, limitFiles) {
  const dirents = await fs.readdir(logsDir, { withFileTypes: true })
  const candidates = []
  for (const dirent of dirents) {
    if (!dirent.isFile()) continue
    const fileName = dirent.name
    if (!/\.jsonl$/i.test(fileName) && !/^desktop-next.*\.log$/i.test(fileName)) continue
    const filePath = path.join(logsDir, fileName)
    try {
      const stat = await fs.stat(filePath)
      if (!Number.isFinite(sinceMs) || stat.mtimeMs >= sinceMs) {
        candidates.push({ filePath, mtimeMs: stat.mtimeMs })
      }
    } catch {
      // A file can disappear between readdir and stat; simply skip it.
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return candidates.slice(0, limitFiles).map(candidate => candidate.filePath)
}

/**
 * Read at most `maxBytes` from the end of a file.
 *
 * @param {string} filePath
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
async function readTail(filePath, maxBytes) {
  const handle = await fs.open(filePath, 'r')
  try {
    const stat = await handle.stat()
    const start = Math.max(0, stat.size - maxBytes)
    const length = stat.size - start
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    let text = buffer.toString('utf8')
    if (start > 0) {
      const newline = text.indexOf('\n')
      if (newline >= 0) text = text.slice(newline + 1)
    }
    return text
  } finally {
    await handle.close()
  }
}

/**
 * Parse one JSONL line; fall back to a plain-text line.
 *
 * @param {string} line
 * @returns {{ level: string, message: string, source: string, at: string|null, timeMs: number|null }|null}
 */
function parseLogLine(line) {
  if (line.startsWith('{')) {
    try {
      const value = JSON.parse(line)
      if (isObject(value) && typeof value.message === 'string') {
        const level = typeof value.level === 'string' ? value.level.toLowerCase() : ''
        const source = typeof value.source === 'string' ? value.source : ''
        const at = typeof value.time === 'string' ? value.time : null
        const timeMs = at === null ? null : Date.parse(at)
        return { level, message: value.message, source, at, timeMs: Number.isFinite(timeMs) ? Number(timeMs) : null }
      }
    } catch {
      // Not valid JSON: treat the line as plain text below.
    }
  }
  const level = /\b(error|warn|warning)\b/i.test(line) ? 'error' : 'warn'
  return { level, message: line, source: '', at: null, timeMs: null }
}

/**
 * Expand one log event into zero or more diagnosable entries. HMR "did not
 * activate" summaries carry one child entry per failing plugin.
 *
 * @param {{ level: string, message: string, source: string, at: string|null }} parsed
 * @param {Array<any>} out
 */
function expandEntry(parsed, out) {
  const { message, source } = parsed
  const at = parsed.at ?? null

  if (/did not activate/i.test(message)) {
    const children = parseChildLines(message)
    for (const child of children) {
      out.push({
        level: parsed.level,
        message: child.message,
        at,
        source,
        plugin: child.name,
        child: true,
        builtin: isBuiltinId(child.id) || isBuiltinId(child.name),
      })
    }
    return
  }

  const child = parseSingleChild(message)
  if (child !== null && isKernelSource(source)) {
    out.push({
      level: parsed.level,
      message: child.message,
      at,
      source,
      plugin: child.name,
      child: true,
      builtin: isBuiltinId(child.id) || isBuiltinId(child.name),
    })
    return
  }

  out.push({ level: parsed.level, message, at, source, plugin: null, child: false, builtin: false })
}

/** Whether a log source belongs to the plugin kernel (not unrelated stderr). */
function isKernelSource(source) {
  return source.startsWith('host.kernel.') || source === 'host.stderr'
}

/**
 * Parse child plugin lines from an HMR summary such as
 * `name (id): Error: ...\n    at ...`.
 *
 * @param {string} message
 * @returns {Array<{ name: string, id: string, message: string }>}
 */
function parseChildLines(message) {
  const lines = message.split('\n')
  /** @type {Array<{ name: string, id: string, message: string }>} */
  const children = []
  /** @type {{ name: string, id: string, buffer: string[] }|null} */
  let current = null
  for (const line of lines.slice(1)) {
    const match = /^\s*([@\w./~-]+)\s+\(([^)]+)\):\s*(.*)$/.exec(line)
    if (match !== null && !/^\s+at\s/.test(line)) {
      if (current !== null) children.push({ name: current.name, id: current.id, message: current.buffer.join('\n').trim() })
      current = { name: match[1], id: match[2], buffer: [match[3]] }
      continue
    }
    if (current !== null) current.buffer.push(line)
  }
  if (current !== null) children.push({ name: current.name, id: current.id, message: current.buffer.join('\n').trim() })
  return children.filter(child => child.message !== '')
}

/**
 * Parse a single `name (id): <message>` line, used outside summary blocks.
 *
 * @param {string} message
 * @returns {{ name: string, id: string, message: string }|null}
 */
function parseSingleChild(message) {
  const lines = message.split('\n')
  const match = /^\s*([@\w./~-]+)\s+\(([^)]+)\):\s*([\s\S]*)$/.exec(lines[0] ?? '')
  if (match === null) return null
  const rest = [match[3], ...lines.slice(1)].join('\n').trim()
  if (rest === '') return null
  return { name: match[1], id: match[2], message: rest }
}

/** Whether a loader id/name identifies a plugin shipped inside DSH. */
function isBuiltinId(value) {
  return typeof value === 'string' && /^@deepseek-ai\/dsh-/.test(value)
}

/**
 * Classify one message using the ordered contract rules.
 *
 * @param {string} message
 * @param {{ source: string, level: string }} entry
 * @returns {string|null}
 */
function classifyMessage(message, entry) {
  // "pending (waiting for service: X)" only means a plugin is still waiting for
  // a sibling service; it is not a load failure and must not be reported.
  if (/waiting for service/i.test(message) || /pending\s*\(\s*waiting/i.test(message)) return null
  for (const rule of MESSAGE_RULES) {
    if (rule.match(message)) return rule.code
  }
  // A line extracted from an "entry did not activate" summary is always a load
  // failure, even when the inner error has no recognizable signature. `unknown`
  // is reserved for plain kernel errors outside such summaries.
  if (entry.child === true) return 'not-activated'
  if (isKernelSource(entry.source) && entry.level === 'error') return 'unknown'
  return null
}

/**
 * Resolve the affected package name from a log entry.
 *
 * @param {{ source: string, plugin: string|null, message: string }} entry
 * @param {string} code
 * @param {{ exact: Set<string>, loose: Map<string, string>, installed: Map<string, string|null> }} index
 * @returns {string|null}
 */
function resolvePlugin(entry, code, index) {
  if (code === 'incompatible') {
    const match = /skipping profile bundle\s+"([^"]+)"/i.exec(entry.message)
    if (match !== null) {
      const name = match[1]
      return index.exact.has(name) ? name : (index.loose.get(stripScope(name)) ?? name)
    }
  }
  if (typeof entry.plugin === 'string' && entry.plugin !== '') {
    const name = entry.plugin
    return index.exact.has(name) ? name : (index.loose.get(stripScope(name)) ?? name)
  }
  if (entry.source.startsWith('host.kernel.')) {
    const id = entry.source.slice('host.kernel.'.length)
    if (id === '' || id === 'hmr' || id === 'app-boot' || id === 'kernel' || id === 'cordis' || id === 'web-server') {
      return null
    }
    if (index.exact.has(id)) return id
    if (index.loose.has(id)) return index.loose.get(id) ?? null
  }
  // Last resort: the longest known package name mentioned in the message, so
  // `dsh-ego-browser` wins over the shorter `ego-browser` alias.
  let best = null
  for (const name of index.exact) {
    if (entry.message.includes(name) && (best === null || name.length > best.length)) best = name
  }
  return best
}

/**
 * Build the diagnostic item payload (title/summary/detail/fixes).
 *
 * @param {{ entry: any, code: string, plugin: string, severity: 'error'|'warn', profile: any, index: any, cache: any }} context
 * @returns {DiagnosticItem}
 */
function buildItem(context) {
  const { entry, code, plugin, severity, profile, index, cache } = context
  const label = plugin
  const installedVersion = index.installed.get(plugin) ?? null
  const runtimeVersion = typeof profile?.runtimeVersion === 'string' ? profile.runtimeVersion : '当前 DSH'
  const summary = buildSummary(code, label, runtimeVersion)
  return {
    id: plugin,
    plugin,
    code,
    severity,
    title: TITLES[code] ?? TITLES.unknown,
    summary: truncate(summary, MAX_SUMMARY_CHARS),
    detail: redactSecrets(truncate(entry.message, MAX_DETAIL_CHARS)),
    at: entry.at ?? null,
    fixes: buildFixes(code, plugin, installedVersion, profile, cache, entry.message, entry.builtin === true),
  }
}

/**
 * One-line Chinese summary per code.
 *
 * @param {string} code
 * @param {string} label
 * @param {string} runtimeVersion
 * @returns {string}
 */
function buildSummary(code, label, runtimeVersion) {
  switch (code) {
    case 'incompatible':
      return `${label} 被版本闸跳过：它的 engines/peer 要求与 DSH ${runtimeVersion} 不兼容。`
    case 'missing-inject':
      return `${label} 依赖的宿主能力（如 webServer）没有被注入，通常是插件 API 与 DSH ${runtimeVersion} 不匹配。`
    case 'not-activated':
      return `${label} 在加载期抛出异常，未能激活。`
    case 'missing-dependency':
      return `${label} 的依赖没有安装完整，加载时找不到模块。`
    case 'ignored-builds':
      return `${label} 需要执行的构建脚本被 pnpm 跳过（allowBuilds 未授权）。`
    case 'broken-package':
      return `${label} 的代码在加载时抛出语法或运行错误，包可能已损坏。`
    case 'duplicate-registration':
      return `${label} 与其它插件注册了相同的 slot/route/section id。`
    default:
      return `${label} 加载时出错，暂时无法归类为已知模式。`
  }
}

/**
 * Build the actionable fix list for one diagnostic.
 *
 * @param {string} code
 * @param {string} plugin
 * @param {string|null} installedVersion
 * @param {any} profile
 * @param {Record<string, any>|null|undefined} cache
 * @param {string} message
 * @param {boolean} builtin
 * @returns {DiagnosticFix[]}
 */
function buildFixes(code, plugin, installedVersion, profile, cache, message, builtin) {
  // Built-in plugins ship inside DSH itself: npm does not own them, so offering
  // "report to the author" (or an install command) would be misleading.
  if (builtin === true || isBuiltinPlugin(plugin)) {
    return [{
      kind: 'text',
      label: '内置插件',
      detail: '这是 DSH 内置插件，不会通过 npm 更新；可在 profile 的 cordis.patch.yml 里把它设成 disabled，或等待 DSH 版本更新修复。',
    }]
  }

  /** @type {DiagnosticFix[]} */
  const fixes = []
  const cwd = typeof profile?.dir === 'string' && profile.dir !== '' ? profile.dir : undefined
  const updateVersion = compatibleUpdateVersion(plugin, installedVersion, cache)
  const updateFix = updateVersion === null
    ? null
    : { kind: 'update', label: `更新到 ${updateVersion}（已确认兼容本机 DSH）`, version: updateVersion }

  switch (code) {
    case 'incompatible':
      if (updateFix !== null) fixes.push(updateFix)
      fixes.push({
        kind: 'text',
        label: '说明',
        detail: '该版本被宿主版本闸跳过：请等作者发布兼容本机 DSH 的版本，或改用其它同类插件；allow-version 不能绕过这道闸。',
      })
      break
    case 'missing-inject':
      if (updateFix !== null) fixes.push(updateFix)
      fixes.push({
        kind: 'text',
        label: '说明',
        detail: '插件声明的注入能力与当前 DSH 运行时不一致：请升级 DSH，或把插件更新/更换到兼容版本。',
      })
      break
    case 'not-activated':
      if (updateFix !== null) fixes.push(updateFix)
      fixes.push({
        kind: 'text',
        label: '说明',
        detail: '插件在加载时抛出异常、没有激活：先尝试更新到兼容版本；仍然失败请把上面的日志片段反馈给插件作者。',
      })
      break
    case 'missing-dependency': {
      // A `link:` plugin can miss its own dependencies; in that case installing
      // in the profile does not help, the install must run in the plugin root.
      const pluginDir = resolvePluginDirFromMessage(message)
      fixes.push({
        kind: 'command',
        label: pluginDir === null ? '在 profile 目录重装依赖' : '在插件目录安装依赖',
        command: 'corepack pnpm install --config.strict-dep-builds=false',
        cwd: pluginDir ?? cwd,
      })
      fixes.push({
        kind: 'text',
        label: '说明',
        detail: pluginDir === null
          ? '通常是依赖没有装全或 node_modules 被清理过；执行命令后重启 DSH 再试。'
          : '这是插件自身缺少依赖，需要在插件目录安装；执行命令后重启 DSH 再试。',
      })
      break
    }
    case 'ignored-builds':
      fixes.push({
        kind: 'command',
        label: '授权构建脚本',
        command: 'pnpm approve-builds',
        cwd,
      })
      fixes.push({
        kind: 'text',
        label: '说明',
        detail: '在 pnpm-workspace.yaml 的 allowBuilds 中把该依赖设为 true（或在交互式 approve-builds 里选中它），然后重启 DSH。',
      })
      break
    case 'broken-package': {
      // A `failed to import` runtime error means the plugin is incompatible with
      // the running DSH/Node, not that its files are corrupt: reinstalling the
      // same version cannot fix it, so only offer an update when one is known.
      if (/failed to import/i.test(message)) {
        if (updateFix !== null) fixes.push(updateFix)
        fixes.push({
          kind: 'text',
          label: '说明',
          detail: '插件与当前 DSH/Node 运行时不兼容：建议更新插件，或升级 DSH 到插件支持的版本。',
        })
        break
      }
      if (plugin !== null && installedVersion !== null) {
        fixes.push({
          kind: 'command',
          label: '重装当前版本',
          command: `corepack pnpm add ${plugin}@${installedVersion} --save-exact --force`,
          cwd,
        })
      }
      fixes.push({
        kind: 'text',
        label: '说明',
        detail: '插件文件可能损坏或不完整：先重装当前版本；如果仍然报错，请更新到兼容版本或反馈给作者。',
      })
      break
    }
    case 'duplicate-registration':
      fixes.push({
        kind: 'text',
        label: '处理重复注册',
        detail: '两个插件注册了同一个 slot/route/section id：在 profile 的 dsh.profile.bundles 里先停用其中一个，然后重启 DSH。',
      })
      break
    default:
      fixes.push({
        kind: 'text',
        label: '反馈给作者',
        detail: '请把详情反馈给插件作者；若是内置插件请升级 DSH。',
      })
      break
  }
  return fixes
}

/**
 * Pick a compatible target version from the updater cache, if one exists.
 *
 * `cache[name].compatibleMax` is produced by `pickTargets()`, which already
 * evaluated compatibility with the running DSH version, so it is safe to offer
 * as an update fix.
 *
 * @param {string|null} plugin
 * @param {string|null} installedVersion
 * @param {Record<string, any>|null|undefined} cache
 * @returns {string|null}
 */
function compatibleUpdateVersion(plugin, installedVersion, cache) {
  if (plugin === null) return null
  const record = isObject(cache) ? cache[plugin] : null
  if (!isObject(record)) return null
  const version = typeof record.compatibleMax === 'string' ? record.compatibleMax : null
  if (version === null || semver.valid(version) === null) return null
  if (installedVersion !== null && semver.eq(version, installedVersion)) return null
  return version
}

/**
 * Build the lookup tables used to turn log ids into package names.
 *
 * @param {any} profile
 * @returns {{ exact: Set<string>, loose: Map<string, string>, installed: Map<string, string|null> }}
 */
function buildProfileIndex(profile) {
  const exact = new Set()
  const loose = new Map()
  const installed = new Map()

  const dependencies = isObject(profile?.manifest?.dependencies)
    ? profile.manifest.dependencies
    : (isObject(profile?.dependencies) ? profile.dependencies : {})
  for (const name of Object.keys(dependencies)) {
    exact.add(name)
    loose.set(stripScope(name), name)
  }

  const packages = Array.isArray(profile?.packages) ? profile.packages : []
  for (const entry of packages) {
    if (!isObject(entry) || typeof entry.name !== 'string') continue
    exact.add(entry.name)
    loose.set(stripScope(entry.name), entry.name)
    if (!installed.has(entry.name)) {
      installed.set(entry.name, typeof entry.installedVersion === 'string' ? entry.installedVersion : null)
    }
  }

  const bundles = Array.isArray(profile?.bundles) ? profile.bundles : []
  for (const bundle of bundles) {
    const name = typeof bundle === 'string'
      ? bundle
      : (isObject(bundle) && typeof bundle.name === 'string' ? bundle.name : null)
    if (name === null) continue
    exact.add(name)
    if (!loose.has(stripScope(name))) loose.set(stripScope(name), name)
  }

  return { exact, loose, installed }
}

/**
 * Merge alias package names that differ only by a `dsh-` or scope prefix
 * (`ego-browser` / `dsh-ego-browser` / `@scope/ego-browser`): keep the most
 * complete name so one log event cannot surface as two diagnostics.
 *
 * @param {string} name
 * @param {Set<string>} names
 * @returns {string}
 */
function canonicalPluginName(name, names) {
  let best = name
  for (const other of names) {
    if (other.length > best.length && isSuffixAlias(other, name)) best = other
  }
  return best
}

/**
 * @param {string} longer
 * @param {string} shorter
 * @returns {boolean}
 */
function isSuffixAlias(longer, shorter) {
  if (longer === shorter || !longer.endsWith(shorter)) return false
  const boundary = longer[longer.length - shorter.length - 1]
  return boundary === '-' || boundary === '/' || boundary === '@'
}

/**
 * Whether a diagnostic belongs to a plugin that ships inside DSH itself.
 *
 * Only the plugin identity may be inspected here. Stack traces always mention
 * host packages such as `@deepseek-ai/dsh-client-connection`, so matching the
 * message body would misclassify ordinary third-party plugins as built-in.
 *
 * @param {string} plugin
 * @returns {boolean}
 */
function isBuiltinPlugin(plugin) {
  return plugin.startsWith('@deepseek-ai/dsh-')
}

/**
 * Resolve the plugin root hinted by `imported from <path>` in a log message.
 * Only absolute paths are accepted; returns null when nothing usable is found.
 *
 * @param {string} message
 * @returns {string|null}
 */
function resolvePluginDirFromMessage(message) {
  const match = /imported from\s+"?([^\n"']+)/i.exec(message)
  if (match === null) return null
  const raw = match[1].trim().replace(/[),.;]+$/, '')
  if (raw === '') return null
  const windows = /^[A-Za-z]:[\\/]/.test(raw)
  if (!windows && !raw.startsWith('/')) return null
  const pathApi = windows ? path.win32 : path
  const start = pathApi.dirname(raw)
  if (start === '' || start === '.') return null
  let dir = start
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(pathApi.join(dir, 'package.json'))) return dir
    const parent = pathApi.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return start
}

/** Strip a leading `@scope/` from a package id. */
function stripScope(name) {
  const slash = name.indexOf('/')
  return name.startsWith('@') && slash > 0 ? name.slice(slash + 1) : name
}

/** Redact obvious secrets from log excerpts before they reach the UI. */
function redactSecrets(text) {
  return text
    .replace(/(token|api[_-]?key|authorization|password|secret)\s*[=:]\s*["']?[^\s"',;]+/gi, '$1=***')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer ***')
}

/** Truncate without splitting surrogate pairs. */
function truncate(text, max) {
  if (typeof text !== 'string') return ''
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

/** Clamp an optional integer input. */
function clampInteger(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(number)))
}

/** Narrow unknown values to plain objects. */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Never throw while stringifying a filesystem error. */
function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
