// Sofia gateway — one origin for the whole product.
//
// WHY THIS EXISTS
// The browser cannot talk to Hermes directly: a request carrying a browser
// Origin gets 403 with no access-control-* headers back, because the Hermes
// api_server has no CORS middleware. Rather than bolt CORS onto the brain, the
// app and its API are served from one origin by this process:
//
//   GET  /                -> the built AIRI stage (static, SPA fallback)
//   ANY  /v1/*            -> proxied to Hermes /p/sofia/v1/*, key injected here
//   POST /api/live/token   -> Gemini ephemeral token (phase 03)
//   GET  /healthz          -> liveness + upstream reachability
//
// Consequence: the browser never holds the Hermes key, there is no preflight,
// and there is no such thing as a cross-origin request in production.
//
// No dependencies on purpose — this must run inside a minimal container and be
// readable a year from now.
import { createServer, request as httpRequest } from 'node:http'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'

const PORT = Number(process.env.PORT || 8787)
const HOST = process.env.HOST || '127.0.0.1'
const DIST = resolve(process.env.DIST_DIR || '../stage-web/dist')
const HERMES_BASE = process.env.HERMES_BASE || 'http://127.0.0.1:8643/p/sofia/v1'
const HERMES_KEY_FILE = process.env.HERMES_KEY_FILE || '/run/secrets/hermes_sofia_key'

function hermesKey() {
  if (process.env.HERMES_KEY) return process.env.HERMES_KEY.trim()
  try {
    return readFileSync(HERMES_KEY_FILE, 'utf8').trim()
  } catch {
    return ''
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.map': 'application/json; charset=utf-8',
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** Proxy everything under /v1 to Hermes, adding the key on this side. */
function proxyToHermes(req, res, url) {
  const key = hermesKey()
  if (!key) {
    sendJson(res, 503, { error: 'gateway has no Hermes key (set HERMES_KEY or HERMES_KEY_FILE)' })
    return
  }

  // /v1/models -> <base>/models
  const suffix = url.pathname.replace(/^\/v1/, '')
  const target = new URL(HERMES_BASE + suffix + (url.search || ''))

  const headers = { ...req.headers }
  delete headers.host
  delete headers['content-length']
  headers.authorization = `Bearer ${key}`
  headers['x-sofia-via'] = 'gateway'

  const upstream = httpRequest(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: req.method,
      headers,
    },
    (up) => {
      // Stream straight through: SSE from /v1/runs must not be buffered.
      res.writeHead(up.statusCode || 502, up.headers)
      up.pipe(res)
    },
  )

  upstream.on('error', (err) => {
    if (!res.headersSent) sendJson(res, 502, { error: `upstream: ${err.message}` })
    else res.end()
  })

  req.pipe(upstream)
}

function serveStatic(req, res, url) {
  const requested = decodeURIComponent(url.pathname)
  const rel = normalize(requested).replace(/^(\.\.[/\\])+/, '')
  let file = join(DIST, rel)

  if (!existsSync(DIST)) {
    sendJson(res, 503, { error: `stage not built: ${DIST} missing. Run pnpm -F @proj-airi/stage-web build` })
    return
  }

  // SPA fallback: unknown paths get index.html, assets 404 honestly.
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (extname(requested)) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }
    file = join(DIST, 'index.html')
  }

  const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream'
  const immutable = /\/assets\/.+\.[0-9a-f]{6,}\./i.test(file)
  res.writeHead(200, {
    'content-type': type,
    // Hashed assets can cache hard; everything else must revalidate, or a
    // deploy keeps serving yesterday's bundle (this exact bug cost a day).
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  createReadStream(file).pipe(res)
}

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

  if (url.pathname === '/healthz') {
    const key = hermesKey()
    const probe = new URL(HERMES_BASE + '/models')
    const r = httpRequest(
      { hostname: probe.hostname, port: probe.port, path: probe.pathname, method: 'GET', headers: { authorization: `Bearer ${key}` } },
      (up) => {
        up.resume()
        sendJson(res, 200, {
          ok: true,
          stage: existsSync(join(DIST, 'index.html')),
          hermes: up.statusCode === 200 ? 'reachable' : `status ${up.statusCode}`,
          key: key ? 'set' : 'missing',
        })
      },
    )
    r.on('error', (e) => sendJson(res, 200, { ok: false, stage: existsSync(join(DIST, 'index.html')), hermes: `unreachable: ${e.message}`, key: key ? 'set' : 'missing' }))
    r.setTimeout(4000, () => r.destroy(new Error('timeout')))
    r.end()
    return
  }

  if (url.pathname.startsWith('/v1/')) {
    proxyToHermes(req, res, url)
    return
  }

  if (url.pathname.startsWith('/api/')) {
    // Phase 03 fills this in; saying "not implemented" beats a silent 404.
    sendJson(res, 501, { error: 'not implemented yet', path: url.pathname })
    return
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'method not allowed' })
    return
  }

  serveStatic(req, res, url)
})

server.listen(PORT, HOST, () => {
  console.log(`[sofia-gateway] http://${HOST}:${PORT}  stage=${DIST}  hermes=${HERMES_BASE}`)
  console.log(`[sofia-gateway] key: ${hermesKey() ? 'loaded' : 'MISSING — /v1 will answer 503'}`)
})
