/**
 * Restart support for the two ways DSH can host us.
 *
 * Desktop (DSH NEXT / DSH Desktop): the host is a Node-mode Electron child that
 * talks to the Electron main process over `process.send`. The main process owns
 * a `desktop-action` IPC message: `{ type: 'desktop-action', action: 'restart' }`
 * makes it ask for confirmation and then restart the whole app (host + UI).
 * That is the official channel, so we never kill the desktop process ourselves.
 *
 * CLI (`dsh web ...` / `dsh --profile ...`): there is no supervisor to ask, so we
 * launch a detached helper that terminates this host once the HTTP response has
 * been flushed and then starts the same invocation again.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

/**
 * How this host can be restarted.
 * @typedef {{ kind: 'desktop', via: 'ipc', confirm: boolean }
 *   | { kind: 'cli', file: string, args: string[], cwd: string }
 *   | { kind: 'none', reason: string }} RestartPlan
 */

/**
 * Work out the restart strategy without side effects.
 * @param {{
 *   platform?: NodeJS.Platform,
 *   env?: NodeJS.ProcessEnv,
 *   execPath?: string,
 *   argv?: string[],
 *   cwd?: string,
 *   hasIpc?: boolean,
 * }} [input]
 * @returns {RestartPlan}
 */
export function probeRestartPlan(input = {}) {
  const platform = input.platform ?? process.platform
  const env = input.env ?? process.env
  // Test / harness escape hatch: never make a test process restart itself.
  if (env.DSH_UPDATER_DISABLE_RESTART === '1') {
    return { kind: 'none', reason: 'automatic restart is disabled by DSH_UPDATER_DISABLE_RESTART' }
  }
  const execPath = input.execPath ?? process.execPath
  const argv = input.argv ?? process.argv
  const cwd = input.cwd ?? process.cwd()
  const hasIpc = input.hasIpc ?? (typeof process.send === 'function' && process.connected)
  const electronNode = env.ELECTRON_RUN_AS_NODE === '1'
  const electronExe = /(?:^|[\\/])DSH[ _-]?NEXT\.exe$/i.test(execPath) || /(?:^|[\\/])electron(?:\.exe)?$/i.test(execPath)
  if (hasIpc && (electronNode || electronExe)) {
    return { kind: 'desktop', via: 'ipc', confirm: true }
  }
  if (execPath && argv.length > 1 && existsSync(argv[1])) {
    return { kind: 'cli', file: execPath, args: argv.slice(1), cwd }
  }
  return { kind: 'none', reason: `cannot identify the process to relaunch (execPath=${execPath || 'unknown'})` }
}

/** Source of the detached helper that restarts a CLI host after it exits. */
export function relaunchHelperSource(plan, pid, waitMs = 6000) {
  return [
    "const { spawn } = require('node:child_process')",
    `const file = ${JSON.stringify(plan.file)}`,
    `const args = ${JSON.stringify(plan.args)}`,
    `const cwd = ${JSON.stringify(plan.cwd ?? null)}`,
    `const pid = ${JSON.stringify(pid)}`,
    `const deadline = Date.now() + ${JSON.stringify(waitMs)}`,
    "const { spawnSync } = require('node:child_process')",
    'function alive() { try { process.kill(pid, 0); return true } catch { return false } }',
    'function kill() {',
    '  if (!alive()) return',
    '  try { process.kill(pid, "SIGTERM") } catch {}',
    "  if (process.platform === 'win32' && alive()) {",
    '    try { spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }) } catch {}',
    '  }',
    '}',
    'function start() {',
    "  const child = spawn(file, args, { cwd: cwd ?? undefined, detached: true, stdio: 'ignore', windowsHide: false })",
    '  child.unref()',
    '}',
    'function wait() {',
    '  if (!alive()) return start()',
    '  if (Date.now() > deadline) {',
    "    try { process.kill(pid, 'SIGKILL') } catch {}",
    '    return setTimeout(start, 250)',
    '  }',
    '  setTimeout(wait, 120)',
    '}',
    'setTimeout(function () { kill(); wait() }, 250)',
  ].join('\n')
}

/**
 * Ask the host to restart. Returns synchronously; the process may disappear
 * shortly afterwards, so callers must answer the HTTP request first.
 * @param {RestartPlan} plan
 * @param {{ pid?: number, spawnImpl?: typeof spawn, sendImpl?: (message: unknown, callback?: (error: Error | null) => void) => void, connected?: boolean }} [options]
 * @returns {{ ok: boolean, mode: 'desktop' | 'cli' | 'none', message: string, helperPid?: number }}
 */
export function requestRestart(plan, options = {}) {
  const pid = options.pid ?? process.pid
  if (plan.kind === 'desktop') {
    const send = options.sendImpl ?? (typeof process.send === 'function' ? process.send.bind(process) : undefined)
    const connected = options.connected ?? process.connected
    if (send === undefined || !connected) {
      return { ok: false, mode: 'none', message: '桌面版的 IPC 通道不可用，无法请求重启。' }
    }
    try {
      send({ type: 'desktop-action', action: 'restart' }, () => {})
    } catch (error) {
      return { ok: false, mode: 'none', message: `重启请求发送失败：${error instanceof Error ? error.message : String(error)}` }
    }
    return { ok: true, mode: 'desktop', message: '已请求桌面版重启，请在弹窗中确认。' }
  }
  if (plan.kind === 'cli') {
    try {
      const helper = (options.spawnImpl ?? spawn)(
        process.execPath,
        ['-e', relaunchHelperSource(plan, pid)],
        { detached: true, stdio: 'ignore', windowsHide: true },
      )
      helper.unref()
      return { ok: true, mode: 'cli', message: '正在重启 DSH，页面会在几秒后重新连接。', helperPid: helper.pid }
    } catch (error) {
      return { ok: false, mode: 'none', message: `重启失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }
  return { ok: false, mode: 'none', message: plan.reason || '当前环境不支持自动重启。' }
}
