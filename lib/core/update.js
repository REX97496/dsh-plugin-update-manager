/**
 * One atomic package update: backup → install → verify → (on any failure)
 * restore. This is the only module that mutates the profile on disk, so it is
 * deliberately paranoid:
 *
 *   - the profile's `package.json`, `pnpm-lock.yaml` and the package's
 *     `node_modules/<pkg>` directory are copied to
 *     `<stateDir>/backups/<name>@<stamp>/` before anything runs;
 *   - after the install the installed version, the manifest compatibility gate
 *     and the untouched-ness of the rest of `package.json` (including
 *     `dsh.profile.bundles`) are verified;
 *   - if verification or the install fails, the backup is restored and
 *     compared byte-for-byte with the original.
 *
 * Cancellation kills the whole process tree (pnpm leaves file locks behind
 * otherwise); on Windows that is `taskkill /PID <pid> /T /F`.
 *
 * Test hook: `DSH_UPDATER_FAKE_PM=success|mismatch|fail` replaces the real
 * package manager with an in-process simulator. Any other value (or absence)
 * takes the production path.
 *
 * @module core/update
 */

import { spawn } from 'node:child_process'
import { Buffer } from 'node:buffer'
import {
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'

import * as semver from './semver.js'
import { evaluateManifest, describeUnmet } from './compat.js'
import { stateDir as defaultStateDir } from './store.js'

const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const BACKUP_SIZE_LIMIT_BYTES = 200 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const OUTPUT_TAIL_CHARS = 800
const OUTPUT_CAPTURE_LIMIT = 200 * 1024
const GITHUB_SOURCE_NEEDS_BUILD_MESSAGE = '该版本没有可安装的 release 资产，只能从 GitHub 源码安装；pnpm 12 默认拒绝执行其构建脚本（ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED）。请改用「npm 国内镜像」更新该插件，或在 profile 的 pnpm-workspace.yaml 中按 pnpm 提示加入 allowBuilds 后重试。'

/**
 * @type {Array<{class: string, hint: string, pattern: RegExp}>}
 */
const PNPM_FAILURE_RULES = [
  {
    // Must run before `windows-file-locked`: a EPERM rename of the profile's
    // package.json / pnpm-lock.yaml is a profile lock, not a node_modules one.
    class: 'profile-file-locked',
    hint: 'package.json 或 pnpm-lock.yaml 被占用，请稍后重试',
    pattern: /(?:package\.json|pnpm-lock\.yaml)[^\n]*EPERM|EPERM[^\n]*(?:package\.json|pnpm-lock\.yaml)/i,
  },
  {
    class: 'windows-file-locked',
    hint: '请完全退出 DSH 桌面版后重试，刷新页面无效',
    pattern: /failed to remove existing directory prior to swap|ERR_PNPM_EPERM[^\n]*(?:node_modules|\.pnpm)|(?:EPERM(?:[:\s]|$)|EBUSY|resource busy or locked)[^\n]*(?:node_modules|\.pnpm)|(?:node_modules|\.pnpm)[^\n]*(?:EPERM|EBUSY|resource busy or locked)/i,
  },
  {
    class: 'host-incompatible-install',
    hint: '宿主版本闸拒绝安装，请选择兼容版本',
    pattern: /installation rejected|is incompatible with dsh/i,
  },
  {
    class: 'ignored-builds',
    hint: '依赖里有需要运行构建脚本的包，宿主禁止了自动构建：请在 profile 目录执行 pnpm approve-builds 授权后重试（或改用不需要构建的版本）',
    pattern: /ERR_PNPM_IGNORED_BUILDS|Ignored build scripts/i,
  },
  {
    class: 'lockfile-outdated',
    hint: 'lockfile 与 package.json 不一致，请先让宿主重新安装一次再更新',
    pattern: /ERR_PNPM_OUTDATED_LOCKFILE|lockfile is not up to date/i,
  },
  {
    class: 'lockfile-broken',
    hint: 'lockfile 损坏，请删除 pnpm-lock.yaml 后让宿主重装',
    pattern: /ERR_PNPM_BROKEN_LOCKFILE|Cannot read properties of undefined[^\n]*lockfile/i,
  },
  {
    class: 'unexpected-store',
    hint: 'pnpm store 位置不一致，请先修复 pnpm 配置',
    pattern: /ERR_PNPM_UNEXPECTED_STORE|unexpected store/i,
  },
  {
    class: 'tarball-url-mismatch',
    hint: '下载地址与 lockfile 记录不一致，请切换更新源或清理 lockfile 后重试',
    pattern: /ERR_PNPM_TARBALL_URL_MISMATCH/i,
  },
  {
    class: 'release-age-violation',
    hint: '该版本发布太新，被 release-age 策略拦下；请稍后重试',
    pattern: /ERR_PNPM_RELEASE_AGE|minimumReleaseAge/i,
  },
  {
    class: 'workspace-root',
    hint: 'profile 不是合法的 pnpm 工作区，请让宿主重新初始化 profile',
    pattern: /ERR_PNPM_ADDING_TO_ROOT|ERR_PNPM_NOT_A_WORKSPACE/i,
  },
  {
    class: 'git-dep-prepare-not-allowed',
    hint: '该版本从 GitHub 源码安装需要执行构建脚本，pnpm 12 默认拒绝（allowBuilds）。请改用 npm 国内镜像更新，或在 profile 的 pnpm-workspace.yaml 里按 pnpm 提示加 allowBuilds 条目后重试。',
    pattern: /ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED|needs to execute build scripts but is not in the "allowBuilds" allowlist/,
  },
  {
    class: 'no-matching-version',
    hint: '该版本不存在或镜像未同步',
    pattern: /ERR_PNPM_NO_MATCHING_VERSION|No matching version found|404 Not Found/i,
  },
  {
    class: 'transient-network',
    hint: '网络波动，可重试或切换源',
    pattern: /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network request failed|ERR_SOCKET/i,
  },
  {
    class: 'pnpm-missing',
    hint: '未找到可用的 pnpm，请安装后重试',
    pattern: /ERR_PNPM_MISSING|command not found|is not recognized as an internal or external command/i,
  },
]

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Internal failure carrier: `code` maps 1:1 onto `UpdateResult.error.code`.
 */
class UpdateFailure extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {string} [detail]
   */
  constructor(code, message, detail) {
    super(message)
    this.name = 'UpdateFailure'
    this.code = code
    if (typeof detail === 'string') this.detail = detail
  }
}

/**
 * @param {string} file
 * @returns {Promise<unknown|null>}
 */
async function readJsonFile(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * @param {string} file
 * @param {unknown} value
 * @returns {Promise<void>}
 */
async function writeJsonFile(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function errorText(value) {
  return value instanceof Error ? value.message : String(value)
}

/**
 * @param {string} root
 * @param {string} target
 * @returns {boolean} True when `target` is `root` or below it.
 */
function isInside(root, target) {
  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(target)
  if (resolvedTarget === resolvedRoot) return true
  return resolvedTarget.startsWith(resolvedRoot + path.sep)
}

/**
 * @param {string} name
 * @returns {string[]}
 */
function packageSegments(name) {
  return name.split('/').filter((segment) => segment !== '')
}

/**
 * @param {Record<string, any>} profile
 * @param {Record<string, any>} entry
 * @returns {string}
 */
function installedDirectory(profile, entry) {
  if (typeof entry.moduleDir === 'string' && entry.moduleDir !== '') return path.resolve(entry.moduleDir)
  const base = typeof profile.dir === 'string' ? profile.dir : process.cwd()
  return path.join(base, 'node_modules', ...packageSegments(String(entry.name)))
}

/**
 * @param {string} name
 * @returns {string} Filesystem-safe backup directory prefix.
 */
function backupName(name) {
  // `<stateDir>/backups/<name>@<stamp>/` — never let a scoped name create
  // nested path segments (Windows would happily build `@scope/pkg`).
  return name.replace(/^@/, '').replace(/[/\\:]/g, '__')
}

/**
 * @returns {string} Timestamp suitable for a directory name.
 */
function backupStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/**
 * Recursively measure a directory, bailing out early once the budget is
 * exceeded.
 *
 * @param {string} dir
 * @param {number} limitBytes
 * @returns {Promise<{size: number, tooBig: boolean}>}
 */
async function measureDirectory(dir, limitBytes) {
  let total = 0
  /** @type {string[]} */
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!entry.isFile()) continue
      try {
        total += (await stat(full)).size
      } catch {
        // Unreadable entries do not matter for the size guard.
      }
      if (total > limitBytes) return { size: total, tooBig: true }
    }
  }
  return { size: total, tooBig: false }
}

/**
 * @typedef {{
 *   backupDir: string,
 *   manifest: Record<string, any>,
 *   lockfileExisted: boolean,
 *   lockfileBackedUp: boolean,
 *   nodeModulesBackedUp: boolean,
 *   hadInstalledDirectory: boolean,
 *   installedDir: string
 * }} BackupState
 */

/**
 * Step 2: copy everything we may need to undo the update.
 *
 * @param {{
 *   profile: Record<string, any>,
 *   entry: Record<string, any>,
 *   name: string,
 *   stateDir: string,
 *   log: string[],
 *   report: (phase: string, message: string, progress?: number) => void
 * }} context
 * @returns {Promise<BackupState>}
 */
async function createBackup(context) {
  const { profile, entry, name, stateDir, log, report } = context
  const profileDir = profile.dir
  const manifestPath = typeof profile.manifestPath === 'string' && profile.manifestPath !== ''
    ? profile.manifestPath
    : path.join(profileDir, 'package.json')

  const manifest = await readJsonFile(manifestPath)
  if (!isRecord(manifest)) throw new UpdateFailure('unknown', '无法读取 profile 的 package.json，已取消更新')

  report('backup', `正在备份 ${name} 的安装信息`, 5)
  const backupDir = path.join(stateDir, 'backups', `${backupName(name)}@${backupStamp()}`)
  await mkdir(backupDir, { recursive: true })
  await copyFile(manifestPath, path.join(backupDir, 'package.json'))
  log.push(`已备份 package.json → ${backupDir}`)

  const lockfilePath = path.join(profileDir, 'pnpm-lock.yaml')
  const lockfileExisted = await fileExists(lockfilePath)
  let lockfileBackedUp = false
  if (lockfileExisted) {
    try {
      await copyFile(lockfilePath, path.join(backupDir, 'pnpm-lock.yaml'))
      lockfileBackedUp = true
      log.push('已备份 pnpm-lock.yaml')
    } catch (error) {
      throw new UpdateFailure('unknown', `备份 pnpm-lock.yaml 失败：${errorText(error)}`)
    }
  }

  const installedDir = installedDirectory(profile, entry)
  const hadInstalledDirectory = await isDirectory(installedDir)
  let nodeModulesBackedUp = false
  if (hadInstalledDirectory) {
    if (!isInside(profileDir, installedDir)) {
      log.push(`警告：${installedDir} 不在 profile 目录内，跳过 node_modules 备份`)
    } else {
      const measured = await measureDirectory(installedDir, BACKUP_SIZE_LIMIT_BYTES)
      if (measured.tooBig) {
        log.push(`警告：node_modules/${name} 超过 200MB，跳过目录备份（失败时仅回滚 manifest）`)
      } else {
        const destination = path.join(backupDir, 'node_modules', ...packageSegments(name))
        await mkdir(path.dirname(destination), { recursive: true })
        try {
          await cp(installedDir, destination, { recursive: true, force: true })
          nodeModulesBackedUp = true
          log.push(`已备份 node_modules/${name}（约 ${Math.round(measured.size / 1024)} KB）`)
        } catch (error) {
          throw new UpdateFailure('unknown', `备份 node_modules/${name} 失败：${errorText(error)}`)
        }
      }
    }
  }

  return {
    backupDir,
    manifest,
    lockfileExisted,
    lockfileBackedUp,
    nodeModulesBackedUp,
    hadInstalledDirectory,
    installedDir,
  }
}

/**
 * @param {string} target
 * @returns {Promise<boolean>}
 */
async function fileExists(target) {
  try {
    const info = await stat(target)
    return info.isFile()
  } catch {
    return false
  }
}

/**
 * @param {string} target
 * @returns {Promise<boolean>}
 */
async function isDirectory(target) {
  try {
    return (await stat(target)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Step 3/4: environment for the package manager, including the
 * `HTTPS_PROXY` → `npm_config_https_proxy` mapping (existing npm_config_* wins).
 *
 * @param {Record<string, string>} commandEnv
 * @returns {Record<string, string>}
 */
function buildInstallEnv(commandEnv) {
  /** @type {Record<string, string>} */
  const env = { ...process.env, ...commandEnv, CI: 'true', npm_config_confirm_modules_purge: 'false' }
  const hasKey = (key) => Object.keys(env).some((existing) => existing.toLowerCase() === key.toLowerCase())
  const read = (...keys) => {
    for (const key of keys) {
      const value = env[key]
      if (typeof value === 'string' && value.trim() !== '') return value
    }
    return undefined
  }

  if (!hasKey('npm_config_https_proxy')) {
    const value = read('HTTPS_PROXY', 'https_proxy')
    if (value !== undefined) env.npm_config_https_proxy = value
  }
  if (!hasKey('npm_config_proxy')) {
    const value = read('HTTP_PROXY', 'http_proxy')
    if (value !== undefined) env.npm_config_proxy = value
  }
  if (!hasKey('npm_config_noproxy')) {
    const value = read('NO_PROXY', 'no_proxy')
    if (value !== undefined) env.npm_config_noproxy = value
  }
  return env
}

/**
 * Classify a pnpm failure from its captured output.
 *
 * Exported for unit tests and diagnostics only; the plugin API is
 * `runUpdate` (see contract §3.5). Tests assert the mapping directly
 * because spawning a real package manager is not available in every
 * environment (and the regex table is the part that needs coverage).
 *
 * @param {string} output
 * @returns {{class: string, hint: string, tail: string}|null}
 */
export function classifyPnpmFailure(output) {
  if (typeof output !== 'string' || output.trim() === '') return null
  for (const rule of PNPM_FAILURE_RULES) {
    if (!rule.pattern.test(output)) continue
    return {
      class: rule.class,
      hint: rule.hint,
      tail: output.slice(-OUTPUT_TAIL_CHARS),
    }
  }
  return { class: 'unknown', hint: '包管理器执行失败，请查看日志', tail: output.slice(-OUTPUT_TAIL_CHARS) }
}

/**
 * Build the `error.detail` string for a pnpm failure (`<class>: <hint>` plus
 * the captured output tail). Exported alongside `classifyPnpmFailure` for
 * unit tests / diagnostics.
 *
 * @param {string} output
 * @returns {string|undefined}
 */
export function failureDetail(output) {
  const classified = classifyPnpmFailure(output)
  if (classified === null) return undefined
  return `${classified.class}: ${classified.hint}\n${classified.tail}`
}

const CMD_METACHARS = /[\s"&|<>^()%!]/

/**
 * Quote one argument for a `cmd.exe /c` command line (mirrors dshmarket's
 * dsh-cli.js helper).
 * @param {string} arg
 * @returns {string}
 */
function quoteCmdArg(arg) {
  return CMD_METACHARS.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg
}

/**
 * @param {string[]} argv
 * @returns {string}
 */
function cmdCommandLine(argv) {
  return argv.map(quoteCmdArg).join(' ')
}

/**
 * @param {string} command
 * @param {string[]} args
 * @returns {{file: string, args: string[], verbatim: boolean}}
 */
function spawnSpec(command, args) {
  if (process.platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(command)) {
    return { file: command, args, verbatim: false }
  }
  const comspec = process.env.ComSpec ?? 'cmd.exe'
  return {
    file: comspec,
    args: ['/d', '/s', '/c', `"${cmdCommandLine([command, ...args])}"`],
    verbatim: true,
  }
}

/**
 * Kill a process tree. pnpm spawns children that hold file locks on Windows;
 * killing only the parent leaves them behind.
 *
 * @param {import('node:child_process').ChildProcess} child
 */
function killTree(child) {
  if (child === null || child === undefined || child.pid === undefined) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
        .once('error', () => {})
    } catch {
      // Nothing else we can do.
    }
    return
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    try {
      child.kill('SIGTERM')
    } catch {
      // Already gone.
    }
  }
  const force = setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }, 5000)
  if (typeof force.unref === 'function') force.unref()
}

/**
 * @typedef {{
 *   code: number|null,
 *   stdout: string,
 *   stderr: string,
 *   timedOut: boolean,
 *   aborted: boolean,
 *   error: Error|null
 * }} SpawnResult
 */

/**
 * @param {{
 *   command: string,
 *   args: string[],
 *   cwd: string,
 *   env: Record<string, string|undefined>,
 *   timeoutMs: number,
 *   signal: AbortSignal|null
 * }} options
 * @returns {Promise<SpawnResult>}
 */
function spawnWithCapture(options) {
  return new Promise((resolve) => {
    const spec = spawnSpec(options.command, options.args)
    /** @type {SpawnResult} */
    const result = { code: null, stdout: '', stderr: '', timedOut: false, aborted: false, error: null }
    let child
    try {
      child = spawn(spec.file, spec.args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: spec.verbatim,
        detached: process.platform !== 'win32',
      })
    } catch (error) {
      result.error = error instanceof Error ? error : new Error(String(error))
      resolve(result)
      return
    }

    let settled = false
    /** @type {NodeJS.Timeout|null} */
    let timer = null
    /** @type {NodeJS.Timeout|null} */
    let killTimer = null
    const onAbort = () => {
      result.aborted = true
      killTree(child)
    }
    const cleanup = () => {
      if (timer !== null) clearTimeout(timer)
      if (killTimer !== null) clearTimeout(killTimer)
      if (options.signal) options.signal.removeEventListener('abort', onAbort)
    }
    const finish = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }
    const append = (target, chunk) => {
      const text = chunk.toString('utf8')
      if (target === 'stdout') {
        if (result.stdout.length < OUTPUT_CAPTURE_LIMIT) result.stdout += text
      } else if (result.stderr.length < OUTPUT_CAPTURE_LIMIT) {
        result.stderr += text
      }
    }

    if (child.stdout !== null) child.stdout.on('data', (chunk) => append('stdout', chunk))
    if (child.stderr !== null) child.stderr.on('data', (chunk) => append('stderr', chunk))
    child.once('error', (error) => {
      result.error = error
      finish()
    })
    child.once('close', (code) => {
      result.code = typeof code === 'number' ? code : null
      finish()
    })

    timer = setTimeout(() => {
      result.timedOut = true
      killTree(child)
      killTimer = setTimeout(finish, 5000)
      if (typeof killTimer.unref === 'function') killTimer.unref()
    }, options.timeoutMs)

    if (options.signal) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/**
 * @param {Record<string, any>|null} value
 * @returns {{command: string, args: string[], env: Record<string, string>}|null}
 */
function normalizeProvidedPackageManager(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') {
    const command = value.trim()
    return command === '' ? null : { command, args: [], env: {} }
  }
  if (!isRecord(value)) return null
  const command = [value.command, value.executable, value.bin, value.cmd]
    .find((item) => typeof item === 'string' && item.trim() !== '')
  if (typeof command !== 'string') return null
  const args = Array.isArray(value.args)
    ? value.args.filter((item) => typeof item === 'string')
    : Array.isArray(value.baseArgs) ? value.baseArgs.filter((item) => typeof item === 'string') : []
  /** @type {Record<string, string>} */
  const env = {}
  const rawEnv = isRecord(value.env)
    ? value.env
    : isRecord(value.environment) ? value.environment : isRecord(value.commandsEnv) ? value.commandsEnv : {}
  for (const [key, item] of Object.entries(rawEnv)) {
    if (typeof item === 'string') env[key] = item
  }
  return { command: command.trim(), args, env }
}

/**
 * Step 3: profile-provided manager first, then pnpm on PATH, then corepack.
 *
 * @param {Record<string, any>} profile
 * @param {string[]} log
 * @returns {Promise<{command: string, args: string[], env: Record<string, string>, source: string}|null>}
 */
async function resolvePackageManager(profile, log) {
  const provided = normalizeProvidedPackageManager(profile.packageManager)
  if (provided !== null) {
    log.push(`使用 profile 提供的包管理器：${provided.command}`)
    return { ...provided, source: 'profile' }
  }

  const candidates = process.platform === 'win32'
    ? [
        { command: 'pnpm.cmd', args: [] },
        { command: 'pnpm', args: [] },
        { command: 'corepack.cmd', args: ['pnpm'] },
        { command: 'corepack', args: ['pnpm'] },
        { command: 'corepack.cmd', args: ['pnpm@11'] },
        { command: 'corepack', args: ['pnpm@11'] },
      ]
    : [
        { command: 'pnpm', args: [] },
        { command: 'corepack', args: ['pnpm'] },
        { command: 'corepack', args: ['pnpm@11'] },
      ]

  for (const candidate of candidates) {
    const probe = await spawnWithCapture({
      command: candidate.command,
      args: [...candidate.args, '--version'],
      cwd: typeof profile.dir === 'string' ? profile.dir : process.cwd(),
      env: { ...process.env },
      timeoutMs: 10 * 1000,
      signal: null,
    })
    if (probe.error !== null || probe.timedOut || probe.aborted) continue
    if (probe.code !== 0) continue
    const version = probe.stdout.trim().split(/\s+/).pop() ?? ''
    log.push(`检测到包管理器：${candidate.command}${candidate.args.length > 0 ? ` ${candidate.args.join(' ')}` : ''}（${version || '版本未知'}）`)
    return { command: candidate.command, args: candidate.args, env: {}, source: 'probe' }
  }
  return null
}

/**
 * @param {Record<string, any>} profile
 * @param {Record<string, any>} entry
 * @param {string} version
 * @returns {Promise<void>}
 */
async function updateProfileDependency(profile, entry, version) {
  const manifestPath = typeof profile.manifestPath === 'string' && profile.manifestPath !== ''
    ? profile.manifestPath
    : path.join(profile.dir, 'package.json')
  const manifest = await readJsonFile(manifestPath)
  if (!isRecord(manifest)) throw new UpdateFailure('install-failed', '安装后无法读取 profile 的 package.json')
  const dependencies = isRecord(manifest.dependencies) ? manifest.dependencies : {}
  dependencies[entry.name] = version
  manifest.dependencies = dependencies
  await writeJsonFile(manifestPath, manifest)
}

/**
 * In-process stand-in for pnpm, enabled only through `DSH_UPDATER_FAKE_PM`.
 *
 * @param {'success'|'mismatch'|'fail'} mode
 * @param {{profile: Record<string, any>, entry: Record<string, any>, target: Record<string, any>, log: string[]}} context
 * @returns {Promise<void>}
 */
async function simulateInstall(mode, context) {
  const { profile, entry, target, log } = context
  const targetVersion = target.version
  const dir = installedDirectory(profile, entry)
  const manifestPath = path.join(dir, 'package.json')
  const existing = await readJsonFile(manifestPath)
  const base = isRecord(existing)
    ? existing
    : isRecord(entry.manifest) ? entry.manifest : { name: entry.name, version: entry.installedVersion ?? '0.0.0' }

  const writeInstalled = async (version) => {
    await mkdir(dir, { recursive: true })
    const manifest = { ...base, name: typeof base.name === 'string' ? base.name : entry.name, version }
    await writeJsonFile(manifestPath, manifest)
  }

  if (mode === 'fail') {
    await writeInstalled('0.0.0-fake')
    await updateProfileDependency(profile, entry, targetVersion)
    log.push(`模拟安装失败：${entry.name}@${targetVersion}`)
    throw new UpdateFailure('install-failed', `安装失败（模拟）：${entry.name}@${targetVersion} 安装未完成`, 'fake-pm: 模拟 pnpm 非零退出')
  }

  if (mode === 'mismatch') {
    await writeInstalled('0.0.0-mismatch')
    await updateProfileDependency(profile, entry, targetVersion)
    log.push(`模拟版本不符：期望 ${targetVersion}，写入 0.0.0-mismatch`)
    return
  }

  await writeInstalled(targetVersion)
  await updateProfileDependency(profile, entry, targetVersion)
  log.push(`模拟安装完成：${entry.name}@${targetVersion}`)
}

/**
 * Step 4: verify the result on disk.
 *
 * @param {{
 *   profile: Record<string, any>,
 *   entry: Record<string, any>,
 *   target: Record<string, any>,
 *   runtimeVersion: string,
 *   backupManifest: Record<string, any>,
 *   allowIncompatible: boolean,
 *   log: string[]
 * }} context
 * @returns {Promise<{ok: true, version: string}|{ok: false, code: string, message: string, detail?: string}>}
 */
async function verifyInstalledState(context) {
  const { profile, entry, target, runtimeVersion, backupManifest, allowIncompatible, log } = context
  const dir = installedDirectory(profile, entry)
  const installedManifest = await readJsonFile(path.join(dir, 'package.json'))
  const actualVersion = isRecord(installedManifest) && typeof installedManifest.version === 'string'
    ? installedManifest.version.trim()
    : null

  if (actualVersion === null || semver.eq(actualVersion, target.version) !== true) {
    return {
      ok: false,
      code: 'version-mismatch',
      message: `安装后版本不符：期望 ${target.version}，实际 ${actualVersion ?? '(未读到已安装版本)'}`,
      detail: actualVersion === null ? undefined : `expected=${target.version} actual=${actualVersion}`,
    }
  }

  if (typeof runtimeVersion === 'string' && runtimeVersion !== 'unknown' && semver.valid(runtimeVersion) !== null) {
    if (allowIncompatible !== true) {
      const compatibility = evaluateManifest(installedManifest, runtimeVersion)
      if (compatibility.compatible !== true) {
        return {
          ok: false,
          code: 'incompatible',
          message: `新版本与当前 DSH 运行时不兼容（${runtimeVersion}）：${describeUnmet(compatibility.unmet) || '请检查 engines.dsh / peerDependencies'}`,
          detail: JSON.stringify(compatibility.unmet),
        }
      }
    }
  } else {
    log.push('警告：无法判定运行时版本，跳过安装后的兼容性复核')
  }

  const currentManifest = await readJsonFile(
    typeof profile.manifestPath === 'string' && profile.manifestPath !== ''
      ? profile.manifestPath
      : path.join(profile.dir, 'package.json'),
  )
  if (!isRecord(currentManifest)) {
    return { ok: false, code: 'manifest-mutated', message: '安装后无法读取 profile 的 package.json' }
  }
  if (!sameProfileManifestExceptPackage(backupManifest, currentManifest, entry.name)) {
    return {
      ok: false,
      code: 'manifest-mutated',
      message: `安装过程改动了 profile package.json 中 ${entry.name} 以外的内容，已回滚`,
      detail: 'profile manifest changed beyond the target dependency',
    }
  }

  return { ok: true, version: actualVersion }
}

/**
 * Deep structural equality that ignores property insertion order.
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
function sameJson(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function canonical(value) {
  if (Array.isArray(value)) return value.map((item) => canonical(item))
  if (isRecord(value)) {
    /** @type {Record<string, unknown>} */
    const sorted = {}
    for (const key of Object.keys(value).sort()) sorted[key] = canonical(value[key])
    return sorted
  }
  return value
}

/**
 * @param {Record<string, any>} manifest
 * @param {string} name
 * @returns {Record<string, any>}
 */
function manifestWithoutTargetDependency(manifest, name) {
  const clone = JSON.parse(JSON.stringify(manifest))
  if (isRecord(clone.dependencies)) delete clone.dependencies[name]
  return clone
}

/**
 * The profile manifest must only change in `dependencies[<pkg>]`; the
 * `dsh.profile.bundles` array has to stay literally the same.
 *
 * @param {Record<string, any>} before
 * @param {Record<string, any>} after
 * @param {string} name
 * @returns {boolean}
 */
function sameProfileManifestExceptPackage(before, after, name) {
  if (!sameJson(manifestWithoutTargetDependency(before, name), manifestWithoutTargetDependency(after, name))) {
    return false
  }
  const bundlesBefore = isRecord(before.dsh) && isRecord(before.dsh.profile) ? before.dsh.profile.bundles : undefined
  const bundlesAfter = isRecord(after.dsh) && isRecord(after.dsh.profile) ? after.dsh.profile.bundles : undefined
  return sameJson(bundlesBefore, bundlesAfter)
}

/**
 * Step 5: restore the backup. Returns false when the restored package.json no
 * longer matches the backup byte-for-byte.
 *
 * @param {{
 *   profile: Record<string, any>,
 *   entry: Record<string, any>,
 *   backup: BackupState,
 *   log: string[]
 * }} context
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function rollback(context) {
  const { profile, entry, backup, log } = context
  const manifestPath = typeof profile.manifestPath === 'string' && profile.manifestPath !== ''
    ? profile.manifestPath
    : path.join(profile.dir, 'package.json')
  try {
    log.push('回滚：恢复 package.json')
    await copyFile(path.join(backup.backupDir, 'package.json'), manifestPath)

    const lockfilePath = path.join(profile.dir, 'pnpm-lock.yaml')
    if (backup.lockfileBackedUp) {
      log.push('回滚：恢复 pnpm-lock.yaml')
      await copyFile(path.join(backup.backupDir, 'pnpm-lock.yaml'), lockfilePath)
    } else if (!backup.lockfileExisted) {
      await rm(lockfilePath, { force: true })
    }

    if (backup.nodeModulesBackedUp) {
      log.push(`回滚：恢复 node_modules/${entry.name}`)
      const source = path.join(backup.backupDir, 'node_modules', ...packageSegments(entry.name))
      if (isInside(profile.dir, backup.installedDir)) {
        await rm(backup.installedDir, { recursive: true, force: true })
        await cp(source, backup.installedDir, { recursive: true, force: true })
      } else {
        log.push(`警告：${backup.installedDir} 不在 profile 目录内，跳过 node_modules 恢复`)
      }
    } else if (!backup.hadInstalledDirectory && isInside(profile.dir, backup.installedDir)) {
      await rm(backup.installedDir, { recursive: true, force: true })
    }

    const restored = await readFile(manifestPath)
    const expected = await readFile(path.join(backup.backupDir, 'package.json'))
    if (!restored.equals(expected)) {
      return { ok: false, error: '回滚后 package.json 与备份不一致' }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: errorText(error) }
  }
}

/**
 * @param {string|undefined} value
 * @returns {'success'|'mismatch'|'fail'|null}
 */
function readFakeMode(value) {
  const mode = typeof value === 'string' ? value.trim() : ''
  return mode === 'success' || mode === 'mismatch' || mode === 'fail' ? mode : null
}

/**
 * @typedef {{
 *   ok: boolean,
 *   name: string,
 *   fromVersion: string|null,
 *   toVersion: string|null,
 *   needsRestart: boolean,
 *   rolledBack: boolean,
 *   durationMs: number,
 *   backupDir: string|null,
 *   packageManager: {command: string, args: string[]}|null,
 *   error: null|{code: string, message: string, detail?: string},
 *   log: string[]
 * }} UpdateResult
 */

/**
 * Run one atomic package update.
 *
 * @param {{
 *   profile: Record<string, any>,
 *   entry: Record<string, any>,
 *   target: {version: string, installSpec?: string|null, installKind?: string|null},
 *   runtimeVersion?: string,
 *   stateDir?: string,
 *   signal?: AbortSignal|null,
 *   onProgress?: ((step: {phase: string, message: string, progress?: number}) => void)|null,
 *   timeoutMs?: number,
 *   allowIncompatible?: boolean
 * }} options
 * @returns {Promise<UpdateResult>}
 */
export async function runUpdate(options) {
  const startedAt = Date.now()
  /** @type {string[]} */
  const log = []
  const input = isRecord(options) ? options : {}
  const profile = isRecord(input.profile) ? input.profile : {}
  const entry = isRecord(input.entry) ? input.entry : {}
  const target = isRecord(input.target) ? input.target : {}
  const name = typeof entry.name === 'string' ? entry.name : ''
  const targetVersion = typeof target.version === 'string' ? target.version.trim() : ''
  const fromVersion = typeof entry.installedVersion === 'string' && entry.installedVersion.trim() !== ''
    ? entry.installedVersion.trim()
    : null
  const runtimeVersion = typeof input.runtimeVersion === 'string'
    ? input.runtimeVersion
    : typeof profile.runtimeVersion === 'string' ? profile.runtimeVersion : 'unknown'
  const signal = input.signal instanceof AbortSignal ? input.signal : null
  const allowIncompatible = input.allowIncompatible === true
  const timeoutMs = Number.isFinite(input.timeoutMs) && input.timeoutMs > 0 ? Math.floor(input.timeoutMs) : DEFAULT_TIMEOUT_MS

  const report = (phase, message, progress) => {
    if (typeof input.onProgress !== 'function') return
    try {
      input.onProgress({ phase, message, progress })
    } catch {
      // A broken UI callback must not break the update.
    }
  }

  /** @param {string} code @param {string} message @param {Partial<UpdateResult>} [overrides] */
  const failure = (code, message, overrides = {}) => {
    const { detail, ...rest } = overrides
    /** @type {{code: string, message: string, detail?: string}} */
    const error = { code, message }
    if (typeof detail === 'string' && detail !== '') error.detail = detail
    const result = {
      ok: false,
      name,
      fromVersion,
      toVersion: targetVersion !== '' ? targetVersion : null,
      needsRestart: false,
      rolledBack: false,
      durationMs: Date.now() - startedAt,
      backupDir: null,
      packageManager: null,
      error,
      log,
      ...rest,
    }
    return result
  }

  if (PACKAGE_NAME_PATTERN.test(name) !== true) {
    log.push(`参数校验失败：包名不合法（${name || '空'}）`)
    return failure('unknown', `无效的包名：${name || '(空)'}`)
  }
  if (VERSION_PATTERN.test(targetVersion) !== true) {
    log.push(`参数校验失败：目标版本不合法（${targetVersion || '空'}）`)
    return failure('unknown', `无效的目标版本：${targetVersion || '(空)'}`)
  }
  if (typeof profile.dir !== 'string' || profile.dir === '') {
    log.push('参数校验失败：profile 缺少目录信息')
    return failure('unknown', 'profile 缺少目录信息，无法执行更新')
  }

  if (signal !== null && signal.aborted) {
    log.push('更新开始前已收到取消请求，未做任何改动')
    return failure('cancelled', '更新已取消', { toVersion: null })
  }

  // Preflight: a source tarball requires pnpm to run `prepare`/build scripts,
  // which pnpm 12 rejects by default (ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED).
  // Fail fast instead of backing up and waiting for a doomed install.
  const requestedInstallSpec = typeof target.installSpec === 'string' ? target.installSpec : ''
  const requestedInstallKind = typeof target.installKind === 'string' ? target.installKind : ''
  const needsSourceBuild = requestedInstallKind === 'source-tarball'
    || (requestedInstallKind === '' && requestedInstallSpec.startsWith('github:'))
  if (needsSourceBuild) {
    log.push('该版本只能从 GitHub 源码安装，pnpm 12 默认拒绝执行其构建脚本，已在安装前中止')
    return failure('github-source-needs-build', GITHUB_SOURCE_NEEDS_BUILD_MESSAGE)
  }

  const stateDirPath = typeof input.stateDir === 'string' && input.stateDir !== ''
    ? input.stateDir
    : defaultStateDir({ dshHome: profile.dshHome, profileDir: profile.dir })

  log.push(`开始更新 ${name}：${fromVersion ?? '未安装'} → ${targetVersion}`)

  /** @type {BackupState} */
  let backup
  try {
    backup = await createBackup({ profile, entry, name, stateDir: stateDirPath, log, report })
  } catch (error) {
    const code = error instanceof UpdateFailure ? error.code : 'unknown'
    const message = error instanceof UpdateFailure ? error.message : `备份失败：${errorText(error)}`
    log.push(message)
    return failure(code, message, { toVersion: null })
  }

  report('install', `准备安装 ${name}@${targetVersion}`, 20)

  const fakeMode = readFakeMode(process.env.DSH_UPDATER_FAKE_PM)
  /** @type {{command: string, args: string[], env: Record<string, string>, source: string}|null} */
  let packageManager = null

  if (fakeMode === null) {
    packageManager = await resolvePackageManager(profile, log)
    if (packageManager === null) {
      const message = '找不到可用的包管理器（pnpm / corepack pnpm）。请先安装 pnpm，或完全退出 DSH 桌面版后重试；详见插件 README 的安装说明。'
      log.push(message)
      return failure('spawn-failed', message, { backupDir: backup.backupDir })
    }
  }

  const installSpec = typeof target.installSpec === 'string' && target.installSpec !== ''
    ? target.installSpec
    : `${name}@${targetVersion}`

  /** @type {UpdateFailure|null} */
  let installFailure = null
  try {
    if (fakeMode !== null) {
      await simulateInstall(fakeMode, { profile, entry, target, log })
      log.push(`已通过测试钩子模拟安装（${fakeMode}）`)
    } else {
      const args = [...packageManager.args, 'add', installSpec, '--save-exact', '--reporter=append-only']
      log.push(`执行：${packageManager.command} ${args.join(' ')}`)
      report('install', `正在安装 ${name}@${targetVersion}`, 30)
      const spawnResult = await spawnWithCapture({
        command: packageManager.command,
        args,
        cwd: profile.dir,
        env: buildInstallEnv(packageManager.env),
        timeoutMs,
        signal,
      })
      const combinedOutput = `${spawnResult.stdout}\n${spawnResult.stderr}`.trim()
      if (combinedOutput !== '') log.push(`包管理器输出（尾部）：${combinedOutput.slice(-OUTPUT_TAIL_CHARS)}`)

      if (spawnResult.aborted) {
        installFailure = new UpdateFailure('cancelled', '更新已取消（安装进程已终止）')
      } else if (spawnResult.timedOut) {
        installFailure = new UpdateFailure('timeout', `安装超时（${Math.round(timeoutMs / 1000)} 秒），已终止安装进程`)
      } else if (spawnResult.error !== null) {
        installFailure = new UpdateFailure(
          'spawn-failed',
          `无法启动包管理器：${errorText(spawnResult.error)}`,
          failureDetail(combinedOutput),
        )
      } else if (spawnResult.code !== 0) {
        const detail = failureDetail(combinedOutput)
        const classified = classifyPnpmFailure(combinedOutput)
        const suffix = classified === null ? '' : `（${classified.class}：${classified.hint}）`
        installFailure = new UpdateFailure(
          'install-failed',
          `安装失败：包管理器退出码 ${spawnResult.code}${suffix}`,
          detail,
        )
      }
    }
  } catch (error) {
    installFailure = error instanceof UpdateFailure
      ? error
      : new UpdateFailure('install-failed', `安装失败：${errorText(error)}`)
  }

  if (installFailure !== null) {
    log.push(installFailure.message)
    report('rollback', '安装失败，正在回滚', 60)
    const restored = await rollback({ profile, entry, backup, log })
    if (!restored.ok) {
      const message = `回滚失败：${restored.error ?? '未知错误'}。备份保留在 ${backup.backupDir}`
      log.push(message)
      return failure('rollback-failed', message, {
        backupDir: backup.backupDir,
        rolledBack: true,
        detail: installFailure.detail,
        packageManager: packageManager === null ? null : { command: packageManager.command, args: packageManager.args },
      })
    }
    log.push('回滚完成，profile 已恢复')
    return failure(installFailure.code, installFailure.message, {
      backupDir: backup.backupDir,
      rolledBack: true,
      detail: installFailure.detail,
      packageManager: packageManager === null ? null : { command: packageManager.command, args: packageManager.args },
    })
  }

  report('verify', '正在校验安装结果', 80)
  const verification = await verifyInstalledState({
    profile,
    entry,
    target,
    runtimeVersion,
    backupManifest: backup.manifest,
    allowIncompatible,
    log,
  })

  if (verification.ok !== true) {
    log.push(verification.message)
    report('rollback', '校验失败，正在回滚', 70)
    const restored = await rollback({ profile, entry, backup, log })
    if (!restored.ok) {
      const message = `回滚失败：${restored.error ?? '未知错误'}。备份保留在 ${backup.backupDir}`
      log.push(message)
      return failure('rollback-failed', message, {
        backupDir: backup.backupDir,
        rolledBack: true,
        detail: verification.detail,
        packageManager: packageManager === null ? null : { command: packageManager.command, args: packageManager.args },
      })
    }
    log.push('回滚完成，profile 已恢复')
    return failure(verification.code, verification.message, {
      backupDir: backup.backupDir,
      rolledBack: true,
      detail: verification.detail,
      packageManager: packageManager === null ? null : { command: packageManager.command, args: packageManager.args },
    })
  }

  log.push(`校验通过：${name}@${verification.version} 已安装，profile manifest 未被影响`)
  report('done', `${name} 已更新到 ${verification.version}`, 100)
  return {
    ok: true,
    name,
    fromVersion,
    toVersion: verification.version,
    needsRestart: true,
    rolledBack: false,
    durationMs: Date.now() - startedAt,
    backupDir: backup.backupDir,
    packageManager: packageManager === null ? null : { command: packageManager.command, args: packageManager.args },
    error: null,
    log,
  }
}
