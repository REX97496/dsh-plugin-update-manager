/**
 * Tiny zero-dependency HTTP helper shared by the updater's metadata readers.
 *
 * Responsibilities:
 *   - one place for request timeouts, cancellation and network error
 *     normalization (`SourceError('timeout'|'network')`);
 *   - honour an explicit `config.proxyUrl` first, then the conventional
 *     `HTTPS_PROXY` / `HTTP_PROXY` environment variables (and `NO_PROXY`);
 *   - when a proxy is in play, tunnel through it without dependencies:
 *     CONNECT for https targets, absolute-form request line for http targets.
 *
 * Data-path only: callers decide what an HTTP status means. The returned
 * `status` lets `sources.js` map 404/403/5xx onto SourceError codes.
 *
 * @module core/http
 */

import http from 'node:http'
import https from 'node:https'
import { Buffer } from 'node:buffer'

const DEFAULT_TIMEOUT_MS = 8000

/**
 * Documented error type for the sources layer (re-exported by sources.js).
 * It lives here as well so http.js can normalize transport failures without a
 * circular import between the two modules.
 */
export class SourceError extends Error {
  /**
   * @param {string} code Machine-readable code (`timeout`, `network`,
   *   `not-found`, `private`, `invalid-repo`, `rate-limit`, `bad-response`).
   * @param {string} message Human readable, Chinese, safe for the UI.
   * @param {{status?: number, detail?: string}} [options]
   */
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'SourceError'
    this.code = code
    if (typeof options.status === 'number') this.status = options.status
    if (typeof options.detail === 'string') this.detail = options.detail
  }
}

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
 * @returns {number} Positive integer timeout in milliseconds.
 */
export function normalizeTimeout(value, fallback = DEFAULT_TIMEOUT_MS) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}

/**
 * @param {unknown} raw
 * @returns {{protocol: string, host: string, port: number, auth: string}|null}
 */
function parseProxyUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  let parsed
  try {
    parsed = new URL(raw.trim())
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  const port = parsed.port !== '' ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) return null
  let auth = ''
  if (parsed.username !== '' || parsed.password !== '') {
    auth = `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`
  }
  return { protocol: parsed.protocol, host: parsed.hostname, port, auth }
}

/**
 * Minimal `NO_PROXY` support: `*`, exact hosts, domain suffixes (with or
 * without leading dot) and optional `:port` suffixes.
 *
 * @param {string} hostname
 * @param {string} [port]
 * @returns {boolean}
 */
function matchesNoProxy(hostname, port) {
  const raw = process.env.NO_PROXY ?? process.env.no_proxy
  if (typeof raw !== 'string' || raw.trim() === '') return false
  const host = hostname.toLowerCase()
  for (const entry of raw.split(',')) {
    let pattern = entry.trim().toLowerCase()
    if (pattern === '') continue
    if (pattern === '*') return true
    if (pattern.includes(':') && !pattern.startsWith('[')) {
      const [hostPart, portPart] = pattern.split(':')
      if (portPart !== '' && portPart !== String(port)) continue
      pattern = hostPart
    }
    if (pattern.startsWith('.')) {
      if (host === pattern.slice(1) || host.endsWith(pattern)) return true
      continue
    }
    if (host === pattern || host.endsWith(`.${pattern}`)) return true
  }
  return false
}

/**
 * Decide which proxy (if any) applies to a URL.
 *
 * Priority: `config.proxyUrl` → `HTTPS_PROXY`/`https_proxy` for https targets
 * (then `HTTP_PROXY` as a fallback) → `HTTP_PROXY`/`http_proxy` for http
 * targets. `NO_PROXY` always wins.
 *
 * @param {string} url
 * @param {unknown} [config]
 * @returns {{proxy: {protocol: string, host: string, port: number, auth: string}, raw: string, source: 'config'|'env', envKey?: string}|null}
 */
export function detectProxy(url, config) {
  let target
  try {
    target = new URL(url)
  } catch {
    return null
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return null
  if (matchesNoProxy(target.hostname, target.port)) return null

  const cfg = isRecord(config) ? config : {}
  const configured = typeof cfg.proxyUrl === 'string' ? cfg.proxyUrl.trim() : ''
  if (configured !== '') {
    const proxy = parseProxyUrl(configured)
    if (proxy !== null) return { proxy, raw: configured, source: 'config' }
  }

  const readEnv = (key) => {
    const value = process.env[key]
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : ''
  }
  const keys = target.protocol === 'https:'
    ? ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']
    : ['HTTP_PROXY', 'http_proxy']
  for (const key of keys) {
    const raw = readEnv(key)
    if (raw === '') continue
    const proxy = parseProxyUrl(raw)
    if (proxy !== null) return { proxy, raw, source: 'env', envKey: key }
  }
  return null
}

/**
 * @param {string} message
 * @param {string} url
 * @param {{status?: number}} [extra]
 * @returns {SourceError}
 */
function transportError(message, url, extra = {}) {
  return new SourceError('network', message, { detail: url, ...extra })
}

/**
 * Normalize a thrown fetch error. Node throws `TimeoutError` when
 * `AbortSignal.timeout()` fires and `AbortError` when the caller cancels.
 *
 * @param {unknown} error
 * @param {{url: string, signal?: AbortSignal|null, timeoutSignal: AbortSignal, timeoutMs: number}} context
 * @returns {SourceError}
 */
function normalizeFetchError(error, context) {
  if (context.signal && context.signal.aborted) {
    return transportError('请求已取消', context.url)
  }
  if (context.timeoutSignal.aborted) {
    return new SourceError('timeout', `请求超时（${context.timeoutMs}ms）`, { detail: context.url })
  }
  const detail = error instanceof Error ? error.message : String(error)
  return transportError(`网络请求失败：${detail}`, context.url, {})
}

/**
 * @typedef {{status: number, ok: boolean, headers: Record<string, string>, buffer: Buffer, url: string}} RawResponse
 */

/**
 * Direct request through the global fetch. Kept as a standalone function so
 * tests can replace `globalThis.fetch` at call time.
 *
 * @param {string} url
 * @param {{headers?: Record<string, string>, signal?: AbortSignal|null, timeoutMs: number}} options
 * @returns {Promise<RawResponse>}
 */
async function requestDirect(url, options) {
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs)
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal
  const context = { url, signal: options.signal ?? null, timeoutSignal, timeoutMs: options.timeoutMs }

  let response
  try {
    response = await globalThis.fetch(url, { headers: options.headers ?? {}, signal, redirect: 'follow' })
  } catch (error) {
    throw normalizeFetchError(error, context)
  }

  let buffer
  try {
    buffer = Buffer.from(await response.arrayBuffer())
  } catch (error) {
    throw normalizeFetchError(error, context)
  }

  /** @type {Record<string, string>} */
  const headers = {}
  try {
    for (const [key, value] of response.headers.entries()) headers[key.toLowerCase()] = value
  } catch {
    // Non-standard response objects are allowed; status/body are what matter.
  }

  return {
    status: Number(response.status) || 0,
    ok: response.status >= 200 && response.status < 300,
    headers,
    buffer,
    url: typeof response.url === 'string' && response.url !== '' ? response.url : url,
  }
}

/**
 * Request through an HTTP(S) proxy.
 *
 * http targets use the absolute-form request line; https targets open a
 * CONNECT tunnel first and then run TLS over the tunnel socket.
 *
 * @param {string} url
 * @param {{protocol: string, host: string, port: number, auth: string}} proxy
 * @param {{headers?: Record<string, string>, signal?: AbortSignal|null, timeoutMs: number}} options
 * @returns {Promise<RawResponse>}
 */
function requestViaProxy(url, proxy, options) {
  const target = new URL(url)
  const isHttps = target.protocol === 'https:'
  const proxyModule = proxy.protocol === 'https:' ? https : http
  const timeoutMs = options.timeoutMs

  return new Promise((resolve, reject) => {
    let settled = false
    /** @type {import('node:http').ClientRequest|null} */
    let activeRequest = null
    /** @type {NodeJS.Timeout|null} */
    let timer = null

    const cleanup = () => {
      if (timer !== null) clearTimeout(timer)
      if (options.signal) options.signal.removeEventListener('abort', onAbort)
    }
    function fail(code, message, detail) {
      if (settled) return
      settled = true
      cleanup()
      if (activeRequest !== null) {
        try {
          activeRequest.destroy()
        } catch {
          // Already destroyed.
        }
      }
      reject(new SourceError(code, message, { detail }))
    }
    function onAbort() {
      fail('network', '请求已取消', url)
    }
    function succeed(response) {
      if (settled) return
      settled = true
      cleanup()
      resolve(response)
    }
    /**
     * @param {import('node:http').IncomingMessage} response
     */
    function collect(response) {
      /** @type {Buffer[]} */
      const chunks = []
      response.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })
      response.on('end', () => {
        /** @type {Record<string, string>} */
        const headers = {}
        if (isRecord(response.headers)) {
          for (const [key, value] of Object.entries(response.headers)) {
            if (typeof value === 'string') headers[key.toLowerCase()] = value
            else if (Array.isArray(value)) headers[key.toLowerCase()] = value.join(', ')
          }
        }
        const status = Number(response.statusCode) || 0
        succeed({
          status,
          ok: status >= 200 && status < 300,
          headers,
          buffer: Buffer.concat(chunks),
          url,
        })
      })
      response.on('error', (error) => {
        fail('network', `读取代理响应失败：${error instanceof Error ? error.message : String(error)}`, url)
      })
    }

    /** @param {Record<string, string>} headers */
    function withProxyAuth(headers) {
      if (proxy.auth === '') return headers
      return {
        ...headers,
        'Proxy-Authorization': `Basic ${Buffer.from(proxy.auth).toString('base64')}`,
      }
    }

    /** @type {Record<string, string>} */
    const headers = withProxyAuth(options.headers ?? {})

    if (isHttps) {
      const connectRequest = proxyModule.request({
        host: proxy.host,
        port: proxy.port,
        method: 'CONNECT',
        path: `${target.hostname}:${target.port !== '' ? target.port : 443}`,
        headers: { host: target.hostname, ...headers },
      })
      activeRequest = connectRequest
      connectRequest.once('connect', (response, socket, head) => {
        if (response.statusCode !== 200) {
          fail('network', `代理 CONNECT 失败（HTTP ${response.statusCode ?? 0}）`, url)
          socket.destroy()
          return
        }
        if (head !== undefined && head.length > 0) socket.unshift(head)
        const request = https.request(
          {
            host: target.hostname,
            port: target.port !== '' ? Number(target.port) : 443,
            method: 'GET',
            path: `${target.pathname}${target.search}`,
            headers: options.headers ?? {},
            agent: false,
            createConnection: () => socket,
          },
          collect,
        )
        activeRequest = request
        request.once('error', (error) => {
          fail('network', `代理请求失败：${error instanceof Error ? error.message : String(error)}`, url)
        })
        request.end()
      })
      connectRequest.once('error', (error) => {
        fail('network', `代理连接失败：${error instanceof Error ? error.message : String(error)}`, url)
      })
      connectRequest.end()
    } else {
      const request = http.request(
        {
          host: proxy.host,
          port: proxy.port,
          method: 'GET',
          path: url,
          headers: { ...headers, host: target.host },
        },
        collect,
      )
      activeRequest = request
      request.once('error', (error) => {
        fail('network', `代理请求失败：${error instanceof Error ? error.message : String(error)}`, url)
      })
      request.end()
    }

    timer = setTimeout(() => {
      fail('timeout', `请求超时（${timeoutMs}ms）`, url)
    }, timeoutMs)
    if (options.signal) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/**
 * Perform one GET request and buffer the whole body.
 *
 * @param {string} url
 * @param {{headers?: Record<string, string>, timeoutMs?: number, signal?: AbortSignal|null, config?: unknown}} [options]
 * @returns {Promise<RawResponse>}
 */
async function request(url, options = {}) {
  if (typeof url !== 'string' || url === '') {
    throw new SourceError('network', '请求地址为空', { detail: String(url) })
  }
  const timeoutMs = normalizeTimeout(options.timeoutMs)
  const headers = isRecord(options.headers) ? { ...options.headers } : {}
  const proxy = detectProxy(url, options.config)
  if (proxy === null) return requestDirect(url, { headers, signal: options.signal ?? null, timeoutMs })
  return requestViaProxy(url, proxy.proxy, { headers, signal: options.signal ?? null, timeoutMs })
}

/**
 * GET and decode the body as UTF-8 text.
 *
 * @param {string} url
 * @param {Parameters<typeof request>[1]} [options]
 * @returns {Promise<{status: number, ok: boolean, headers: Record<string, string>, text: string, url: string}>}
 */
export async function fetchText(url, options) {
  const response = await request(url, options)
  return {
    status: response.status,
    ok: response.ok,
    headers: response.headers,
    text: response.buffer.toString('utf8'),
    url: response.url,
  }
}

/**
 * GET and parse the body as JSON. Non-2xx responses are returned with
 * `json: null` (status handling belongs to the caller); malformed JSON on a
 * 2xx response throws `SourceError('bad-response')`.
 *
 * @param {string} url
 * @param {Parameters<typeof request>[1]} [options]
 * @returns {Promise<{status: number, ok: boolean, headers: Record<string, string>, json: unknown, text: string, url: string}>}
 */
export async function fetchJson(url, options) {
  const response = await fetchText(url, options)
  if (!response.ok) return { ...response, json: null }
  try {
    return { ...response, json: JSON.parse(response.text) }
  } catch {
    throw new SourceError('bad-response', `响应不是合法 JSON：${url}`, {
      status: response.status,
      detail: response.text.slice(0, 300),
    })
  }
}

/**
 * GET and return the raw body as a Buffer.
 *
 * @param {string} url
 * @param {Parameters<typeof request>[1]} [options]
 * @returns {Promise<{status: number, ok: boolean, headers: Record<string, string>, buffer: Buffer, url: string}>}
 */
export async function fetchBuffer(url, options) {
  const response = await request(url, options)
  return {
    status: response.status,
    ok: response.ok,
    headers: response.headers,
    buffer: response.buffer,
    url: response.url,
  }
}
