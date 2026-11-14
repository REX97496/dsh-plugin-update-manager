import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  probeRestartPlan,
  relaunchHelperSource,
  requestRestart,
} from '../lib/core/restart.js'

const DESKTOP_EXE = 'C:\\Users\\Administrator\\AppData\\Local\\Programs\\DSH NEXT\\DSH NEXT.exe'

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-updater-restart-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function tempEntry(t) {
  const dir = tempDir(t)
  const file = path.join(dir, 'entry.mjs')
  fs.writeFileSync(file, '// fake dsh entry for restart tests\n')
  return file
}

function fakeSpawn({ pid = 4242, throws = null } = {}) {
  const calls = []
  function spawnImpl(file, args, options) {
    if (throws) throw throws
    calls.push({ file, args, options })
    return { pid, unref() {}, on() {} }
  }
  return { spawnImpl, calls }
}

// ---------------------------------------------------------------------------
// 1. desktop detection
// ---------------------------------------------------------------------------

test('probeRestartPlan: desktop when IPC exists and ELECTRON_RUN_AS_NODE=1', () => {
  const plan = probeRestartPlan({
    hasIpc: true,
    env: { ELECTRON_RUN_AS_NODE: '1' },
    execPath: '/usr/local/bin/node',
    argv: ['/usr/local/bin/node', '/tmp/app.mjs'],
    cwd: '/tmp',
  })
  assert.deepEqual(plan, { kind: 'desktop', via: 'ipc', confirm: true })
})

test('probeRestartPlan: desktop when execPath is a DSH NEXT / Electron executable', () => {
  for (const execPath of [
    DESKTOP_EXE,
    'C:\\Program Files\\DSH NEXT\\DSH-NEXT.exe',
    'C:\\Program Files\\DSH NEXT\\dsh_next.exe',
    'C:\\Program Files\\Electron\\electron.exe',
  ]) {
    const plan = probeRestartPlan({ hasIpc: true, env: {}, execPath, argv: [execPath], cwd: 'C:\\x' })
    assert.equal(plan.kind, 'desktop', `expected desktop for ${execPath}`)
    assert.equal(plan.via, 'ipc')
    assert.equal(plan.confirm, true)
  }
})

test('probeRestartPlan: Electron path without IPC falls back to cli', (t) => {
  const entry = tempEntry(t)
  const plan = probeRestartPlan({
    hasIpc: false,
    env: { ELECTRON_RUN_AS_NODE: '1' },
    execPath: DESKTOP_EXE,
    argv: [DESKTOP_EXE, entry, '--profile', 'desktop'],
    cwd: 'C:\\work',
  })
  assert.equal(plan.kind, 'cli')
  assert.equal(plan.file, DESKTOP_EXE)
  assert.equal(plan.cwd, 'C:\\work')
})

test('probeRestartPlan: ELECTRON_RUN_AS_NODE alone is not enough without IPC', (t) => {
  const entry = tempEntry(t)
  const plan = probeRestartPlan({
    hasIpc: false,
    env: { ELECTRON_RUN_AS_NODE: '1' },
    execPath: process.execPath,
    argv: [process.execPath, entry],
    cwd: os.tmpdir(),
  })
  assert.equal(plan.kind, 'cli')
})

// ---------------------------------------------------------------------------
// 2. cli detection
// ---------------------------------------------------------------------------

test('probeRestartPlan: cli keeps execPath as file and args from argv[1]', (t) => {
  const entry = tempEntry(t)
  const argv = [process.execPath, entry, 'web', '--port', '1450']
  const plan = probeRestartPlan({
    hasIpc: false,
    env: {},
    execPath: process.execPath,
    argv,
    cwd: 'E:\\project\\dsh-plugin-update-manager',
  })
  assert.deepEqual(plan, {
    kind: 'cli',
    file: process.execPath,
    args: [entry, 'web', '--port', '1450'],
    cwd: 'E:\\project\\dsh-plugin-update-manager',
  })
})

test('probeRestartPlan: cli cwd defaults to process.cwd()', (t) => {
  const entry = tempEntry(t)
  const plan = probeRestartPlan({ hasIpc: false, argv: [process.execPath, entry] })
  assert.equal(plan.kind, 'cli')
  assert.equal(plan.cwd, process.cwd())
})

test('probeRestartPlan: argv[1] that does not exist cannot be relaunched', () => {
  const plan = probeRestartPlan({
    hasIpc: false,
    execPath: process.execPath,
    argv: [process.execPath, path.join(os.tmpdir(), 'definitely-missing-entry-9f3c.mjs')],
  })
  assert.equal(plan.kind, 'none')
})

// ---------------------------------------------------------------------------
// 3. none
// ---------------------------------------------------------------------------

test('probeRestartPlan: empty execPath yields none with a reason', () => {
  const plan = probeRestartPlan({ hasIpc: false, execPath: '', argv: ['', 'x'] })
  assert.equal(plan.kind, 'none')
  assert.equal(typeof plan.reason, 'string')
  assert.match(plan.reason, /cannot identify the process to relaunch/)
})

// ---------------------------------------------------------------------------
// 4. requestRestart: desktop
// ---------------------------------------------------------------------------

test('requestRestart: desktop sends the desktop-action IPC message', () => {
  const sent = []
  const result = requestRestart(
    { kind: 'desktop', via: 'ipc', confirm: true },
    {
      pid: 1234,
      connected: true,
      sendImpl(message, callback) {
        sent.push({ message, callback })
      },
    },
  )
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0].message, { type: 'desktop-action', action: 'restart' })
  assert.equal(typeof sent[0].callback, 'function')
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'desktop')
  assert.equal(result.helperPid, undefined)
  assert.match(result.message, /重启/)
})

test('requestRestart: desktop without a connected IPC channel refuses and never sends', () => {
  let calls = 0
  const result = requestRestart(
    { kind: 'desktop', via: 'ipc', confirm: true },
    {
      pid: 1234,
      connected: false,
      sendImpl() {
        calls += 1
      },
    },
  )
  assert.equal(calls, 0)
  assert.equal(result.ok, false)
  assert.equal(result.mode, 'none')
  assert.match(result.message, /IPC/)
})

test('requestRestart: desktop send failure is reported, not thrown', () => {
  const result = requestRestart(
    { kind: 'desktop', via: 'ipc', confirm: true },
    {
      connected: true,
      sendImpl() {
        throw new Error('channel closed')
      },
    },
  )
  assert.equal(result.ok, false)
  assert.equal(result.mode, 'none')
  assert.match(result.message, /重启请求发送失败/)
  assert.match(result.message, /channel closed/)
})

// ---------------------------------------------------------------------------
// 5. requestRestart: cli
// ---------------------------------------------------------------------------

test('requestRestart: cli spawns a detached node helper', (t) => {
  const entry = tempEntry(t)
  const plan = probeRestartPlan({
    hasIpc: false,
    execPath: process.execPath,
    argv: [process.execPath, entry, '--profile', 'desktop'],
    cwd: os.tmpdir(),
  })
  assert.equal(plan.kind, 'cli')

  const { spawnImpl, calls } = fakeSpawn({ pid: 98765 })
  const result = requestRestart(plan, { pid: 4321, spawnImpl })

  assert.equal(calls.length, 1)
  const call = calls[0]
  assert.equal(call.file, process.execPath)
  assert.equal(Array.isArray(call.args), true)
  assert.equal(call.args.length, 2)
  assert.equal(call.args[0], '-e')
  assert.equal(typeof call.args[1], 'string')
  assert.deepEqual(call.options, { detached: true, stdio: 'ignore', windowsHide: true })

  const source = call.args[1]
  assert.match(source, /process\.kill\(pid, 0\)/)
  assert.match(source, /detached: true/)
  assert.equal(source.includes('${'), false, 'helper source must not keep template placeholders')
  assert.equal(source.includes(JSON.stringify(entry)), true, 'helper source must carry argv[1]')
  assert.equal(source.includes('4321'), true, 'helper source must carry the parent pid')

  assert.equal(result.ok, true)
  assert.equal(result.mode, 'cli')
  assert.equal(result.helperPid, 98765)
  assert.match(result.message, /重新连接/)
})

test('requestRestart: cli spawn failure is reported, not thrown', (t) => {
  const entry = tempEntry(t)
  const plan = probeRestartPlan({
    hasIpc: false,
    execPath: process.execPath,
    argv: [process.execPath, entry],
    cwd: os.tmpdir(),
  })
  const { spawnImpl } = fakeSpawn({ throws: new Error('spawn EACCES') })
  const result = requestRestart(plan, { pid: 1, spawnImpl })
  assert.equal(result.ok, false)
  assert.equal(result.mode, 'none')
  assert.match(result.message, /重启失败/)
  assert.match(result.message, /spawn EACCES/)
})

test('requestRestart: cli defaults to the real child_process.spawn when not injected', () => {
  // Use a plan whose target cannot actually launch anything: the helper still gets
  // spawned (that is what we assert), but it fails to relaunch instead of starting a
  // second DSH host inside the test run. The pid is deliberately dead: the helper now
  // sends SIGTERM first, so passing process.pid here would kill the test runner itself.
  const plan = { kind: 'cli', file: path.join(os.tmpdir(), 'no-such-dsh-exe-4c1e'), args: [], cwd: os.tmpdir() }
  const result = requestRestart(plan, { pid: 2147483646 })
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'cli')
  assert.equal(Number.isInteger(result.helperPid), true)
})

// ---------------------------------------------------------------------------
// 6. relaunchHelperSource
// ---------------------------------------------------------------------------

test('relaunchHelperSource: embeds JSON stringified plan fields', () => {
  const plan = {
    kind: 'cli',
    file: 'C:\\nodejs\\node.exe',
    args: ['C:\\work dir\\entry.mjs', 'web', '--port', '1450'],
    cwd: 'C:\\work dir',
  }
  const source = relaunchHelperSource(plan, 7777, 2500)

  assert.equal(source.includes(`const file = ${JSON.stringify(plan.file)}`), true)
  assert.equal(source.includes(`const args = ${JSON.stringify(plan.args)}`), true)
  assert.equal(source.includes(`const cwd = ${JSON.stringify(plan.cwd)}`), true)
  assert.equal(source.includes('const pid = 7777'), true)
  assert.equal(source.includes('Date.now() + 2500'), true)
})

test('relaunchHelperSource: kills the old host, then polls and spawns detached', () => {
  const source = relaunchHelperSource(
    { kind: 'cli', file: 'node', args: ['app.mjs'], cwd: null },
    123,
    6000,
  )
  assert.match(source, /function alive\(\) \{ try \{ process\.kill\(pid, 0\); return true \} catch \{ return false \} \}/)
  assert.match(source, /spawn\(file, args, \{ cwd: cwd \?\? undefined, detached: true, stdio: 'ignore', windowsHide: false \}\)/)
  assert.match(source, /child\.unref\(\)/)
  assert.match(source, /setTimeout\(wait, 120\)/)
  assert.match(source, /setTimeout\(function \(\) \{ kill\(\); wait\(\) \}, 250\)/)
  assert.equal(source.includes('function kill() {'), true)
  assert.equal(source.includes('process.kill(pid, "SIGTERM")'), true)
  assert.equal(source.includes('spawnSync("taskkill"'), true)
  assert.equal(source.includes("process.platform === 'win32'"), true)
  assert.equal(source.includes("try { process.kill(pid, 'SIGKILL') } catch {}"), true)
  assert.equal(source.includes('return setTimeout(start, 250)'), true)
  assert.equal(source.includes('    undefined, detached'), false)
  assert.equal(source.includes('${'), false)
  assert.equal(source.includes('\n'), true, 'helper source is multi-line')
  assert.equal(source.split('\n').length > 10, true)
})

test('relaunchHelperSource: null cwd is JSON null so the child inherits the helper cwd', () => {
  const source = relaunchHelperSource({ kind: 'cli', file: 'node', args: [], cwd: null }, 1, 100)
  assert.equal(source.includes('const cwd = null'), true)
  assert.equal(source.includes('const args = []'), true)
})
