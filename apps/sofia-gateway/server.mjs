// Sofia gateway — one origin for the whole product.
//
// WHY THIS EXISTS
// The browser cannot talk to Hermes directly: a request carrying a browser
// Origin gets 403 with no access-control-* headers back, because the Hermes
// api_server has no CORS middleware. Rather than bolt CORS onto the brain, the
// app and its API are served from one origin by this process:
//
//   GET  /                 -> the built AIRI stage (static, SPA fallback)
//   ANY  /v1/*             -> proxied to Hermes /p/sofia/v1/*, key injected here
//   GET  /api/live/info    -> which live model/voice this build talks to
//   WS   /api/live/stream  -> duplex voice: browser <-> gateway <-> Gemini Live
//   GET  /healthz          -> liveness, upstream reachability, live config
//
// Consequence: the browser never holds a Hermes key or a Google credential,
// there is no preflight, and there is no such thing as a cross-origin request
// in production.
//
// Three jobs the proxy does that a plain proxy would not:
//   1. drops the browser Origin (Hermes 403s on it),
//   2. strips model reasoning from completions (the body is a mouth, not a mind),
//   3. holds the Live socket so voice needs no client-side secret.
import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { appendFileSync, createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'

import { WebSocketServer } from 'ws'

import { DEFAULT_MODEL, DEFAULT_VOICE, LiveBridge } from './live.mjs'
import { SseReasoningFilter, stripReasoningFromBody } from './reasoning-filter.mjs'

const PORT = Number(process.env.PORT || 8787)
const HOST = process.env.HOST || '127.0.0.1'
const DIST = resolve(process.env.DIST_DIR || '../stage-web/dist')
const PUBLIC = resolve(process.env.PUBLIC_DIR || './public')
const HERMES_BASE = process.env.HERMES_BASE || 'http://127.0.0.1:8643/p/sofia/v1'
const HERMES_KEY_FILE = process.env.HERMES_KEY_FILE || '/run/secrets/hermes_sofia_key'
const TRACE = process.env.TRACE === '1'
const KEEP_REASONING = process.env.KEEP_REASONING === '1'

const SYSTEM_INSTRUCTION = process.env.LIVE_SYSTEM_INSTRUCTION
  || 'You are Sofia, a warm, quick-witted personal assistant. Speak naturally and briefly — one or two sentences unless asked for detail. Never read out formatting, markdown, lists, URLs or code; say the meaning instead.'

function hermesKey() {
  if (process.env.HERMES_KEY) return process.env.HERMES_KEY.trim()
  try {
    return readFileSync(HERMES_KEY_FILE, 'utf8').trim()
  }
  catch {
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

// http.request speaks plaintext whatever the URL says, so an https upstream
// answers 301 and every proxied call fails. Pick the matching client.
function requestFor(target) {
  return target.protocol === 'https:' ? httpsRequest : httpRequest
}

/** Proxy everything under /v1 to Hermes, adding the key on this side. */
function proxyToHermes(req, res, url) {
  const key = hermesKey()
  if (!key) {
    sendJson(res, 503, { error: 'gateway has no Hermes key (set HERMES_KEY or HERMES_KEY_FILE)' })
    return
  }

  const suffix = url.pathname.replace(/^\/v1/, '')
  const target = new URL(HERMES_BASE + suffix + (url.search || ''))
  const wantsFilter = /\/chat\/completions$/.test(target.pathname) && !KEEP_REASONING

  const headers = { ...req.headers }
  delete headers.host
  delete headers['content-length']
  // Hermes refuses any request carrying a browser Origin (no CORS support, and
  // it treats the header as hostile). This is a trusted server-side call, so the
  // browser's origin/referer must not travel with it.
  delete headers.origin
  delete headers.referer
  headers.authorization = `Bearer ${key}`
  headers['x-sofia-via'] = 'gateway'

  const reqChunks = []
  if (TRACE) {
    req.on('data', (c) => { reqChunks.push(c) })
    req.on('end', () => {
      const body = Buffer.concat(reqChunks).toString('utf8').slice(0, 5000)
      appendFileSync('/tmp/gw-trace.log', `\n=== REQ ${req.method} ${url.pathname}\n${body}\n`)
    })
  }

  const upstream = requestFor(target)(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: req.method,
      headers,
    },
    (up) => {
      const outHeaders = { ...up.headers }
      const contentType = String(up.headers['content-type'] || '')

      if (wantsFilter && contentType.includes('text/event-stream')) {
        // Stream must stay unbuffered: the answer appears as it is generated.
        delete outHeaders['content-length']
        res.writeHead(up.statusCode || 502, outHeaders)
        up.pipe(new SseReasoningFilter()).pipe(res)
        return
      }

      if (wantsFilter && contentType.includes('application/json')) {
        // Buffer once, drop reasoning, fix the length. Bodies here are small.
        const parts = []
        up.on('data', (c) => { parts.push(c) })
        up.on('end', () => {
          let out = Buffer.concat(parts)
          try {
            const parsed = JSON.parse(out.toString('utf8'))
            if (stripReasoningFromBody(parsed))
              out = Buffer.from(JSON.stringify(parsed))
          }
          catch {}
          delete outHeaders['content-length']
          outHeaders['content-length'] = Buffer.byteLength(out)
          res.writeHead(up.statusCode || 502, outHeaders)
          res.end(out)
        })
        return
      }

      res.writeHead(up.statusCode || 502, outHeaders)
      if (TRACE) {
        let captured = ''
        up.on('data', (c) => { if (captured.length < 8000) captured += c.toString('utf8') })
        up.on('end', () => {
          appendFileSync('/tmp/gw-trace.log', `=== RES ${up.statusCode}\n${captured.slice(0, 8000)}\n`)
        })
      }
      up.pipe(res)
    },
  )

  upstream.on('error', (err) => {
    if (!res.headersSent) sendJson(res, 502, { error: `upstream: ${err.message}` })
    else res.end()
  })

  req.pipe(upstream)
}

function serveFrom(req, res, base, relPath) {
  const requested = decodeURIComponent(relPath)
  const rel = normalize(requested).replace(/^(\.\.[/\\])+/, '')
  let file = join(base, rel)

  if (!existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
    return
  }

  const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream'
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' })
  createReadStream(file).pipe(res)
}

function serveStatic(req, res, url) {
  const requested = decodeURIComponent(url.pathname)
  const rel = normalize(requested).replace(/^(\.\.[/\\])+/, '')
  let file = join(DIST, rel)

  if (!existsSync(DIST)) {
    sendJson(res, 503, { error: `stage not built: ${DIST} missing. Run pnpm -F @proj-airi/stage-web build` })
    return
  }

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
    const probe = new URL(`${HERMES_BASE}/models`)
    const r = requestFor(probe)(
      { hostname: probe.hostname, port: probe.port, path: probe.pathname, method: 'GET', headers: { authorization: `Bearer ${key}` } },
      (up) => {
        up.resume()
        sendJson(res, 200, {
          ok: true,
          stage: existsSync(join(DIST, 'index.html')),
          hermes: up.statusCode === 200 ? 'reachable' : `status ${up.statusCode}`,
          key: key ? 'set' : 'missing',
          public: existsSync(PUBLIC),
          trace: TRACE,
          reasoning: KEEP_REASONING ? 'kept' : 'stripped',
          live: { transport: 'gateway-proxy', model: DEFAULT_MODEL, voice: DEFAULT_VOICE },
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

  if (url.pathname.startsWith('/public/')) {
    serveFrom(req, res, PUBLIC, url.pathname.slice('/public/'.length))
    return
  }

  if (url.pathname === '/api/live/info') {
    sendJson(res, 200, { transport: 'gateway-proxy', model: DEFAULT_MODEL, voice: DEFAULT_VOICE, ws: '/api/live/stream' })
    return
  }

  if (url.pathname.startsWith('/api/')) {
    sendJson(res, 501, { error: 'not implemented yet', path: url.pathname })
    return
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'method not allowed' })
    return
  }

  serveStatic(req, res, url)
})

// --- voice: browser <-> gateway <-> Gemini Live ------------------------------
const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  if (url.pathname !== '/api/live/stream') {
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})

wss.on('connection', (ws) => {
  const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)) }

  const bridge = new LiveBridge({
    emit: (evt) => send(evt),
    systemInstruction: SYSTEM_INSTRUCTION,
  }).start()

  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString('utf8')) }
    catch { return }

    if (msg.type === 'audio' && typeof msg.data === 'string') {
      bridge.sendAudioBase64(msg.data)
      return
    }
    if (msg.type === 'text' && typeof msg.text === 'string') {
      const ok = bridge.sendText(msg.text)
      if (!ok) send({ type: 'error', message: 'live session not ready' })
      return
    }
    if (msg.type === 'toolResponse' && Array.isArray(msg.responses)) {
      bridge.sendToolResponse(msg.responses)
      return
    }
    if (msg.type === 'close') {
      bridge.close()
      ws.close()
    }
  })

  ws.on('close', () => bridge.close())
  ws.on('error', () => bridge.close())
})

server.listen(PORT, HOST, () => {
  console.log(`[sofia-gateway] http://${HOST}:${PORT}  stage=${DIST}  hermes=${HERMES_BASE}`)
  console.log(`[sofia-gateway] key: ${hermesKey() ? 'loaded' : 'MISSING — /v1 will answer 503'}  trace=${TRACE}  reasoning=${KEEP_REASONING ? 'kept' : 'stripped'}`)
  console.log(`[sofia-gateway] live: ws /api/live/stream -> ${DEFAULT_MODEL} (${DEFAULT_VOICE})`)
})
