import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { listVersions, SourceError } from '../lib/core/sources.js'
import { normalizeConfig } from '../lib/core/store.js'

const COMPATIBLE = { engines: { dsh: '>=0.2.1-rc.1 <0.4.0' } }

/** Local npm registry stub; returns the base URL and the recorded requests. */
async function startRegistry(t, handler) {
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers })
    handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return { base: `http://127.0.0.1:${port}`, requests }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

function config(overrides = {}) {
  return normalizeConfig(overrides)
}

/** npm Response object for the GitHub stubs (Node 24 has a global Response). */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Replace global fetch for GitHub tests: the GitHub source cannot be pointed
 * at a local registry through config, and the contract forbids injecting a
 * fetch option, so the stub patches the global the module calls.
 */
function stubFetch(t, handler) {
  const realFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url)
    calls.push({ url: target, init })
    return handler(target, init)
  }
  t.after(() => {
    globalThis.fetch = realFetch
  })
  return calls
}

test('npm: abbreviated metadata is parsed from a custom registry', async (t) => {
  const { base, requests } = await startRegistry(t, (req, res) => {
    sendJson(res, 200, {
      name: 'demo-plugin',
      'dist-tags': { latest: '1.2.0' },
      versions: {
        '1.0.0': {
          name: 'demo-plugin',
          version: '1.0.0',
          engines: COMPATIBLE.engines,
          dist: { tarball: `${'http://example.invalid'}/demo-plugin-1.0.0.tgz` },
        },
        '1.2.0': {
          name: 'demo-plugin',
          version: '1.2.0',
          peerDependencies: { '@deepseek-ai/dsh': '>=0.2.1-rc.1 <0.4.0' },
          dist: { tarball: 'http://example.invalid/demo-plugin-1.2.0.tgz' },
        },
      },
    })
  })

  const result = await listVersions({
    name: 'demo-plugin',
    source: 'npm-official',
    config: config({ customRegistry: base }),
  })

  assert.equal(result.source, 'npm-official')
  assert.equal(result.registryUrl, base)
  assert.equal(result.latest, '1.2.0')
  assert.equal(result.fetchedAt !== undefined && Number.isFinite(Date.parse(result.fetchedAt)), true)
  assert.deepEqual(
    result.versions.map((entry) => entry.version).sort(),
    ['1.0.0', '1.2.0'],
  )
  const newest = result.versions.find((entry) => entry.version === '1.2.0')
  assert.equal(newest.manifest.peerDependencies['@deepseek-ai/dsh'], '>=0.2.1-rc.1 <0.4.0')
  assert.equal(newest.dist.tarball, 'http://example.invalid/demo-plugin-1.2.0.tgz')
  assert.equal(newest.installSpec, 'demo-plugin@1.2.0')

  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, '/demo-plugin')
  assert.equal(requests[0].headers.accept, 'application/vnd.npm.install-v1+json')
})

test('npm: scoped package names are percent-encoded', async (t) => {
  const { base, requests } = await startRegistry(t, (req, res) => {
    sendJson(res, 200, {
      name: '@scope/demo',
      'dist-tags': { latest: '0.1.0' },
      versions: { '0.1.0': { name: '@scope/demo', version: '0.1.0', engines: COMPATIBLE.engines } },
    })
  })

  const result = await listVersions({
    name: '@scope/demo',
    source: 'npm-mirror',
    config: config({ customRegistry: base }),
  })
  assert.equal(result.latest, '0.1.0')
  assert.equal(requests[0].url, '/@scope%2Fdemo')
})

test('npm: default registries per source', async (t) => {
  // No requests are allowed to leave the machine: only assert the URL the
  // module would have used by capturing fetch.
  const calls = stubFetch(t, () =>
    json({ name: 'demo', 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { name: 'demo', version: '1.0.0' } } }),
  )
  const official = await listVersions({ name: 'demo', source: 'npm-official', config: config({}) })
  assert.equal(official.registryUrl, 'https://registry.npmjs.org')
  assert.equal(calls[0].url, 'https://registry.npmjs.org/demo')

  const mirror = await listVersions({ name: 'demo', source: 'npm-mirror', config: config({}) })
  assert.equal(mirror.registryUrl, 'https://registry.npmmirror.com')
  assert.equal(calls[1].url, 'https://registry.npmmirror.com/demo')
})

test('npm: 404 becomes SourceError(not-found)', async (t) => {
  const { base } = await startRegistry(t, (req, res) => {
    sendJson(res, 404, { error: 'Not found' })
  })

  await assert.rejects(
    listVersions({ name: 'missing-pkg', source: 'npm-official', config: config({ customRegistry: base }) }),
    (error) => {
      assert.ok(error instanceof SourceError)
      assert.equal(error.code, 'not-found')
      return true
    },
  )
})

test('npm: request timeout becomes SourceError(timeout)', async (t) => {
  const { base } = await startRegistry(t, (req, res) => {
    // Answer too late; the client must have given up already. The per-call
    // timeoutMs option wins over config.requestTimeoutMs (which store clamps
    // to a 1000ms floor), so a short 120ms deadline is honoured here.
    const timer = setTimeout(() => {
      if (!res.writableEnded) sendJson(res, 200, { name: 'slow', 'dist-tags': { latest: '1.0.0' }, versions: {} })
    }, 500)
    res.on('close', () => clearTimeout(timer))
  })

  await assert.rejects(
    listVersions({
      name: 'slow-pkg',
      source: 'npm-official',
      timeoutMs: 120,
      config: config({ customRegistry: base }),
    }),
    (error) => {
      assert.ok(error instanceof SourceError)
      assert.equal(error.code, 'timeout')
      return true
    },
  )
})

test('npm: proxy environment is reported as a warning (node fetch ignores it)', async (t) => {
  const previous = process.env.HTTPS_PROXY
  process.env.HTTPS_PROXY = 'http://127.0.0.1:3128'
  t.after(() => {
    if (previous === undefined) delete process.env.HTTPS_PROXY
    else process.env.HTTPS_PROXY = previous
  })

  const { base } = await startRegistry(t, (req, res) => {
    sendJson(res, 200, { name: 'demo', 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { name: 'demo', version: '1.0.0' } } })
  })
  const result = await listVersions({ name: 'demo', source: 'npm-official', config: config({ customRegistry: base }) })
  assert.ok(
    result.warnings.some((warning) => /proxy|代理/i.test(warning)),
    `expected a proxy warning, got ${JSON.stringify(result.warnings)}`,
  )
})

test('github: release asset tarball is preferred over the source archive', async (t) => {
  const calls = stubFetch(t, (url) => {
    if (url.includes('api.github.com/repos/owner/repo/releases')) {
      return json([
        {
          tag_name: 'v1.2.3',
          assets: [
            { name: 'demo-1.2.3.tgz', browser_download_url: 'https://github.com/owner/repo/releases/download/v1.2.3/demo-1.2.3.tgz' },
          ],
        },
      ])
    }
    if (url.includes('raw.githubusercontent.com/owner/repo/v1.2.3/package.json')) {
      return json({ name: 'demo', version: '1.2.3', ...COMPATIBLE })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })

  const result = await listVersions({
    name: 'demo',
    source: 'github',
    config: config({}),
    manifest: { name: 'demo', repository: { type: 'git', url: 'git+https://github.com/owner/repo.git' } },
  })

  assert.deepEqual(result.repo, { owner: 'owner', repo: 'repo' })
  assert.equal(result.latest, '1.2.3')
  assert.equal(result.versions.length, 1)
  const entry = result.versions[0]
  assert.equal(entry.version, '1.2.3')
  assert.equal(entry.installKind, 'tarball')
  // Release assets install directly as a URL: a `github:` spec would make
  // pnpm 12 run the package's `prepare` script, which its default
  // allowBuilds:[] rejects (ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED).
  assert.equal(entry.installSpec, 'https://github.com/owner/repo/releases/download/v1.2.3/demo-1.2.3.tgz')
  assert.equal(entry.dist.tarball, 'https://github.com/owner/repo/releases/download/v1.2.3/demo-1.2.3.tgz')
  assert.equal(entry.manifest.engines.dsh, COMPATIBLE.engines.dsh)
  assert.equal(
    result.warnings.some((warning) => warning.startsWith('source-tarball')),
    false,
  )
  assert.ok(calls.some((call) => call.url.includes('api.github.com')))
})

test('github: tags fall back and produce a source-tarball warning', async (t) => {
  stubFetch(t, (url) => {
    if (url.includes('/releases')) return json([])
    if (url.includes('/tags')) return json([{ name: 'v2.0.0' }, { name: 'nightly' }])
    if (url.includes('raw.githubusercontent.com/owner/repo/v2.0.0/package.json')) {
      return json({ name: 'demo', version: '2.0.0', ...COMPATIBLE })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })

  const result = await listVersions({
    name: 'demo',
    source: 'github',
    config: config({}),
    manifest: { repository: 'https://github.com/owner/repo' },
  })

  assert.equal(result.latest, '2.0.0')
  assert.deepEqual(
    result.versions.map((entry) => entry.version),
    ['2.0.0'],
  )
  assert.equal(result.versions[0].installKind, 'source-tarball')
  assert.equal(result.versions[0].installSpec, 'github:owner/repo#v2.0.0')
  const sourceWarning = result.warnings.find((warning) => warning.startsWith('source-tarball'))
  assert.ok(sourceWarning, JSON.stringify(result.warnings))
  // The warning has to tell the user *why* this candidate is a bad idea and
  // what to do instead; keep the actionable keywords pinned.
  assert.ok(sourceWarning.includes('release 资产'), sourceWarning)
  assert.ok(sourceWarning.includes('建议改用 npm'), sourceWarning)
})

test('github-mirror: prefixes are tried in order and the working one is remembered', async (t) => {
  const failures = new Set()
  const calls = stubFetch(t, (url) => {
    if (url.startsWith('https://mirror-one.example/')) {
      failures.add(url)
      throw new TypeError('fetch failed')
    }
    if (url.startsWith('https://mirror-two.example/')) {
      const inner = url.slice('https://mirror-two.example/'.length)
      if (inner.includes('/releases')) {
        return json([
          { tag_name: 'v3.1.0', assets: [{ name: 'demo-3.1.0.tgz', browser_download_url: 'https://github.com/owner/repo/releases/download/v3.1.0/demo-3.1.0.tgz' }] },
        ])
      }
      if (inner.includes('/package.json')) return json({ name: 'demo', version: '3.1.0', ...COMPATIBLE })
      throw new Error(`unexpected inner fetch: ${inner}`)
    }
    throw new Error(`unexpected fetch: ${url}`)
  })

  const mirrorConfig = config({
    githubMirrorPrefixes: ['https://mirror-one.example', 'https://mirror-two.example'],
  })
  const manifest = { repository: { url: 'https://github.com/owner/repo' } }

  const first = await listVersions({ name: 'demo', source: 'github-mirror', config: mirrorConfig, manifest })
  assert.equal(first.latest, '3.1.0')
  assert.equal(first.versions[0].installKind, 'tarball')
  assert.ok(failures.size >= 1, 'the first prefix should have been attempted')
  // Every outbound URL is <prefix>/<original absolute URL>.
  const firstPrefixCalls = calls.filter((call) => call.url.startsWith('https://mirror-one.example/'))
  assert.ok(firstPrefixCalls.length >= 1)
  for (const call of firstPrefixCalls) {
    assert.match(call.url, /^https:\/\/mirror-one\.example\/https:\/\//)
  }
  assert.ok(
    first.warnings.some((warning) => warning.includes('mirror-two.example')),
    `expected the active prefix in warnings, got ${JSON.stringify(first.warnings)}`,
  )

  // A second lookup in the same process should start from the remembered prefix.
  calls.length = 0
  const second = await listVersions({ name: 'demo', source: 'github-mirror', config: mirrorConfig, manifest })
  assert.equal(second.latest, '3.1.0')
  assert.equal(calls[0].url.startsWith('https://mirror-two.example/'), true, calls[0].url)
  assert.equal(
    calls.some((call) => call.url.startsWith('https://mirror-one.example/')),
    false,
  )
  // The install address itself goes through the working mirror prefix, so pnpm
  // downloads the release asset from the reachable host instead of GitHub.
  assert.equal(
    second.versions[0].installSpec,
    'https://mirror-two.example/https://github.com/owner/repo/releases/download/v3.1.0/demo-3.1.0.tgz',
  )
  assert.ok(
    second.warnings.some((warning) => warning.startsWith('github-mirror:') && warning.includes('安装地址使用镜像前缀')),
    JSON.stringify(second.warnings),
  )
})

test('github: a release without .tgz assets falls back to a source tarball', async (t) => {
  stubFetch(t, (url) => {
    if (url.includes('/releases')) {
      return json([
        // Non-archive assets do not count: pnpm would have to build the source.
        { tag_name: 'v4.0.0', assets: [{ name: 'checksums.txt', browser_download_url: 'https://github.com/owner/repo/releases/download/v4.0.0/checksums.txt' }] },
      ])
    }
    if (url.includes('/package.json')) return json({ name: 'demo', version: '4.0.0', ...COMPATIBLE })
    throw new Error(`unexpected fetch: ${url}`)
  })

  const result = await listVersions({
    name: 'demo',
    source: 'github',
    config: config({}),
    manifest: { repository: 'https://github.com/owner/repo' },
  })
  assert.equal(result.versions[0].installKind, 'source-tarball')
  assert.ok(result.versions[0].installSpec.startsWith('github:owner/repo#'), result.versions[0].installSpec)
  const sourceWarning = result.warnings.find((warning) => warning.startsWith('source-tarball'))
  assert.ok(sourceWarning, JSON.stringify(result.warnings))
  assert.ok(sourceWarning.includes('release 资产'), sourceWarning)
  assert.ok(sourceWarning.includes('建议改用 npm'), sourceWarning)
})

test('github: non-semver tags are ignored and missing raw manifest is tolerated', async (t) => {
  stubFetch(t, (url) => {
    if (url.includes('/releases')) return json([])
    if (url.includes('/tags')) return json([{ name: 'v1.0.0' }, { name: 'latest' }, { name: 'v1.1.0-beta.1' }])
    if (url.includes('raw.githubusercontent.com')) return json({}, 404)
    throw new Error(`unexpected fetch: ${url}`)
  })

  const result = await listVersions({
    name: 'demo',
    source: 'github',
    config: config({}),
    manifest: { repository: 'owner/repo' },
  })
  assert.deepEqual(
    result.versions.map((entry) => entry.version),
    ['1.0.0', '1.1.0-beta.1'],
  )
  for (const entry of result.versions) assert.equal(entry.manifest, null)
  // Without a manifest the candidate is still listed but cannot be recommended.
  assert.equal(result.latest, '1.1.0-beta.1')
})

test('github-mirror: a bare 403 (mirror throttling) rotates to the next prefix', async (t) => {
  // gh-proxy / ghfast / ghproxy answer with a plain 403 when they throttle or
  // refuse the upstream request; that must not abort the whole sweep.
  const calls = stubFetch(t, (url) => {
    if (url.startsWith('https://mirror-alpha.example/')) return json({ message: 'Forbidden' }, 403)
    if (url.startsWith('https://mirror-beta.example/')) {
      const inner = url.slice('https://mirror-beta.example/'.length)
      if (inner.includes('/releases')) {
        return json([
          { tag_name: 'v4.2.0', assets: [{ name: 'demo-4.2.0.tgz', browser_download_url: 'https://github.com/owner/repo/releases/download/v4.2.0/demo-4.2.0.tgz' }] },
        ])
      }
      if (inner.includes('/package.json')) return json({ name: 'demo', version: '4.2.0', ...COMPATIBLE })
      throw new Error(`unexpected inner fetch: ${inner}`)
    }
    throw new Error(`unexpected fetch: ${url}`)
  })

  const mirrorConfig = config({
    githubMirrorPrefixes: ['https://mirror-alpha.example', 'https://mirror-beta.example'],
  })
  const result = await listVersions({
    name: 'demo',
    source: 'github-mirror',
    config: mirrorConfig,
    manifest: { repository: 'owner/repo' },
  })

  assert.equal(result.latest, '4.2.0')
  assert.ok(
    calls.some((call) => call.url.startsWith('https://mirror-alpha.example/')),
    JSON.stringify(calls.map((call) => call.url)),
  )
  assert.ok(
    result.warnings.some((warning) => warning.includes('mirror-alpha.example') && warning.includes('rate-limit')),
    JSON.stringify(result.warnings),
  )
  assert.ok(
    result.warnings.some((warning) => warning.includes('mirror-beta.example')),
    JSON.stringify(result.warnings),
  )
  // The remembered working prefix is also used for the install address.
  assert.equal(
    result.versions[0].installSpec,
    'https://mirror-beta.example/https://github.com/owner/repo/releases/download/v4.2.0/demo-4.2.0.tgz',
  )
})

test('github-mirror: a 403 on every prefix surfaces as SourceError(rate-limit)', async (t) => {
  const calls = stubFetch(t, () => json({ message: 'Forbidden' }, 403))
  const mirrorConfig = config({
    githubMirrorPrefixes: [
      'https://mirror-c1.example',
      'https://mirror-c2.example',
      'https://mirror-c3.example',
    ],
  })

  await assert.rejects(
    () =>
      listVersions({
        name: 'demo',
        source: 'github-mirror',
        config: mirrorConfig,
        manifest: { repository: 'owner/repo' },
      }),
    (error) => {
      assert.ok(error instanceof SourceError, String(error))
      assert.equal(error.code, 'rate-limit')
      return true
    },
  )
  assert.ok(calls.length >= 3, `expected all prefixes to be attempted, got ${calls.length}`)
})
