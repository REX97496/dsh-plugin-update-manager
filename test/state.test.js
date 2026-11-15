import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { apply } from '../lib/index.js'

/**
 * Minimal Cordis-like context for one plugin mount.
 * Captures the web-server handler and every effect disposer.
 *
 * @param {Record<string, any>} [profileContext] optional host-published
 *   profile identity ({name, dir, home, runtimeVersion, ...}).
 */
function makeCtx(profileContext) {
  const disposers = []
  let handler = null
  return {
    ctx: {
      logger: { info() {} },
      get(name) {
        return name === 'profileContext' ? profileContext : undefined
      },
      inject() {},
      effect(fn) {
        const dispose = fn()
        if (typeof dispose === 'function') disposers.push(dispose)
      },
      webServer: {
        host: '127.0.0.1',
        port: 0,
        register(options) {
          handler = options.handler
          return () => { handler = null }
        },
      },
    },
    getHandler() { return handler },
    dispose() {
      for (const dispose of disposers.splice(0)) dispose()
    },
  }
}

/**
 * Drive the registered `/state` handler with a bare request object.
 *
 * @param {(req: any, res: any) => any} handler
 * @param {string} url
 * @returns {Promise<{status: number, body: any}>}
 */
function requestState(handler, url) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 0,
      writeHead(status) { this.statusCode = status },
      end(payload) {
        try {
          resolve({ status: this.statusCode, body: payload ? JSON.parse(payload) : null })
        } catch (error) {
          reject(error)
        }
      },
    }
    try {
      handler({ method: 'GET', url, headers: {} }, res)
    } catch (error) {
      reject(error)
    }
  })
}

/**
 * Drive any route (GET or POST) with a bare request object. POST bodies are fed
 * through a Readable so the plugin's stream-based body reader works unchanged.
 *
 * @param {(req: any, res: any) => any} handler
 * @param {{ method?: string, url: string, body?: any }} request
 * @returns {Promise<{status: number, body: any}>}
 */
function requestApi(handler, request) {
  return new Promise((resolve, reject) => {
    const req = request.body === undefined
      ? Readable.from([])
      : Readable.from([Buffer.from(JSON.stringify(request.body))])
    req.method = request.method ?? 'GET'
    req.url = request.url
    req.headers = {}
    const res = {
      statusCode: 0,
      writeHead(status) { this.statusCode = status },
      end(payload) {
        try {
          resolve({ status: this.statusCode, body: payload ? JSON.parse(payload) : null })
        } catch (error) {
          reject(error)
        }
      },
    }
    Promise.resolve()
      .then(() => handler(req, res))
      .catch(reject)
  })
}

/** @param {import('node:test').TestContext} t */
function withTempDshHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-updater-state-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  })
  return home
}

test('GET /state exposes a per-mount bootId that changes across mounts', async (t) => {
  withTempDshHome(t)

  const first = makeCtx()
  apply(first.ctx, undefined)
  t.after(() => first.dispose())

  const response = await requestState(first.getHandler(), '/plugin-updater/api/state')
  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  const state = response.body.value
  assert.equal(typeof state.bootId, 'string')
  assert.ok(state.bootId.length > 0)
  // The config carries the new startup policy alongside the state payload.
  assert.equal(state.config.checkOnStartup, 'force')

  const second = makeCtx()
  const secondApi = apply(second.ctx, undefined)
  t.after(() => second.dispose())
  const secondState = (await requestState(second.getHandler(), '/plugin-updater/api/state')).body.value
  assert.notEqual(secondState.bootId, state.bootId)

  // The diagnostics surface returned by apply agrees with the route.
  const direct = await secondApi.getState()
  assert.equal(direct.bootId, secondState.bootId)
})

test('state bootId stays stable for the lifetime of one mount', async (t) => {
  withTempDshHome(t)
  const mount = makeCtx()
  const api = apply(mount.ctx, undefined)
  t.after(() => mount.dispose())

  const first = await api.getState()
  const second = await api.getState()
  assert.equal(first.bootId, second.bootId)
  assert.ok(first.config.checkOnStartup === 'force')
})

test('GET /state exposes a diagnostics field that is null before the first scan', async (t) => {
  withTempDshHome(t)
  const mount = makeCtx()
  const api = apply(mount.ctx, undefined)
  t.after(() => mount.dispose())

  const state = await api.getState()
  assert.ok('diagnostics' in state)
  assert.equal(state.diagnostics, null)
})

test('POST /diagnose returns a Diagnostics payload', async (t) => {
  withTempDshHome(t)
  const mount = makeCtx()
  apply(mount.ctx, undefined)
  t.after(() => mount.dispose())

  const response = await requestApi(mount.getHandler(), {
    method: 'POST',
    url: '/plugin-updater/api/diagnose',
    body: { force: true },
  })
  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  const result = response.body.value
  assert.equal(typeof result.checkedAt, 'string')
  assert.equal(Number.isNaN(Date.parse(result.checkedAt)), false)
  assert.ok(Array.isArray(result.scanned))
  assert.ok(Array.isArray(result.items))
  assert.ok(Array.isArray(result.errors))
  // A fresh DSH_HOME has no logs directory, so the scan reports an error rather
  // than inventing diagnostics.
  assert.equal(result.items.length, 0)
  assert.ok(result.errors.length >= 1)

  // The same result is cached and exposed on /state.
  const state = await requestApi(mount.getHandler(), { url: '/plugin-updater/api/state' })
  assert.deepEqual(state.body.value.diagnostics, result)
})

// ---------------------------------------------------------------------------
// loadFailure / selfPlugin projection
// ---------------------------------------------------------------------------

const SELF = 'dsh-plugin-update-manager'

/**
 * Build an isolated profile + DSH_HOME pair, mount the plugin on it and return
 * the web handler. `logs` are written as fresh `*.jsonl` files so the default
 * startup-time window in diagnose.js picks them up.
 *
 * @param {import('node:test').TestContext} t
 * @param {{ packages?: Record<string, string>, logs?: any[] }} [options]
 */
function mountProfile(t, options = {}) {
  const packages = options.packages ?? { 'demo-plugin': '1.0.0', 'other-plugin': '2.0.0', [SELF]: '0.1.0' }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-updater-state-'))
  const home = path.join(root, 'home')
  const dir = path.join(root, 'profile')
  const logsDir = path.join(home, 'logs')
  fs.mkdirSync(dir, { recursive: true })
  fs.mkdirSync(logsDir, { recursive: true })

  const bundles = Object.keys(packages)
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'qa-profile',
    private: true,
    dependencies: packages,
    dsh: { profile: { bundles } },
  }, null, 2) + '\n')
  for (const [name, version] of Object.entries(packages)) {
    const pkgDir = path.join(dir, 'node_modules', name)
    fs.mkdirSync(pkgDir, { recursive: true })
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name, version }, null, 2) + '\n')
  }

  if (Array.isArray(options.logs) && options.logs.length > 0) {
    const lines = options.logs.map(entry => JSON.stringify({
      time: new Date().toISOString(),
      event: 'log',
      ...entry,
    }))
    fs.writeFileSync(path.join(logsDir, 'desktop-next-test.0.jsonl'), lines.join('\n') + '\n')
  }

  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const mount = makeCtx({ name: 'qa-profile', dir, home, runtimeVersion: '0.2.1-rc.4' })
  const api = apply(mount.ctx, undefined)
  t.after(() => {
    mount.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { dir, home, api, handler: () => mount.getHandler() }
}

function rowByName(state, name) {
  const row = state.rows.find(entry => entry.name === name)
  assert.ok(row, `missing row ${name}`)
  return row
}

test('rows expose loadFailure from error diagnostics only', async (t) => {
  const mount = mountProfile(t, {
    logs: [
      {
        level: 'error',
        source: 'host.kernel.demo-plugin',
        message: 'Error: cannot get property "webServer" without inject\n    at Fiber.<anonymous>',
      },
      {
        level: 'error',
        source: 'host.kernel.other-plugin',
        message: "Error: Cannot find module '@deepseek-ai/schemastery' imported from C:\p\other-plugin\lib\index.js",
      },
      {
        level: 'warn',
        source: 'host.kernel.demo-plugin',
        message: 'tool "demo_tool" is already registered',
      },
    ],
  })

  const scanned = await requestApi(mount.handler(), {
    method: 'POST',
    url: '/plugin-updater/api/diagnose',
    body: { force: true },
  })
  assert.equal(scanned.status, 200)
  assert.ok(scanned.body.value.items.length >= 3)

  const state = (await requestApi(mount.handler(), { url: '/plugin-updater/api/state' })).body.value
  const demo = rowByName(state, 'demo-plugin')
  const other = rowByName(state, 'other-plugin')

  // The error item wins over the later warn item for the same plugin.
  assert.equal(demo.loadFailure.code, 'missing-inject')
  assert.equal(demo.loadFailure.severity, undefined)
  assert.equal(typeof demo.loadFailure.summary, 'string')
  assert.ok(demo.loadFailure.fixes.length > 0)
  assert.equal(other.loadFailure.code, 'missing-dependency')

  // selfPlugin is set for exactly one row.
  assert.equal(rowByName(state, SELF).selfPlugin, true)
  assert.equal(demo.selfPlugin, false)
  assert.equal(other.selfPlugin, false)
})

test('rows keep loadFailure null when only warn diagnostics exist', async (t) => {
  const mount = mountProfile(t, {
    logs: [
      {
        level: 'warn',
        source: 'host.kernel.demo-plugin',
        message: 'tool "demo_tool" is already registered',
      },
      {
        level: 'error',
        source: 'host.kernel.other-plugin',
        message: "Error: Cannot find module '@deepseek-ai/schemastery' imported from C:\p\other-plugin\lib\index.js",
      },
    ],
  })

  await requestApi(mount.handler(), {
    method: 'POST',
    url: '/plugin-updater/api/diagnose',
    body: { force: true },
  })

  const state = (await requestApi(mount.handler(), { url: '/plugin-updater/api/state' })).body.value
  const warnItem = state.diagnostics.items.find(item => item.plugin === 'demo-plugin')
  assert.ok(warnItem, 'expected a warn diagnostic for demo-plugin')
  assert.equal(warnItem.severity, 'warn')
  assert.equal(warnItem.code, 'duplicate-registration')

  assert.equal(rowByName(state, 'demo-plugin').loadFailure, null)
  assert.equal(rowByName(state, 'other-plugin').loadFailure.code, 'missing-dependency')
})

test('loadFailure is null for every row before the first diagnostics scan', async (t) => {
  const mount = mountProfile(t)
  const state = await mount.api.getState()
  assert.equal(state.diagnostics, null)
  assert.ok(state.rows.length > 0)
  for (const row of state.rows) assert.equal(row.loadFailure, null)
  assert.equal(state.rows.filter(row => row.selfPlugin).length, 1)
})
