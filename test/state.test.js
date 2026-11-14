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
 */
function makeCtx() {
  const disposers = []
  let handler = null
  return {
    ctx: {
      logger: { info() {} },
      get() { return undefined },
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
