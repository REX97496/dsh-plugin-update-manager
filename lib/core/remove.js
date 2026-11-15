/**
 * Uninstall / reinstall of a registry plugin from the active profile.
 *
 * Both operations follow the same safety model as `update.js`:
 *
 *   backup → run the profile's package manager → verify the result on disk →
 *   restore the backup byte for byte on any failure.
 *
 * Uninstall additionally removes the loader bundle entry from
 * `dsh.profile.bundles`; reinstall keeps that array untouched for the whole
 * operation, so a failed reinstall can never lose the plugin from the loader
 * config.
 */

import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import * as semver from './semver.js'
import { runUpdate } from './update.js'

/** The plugin never removes itself: doing so would delete the running code. */
const SELF_NAME = 'dsh-plugin-update-manager'

/** Same validation as update.js / index.js routes. */
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** Default budget for one package-manager invocation. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

/** Bounded capture so a pathological pnpm run cannot exhaust memory. */
const OUTPUT_CAPTURE_LIMIT = 200 * 1024

/** Backups larger than this are skipped (rollback then only restores the manifest). */
const MAX_BACKUP_BYTES = 200 * 1024 * 1024

/**
 * @typedef {{
 *   ok: boolean,
 *   name: string,
 *   fromVersion: string|null,
 *   needsRestart: boolean,
 *   rolledBack: boolean,
 *   durationMs: number,
 *   backupDir: string|null,
 *   packageManager: {command: string, args: string[]}|null,
 *   error: {code: string, message: string, detail?: string}|null,
 *   log: string[]
 * }} RemoveResult
 */

/**
 * @typedef {RemoveResult & { toVersion: string|null }} ReinstallResult
 */

class RemoveFailure extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {string} [detail]
   */
  constructor(code, message, detail = undefined) {
    super(message)
    this.name = 'RemoveFailure'
    this.code = code
    this.detail = detail
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {string} file
 * @returns {Promise<boolean>}
 */
async function fileExists(file) {
  try {
    const stats = await fs.stat(file)
    return stats.isFile()
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
    const stats = await fs.stat(target)
    return stats.isDirectory()
  } catch {
    return false
  }
}

/**
 * @param {string} file
 * @returns {Promise<any>}
 */
async function readJsonFile(file) {
  const text = await fs.readFile(file, 'utf8')
  return JSON.parse(text)
}

/**
 * @param {string} file
 * @param {any} value
 * @returns {Promise<void>}
 */
async function writeJsonFile(file, value) {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/**
 * Recursively measure a directory, stopping once `limitBytes` is exceeded.
 *
 * @param {string} dir
 * @param {number} limitBytes
 * @returns {Promise<number>}
 */
async function measureDirectory(dir, limitBytes) {
  let total = 0
  /** @type {string[]} */
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) break
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      try {
        const stats = await fs.lstat(full)
        total += stats.size
      } catch {
        // Unreadable entries do not contribute.
      }
      if (total > limitBytes) return total
    }
  }
  return total
}

/**
 * @param {string} source
 * @param {string} destination
 * @returns {Promise<void>}
 */
async function copyDirectory(source, destination) {
  await fs.rm(destination, { recursive: true, force: true })
  await fs.cp(source, destination, { recursive: true, force: true, dereference: true })
}

/**
 * Filesystem-safe backup directory name for a package (same rules as update.js).
 *
 * @param {string} name
 * @returns {string}
 */
function backupName(name) {
  return name.replace(/^@/, '').replace(/[/\\:]/g, '__')
}

/**
 * @returns {string}
 */
function backupStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/**
 * @param {Record<string, any>} profile
 * @returns {string}
 */
function manifestPathOf(profile) {
  return typeof profile.manifestPath === 'string' && profile.manifestPath !== ''
    ? profile.manifestPath
    : path.join(String(profile.dir), 'package.json')
}

/**
 * @param {Record<string, any>} profile
 * @param {string} name
 * @returns {string}
 */
function installedDirectory(profile, name) {
  return path.join(String(profile.dir), 'node_modules', ...name.split('/'))
}

const CMD_METACHARS = /[\s"&|<>^()%!]/

/**
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
 * Kill a whole process tree: pnpm children keep Windows file locks alive.
 *
 * @param {import('node:child_process').ChildProcess} child
 */
function killTree(child) {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.once('error', () => {})
    } catch {
      // Best effort.
    }
    return
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    // Already gone.
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
  return new Promise(resolve => {
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
      if (result[target].length >= OUTPUT_CAPTURE_LIMIT) return
      result[target] += text
    }

    if (child.stdout !== null) child.stdout.on('data', chunk => append('stdout', chunk))
    if (child.stderr !== null) child.stderr.on('data', chunk => append('stderr', chunk))
    child.once('error', error => {
      result.error = error
      finish()
    })
    child.once('close', code => {
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
 * Environment for the package manager, incl. the proxy → npm_config_* mapping.
 *
 * @param {Record<string, string>} commandEnv
 * @returns {Record<string, string>}
 */
function buildInstallEnv(commandEnv) {
  /** @type {Record<string, string>} */
  const env = { ...process.env, ...commandEnv, CI: 'true', npm_config_confirm_modules_purge: 'false' }
  const hasKey = key => Object.keys(env).some(existing => existing.toLowerCase() === key.toLowerCase())
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
    .find(item => typeof item === 'string' && item.trim() !== '')
  if (typeof command !== 'string') return null
  const args = Array.isArray(value.args)
    ? value.args.filter(item => typeof item === 'string')
    : Array.isArray(value.baseArgs) ? value.baseArgs.filter(item => typeof item === 'string') : []
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
 * profile-provided manager first, then pnpm on PATH, then corepack.
 *
 * @param {Record<string, any>} profile
 * @param {string[]} log
 * @returns {Promise<{command: string, args: string[], env: Record<string, string>}|null>}
 */
async function resolvePackageManager(profile, log) {
  const provided = normalizeProvidedPackageManager(profile.packageManager)
  if (provided !== null) {
    log.push(`使用 profile 提供的包管理器：${provided.command}`)
    return provided
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
    if (probe.error !== null || probe.timedOut || probe.aborted || probe.code !== 0) continue
    const version = probe.stdout.trim().split(/\s+/).pop() ?? ''
    log.push(`检测到包管理器：${candidate.command} ${candidate.args.join(' ')} ${version}`.trim())
    return { command: candidate.command, args: candidate.args, env: {} }
  }
  return null
}

/**
 * The `DSH_UPDATER_FAKE_PM` test hook. `'mismatch'` only means something for
 * an install, so for uninstall it behaves like `'success'`.
 *
 * @returns {'success'|'fail'|null}
 */
function readFakeMode() {
  const value = process.env.DSH_UPDATER_FAKE_PM
  return value === 'success' || value === 'mismatch' ? 'success' : value === 'fail' ? 'fail' : null
}

/**
 * @param {string} code
 * @param {string} message
 * @param {{detail?: string, backupDir?: string|null, rolledBack?: boolean, packageManager?: {command: string, args: string[]}|null}} [overrides]
 * @returns {RemoveResult}
 */
function failure(code, message, overrides = {}) {
  const { detail, ...rest } = overrides
  /** @type {{code: string, message: string, detail?: string}} */
  const error = { code, message }
  if (typeof detail === 'string' && detail !== '') error.detail = detail
  return {
    ok: false,
    name: '',
    fromVersion: null,
    needsRestart: false,
    rolledBack: rest.rolledBack === true,
    durationMs: 0,
    backupDir: rest.backupDir ?? null,
    packageManager: rest.packageManager ?? null,
    error,
    log: [],
  }
}

/**
 * @param {Record<string, any>} profile
 * @param {Record<string, any>} entry
 * @param {string} stateDir
 * @param {string[]} log
 * @returns {Promise<{backupDir: string, manifest: any, lockfileExisted: boolean, lockfileBackedUp: boolean, nodeModulesBackedUp: boolean, installedDir: string}>}
 */
async function createBackup(profile, entry, stateDir, log) {
  const backupDir = path.join(stateDir, 'backups', `${backupName(String(entry.name))}@${backupStamp()}-uninstall`)
  await fs.mkdir(backupDir, { recursive: true })
  const manifestPath = manifestPathOf(profile)
  const manifest = await readJsonFile(manifestPath)
  await fs.copyFile(manifestPath, path.join(backupDir, 'package.json'))
  log.push(`备份 profile manifest：${manifestPath}`)

  const lockfile = path.join(String(profile.dir), 'pnpm-lock.yaml')
  const lockfileExisted = await fileExists(lockfile)
  let lockfileBackedUp = false
  if (lockfileExisted) {
    await fs.copyFile(lockfile, path.join(backupDir, 'pnpm-lock.yaml'))
    lockfileBackedUp = true
    log.push('备份 pnpm-lock.yaml')
  }

  const installedDir = installedDirectory(profile, String(entry.name))
  const installedExisted = await isDirectory(installedDir)
  let nodeModulesBackedUp = false
  if (installedExisted) {
    const size = await measureDirectory(installedDir, MAX_BACKUP_BYTES)
    if (size > MAX_BACKUP_BYTES) {
      log.push(`node_modules/${entry.name} 超过 200MB，跳过目录备份（只回滚 manifest）`)
    } else {
      await copyDirectory(installedDir, path.join(backupDir, 'node_modules', String(entry.name)))
      nodeModulesBackedUp = true
      log.push(`备份 node_modules/${entry.name}`)
    }
  }
  return { backupDir, manifest, lockfileExisted, lockfileBackedUp, nodeModulesBackedUp, installedDir }
}

/**
 * Restore a backup over the profile. Returns `true` when the manifest matches
 * the backup byte for byte after the restore.
 *
 * @param {Record<string, any>} profile
 * @param {Record<string, any>} entry
 * @param {{backupDir: string, lockfileExisted: boolean, lockfileBackedUp: boolean, nodeModulesBackedUp: boolean, installedDir: string}} backup
 * @param {string[]} log
 * @returns {Promise<boolean>}
 */
async function restoreBackup(profile, entry, backup, log) {
  const manifestPath = manifestPathOf(profile)
  try {
    await fs.copyFile(path.join(backup.backupDir, 'package.json'), manifestPath)
    const lockfile = path.join(String(profile.dir), 'pnpm-lock.yaml')
    if (backup.lockfileBackedUp) {
      await fs.copyFile(path.join(backup.backupDir, 'pnpm-lock.yaml'), lockfile)
    } else if (!backup.lockfileExisted) {
      await fs.rm(lockfile, { force: true })
    }
    if (backup.nodeModulesBackedUp) {
      await copyDirectory(path.join(backup.backupDir, 'node_modules', String(entry.name)), backup.installedDir)
    } else {
      await fs.rm(backup.installedDir, { recursive: true, force: true })
    }
    const restored = await fs.readFile(manifestPath)
    const expected = await fs.readFile(path.join(backup.backupDir, 'package.json'))
    const same = Buffer.compare(restored, expected) === 0
    log.push(same ? '已从备份恢复 profile' : '已从备份恢复，但 manifest 与备份不一致')
    return same
  } catch (error) {
    log.push(`回滚失败：${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/**
 * Remove one dependency entry from the profile manifest (in place).
 *
 * @param {Record<string, any>} manifest
 * @param {string} name
 */
function removeDependency(manifest, name) {
  if (isRecord(manifest.dependencies)) delete manifest.dependencies[name]
}

/**
 * Remove the loader bundle entries that belong to one package, keeping order.
 *
 * @param {Record<string, any>} manifest
 * @param {string} name
 * @param {string|null} bundleId
 * @returns {number}
 */
function removeBundles(manifest, name, bundleId) {
  const profileSection = isRecord(manifest.dsh) && isRecord(manifest.dsh.profile) ? manifest.dsh.profile : null
  if (profileSection === null || !Array.isArray(profileSection.bundles)) return 0
  const matches = value => {
    if (value === name) return true
    if (typeof bundleId !== 'string' || bundleId === '') return false
    if (value === bundleId) return true
    return isRecord(value) && (value.name === name || value.id === bundleId || value.name === bundleId)
  }
  const before = profileSection.bundles.length
  profileSection.bundles = profileSection.bundles.filter(value => !matches(value))
  return before - profileSection.bundles.length
}

/**
 * Run `pnpm remove` and verify it took effect. No backup/rollback here: callers
 * own the surrounding transaction.
 *
 * @param {{profile: Record<string, any>, entry: Record<string, any>, name: string, packageManager: {command: string, args: string[], env: Record<string, string>}, fakeMode: 'success'|'fail'|null, signal: AbortSignal|null, timeoutMs: number, log: string[], onProgress: ((step: {phase: string, message: string, progress?: number}) => void)|null}} context
 * @returns {Promise<{code: string|null, message: string, detail?: string}>}
 */
async function executeRemove(context) {
  const { profile, entry, name, packageManager, fakeMode, signal, timeoutMs, log, onProgress } = context
  const report = step => {
    if (typeof onProgress === 'function') onProgress(step)
  }
  const installedDir = installedDirectory(profile, name)
  const manifestPath = manifestPathOf(profile)

  report({ phase: 'remove', message: `正在卸载 ${name}`, progress: 40 })

  if (fakeMode !== null) {
    const manifest = await readJsonFile(manifestPath)
    if (!isRecord(manifest)) return { code: 'uninstall-failed', message: '无法读取 profile 的 package.json' }
    removeDependency(manifest, name)
    await writeJsonFile(manifestPath, manifest)
    await fs.rm(installedDir, { recursive: true, force: true })
    log.push(`模拟卸载${fakeMode === 'fail' ? '失败' : ''}：${name}`)
    if (fakeMode === 'fail') {
      return {
        code: 'uninstall-failed',
        message: `卸载失败（模拟）：${name} 未能从 profile 移除`,
        detail: 'fake-pm: 模拟 pnpm 非零退出',
      }
    }
    return { code: null, message: 'ok' }
  }

  const args = [...packageManager.args, 'remove', name, '--reporter=append-only']
  log.push(`执行：${packageManager.command} ${args.join(' ')}`)
  const spawnResult = await spawnWithCapture({
    command: packageManager.command,
    args,
    cwd: String(profile.dir),
    env: buildInstallEnv(packageManager.env),
    timeoutMs,
    signal,
  })
  const combinedOutput = `${spawnResult.stdout}\n${spawnResult.stderr}`.trim()
  if (combinedOutput !== '') log.push(`包管理器输出（尾部）：${combinedOutput.slice(-800)}`)

  if (spawnResult.aborted) return { code: 'cancelled', message: '已取消卸载' }
  if (spawnResult.timedOut) {
    return { code: 'uninstall-failed', message: `卸载超时（${Math.round(timeoutMs / 1000)} 秒），已终止包管理器` }
  }
  if (spawnResult.error !== null) {
    return {
      code: 'uninstall-failed',
      message: `无法启动包管理器：${spawnResult.error.message}`,
      detail: combinedOutput !== '' ? combinedOutput.slice(-4000) : undefined,
    }
  }
  if (spawnResult.code !== 0) {
    return {
      code: 'uninstall-failed',
      message: `卸载失败：包管理器退出码 ${spawnResult.code}`,
      detail: combinedOutput !== '' ? combinedOutput.slice(-4000) : undefined,
    }
  }

  // Read back: the dependency must be gone and the installed directory removed.
  let manifest
  try {
    manifest = await readJsonFile(manifestPath)
  } catch (error) {
    return { code: 'uninstall-failed', message: `卸载后无法读取 profile 的 package.json：${error instanceof Error ? error.message : String(error)}` }
  }
  const stillDepends = isRecord(manifest?.dependencies) && Object.hasOwn(manifest.dependencies, name)
  if (stillDepends) {
    return { code: 'uninstall-failed', message: '卸载后 profile 的 dependencies 里仍存在该插件' }
  }
  if (await isDirectory(installedDir)) {
    return { code: 'uninstall-failed', message: `卸载后 node_modules/${entry.name} 仍然存在` }
  }
  return { code: null, message: 'ok' }
}

/**
 * Uninstall one plugin from the profile, including its bundle entry.
 *
 * @param {{
 *   profile: Record<string, any>,
 *   entry: Record<string, any>,
 *   stateDir: string,
 *   signal?: AbortSignal|null,
 *   timeoutMs?: number,
 *   onProgress?: ((step: {phase: string, message: string, progress?: number}) => void)|null
 * }} options
 * @returns {Promise<RemoveResult>}
 */
export async function uninstallPlugin(options) {
  const startedAt = Date.now()
  const log = []
  const result = failure('uninstall-failed', '卸载失败')
  result.log = log
  const report = step => {
    if (typeof options.onProgress === 'function') options.onProgress(step)
  }
  const done = /** @type {RemoveResult} */ (result)
  const finish = patch => Object.assign(done, { durationMs: Date.now() - startedAt }, patch, {
    name: done.name,
    fromVersion: done.fromVersion,
  })

  if (typeof options.signal === 'object' && options.signal !== null && options.signal.aborted === true) {
    return finish(failure('cancelled', '已取消卸载', { rolledBack: false }))
  }

  const profile = options.profile
  const entry = options.entry
  const name = typeof entry?.name === 'string' ? entry.name : ''
  done.name = name
  done.fromVersion = typeof entry?.installedVersion === 'string' ? entry.installedVersion : null

  if (!isRecord(profile) || typeof profile.dir !== 'string' || profile.dir === '') {
    return finish(failure('uninstall-failed', 'profile 目录不可用'))
  }
  if (!PACKAGE_NAME_PATTERN.test(name)) return finish(failure('uninstall-failed', `包名非法：${name}`))
  if (name === SELF_NAME) return finish(failure('self-operation', '不能卸载更新管理器自己'))
  if (entry.kind === 'builtin' || entry.kind === 'local') {
    return finish(failure('not-managed', `${name} 是本地/内置插件，不能通过 npm 卸载`))
  }

  const stateDir = typeof options.stateDir === 'string' && options.stateDir !== '' ? options.stateDir : ''
  if (stateDir === '') return finish(failure('uninstall-failed', '状态目录不可用'))

  let packageManager = null
  let backup = null
  const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  try {
    report({ phase: 'backup', message: `正在备份 ${name}`, progress: 10 })
    backup = await createBackup(profile, entry, stateDir, log)

    packageManager = await resolvePackageManager(profile, log)
    if (packageManager === null) {
      return finish(failure('uninstall-failed', '没有找到可用的 pnpm：请查看 README 的安装说明，或让宿主提供包管理器', {
        backupDir: backup.backupDir,
      }))
    }
    done.packageManager = { command: packageManager.command, args: packageManager.args }

    const removal = await executeRemove({
      profile,
      entry,
      name,
      packageManager,
      fakeMode: readFakeMode(),
      signal: options.signal ?? null,
      timeoutMs,
      log,
      onProgress: options.onProgress ?? null,
    })

    if (removal.code !== null) {
      log.push(removal.message)
      report({ phase: 'rollback', message: '正在回滚', progress: 60 })
      const restored = await restoreBackup(profile, entry, backup, log)
      const message = restored
        ? removal.message
        : `回滚未完成：${removal.message}。备份保留在 ${backup.backupDir}`
      return finish(failure(removal.code, message, {
        detail: removal.detail,
        backupDir: backup.backupDir,
        rolledBack: true,
        packageManager: { command: packageManager.command, args: packageManager.args },
      }))
    }

    // Success: drop the loader bundle entry as well (keep every other entry/order).
    const manifestPath = manifestPathOf(profile)
    let manifest = await readJsonFile(manifestPath)
    if (!isRecord(manifest)) return finish(failure('uninstall-failed', '无法读取 profile 的 package.json', { backupDir: backup.backupDir }))
    const removedBundles = removeBundles(manifest, name, entry.bundleId ?? null)
    if (removedBundles > 0) await writeJsonFile(manifestPath, manifest)
    log.push(`已从 dsh.profile.bundles 移除 ${removedBundles} 条`)

    report({ phase: 'done', message: `${name} 已卸载，重启 DSH 后生效`, progress: 100 })
    return finish({
      ok: true,
      needsRestart: true,
      rolledBack: false,
      backupDir: backup.backupDir,
      error: null,
      packageManager: { command: packageManager.command, args: packageManager.args },
    })
  } catch (error) {
    log.push(`卸载异常：${error instanceof Error ? error.message : String(error)}`)
    if (backup !== null) {
      report({ phase: 'rollback', message: '正在回滚', progress: 60 })
      await restoreBackup(profile, entry, backup, log)
    }
    return finish(failure('uninstall-failed', `卸载失败：${error instanceof Error ? error.message : String(error)}`, {
      backupDir: backup?.backupDir ?? null,
      rolledBack: backup !== null,
      packageManager: packageManager === null ? null : { command: packageManager.command, args: packageManager.args },
    }))
  }
}

/**
 * Reinstall one plugin at a given (or the currently installed) version.
 *
 * Bundles stay untouched for the whole operation; any failure restores the
 * pre-reinstall snapshot (deps, lockfile, node_modules).
 *
 * @param {{
 *   profile: Record<string, any>,
 *   entry: Record<string, any>,
 *   version?: string|null,
 *   installSpec?: string|null,
 *   installKind?: string|null,
 *   stateDir: string,
 *   signal?: AbortSignal|null,
 *   timeoutMs?: number,
 *   onProgress?: ((step: {phase: string, message: string, progress?: number}) => void)|null
 * }} options
 * @returns {Promise<ReinstallResult>}
 */
export async function reinstallPlugin(options) {
  const startedAt = Date.now()
  const log = []
  /** @type {ReinstallResult} */
  const result = Object.assign(failure('reinstall-failed', '重新安装失败'), { toVersion: null })
  result.log = log
  const done = result
  const finish = patch => Object.assign(done, { durationMs: Date.now() - startedAt }, patch, {
    name: done.name,
    fromVersion: done.fromVersion,
  })

  if (typeof options.signal === 'object' && options.signal !== null && options.signal.aborted === true) {
    return finish(failure('cancelled', '已取消重新安装', { rolledBack: false }))
  }

  const profile = options.profile
  const entry = options.entry
  const name = typeof entry?.name === 'string' ? entry.name : ''
  done.name = name
  done.fromVersion = typeof entry?.installedVersion === 'string' ? entry.installedVersion : null
  const version = typeof options.version === 'string' && options.version !== ''
    ? options.version
    : done.fromVersion

  if (!isRecord(profile) || typeof profile.dir !== 'string' || profile.dir === '') {
    return finish(failure('reinstall-failed', 'profile 目录不可用'))
  }
  if (!PACKAGE_NAME_PATTERN.test(name)) return finish(failure('reinstall-failed', `包名非法：${name}`))
  if (name === SELF_NAME) return finish(failure('self-operation', '不能重新安装更新管理器自己'))
  if (entry.kind === 'builtin' || entry.kind === 'local') {
    return finish(failure('not-managed', `${name} 是本地/内置插件，不能通过 npm 重新安装`))
  }
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    return finish(failure('reinstall-failed', `版本号非法：${String(version)}`))
  }

  const stateDir = typeof options.stateDir === 'string' && options.stateDir !== '' ? options.stateDir : ''
  if (stateDir === '') return finish(failure('reinstall-failed', '状态目录不可用'))
  const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  const report = step => {
    if (typeof options.onProgress === 'function') options.onProgress(step)
  }

  let packageManager = null
  let backup = null
  try {
    report({ phase: 'backup', message: `正在备份 ${name}`, progress: 10 })
    backup = await createBackup(profile, entry, stateDir, log)
    const backupManifestText = await fs.readFile(path.join(backup.backupDir, 'package.json'), 'utf8')
    const backupManifest = JSON.parse(backupManifestText)
    const backupBundles = JSON.stringify(
      isRecord(backupManifest?.dsh) && isRecord(backupManifest.dsh.profile)
        ? backupManifest.dsh.profile.bundles ?? null
        : null,
    )

    packageManager = await resolvePackageManager(profile, log)
    if (packageManager === null) {
      return finish(failure('reinstall-failed', '没有找到可用的 pnpm：请查看 README 的安装说明，或让宿主提供包管理器', {
        backupDir: backup.backupDir,
      }))
    }
    done.packageManager = { command: packageManager.command, args: packageManager.args }

    // Step 1: remove the current copy without touching bundles.
    const removal = await executeRemove({
      profile,
      entry,
      name,
      packageManager,
      fakeMode: readFakeMode(),
      signal: options.signal ?? null,
      timeoutMs,
      log,
      onProgress: options.onProgress ?? null,
    })
    if (removal.code !== null) {
      log.push(removal.message)
      report({ phase: 'rollback', message: '正在回滚', progress: 60 })
      await restoreBackup(profile, entry, backup, log)
      return finish(failure('reinstall-failed', removal.message, {
        detail: removal.detail,
        backupDir: backup.backupDir,
        rolledBack: true,
        packageManager: { command: packageManager.command, args: packageManager.args },
      }))
    }

    // Step 2: install the same version through the update pipeline.
    const installSpec = typeof options.installSpec === 'string' && options.installSpec !== ''
      ? options.installSpec
      : `${name}@${version}`
    report({ phase: 'install', message: `正在重新安装 ${name}@${version}`, progress: 50 })
    const updateResult = await runUpdate({
      profile,
      entry,
      target: { version, installSpec, installKind: options.installKind ?? null },
      runtimeVersion: profile.runtimeVersion,
      stateDir,
      signal: options.signal ?? null,
      timeoutMs,
      allowIncompatible: true,
      onProgress: step => {
        if (typeof options.onProgress === 'function') {
          options.onProgress({ phase: `install-${step.phase}`, message: step.message, progress: step.progress })
        }
      },
    })
    for (const line of Array.isArray(updateResult.log) ? updateResult.log : []) log.push(line)

    if (!updateResult.ok) {
      log.push(updateResult.error?.message ?? '重新安装失败')
      report({ phase: 'rollback', message: '正在回滚', progress: 60 })
      await restoreBackup(profile, entry, backup, log)
      return finish(failure('reinstall-failed', updateResult.error?.message ?? '重新安装失败', {
        detail: updateResult.error?.detail,
        backupDir: backup.backupDir,
        rolledBack: true,
        packageManager: { command: packageManager.command, args: packageManager.args },
      }))
    }

    // Step 3: verify the exact version came back and bundles are untouched.
    let manifest = null
    try {
      manifest = await readJsonFile(manifestPathOf(profile))
    } catch {
      manifest = null
    }
    const bundlesNow = JSON.stringify(
      isRecord(manifest?.dsh) && isRecord(manifest.dsh.profile) ? manifest.dsh.profile.bundles ?? null : null,
    )
    if (bundlesNow !== backupBundles) {
      report({ phase: 'rollback', message: '正在回滚', progress: 60 })
      await restoreBackup(profile, entry, backup, log)
      return finish(failure('reinstall-failed', '重新安装后 dsh.profile.bundles 发生了变化', {
        backupDir: backup.backupDir,
        rolledBack: true,
        packageManager: { command: packageManager.command, args: packageManager.args },
      }))
    }
    if (typeof updateResult.toVersion !== 'string' || !semver.eq(updateResult.toVersion, version)) {
      report({ phase: 'rollback', message: '正在回滚', progress: 60 })
      await restoreBackup(profile, entry, backup, log)
      return finish(failure('reinstall-failed', `重新安装后版本不匹配：期望 ${version}，实际 ${String(updateResult.toVersion)}`, {
        backupDir: backup.backupDir,
        rolledBack: true,
        packageManager: { command: packageManager.command, args: packageManager.args },
      }))
    }

    report({ phase: 'done', message: `${name}@${version} 已重新安装，重启 DSH 后生效`, progress: 100 })
    return finish({
      ok: true,
      toVersion: updateResult.toVersion,
      needsRestart: true,
      rolledBack: false,
      backupDir: backup.backupDir,
      error: null,
      packageManager: { command: packageManager.command, args: packageManager.args },
    })
  } catch (error) {
    log.push(`重新安装异常：${error instanceof Error ? error.message : String(error)}`)
    if (backup !== null) {
      report({ phase: 'rollback', message: '正在回滚', progress: 60 })
      await restoreBackup(profile, entry, backup, log)
    }
    return finish(failure('reinstall-failed', `重新安装失败：${error instanceof Error ? error.message : String(error)}`, {
      backupDir: backup?.backupDir ?? null,
      rolledBack: backup !== null,
      packageManager: packageManager === null ? null : { command: packageManager.command, args: packageManager.args },
    }))
  }
}
