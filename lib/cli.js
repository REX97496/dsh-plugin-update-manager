#!/usr/bin/env node
/**
 * `dsh-plugin-update-manager` command line entry.
 *
 * The desktop build of DSH keeps `node_modules` open while it runs, so
 * `pnpm add` fails with EPERM file locks. This CLI is the fallback: quit DSH
 * completely, run `dsh-plugin-update-manager update <name>@<version>` in a
 * terminal, then start DSH again.
 *
 * The module exports its argument parser and `main(argv, io)` so the logic can
 * be unit tested without spawning a child process; `io.stdout` / `io.stderr`
 * accept line writers, which keeps the output captureable.
 */

import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { loadProfile } from './core/profile.js'
import { loadConfig, stateDir as resolveStateDir, SOURCE_IDS } from './core/store.js'
import { listVersions, SourceError } from './core/sources.js'
import { pickTargets } from './core/pick.js'
import { evaluateManifest } from './core/compat.js'
import { runUpdate } from './core/update.js'
import * as semver from './core/semver.js'

const PREFIX = '[plugin-updater]'
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

/** Same rules as `lib/core/update.js`; duplicated so the CLI can validate before loading anything. */
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

export const USAGE = `用法：
  dsh-plugin-update-manager update <name>@<version> [选项]
  dsh-plugin-update-manager update <name> --version <version> [选项]
  dsh-plugin-update-manager check [<name>] [选项]

命令：
  update   安装指定版本（需先完全退出 DSH 桌面版，避免文件锁）
  check    只解析候选版本并打印，不安装

选项：
  --version <x.y.z>        目标版本（也可写成 <name>@<x.y.z>）
  --source <id>            版本源：npm-official | npm-mirror | github | github-mirror
                           默认读取插件配置（perPackageSource / defaultSource）
  --profile-dir <dir>      指定 profile 目录（默认自动定位 desktop profile）
  --allow-incompatible     目标版本与本机 DSH 不兼容时仍继续安装（有风险）
  --json                   机器可读输出：每行一个 JSON 对象
  --help, -h               显示本帮助

退出码：0 成功 / 1 运行失败 / 2 用法或前置校验失败`

/**
 * @typedef {'update'|'check'|null} CliCommand
 * @typedef {{
 *   command: CliCommand,
 *   name: string,
 *   version: string,
 *   source: string,
 *   profileDir: string,
 *   json: boolean,
 *   allowIncompatible: boolean,
 *   help: boolean,
 *   errors: string[],
 * }} ParsedArgs
 */

/**
 * Parse `process.argv.slice(2)` without a dependency. Unknown options and
 * missing values are collected instead of thrown so `main` can report them
 * with exit code 2.
 *
 * @param {string[]} argv
 * @returns {ParsedArgs}
 */
export function parseArgs(argv) {
  /** @type {ParsedArgs} */
  const parsed = {
    command: null,
    name: '',
    version: '',
    source: '',
    profileDir: '',
    json: false,
    allowIncompatible: false,
    help: false,
    errors: [],
  }
  const positional = []
  const tokens = Array.isArray(argv) ? argv.map((token) => String(token)) : []

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--help' || token === '-h') {
      parsed.help = true
      continue
    }
    if (token === '--json') {
      parsed.json = true
      continue
    }
    if (token === '--allow-incompatible') {
      parsed.allowIncompatible = true
      continue
    }
    if (token === '--version' || token === '--source' || token === '--profile-dir') {
      const value = tokens[index + 1]
      if (typeof value !== 'string' || value === '' || value.startsWith('--')) {
        parsed.errors.push(`选项 ${token} 需要一个值`)
        continue
      }
      index += 1
      if (token === '--version') parsed.version = value
      else if (token === '--source') parsed.source = value
      else parsed.profileDir = value
      continue
    }
    if (token.startsWith('--')) {
      parsed.errors.push(`未知选项：${token}`)
      continue
    }
    positional.push(token)
  }

  if (positional.length > 0) {
    const command = positional[0]
    if (command === 'update' || command === 'check') parsed.command = command
    else parsed.errors.push(`未知命令：${command}`)
  }

  const nameToken = positional.length > 1 ? positional[1] : ''
  if (positional.length > 2) {
    parsed.errors.push(`多余的参数：${positional.slice(2).join(' ')}`)
  }
  if (positional.length > 1) {
    // `update demo-plugin@1.2.0` — only split on an `@` that is not the
    // leading scope marker. Scoped names keep their slash untouched.
    const at = nameToken.lastIndexOf('@')
    if (at > 0) {
      parsed.name = nameToken.slice(0, at)
      const inlineVersion = nameToken.slice(at + 1)
      if (parsed.version !== '' && parsed.version !== inlineVersion) {
        parsed.errors.push(`版本冲突：位置参数 ${inlineVersion} 与 --version ${parsed.version} 不一致`)
      }
      if (parsed.version === '') parsed.version = inlineVersion
    } else {
      parsed.name = nameToken
    }
  }

  if (parsed.help === true) return parsed

  if (parsed.command === null && parsed.errors.length === 0) {
    parsed.errors.push('缺少命令（update 或 check），使用 --help 查看用法')
  }
  if (parsed.command === 'update') {
    if (parsed.name === '') parsed.errors.push('update 需要包名')
    if (parsed.version === '') parsed.errors.push('update 需要版本号（<name>@<version> 或 --version）')
  }
  if (parsed.name !== '' && PACKAGE_NAME_PATTERN.test(parsed.name) !== true) {
    parsed.errors.push(`包名不合法：${parsed.name}`)
  }
  if (parsed.version !== '' && VERSION_PATTERN.test(parsed.version) !== true) {
    parsed.errors.push(`版本号不合法：${parsed.version}（需要 x.y.z 或 x.y.z-预发布）`)
  }
  if (parsed.source !== '' && SOURCE_IDS.includes(parsed.source) !== true) {
    parsed.errors.push(`未知的版本源：${parsed.source}（可选 ${SOURCE_IDS.join(' / ')}）`)
  }
  return parsed
}

/**
 * @param {unknown} error
 * @returns {{code: string, message: string, detail?: string}}
 */
function describeError(error) {
  if (error instanceof SourceError) {
    const described = { code: error.code, message: error.message }
    if (typeof error.detail === 'string' && error.detail !== '') described.detail = error.detail
    return described
  }
  if (error instanceof Error) return { code: 'unknown', message: error.message }
  return { code: 'unknown', message: String(error) }
}

/**
 * Resolve the profile the user asked for. `--profile-dir` is injected through
 * `profileContext` because `loadProfile` intentionally has no directory option.
 *
 * @param {ParsedArgs} parsed
 * @param {Record<string, string|undefined>} env
 * @returns {Promise<import('./core/profile.js').Profile>}
 */
async function openProfile(parsed, env) {
  if (parsed.profileDir !== '') {
    const dir = path.resolve(parsed.profileDir)
    const home = firstNonEmpty(env.DSH_HOME, process.env.DSH_HOME) ?? path.resolve(dir, '..', '..')
    return loadProfile({ profileContext: { dir, home }, env })
  }
  return loadProfile({ env })
}

/**
 * @param {...(string|null|undefined)} values
 * @returns {string|null}
 */
function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return null
}

/**
 * @param {import('./core/profile.js').Profile} profile
 * @param {string} name
 * @returns {import('./core/profile.js').PackageEntry|null}
 */
function findEntry(profile, name) {
  const packages = Array.isArray(profile.packages) ? profile.packages : []
  return packages.find((entry) => entry !== null && typeof entry === 'object' && entry.name === name) ?? null
}

/**
 * @param {unknown} value
 * @returns {NonNullable<import('./core/pick.js').PickResult['target']>|null}
 */
function targetOf(value) {
  if (value === null || typeof value !== 'object') return null
  const target = /** @type {{version?: unknown, risk?: unknown}} */ (value)
  if (typeof target.version !== 'string') return null
  return { version: target.version, risk: target.risk === 'latest-incompatible' ? 'latest-incompatible' : 'none' }
}

/**
 * Pick the candidate matching the requested version. Falls back to a semver
 * comparison so `1.2.0` matches an entry stored with a `v` prefix.
 *
 * @param {Array<{version: string, manifest: object|null, installSpec: string|null, installKind: string|null}>} candidates
 * @param {string} version
 */
function findCandidate(candidates, version) {
  const exact = candidates.find((candidate) => candidate.version === version)
  if (exact !== undefined) return exact
  try {
    return candidates.find((candidate) => semver.eq(candidate.version, version)) ?? null
  } catch {
    return null
  }
}

/**
 * @param {{versions: Array<{version: string}>}} result
 * @returns {string[]}
 */
function versionList(result) {
  return result.versions.map((entry) => entry.version)
}

/**
 * Format a compatibility verdict for humans.
 *
 * @param {{compatible: boolean, source: string, unmet: Array<{name: string, range: string, actual: string}>}} verdict
 * @returns {string}
 */
function describeVerdict(verdict) {
  if (verdict.compatible === true) return '兼容'
  const details = verdict.unmet
    .map((item) => `${item.name} 需要 ${item.range}（本机 ${item.actual}）`)
    .join('；')
  return details === '' ? '不兼容' : `不兼容：${details}`
}

/**
 * Run a single check for one package and return one row per package.
 *
 * @param {import('./core/profile.js').Profile} profile
 * @param {import('./core/profile.js').PackageEntry} entry
 * @param {{source: string, config: Record<string, unknown>, json: boolean, emit: (event: Record<string, unknown>) => void, info: (message: string) => void, warn: (message: string) => void, out: (line: string) => void}} context
 */
async function checkPackage(profile, entry, context) {
  const result = await listVersions({
    name: entry.name,
    source: context.source,
    config: context.config,
    manifest: entry.manifest,
  })
  const picked = pickTargets({
    installedVersion: entry.installedVersion,
    installedManifest: entry.manifest,
    candidates: result.versions,
    latest: result.latest,
    runtimeVersion: profile.runtimeVersion,
    allowPrerelease: context.config.allowPrerelease === true,
    kind: entry.kind,
  })
  const target = targetOf(picked.target)

  if (context.json === true) {
    context.emit({
      event: 'check',
      name: entry.name,
      source: context.source,
      installedVersion: entry.installedVersion,
      latestVersion: picked.latestVersion,
      compatibleMax: picked.compatibleMax,
      status: picked.status,
      target: target === null ? null : target.version,
      risk: target === null ? null : target.risk,
      reason: picked.reason,
    })
    return picked
  }

  context.info(`正在检查 ${entry.name}（来源 ${context.source}，本机 DSH ${profile.runtimeVersion}）`)
  context.info(`  已安装 ${entry.installedVersion ?? '未知'}；最新 ${picked.latestVersion ?? '未知'}；兼容最高 ${picked.compatibleMax ?? '无'}`)
  context.info(`  状态 ${picked.status}：${picked.reason.message}`)
  if (target !== null) {
    context.out(`${PREFIX}  可更新到 ${target.version}${target.risk === 'latest-incompatible' ? '（最新版不兼容，已降级）' : ''}`)
  } else if (picked.status === 'update-compatible' || picked.status === 'update-latest') {
    context.out(`${PREFIX}  没有可安装的兼容更新`)
  }
  return picked
}

/**
 * @typedef {{
 *   stdout?: (line: string) => void,
 *   stderr?: (line: string) => void,
 *   env?: Record<string, string|undefined>,
 * }} CliIo
 */

/**
 * Run the CLI and resolve with the process exit code (0 / 1 / 2).
 *
 * @param {string[]} [argv]
 * @param {CliIo} [io]
 * @returns {Promise<number>}
 */
export async function main(argv = process.argv.slice(2), io = {}) {
  const env = io.env ?? process.env
  const out = typeof io.stdout === 'function' ? io.stdout : (line) => process.stdout.write(`${line}\n`)
  const err = typeof io.stderr === 'function' ? io.stderr : (line) => process.stderr.write(`${line}\n`)
  const parsed = parseArgs(argv)
  const json = parsed.json

  /** @type {(event: Record<string, unknown>) => void} */
  const emit = (event) => {
    if (json === true) out(JSON.stringify(event))
  }
  /** @type {(message: string) => void} */
  const info = (message) => {
    if (json !== true) out(`${PREFIX} ${message}`)
  }
  /** @type {(message: string) => void} */
  const warn = (message) => {
    if (json !== true) err(`${PREFIX} 警告：${message}`)
  }
  /**
   * @param {number} code
   * @param {string} message
   * @param {Record<string, unknown>} [extra]
   * @returns {number}
   */
  const fail = (code, message, extra = {}) => {
    if (json === true) out(JSON.stringify({ event: 'error', code, message, ...extra }))
    else err(`${PREFIX} 错误：${message}`)
    return code
  }

  if (parsed.help === true) {
    out(USAGE)
    return 0
  }
  if (parsed.errors.length > 0) {
    return fail(2, parsed.errors.join('；'), { errors: parsed.errors })
  }

  /** @type {import('./core/profile.js').Profile} */
  let profile
  try {
    profile = await openProfile(parsed, env)
  } catch (error) {
    const described = describeError(error)
    return fail(1, `无法加载 profile：${described.message}`)
  }

  /** @type {string} */
  const stateDir = resolveStateDir({ dshHome: profile.dshHome, profileDir: profile.dir })
  /** @type {Record<string, unknown>} */
  let config
  try {
    config = await loadConfig(stateDir)
  } catch (error) {
    const described = describeError(error)
    return fail(1, `无法读取插件配置（${stateDir}）：${described.message}`)
  }

  emit({ event: 'profile', name: profile.name, dir: profile.dir, runtimeVersion: profile.runtimeVersion })

  const perPackage = config.perPackageSource
  const configured = perPackage !== null && typeof perPackage === 'object' && !Array.isArray(perPackage)
    ? /** @type {Record<string, unknown>} */ (perPackage)[
      parsed.command === 'update' || parsed.name !== '' ? parsed.name : ''
    ]
    : undefined
  /** @type {string} */
  const source = parsed.source !== ''
    ? parsed.source
    : typeof configured === 'string' && SOURCE_IDS.includes(configured)
      ? configured
      : typeof config.defaultSource === 'string' && SOURCE_IDS.includes(config.defaultSource)
        ? config.defaultSource
        : 'npm-mirror'

  /** @type {import('./core/profile.js').PackageEntry[]} */
  let entries = []
  if (parsed.command === 'check' && parsed.name === '') {
    entries = (Array.isArray(profile.packages) ? profile.packages : []).filter(
      (entry) => entry !== null && typeof entry === 'object' && entry.kind === 'registry',
    )
    if (entries.length === 0) {
      info('profile 中没有可检查的 registry 包')
      return 0
    }
  } else {
    const entry = findEntry(profile, parsed.name)
    if (entry === null) {
      return fail(2, `profile 中找不到包 ${parsed.name}（可能尚未安装）`, { name: parsed.name })
    }
    if (entry.kind !== 'registry') {
      return fail(2, `包 ${parsed.name} 是 ${entry.kind} 依赖（${entry.specifier ?? ''}），CLI 无法直接更新；请通过 profile 的包管理器处理`, {
        name: parsed.name,
        kind: entry.kind,
      })
    }
    entries = [entry]
  }

  info(`profile：${profile.name}（${profile.dir}），本机 DSH ${profile.runtimeVersion}，来源 ${source}`)

  if (parsed.command === 'check') {
    let failed = 0
    for (const entry of entries) {
      try {
        await checkPackage(profile, entry, { source, config, json, emit, info, warn, out })
      } catch (error) {
        failed += 1
        const described = describeError(error)
        if (json === true) emit({ event: 'check-error', name: entry.name, code: described.code, message: described.message })
        else err(`${PREFIX} 检查 ${entry.name} 失败（${described.code}）：${described.message}`)
      }
    }
    return failed === 0 ? 0 : 1
  }

  const entry = entries[0]
  const targetVersion = parsed.version

  /** @type {Awaited<ReturnType<typeof listVersions>>} */
  let result
  try {
    result = await listVersions({ name: entry.name, source, config, manifest: entry.manifest })
  } catch (error) {
    const described = describeError(error)
    return fail(1, `无法从 ${source} 获取 ${entry.name} 的版本列表：${described.message}`, { code: described.code })
  }

  emit({ event: 'versions', name: entry.name, source, count: result.versions.length, latest: result.latest })

  const candidate = findCandidate(result.versions, targetVersion)
  if (candidate === null) {
    return fail(2, `${source} 中没有版本 ${targetVersion}；可用版本：${versionList(result).join(', ') || '无'}`, {
      name: entry.name,
      version: targetVersion,
      available: versionList(result),
    })
  }

  const picked = pickTargets({
    installedVersion: entry.installedVersion,
    installedManifest: entry.manifest,
    candidates: result.versions,
    latest: result.latest,
    runtimeVersion: profile.runtimeVersion,
    allowPrerelease: config.allowPrerelease === true,
    kind: entry.kind,
  })
  emit({
    event: 'target',
    name: entry.name,
    requested: targetVersion,
    installedVersion: entry.installedVersion,
    latestVersion: picked.latestVersion,
    compatibleMax: picked.compatibleMax,
    status: picked.status,
    reason: picked.reason,
  })

  if (semver.eq(entry.installedVersion, targetVersion) === true) {
    info(`${entry.name}@${targetVersion} 已经安装，无需更新`)
    emit({ event: 'success', name: entry.name, fromVersion: entry.installedVersion, toVersion: targetVersion, needsRestart: false, changed: false })
    return 0
  }

  /** @type {{compatible: boolean, source: string, unmet: Array<{name: string, range: string, actual: string}>}|null} */
  let verdict = null
  if (candidate.manifest !== null && typeof candidate.manifest === 'object') {
    verdict = evaluateManifest(candidate.manifest, profile.runtimeVersion)
  }
  if (verdict === null) {
    warn(`版本 ${targetVersion} 缺少 manifest，无法判定与 DSH ${profile.runtimeVersion} 的兼容性，继续尝试安装`)
  } else if (verdict.compatible !== true) {
    const suggestion = picked.compatibleMax === null
      ? '没有找到兼容版本'
      : `可用的最高兼容版本是 ${picked.compatibleMax}`
    warn(`版本 ${targetVersion} 与本机 DSH ${profile.runtimeVersion} 不兼容：${describeVerdict(verdict)}；${suggestion}`)
    if (parsed.allowIncompatible !== true) {
      return fail(2, `目标版本 ${targetVersion} 与 DSH ${profile.runtimeVersion} 不兼容（${suggestion}）；如确认继续，请加 --allow-incompatible`, {
        name: entry.name,
        version: targetVersion,
        compatibleMax: picked.compatibleMax,
        unmet: verdict.unmet,
      })
    }
    warn('已指定 --allow-incompatible，继续安装不兼容版本')
  }

  const installSpec = typeof candidate.installSpec === 'string' && candidate.installSpec !== ''
    ? candidate.installSpec
    : `${entry.name}@${targetVersion}`

  /** @type {Awaited<ReturnType<typeof runUpdate>>} */
  let update
  try {
    update = await runUpdate({
      profile,
      entry,
      target: {
        version: targetVersion,
        installSpec,
        installKind: candidate.installKind ?? null,
      },
      runtimeVersion: profile.runtimeVersion,
      stateDir,
      allowIncompatible: parsed.allowIncompatible,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      onProgress: (step) => {
        if (json === true) emit({ event: 'step', phase: step.phase, message: step.message, progress: step.progress ?? null })
        else out(`${PREFIX} [${step.phase}] ${step.message}`)
      },
    })
  } catch (error) {
    const described = describeError(error)
    return fail(1, `更新失败（${described.code}）：${described.message}`, { code: described.code })
  }

  if (update.ok !== true) {
    const error = update.error ?? { code: 'unknown', message: '未知错误' }
    if (json === true) {
      emit({
        event: 'error',
        name: update.name,
        code: error.code,
        message: error.message,
        detail: error.detail ?? null,
        rolledBack: update.rolledBack,
        backupDir: update.backupDir,
      })
    } else {
      err(`${PREFIX} 更新失败（${error.code}）：${error.message}`)
      if (typeof error.detail === 'string' && error.detail !== '') err(`${PREFIX} 详情：${error.detail}`)
      if (update.rolledBack === true) {
        err(`${PREFIX} 已回滚${update.backupDir === null ? '' : `（备份保留在 ${update.backupDir}）`}`)
      }
    }
    return 1
  }

  if (json === true) {
    emit({
      event: 'success',
      name: update.name,
      fromVersion: update.fromVersion,
      toVersion: update.toVersion,
      needsRestart: true,
      backupDir: update.backupDir,
    })
  } else {
    out(`${PREFIX} 已把 ${update.name} 从 ${update.fromVersion ?? '未知'} 更新到 ${update.toVersion}`)
    out(`${PREFIX} 需要重启 DSH 后生效（请完全退出并重新打开桌面版）`)
  }
  return 0
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      process.stderr.write(`${PREFIX} 未捕获的错误：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
      process.exitCode = 1
    },
  )
}
