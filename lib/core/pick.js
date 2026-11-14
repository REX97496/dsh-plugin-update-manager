/**
 * Pure decision logic: given the installed plugin state and the candidate
 * versions found by a source, decide what the updater UI should offer.
 *
 * No I/O, no clock, no environment access: every input is passed in, so the
 * rules below are deterministic and unit-testable.
 *
 * @module core/pick
 */

import * as semver from './semver.js'
import { evaluateManifest } from './compat.js'

const RISK_NONE = 'none'
const RISK_LATEST_INCOMPATIBLE = 'latest-incompatible'

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Normalize and de-duplicate candidates, dropping entries without a usable
 * semver `version`. Source order is preserved (first occurrence wins).
 *
 * @param {unknown} list
 * @returns {Array<{version: string, manifest: object|null}>}
 */
function normalizeCandidates(list) {
  if (!Array.isArray(list)) return []
  /** @type {Array<{version: string, manifest: object|null}>} */
  const out = []
  const seen = new Set()
  for (const raw of list) {
    if (!isRecord(raw)) continue
    const version = typeof raw.version === 'string' ? semver.valid(raw.version) : null
    if (version === null || seen.has(version)) continue
    seen.add(version)
    out.push({ version, manifest: isRecord(raw.manifest) ? raw.manifest : null })
  }
  return out
}

/**
 * Pick the "latest version" displayed by the UI. Prefers the source-provided
 * latest when it passes the pre-release policy, otherwise the highest visible
 * candidate. Returns `null` when nothing can be shown.
 *
 * @param {unknown} latest Source-reported latest version.
 * @param {Array<{version: string}>} candidates Normalized candidates.
 * @param {boolean} allowPrerelease Whether pre-releases are visible.
 * @returns {string|null}
 */
function resolveLatest(latest, candidates, allowPrerelease) {
  const fromSource = typeof latest === 'string' ? semver.valid(latest) : null
  if (fromSource !== null && (allowPrerelease || !semver.isPrerelease(fromSource))) {
    return fromSource
  }
  let max = null
  for (const candidate of candidates) {
    if (!allowPrerelease && semver.isPrerelease(candidate.version)) continue
    if (max === null || semver.gt(candidate.version, max)) max = candidate.version
  }
  if (max !== null) return max
  // Last resort: a pre-release source latest still beats showing nothing.
  return fromSource
}

/**
 * @typedef {{code: string, message: string, unmet: Array<{name: string, range: string, actual: string}>}} PickReason
 */

/**
 * @typedef {{
 *   status: string,
 *   installedVersion: string|null,
 *   latestVersion: string|null,
 *   compatibleMax: string|null,
 *   installedCompatible: boolean,
 *   target: {version: string, risk: 'none'|'latest-incompatible'}|null,
 *   altTarget: {version: string, risk: 'latest-incompatible'}|null,
 *   reason: PickReason,
 *   candidatesSeen: number,
 *   candidatesCompatible: number
 * }} PickResult
 */

/**
 * Decide the update state for one package.
 *
 * @param {{
 *   installedVersion?: string|null,
 *   installedManifest?: object|null,
 *   candidates?: Array<{version: string, manifest?: object|null}>,
 *   latest?: string|null,
 *   runtimeVersion?: string,
 *   allowPrerelease?: boolean,
 *   kind?: 'registry'|'local'|'builtin'
 * }} input
 * @returns {PickResult}
 */
export function pickTargets(input) {
  const raw = isRecord(input) ? input : {}
  const candidates = normalizeCandidates(raw.candidates)
  const candidatesSeen = candidates.length
  const kind = raw.kind === 'local' || raw.kind === 'builtin' ? raw.kind : 'registry'
  const installedVersion = typeof raw.installedVersion === 'string' && raw.installedVersion !== '' ? raw.installedVersion : null
  const installedValid = installedVersion === null ? null : semver.valid(installedVersion)
  const runtimeVersion = typeof raw.runtimeVersion === 'string' ? raw.runtimeVersion : ''
  const allowPrerelease = raw.allowPrerelease === true || (installedValid !== null && semver.isPrerelease(installedValid))
  const latestVersion = resolveLatest(raw.latest, candidates, allowPrerelease)

  /** @type {PickResult} */
  const result = {
    status: 'error',
    installedVersion,
    latestVersion,
    compatibleMax: null,
    installedCompatible: false,
    target: null,
    altTarget: null,
    reason: { code: 'ok', message: '', unmet: [] },
    candidatesSeen,
    candidatesCompatible: 0,
  }

  if (kind === 'local') {
    result.status = 'local'
    result.installedCompatible = true
    result.reason = { code: 'local-dependency', message: '本地依赖不检查远程更新，请直接修改源工程', unmet: [] }
    return result
  }
  if (kind === 'builtin') {
    result.status = 'builtin'
    result.installedCompatible = true
    result.reason = { code: 'builtin-package', message: 'DSH 内置包随宿主版本发布，不单独升级', unmet: [] }
    return result
  }
  if (installedVersion === null || installedValid === null) {
    result.status = 'error'
    result.reason = { code: 'missing-install', message: '未安装或无法读取已装版本，无法比较更新' }
    return result
  }
  if (candidates.length === 0) {
    result.status = 'error'
    result.reason = { code: 'no-candidates', message: '源中没有可用版本' }
    return result
  }

  const installedEval = isRecord(raw.installedManifest) ? evaluateManifest(raw.installedManifest, runtimeVersion) : null
  const installedCompatible = installedEval === null ? true : installedEval.compatible
  result.installedCompatible = installedCompatible

  const visible = candidates.filter((candidate) => allowPrerelease || !semver.isPrerelease(candidate.version))
  /** @type {Array<{version: string, manifest: object|null}>} */
  const compatibleCandidates = []
  for (const candidate of visible) {
    if (candidate.manifest === null) continue
    if (evaluateManifest(candidate.manifest, runtimeVersion).compatible) compatibleCandidates.push(candidate)
  }
  const candidatesCompatible = compatibleCandidates.length
  result.candidatesCompatible = candidatesCompatible
  const compatibleMax = compatibleCandidates.length === 0 ? null : semver.maxVersion(compatibleCandidates.map((c) => c.version))
  result.compatibleMax = compatibleMax

  const latestCandidate = latestVersion === null ? null : candidates.find((c) => semver.eq(c.version, latestVersion)) ?? null
  const latestEval = latestCandidate !== null && latestCandidate.manifest !== null
    ? evaluateManifest(latestCandidate.manifest, runtimeVersion)
    : null
  const latestKnownIncompatible = latestEval !== null && latestEval.compatible === false
  const latestKnownCompatible = latestEval !== null && latestEval.compatible === true
  const latestIsNewer = latestVersion !== null && latestVersion !== installedValid && semver.gt(latestVersion, installedValid)

  if (!installedCompatible) {
    const unmet = installedEval !== null && installedEval.unmet.length > 0
      ? installedEval.unmet
      : latestEval !== null ? latestEval.unmet : []
    if (compatibleMax !== null) {
      const altTarget = latestKnownIncompatible && latestIsNewer
        ? { version: latestVersion, risk: RISK_LATEST_INCOMPATIBLE }
        : null
      result.status = 'switch-compatible'
      result.target = { version: compatibleMax, risk: RISK_NONE }
      result.altTarget = altTarget
      result.reason = {
        code: 'installed-incompatible',
        message: `已装版本 ${installedVersion} 与当前 DSH 不兼容，建议切换到兼容版本 ${compatibleMax}`,
        unmet,
      }
      return result
    }
    result.status = 'incompatible-no-compatible'
    result.reason = {
      code: 'no-compatible-candidate',
      message: `没有找到与当前 DSH 兼容的版本，已装版本也可能被宿主跳过`,
      unmet,
    }
    return result
  }

  const newerCompatible = compatibleCandidates.filter((candidate) => semver.gt(candidate.version, installedValid))
  if (newerCompatible.length > 0) {
    const newestCompatible = semver.maxVersion(newerCompatible.map((c) => c.version))
    const latestIsCompatible = latestCandidate !== null && latestKnownCompatible && semver.eq(latestVersion, newestCompatible)
    if (latestIsCompatible) {
      result.status = 'update-latest'
      result.target = { version: latestVersion, risk: RISK_NONE }
      result.reason = { code: 'newer-available', message: `有新版本 ${latestVersion}，与当前 DSH 兼容`, unmet: [] }
      return result
    }
    result.status = 'update-compatible'
    result.target = { version: newestCompatible, risk: RISK_NONE }
    result.altTarget = latestKnownIncompatible && latestIsNewer
      ? { version: latestVersion, risk: RISK_LATEST_INCOMPATIBLE }
      : null
    result.reason = {
      code: 'newer-incompatible',
      message: latestKnownIncompatible
        ? `最新版 ${latestVersion} 与当前 DSH 不兼容，可安全更新到 ${newestCompatible}`
        : `可更新到兼容版本 ${newestCompatible}`,
      unmet: latestEval !== null ? latestEval.unmet : [],
    }
    return result
  }

  result.status = 'latest'
  if (latestKnownIncompatible && latestIsNewer) {
    result.reason = {
      code: 'newer-incompatible',
      message: `已装版本 ${installedVersion} 已是当前 DSH 可用的最新兼容版本（${latestVersion} 不兼容）`,
      unmet: [],
    }
  } else if (latestIsNewer && latestCandidate !== null && latestCandidate.manifest === null) {
    result.reason = {
      code: 'ok',
      message: `最新版 ${latestVersion} 的兼容性无法校验，暂不作为默认更新`,
      unmet: [],
    }
  } else if (latestIsNewer) {
    result.reason = { code: 'ok', message: `已装版本 ${installedVersion} 与当前 DSH 兼容，暂无更高兼容版本`, unmet: [] }
  } else {
    result.reason = { code: 'ok', message: `已是最新版本 ${installedVersion}`, unmet: [] }
  }
  return result
}
