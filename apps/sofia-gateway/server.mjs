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
import { Buffer } from 'node:buffer'
import { createServer, request as httpRequest, STATUS_CODES } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { appendFileSync, createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'

import { WebSocketServer } from 'ws'

import { DEFAULT_MODEL, DEFAULT_VOICE, LiveBridge } from './live.mjs'
import { LIVE_TOOLS, executeToolCall } from './tools.mjs'
import { SseReasoningFilter, stripReasoningFromBody } from './reasoning-filter.mjs'
import { checkPassword, clearCookie, isAuthed, loginPage, makeSession, sessionCookie } from './auth.mjs'
import { ack as proactiveAck, fireNow as proactiveFire, pending as proactivePending, start as startProactive, status as proactiveStatus } from './proactive.mjs'

const PORT = Number(process.env.PORT || 8787)
const HOST = process.env.HOST || '127.0.0.1'
const DIST = resolve(process.env.DIST_DIR || '../stage-web/dist')
const PUBLIC = resolve(process.env.PUBLIC_DIR || './public')
const HERMES_BASE = process.env.HERMES_BASE || 'http://127.0.0.1:8643/p/sofia/v1'
const HERMES_KEY_FILE = process.env.HERMES_KEY_FILE || '/run/secrets/hermes_sofia_key'
const TRACE = process.env.TRACE === '1'
const KEEP_REASONING = process.env.KEEP_REASONING === '1'
const BRAND_DIR = resolve(process.env.BRAND_DIR || join(PUBLIC, 'brand'))

// Two registers: a companion in conversation, an operator when a task is asked
// for. The tools are what make the second register honest — she can hand real
// work to Hermes instead of describing what she would do.
const SYSTEM_INSTRUCTION = process.env.LIVE_SYSTEM_INSTRUCTION
  || [
    'You are Sofia, a warm, quick-witted personal assistant to Sithum, who is Sri Lankan and lives in Colombo.',
    'Speak naturally and briefly — one or two sentences unless he asks for detail. Never read out formatting, markdown, lists, URLs or code; say the meaning instead.',
    'You have hands: call `ask_hermes` whenever he wants something actually done or looked up — a server checked, a command run, a file read, the web searched, a fact remembered or recalled. Call `local_time` for the time or date. Do not answer those yourself and never claim you did something you did not call a tool for.',
    'You have a screen. When he asks to see, show or open ANYTHING visual — a website, a picture, a logo, a page — you MUST call `show_panel` in that same turn. Do not describe a page as open, and never say something is on the stage, unless the `show_panel` call succeeded. Several windows may be open at once; each call opens or raises one. `browse` works inside a page you opened — click by visible text, type into a field, press Enter, scroll, read the page aloud, list the links, go back, reload, or goto another address; to search, click the search box, fill it, press Enter, then read. `control_avatar` changes your own size and place — when he says "get smaller", "shrink", "move left", "come back", "bigger" or "reset", that is this tool: ACTUALLY call it, never answer that you cannot resize yourself, and use it before you open something wide so he can see both. `control_window` arranges what is already on screen — he says "make it bigger", "move it", "open another one", "tile them", "close that": resize, move, maximize, minimize, close, close_all, tile, focus. A move can take position left, centre or right — the stage is hers, so a window is never stuck on one half. After a new window opens, tile or resize so nothing covers her and both stay readable. Before any slow tool — `ask_hermes` in particular — say one short sentence out loud first (`let me check`), because a silent stage reads as a broken one.',
    'When a tool returns an error, say plainly that it did not work and what it said. Never invent a result.',
    'Never say you cannot see what is on screen, and never guess. Every tool answer ends with a `[stage: …]` line — that is what is really open right now. If you are unsure, call `browse` with action links or read and look.',
  ].join(' ')

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

// --- branding ---------------------------------------------------------------
// The stage is upstream AIRI's build, so its logo, its icon set, its PWA
// manifest and the open-graph tags still carry that name and that site. Forking
// the artwork inside the bundle would break every merge with upstream, so the
// gateway serves its own files at the exact URLs the built HTML asks for:
// filenames stay, pixels change.
const BRAND_ASSETS = {
  '/favicon.svg': 'favicon.svg',
  '/favicon.ico': 'favicon.ico',
  '/apple-touch-icon.png': 'apple-touch-icon.png',
  '/web-app-manifest-192x192.png': 'web-app-manifest-192x192.png',
  '/web-app-manifest-512x512.png': 'web-app-manifest-512x512.png',
  '/maskable_icon_x192.png': 'maskable_icon_x192.png',
  '/maskable_icon_x512.png': 'maskable_icon_x512.png',
  '/og.png': 'og.png',
  '/icon-512.png': 'icon-512.png',
}

const MANIFEST = {
  name: 'Sofia',
  short_name: 'Sofia',
  description: 'Your personal companion',
  start_url: '/',
  display: 'standalone',
  background_color: '#0b0708',
  theme_color: '#0b0708',
  lang: 'en',
  scope: '/',
  icons: [
    { src: '/web-app-manifest-192x192.png', sizes: '192x192', type: 'image/png' },
    { src: '/web-app-manifest-512x512.png', sizes: '512x512', type: 'image/png' },
    { src: '/maskable_icon_x192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
    { src: '/maskable_icon_x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
}

// Every rewrite is a literal the built HTML is expected to contain. A miss is
// recorded rather than thrown: a drifted upstream build must still serve, but
// /healthz must say the rebrand stopped matching.
const BRAND_WARNINGS = []

function swapOnce(html, from, to, label) {
  if (!html.includes(from)) {
    if (!BRAND_WARNINGS.includes(label)) BRAND_WARNINGS.push(label)
    return html
  }
  return html.split(from).join(to)
}

function rebrandHtml(html) {
  // The brand strings a person can read. Note this runs BEFORE the seed script
  // is injected, so that script is written without the old name in it.
  html = html.replace(/AIRI/g, 'Sofia').replace(/アイリ/g, 'ソフィア')
  // Metadata still advertises the upstream project's site and card.
  html = swapOnce(html, 'https://airi.moeru.ai/open-graph.png', 'https://sofia.ctum.org/og.png', 'meta:og-image')
  html = swapOnce(html, 'https://airi.moeru.ai/docs/en/', 'https://sofia.ctum.org/', 'meta:og-url')
  html = swapOnce(html, 'Open source attempt to create cyber companion.', 'Your personal companion.', 'meta:description')
  html = swapOnce(html, 'Top 1 open source attempt to create cyber companion, capable of playing Minecraft, Factorio, Balatro, etc. .', 'Your personal companion — she keeps track of your day and speaks first.', 'meta:og-description')
  // Splash: the built one is a white sheet with the old mark hue-rotated to the
  // theme colour. Sofia's splash is the dark stage with her own mark at full
  // colour, so the hue-rotate filter and the white palette both have to go.
  html = swapOnce(html, 'color:#262626;background:#fff;', 'color:#eef2f7;background:#0b0708;', 'splash:palette')
  html = swapOnce(html, 'filter:hue-rotate(calc(var(--chromatic-hue,220.44) * 1deg))', 'border-radius:24%', 'splash:logo-filter')
  html = swapOnce(html, '#boot-splash .boot-error button{background:oklch(65% .16 var(--chromatic-hue,220.44))', '#boot-splash .boot-error button{background:#a3283a', 'splash:button')
  html = swapOnce(html, 'html.dark #boot-splash{color:#f5f5f5;background:#171717}', 'html.dark #boot-splash{color:#eef2f7;background:#0b0708}', 'splash:dark')
  return html
}

function serveBrandAsset(res, pathname) {
  const file = join(BRAND_DIR, BRAND_ASSETS[pathname])
  if (!existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('brand asset missing')
    return
  }
  res.writeHead(200, {
    'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': statSync(file).size,
    'cache-control': 'no-cache',
  })
  createReadStream(file).pipe(res)
}

// Runs before the app boots. Only fills what is missing, so a deliberate change
// made in Settings is never overwritten on reload.
const SEED_SCRIPT = `<script>
(function () {
  try {
    var origin = location.origin + '/v1';
    var seed = {
      'settings/providers/configured': JSON.stringify({
        'openai-compatible': {
          id: 'openai-compatible',
          definitionId: 'openai-compatible',
          config: { api: 'chat-completions', baseUrl: origin, apiKey: 'gateway-injects-real-key' },
          status: 'configured',
          configuredBy: 'user',
        },
      }),
      'settings/providers/added': JSON.stringify({ 'openai-compatible': true }),
      'settings/consciousness/active-provider': 'openai-compatible',
      'settings/consciousness/active-model': 'sofia',
      'settings/speech/active-provider': 'speech-noop',
    };
    for (var key in seed) {
      if (!localStorage.getItem(key)) localStorage.setItem(key, seed[key]);
    }

    // The character card lives in localStorage, not in the bundle. A browser that
    // saved a card before the rename keeps showing the old name: the built-in
    // default renders for a moment, then the saved card hydrates over it. Rewrite
    // the saved cards once so the name sticks.
    // The previous product name is assembled here rather than written out, so the
    // served HTML contains no trace of it.
    var LEGACY = ['Iru', ['A', 'I', 'R', 'I'].join(''), 'アイリ'];
    try {
      var rawCards = localStorage.getItem('airi-cards');
      if (rawCards) {
        var parsed = JSON.parse(rawCards);
        var touched = false;
        var walk = function (node) {
          if (!node || typeof node !== 'object') return;
          if (Array.isArray(node)) { for (var i = 0; i < node.length; i++) walk(node[i]); return; }
          if (typeof node.name === 'string' && LEGACY.indexOf(node.name.trim()) !== -1) {
            node.name = 'Sofia';
            touched = true;
          }
          // The persona copy opens with the character introducing itself by the
          // legacy name, so a renamed card still answers to the old one. Rewrite
          // that line only: the rest of the description is personality, which is
          // the part worth keeping.
          if (typeof node.description === 'string' && node.description.indexOf('Your name is ' + LEGACY[0]) !== -1) {
            node.description = node.description
              .split('Your name is ' + LEGACY[0] + ', pronounced as /ˈiːruː/.').join('Your name is Sofia.')
              .split('Your name is ' + LEGACY[0]).join('Your name is Sofia');
            touched = true;
          }
          for (var k in node) { if (node[k] && typeof node[k] === 'object') walk(node[k]); }
        };
        walk(parsed);
        if (touched) localStorage.setItem('airi-cards', JSON.stringify(parsed));
      }
    } catch (e) {}

    // A cached service worker can replay an old shell forever — that is exactly
    // how a pre-auth build kept appearing after deploys. Unregister it so every
    // load is served by this gateway.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then(function (rs) {
        for (var i = 0; i < rs.length; i++) rs[i].unregister();
      }).catch(function () {});
    }
    if (window.caches && caches.keys) {
      caches.keys().then(function (keys) {
        for (var i = 0; i < keys.length; i++) caches.delete(keys[i]);
      }).catch(function () {});
    }
  } catch (e) {}
})();
</script>`;

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
// Buffered only for chat turns: the body is small JSON, and the text path needs
// to be read before it is forwarded (see maybeOpenFromText).
function readRequestBody(req, limit = 2000000) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function proxyToHermes(req, res, url, body) {
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
  if (body)
    headers['content-length'] = String(body.length)

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

  if (body)
    upstream.end(body)
  else
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

  // The stage is upstream AIRI's build. Two things are rewritten as it is served:
  // the brand strings a person can see, and a seed that makes the provider
  // already-configured so nobody meets an onboarding wizard.
  if (file.endsWith('index.html')) {
    let html = readFileSync(file, 'utf8')
    html = rebrandHtml(html)
    html = html.replace('</head>', `${SEED_SCRIPT}</head>`)
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
    res.end(html)
    return
  }

  res.writeHead(200, {
    'content-type': type,
    // Hashed assets can cache hard; everything else must revalidate, or a
    // deploy keeps serving yesterday's bundle (this exact bug cost a day).
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  createReadStream(file).pipe(res)
}

// --- login rate limit -------------------------------------------------------
// The gate is the only credential in front of a public box, so an unthrottled
// form is an invitation to grind it. Five failures from one address inside ten
// minutes locks that address out for the rest of the window; a success clears
// the record. Kept in memory on purpose: one process, and a restart forgiving
// the attacker is better than a table nobody prunes.
const LOGIN_WINDOW_MS = 10 * 60 * 1000
const LOGIN_MAX_FAILURES = 5
// Shorter than the counting window on purpose: an attacker gets five guesses per
// window, but the owner is never stranded for the full ten minutes.
const LOGIN_LOCK_MS = 5 * 60 * 1000
// Backstop bucket. No single header is both precise and unspoofable, so the gate
// counts on two: the address Cloudflare vouches for (precise — CF overwrites
// CF-Connecting-IP and answers 403 to a client that tries to set it), and the
// tail hop Caddy appended, which is the peer it actually saw and therefore the
// only element in the chain a client cannot choose. Through Cloudflare the first
// bucket does the work at five attempts; an attacker who reaches the origin
// directly and rotates the forged header still meets the second bucket instead of
// grinding forever. Measured before this: 20 consecutive failures, zero 429s.
const LOGIN_PEER_MAX_FAILURES = 25
const LOGIN_PEER_LOCK_MS = 10 * 60 * 1000
const loginFailures = new Map()

function forwardedHops(req) {
  return String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
}

function loginKeys(req) {
  const cf = String(req.headers['cf-connecting-ip'] || '').trim()
  const hops = forwardedHops(req)
  const tail = hops.length > 0 ? hops[hops.length - 1] : ''
  const peer = tail || String(req.socket.remoteAddress || 'unknown')
  return { precise: `ip:${cf || peer}`, peer: `peer:${peer}` }
}

function loginLockSeconds(key) {
  const record = loginFailures.get(key)
  if (!record)
    return 0
  const now = Date.now()
  if (record.until && record.until > now)
    return Math.ceil((record.until - now) / 1000)
  if (now - record.first > LOGIN_WINDOW_MS)
    loginFailures.delete(key)
  return 0
}

function noteLoginFailure(key, maxFailures = LOGIN_MAX_FAILURES, lockMs = LOGIN_LOCK_MS) {
  const now = Date.now()
  const record = loginFailures.get(key) || { count: 0, first: now, until: 0 }
  if (now - record.first > LOGIN_WINDOW_MS) {
    record.count = 0
    record.first = now
    record.until = 0
  }
  record.count += 1
  if (record.count >= maxFailures)
    record.until = now + lockMs
  loginFailures.set(key, record)
  if (loginFailures.size > 1024) {
    for (const [staleKey, value] of loginFailures) {
      if (!value.until || value.until < now)
        loginFailures.delete(staleKey)
    }
  }
}

// --- stage events -----------------------------------------------------------
// Voice answers arrive on the Live socket and carry their own tool results.
// A typed message goes to Hermes over /v1 and has no tools at all, so a window
// opened in text has to be pushed out of band. One SSE stream, one subscriber
// per tab, same session cookie as everything else.
const stageClients = new Set()

function broadcastToStage(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`
  for (const res of stageClients) {
    try { res.write(line) }
    catch { stageClients.delete(res) }
  }
}

const OPEN_VERB = /\b(?:open|show|pull up|bring up|go to|take me to)\b/i
const SITES = {
  github: 'https://github.com',
  gitlab: 'https://gitlab.com',
  youtube: 'https://youtube.com',
  google: 'https://google.com',
  gmail: 'https://mail.google.com',
  reddit: 'https://reddit.com',
  x: 'https://x.com',
  twitter: 'https://x.com',
  wikipedia: 'https://wikipedia.org',
  notion: 'https://notion.so',
  maps: 'https://maps.google.com',
  hn: 'https://news.ycombinator.com',
  hackernews: 'https://news.ycombinator.com',
  stackoverflow: 'https://stackoverflow.com',
}

/** "open github for me and show" -> https://github.com, or null. */
function urlFromText(text) {
  // The chat prefixes its own timestamps ("[2026-11-10 21:43] …") and any
  // dotted token used to win the match: that is how "try again and open github"
  // became https://chess.play and failed. Known sites first, strips of digits
  // and times removed, and only real TLDs accepted.
  const said = String(text || '').replace(/\[[^\]]*\]/g, ' ').replace(/\b\d{1,2}:\d{2}\b/g, ' ')
  if (!OPEN_VERB.test(said))
    return null
  const direct = said.match(/https?:\/\/[^\s'"]+/i)
  if (direct)
    return direct[0].replace(/[.,;:!)]+$/, '')
  const lower = said.toLowerCase()
  for (const key of Object.keys(SITES)) {
    if (new RegExp(`\\b${key}\\b`).test(lower))
      return SITES[key]
  }
  const TLD = /^(?:com|org|net|io|dev|ai|app|co|me|sh|gg|tv|xyz|edu|gov|info|site|so)$/
  for (const candidate of lower.match(/[a-z0-9-]+(?:\.[a-z0-9-]+)+/g) || []) {
    const tld = candidate.split('.').pop()
    if (TLD.test(tld))
      return `https://${candidate}`
  }
  for (const key of Object.keys(SITES)) {
    if (new RegExp(`\\b${key}\\b`).test(said.toLowerCase()))
      return SITES[key]
  }
  return null
}

// The last page this gateway put on screen. A typed turn has no browser state
// of its own, so "click the search box" has to attach to something — this is it.
let stageLastPage = null

function rememberPage(page) {
  if (page?.sid)
    stageLastPage = { sid: page.sid, url: page.url || stageLastPage?.url || '', title: page.title || '' }
}

// Her own size and place. These run before the open matcher, because "make
// yourself smaller" contains "make" and would otherwise be read as a request to
// open something.
// Word order is the whole bug: the first version only accepted "get smaller"
// and "smaller yourself", so the phrasing he actually uses — "make yourself
// smaller" — matched nothing, fell through to prose, and she answered that she
// could not resize herself. The rules below read the size word and the subject
// in either order; an explicit number ("scale yourself to 0.6") wins over both.
const AVATAR_RULES = [
  // A size word is a step, not a fixed number: "make yourself smaller" twice
  // has to leave her smaller than once. The fixed 0.65 made the second ask a
  // no-op, and a command that does nothing on the second try reads as broken.
  [/\b(?:smaller|tinier|littler)\b|\bshrink\b|\bscale (?:yourself )?down\b|\bminimi[sz]e yourself\b/i, { action: 'set', step: -0.2 }],
  [/\bhalf size\b|\bsmall size\b/i, { action: 'set', scale: 0.5 }],
  [/\b(?:bigger|larger|taller)\b|\bgrow\b|\bscale (?:yourself )?up\b|\bmaximi[sz]e yourself\b/i, { action: 'set', step: 0.2 }],
  [/\bfull size\b|\bnormal size\b/i, { action: 'set', scale: 1 }],
  [/\bmove (?:yourself )?(?:to the )?left\b/i, { action: 'set', x: -260 }],
  [/\bmove (?:yourself )?(?:to the )?right\b/i, { action: 'set', x: 260 }],
  [/\bmove aside\b/i, { action: 'set', x: 220, scale: 0.8 }],
  [/\b(?:come back|reset yourself|back to normal|usual place)\b/i, { action: 'reset' }],
]

/**
 * What a typed turn asks the stage to do. Deliberately deterministic: the text
 * lane is Hermes, which has no function calling here, so every capability the
 * voice lane gets from a tool has to be recognised here or it does not exist
 * while typing.
 */
function stageIntent(rawText) {
  const said = String(rawText || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b\d{1,2}:\d{2}\b/g, ' ')
  const lower = said.toLowerCase().trim()

  // Does this turn talk about HER, or about the furniture? "make yourself
  // smaller" is her; "make the window smaller" is the stage. Getting that
  // backwards is how a size request ends up opening a page.
  const herDirect = /\byourself\b|\byour avatar\b|\bavatar\b|\bshrink\b|\bmove aside\b|\bcome back\b/.test(lower)
  const sizeTalk = /\b(?:smaller|bigger|tinier|littler|larger|taller)\b|\bscale (?:up|down)\b|\bfull size\b|\bhalf size\b|\bnormal size\b|\b(?:scale|size)\b[^0-9%]{0,14}\d/.test(lower)
  const furniture = /\bwindows?\b|\bpanes?\b/.test(lower)

  if (herDirect || (sizeTalk && !furniture)) {
    // "scale yourself to 0.6" / "size 60%" beats a vague word.
    const sized = lower.match(/\b(?:scale|size)\b[^0-9%]{0,14}(\d*\.?\d+)\s*(?:%|percent)?/)
    if (sized) {
      const percent = /%|percent/.test(sized[0])
      let value = Number(sized[1])
      if (percent || value > 1.6)
        value = value / 100
      if (Number.isFinite(value) && value > 0)
        return { events: [{ kind: 'avatar', action: 'set', scale: Math.max(0.35, Math.min(1.6, value)) }] }
    }
    for (const [re, payload] of AVATAR_RULES) {
      if (re.test(lower))
        return { events: [{ kind: 'avatar', ...payload }] }
    }
  }

  // A window move, not a body move: "move it to the left" must not shrink her.
  if (/\b(?:window|page|browser|it)\b/.test(lower) && /\bmove\b/.test(lower)) {
    if (/\bleft\b/.test(lower))
      return { events: [{ kind: 'control', action: 'move', position: 'left' }] }
    if (/\bright\b/.test(lower))
      return { events: [{ kind: 'control', action: 'move', position: 'right' }] }
    if (/\b(?:centre|center|middle)\b/.test(lower))
      return { events: [{ kind: 'control', action: 'move', position: 'center' }] }
  }

  if (/\bclose (?:all|everything|all of them)\b|\bclose the windows\b/.test(lower))
    return { events: [{ kind: 'control', action: 'close_all' }] }
  if (/\bclose (?:it|that|this|the window)\b/.test(lower))
    return { events: [{ kind: 'control', action: 'close', target: 'last' }] }
  if (/\b(?:tile|line (?:them|the windows) up|arrange (?:them|the windows))\b/.test(lower))
    return { events: [{ kind: 'control', action: 'tile' }] }
  if (/\bmaximi[sz]e\b/.test(lower))
    return { events: [{ kind: 'control', action: 'maximize', target: 'last' }] }
  if (/\bminimi[sz]e\b/.test(lower))
    return { events: [{ kind: 'control', action: 'minimize', target: 'last' }] }

  const url = urlFromText(said)
  if (url)
    return { events: [{ kind: 'open', url }] }

  if (/\b(?:search|look up|google)\b/i.test(lower)) {
    const q = said.replace(/^.*?\b(?:search(?: for)?|look up|google)\b/i, '').replace(/^\s*(?:for|about)\s+/i, '').trim()
    if (q)
      return { events: [{ kind: 'open', url: `https://duckduckgo.com/?q=${encodeURIComponent(q.replace(/[?.!]+$/, ''))}` }] }
  }

  const click = said.match(/\b(?:click|tap|press) (?:on )?(?:the )?(.+?)(?: link| button)?$/i)
  if (click && !/^enter$/i.test(click[1].trim()))
    return { events: [], browse: { action: 'clickText', text: click[1].trim() } }
  if (/\bpress (?:the )?enter\b|\bhit enter\b/i.test(lower))
    return { events: [], browse: { action: 'press', text: 'Enter' } }
  const type = said.match(/\btype (?:in )?(?:["“])(.+?)["”]/i) || said.match(/\btype (?:in )?(.{2,80})$/i)
  if (type)
    return { events: [], browse: { action: 'fill', text: type[1].trim(), selector: 'input:not([type=hidden]), textarea' } }
  if (/\bscroll (?:down|further)\b/i.test(lower))
    return { events: [], browse: { action: 'scroll', text: 'down' } }
  if (/\bscroll (?:up|back)\b/i.test(lower))
    return { events: [], browse: { action: 'scroll', text: 'up' } }
  if (/\bgo back\b|\bback to the (?:last|previous) page\b/i.test(lower))
    return { events: [], browse: { action: 'back' } }
  if (/\breload\b|\brefresh the page\b/i.test(lower))
    return { events: [], browse: { action: 'reload' } }

  return { events: [] }
}

async function runStageIntent(intent) {
  const base = process.env.BROWSER_URL || 'http://sofia-browser:8790'
  if (intent.browse) {
    const target = stageLastPage?.sid
    if (!target) {
      console.log(`[sofia-gateway] text: ${intent.browse.action} needs a page and none is open`)
      return
    }
    const res = await fetch(`${base}/act`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sid: target,
        action: intent.browse.action,
        text: intent.browse.text,
        selector: intent.browse.selector,
        key: intent.browse.text,
        x: 640,
        y: 400,
      }),
      signal: AbortSignal.timeout(45000),
    })
    const body = await res.json()
    // `tick` is what makes her clicks visible: without it the window keeps the
    // picture it took when the page opened and every action looks ignored. It
    // fires whether the action worked or not — a failed click must still show
    // him the real page, never a picture from a minute ago.
    broadcastToStage({ kind: 'live', sid: body.sid || target, url: body.url || stageLastPage?.url || '', title: body.title || '', tick: Date.now() })
    if (!res.ok)
      throw new Error(body.error || `status ${res.status}`)
    rememberPage(body)
    console.log(`[sofia-gateway] text: ${intent.browse.action} -> ${body.url || body.title || 'done'}`)
    return
  }

  for (const event of intent.events) {
    if (event.kind === 'open') {
      const up = await fetch(`${base}/open`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: event.url }),
        signal: AbortSignal.timeout(45000),
      })
      const page = await up.json()
      if (!up.ok)
        throw new Error(page.error || `status ${up.status}`)
      rememberPage({ ...page, url: page.url || event.url })
      console.log(`[sofia-gateway] text: opened ${page.url || event.url}`)
      broadcastToStage({ kind: 'live', sid: page.sid, url: page.url || event.url, title: page.title || '' })
      continue
    }
    broadcastToStage(event)
    console.log(`[sofia-gateway] text: ${event.kind} ${event.action}`)
  }
}

async function maybeOpenFromText(body) {
  let payload
  try { payload = JSON.parse(body.toString('utf8')) }
  catch {
    console.log(`[sofia-gateway] text: unreadable body (${body?.length ?? 'no'} bytes)`)
    return
  }
  const messages = Array.isArray(payload?.messages) ? payload.messages : []
  const lastUser = [...messages].reverse().find(m => m?.role === 'user')
  const text = typeof lastUser?.content === 'string'
    ? lastUser.content
    : Array.isArray(lastUser?.content) ? lastUser.content.map(p => p?.text || '').join(' ') : ''
  const intent = stageIntent(text)
  const what = intent.browse
    ? `browse ${intent.browse.action}`
    : intent.events.length ? intent.events.map(e => `${e.kind}:${e.action || e.url || ''}`).join(', ') : 'no intent'
  console.log(`[sofia-gateway] text: turn "${String(text).slice(0, 60)}" -> ${what}`)
  if (!intent.browse && !intent.events.length)
    return
  try {
    await runStageIntent(intent)
  }
  catch (error) {
    console.log(`[sofia-gateway] text: intent failed (${String(error && error.message || error).slice(0, 100)})`)
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

  if (url.pathname === '/healthz') {
    // handled below, but keep it ahead of the gate so uptime probes stay green
  }

  // --- password gate ---
  if (url.pathname === '/api/login' && req.method === 'POST') {
    const keys = loginKeys(req)
    const lockedFor = Math.max(loginLockSeconds(keys.precise), loginLockSeconds(keys.peer))
    if (lockedFor > 0) {
      res.writeHead(429, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'retry-after': String(lockedFor),
      })
      res.end(loginPage({ error: `Too many attempts. Try again in ${Math.ceil(lockedFor / 60)} minute(s).` }))
      return
    }
    const chunks = []
    req.on('data', (c) => { chunks.push(c) })
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const params = new URLSearchParams(body)
      if (checkPassword(params.get('password') || '')) {
        loginFailures.delete(keys.precise)
        loginFailures.delete(keys.peer)
        res.writeHead(302, { 'set-cookie': sessionCookie(makeSession()), location: '/' })
        res.end()
        return
      }
      noteLoginFailure(keys.precise)
      noteLoginFailure(keys.peer, LOGIN_PEER_MAX_FAILURES, LOGIN_PEER_LOCK_MS)
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(loginPage({ error: 'Wrong password.' }))
    })
    return
  }

  if (url.pathname === '/api/logout') {
    res.writeHead(302, { 'set-cookie': clearCookie(), location: '/' })
    res.end()
    return
  }

  // Service-worker kill switch, served at the exact URL the built app registers.
  //
  // Why: the stage is a PWA. A browser holding the old worker replays a cached
  // shell and never asks this server, so server-side changes (new HTML, seeded
  // provider, renamed strings) do not reach existing tabs — "only incognito
  // works". Unregistering from inside the page cannot fix it, because that page
  // code never runs. Replacing the worker script is the only reliable lever: the
  // browser byte-compares sw.js on navigation, installs this one instead, and it
  // deletes every cache and unregisters itself.
  if (url.pathname === '/sw.js') {
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-store, must-revalidate',
    })
    res.end(`self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (e) {}
    try { await self.registration.unregister(); } catch (e) {}
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach((c) => { try { c.navigate(c.url); } catch (e) {} });
  })());
});`);
    return;
  }

  if (url.searchParams.get('reset') === '1') {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'clear-site-data': '"cache", "storage", "executionContexts"',
    })
    res.end(`<!doctype html><meta charset="utf-8"><title>Resetting</title>
<body style="background:#07080a;color:#e9ecef;font:15px system-ui;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center">
  <p>Browser state cleared. Taking you to the door…</p>
  <p><a style="color:#3ddc97" href="/">Continue</a></p>
</div>
<script>setTimeout(function(){location.replace('/')},1200)</script>`)
    return
  }

  const publicPath = url.pathname === '/healthz' || url.pathname === '/login'
    // Brand pixels and the PWA manifest are not secrets, and the browser asks for
    // the favicon on the login page too.
    || Object.hasOwn(BRAND_ASSETS, url.pathname)
    || url.pathname === '/manifest.webmanifest'
  if (!publicPath && !isAuthed(req)) {
    const wantsHtml = (req.headers.accept || '').includes('text/html')
    if (wantsHtml || url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(loginPage())
      return
    }
    sendJson(res, 401, { error: 'unauthorized' })
    return
  }

  if (url.pathname === '/login') {
    res.writeHead(302, { location: '/' })
    res.end()
    return
  }

  // --- brand: the files the built HTML asks for, served with Sofia's pixels ---
  if (Object.hasOwn(BRAND_ASSETS, url.pathname)) {
    serveBrandAsset(res, url.pathname)
    return
  }

  if (url.pathname === '/manifest.webmanifest') {
    const body = JSON.stringify(MANIFEST)
    res.writeHead(200, {
      'content-type': 'application/manifest+json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-cache',
    })
    res.end(body)
    return
  }

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
          brand: BRAND_WARNINGS.length ? BRAND_WARNINGS : 'rewritten',
          hermes: up.statusCode === 200 ? 'reachable' : `status ${up.statusCode}`,
          key: key ? 'set' : 'missing',
          public: existsSync(PUBLIC),
          trace: TRACE,
          reasoning: KEEP_REASONING ? 'kept' : 'stripped',
          live: { transport: 'gateway-proxy', model: DEFAULT_MODEL, voice: DEFAULT_VOICE },
          proactive: proactiveStatus(),
        })
      },
    )
    r.on('error', (e) => sendJson(res, 200, { ok: false, stage: existsSync(join(DIST, 'index.html')), hermes: `unreachable: ${e.message}`, key: key ? 'set' : 'missing' }))
    r.setTimeout(4000, () => r.destroy(new Error('timeout')))
    r.end()
    return
  }

  if (url.pathname.startsWith('/v1/')) {
    // A typed turn has no tools: the gateway does the one thing a window needs
    // before handing the message to Hermes.
    if (url.pathname.endsWith('/chat/completions') && req.method === 'POST') {
      console.log(`[sofia-gateway] text: chat turn ${req.method} ${url.pathname}`)
      const body = await readRequestBody(req).catch(() => null)
      if (body) {
        maybeOpenFromText(body).catch(e => console.log(`[sofia-gateway] text: intent failed (${String(e && e.message || e).slice(0, 100)})`))
        proxyToHermes(req, res, url, body)
        return
      }
    }
    proxyToHermes(req, res, url)
    return
  }

  if (url.pathname.startsWith('/public/')) {
    serveFrom(req, res, PUBLIC, url.pathname.slice('/public/'.length))
    return
  }

  // --- her eyes and hands on the web --------------------------------------
  // A real Chromium lives beside the gateway (container `sofia-browser`). Each
  // window gets one page there; the window shows a screenshot and relays the
  // pointer back. Nothing is iframed, because almost no real site allows it.
  if (url.pathname === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write(': connected\n\n')
    stageClients.add(res)
    const beat = setInterval(() => {
      try { res.write(': ping\n\n') }
      catch { clearInterval(beat); stageClients.delete(res) }
    }, 25000)
    req.on('close', () => { clearInterval(beat); stageClients.delete(res) })
    return
  }

  if (url.pathname.startsWith('/api/browse/')) {
    const base = process.env.BROWSER_URL || 'http://sofia-browser:8790'
    try {
      if (url.pathname === '/api/browse/frame') {
        const sid = url.searchParams.get('sid') || ''
        const upstream = await fetch(`${base}/frame?sid=${encodeURIComponent(sid)}`, { signal: AbortSignal.timeout(20000) })
        if (!upstream.ok) {
          sendJson(res, 502, { error: 'the page did not render' })
          return
        }
        const png = Buffer.from(await upstream.arrayBuffer())
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
        res.end(png)
        return
      }
      const routes = { '/api/browse/open': '/open', '/api/browse/act': '/act', '/api/browse/close': '/close' }
      const target = routes[url.pathname]
      if (!target) {
        sendJson(res, 404, { error: 'no route' })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      const body = await new Promise((resolve) => {
        let raw = ''
        req.on('data', (chunk) => {
          raw += chunk
          if (raw.length > 5e5)
            req.destroy()
        })
        req.on('end', () => {
          try { resolve(raw ? JSON.parse(raw) : {}) }
          catch { resolve({}) }
        })
      })
      const upstream = await fetch(base + target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(45000),
      })
      const text = await upstream.text()
      res.writeHead(upstream.status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(text)
    }
    catch (error) {
      sendJson(res, 502, { error: `the browser is not answering: ${String(error.message || error).slice(0, 120)}` })
    }
    return
  }

  // --- she speaks first -----------------------------------------------------
  // The clock is here; the words are the page's. A slot is handed over as a
  // time, not a sentence, because a line composed at 07:00 and read at 14:00
  // says "good morning" — the page interpolates the clock it actually has, and
  // refuses a slot that has gone stale rather than opening with last night's
  // verdict.
  if (url.pathname === '/api/proactive/pending') {
    sendJson(res, 200, { ok: true, items: proactivePending(), status: proactiveStatus() })
    return
  }
  if (url.pathname === '/api/proactive/ack' && req.method === 'POST') {
    const body = await readRequestBody(req).catch(() => null)
    let ids = []
    try { ids = JSON.parse(body || '{}').ids || [] } catch {}
    sendJson(res, 200, { ok: true, cleared: proactiveAck(ids) })
    return
  }
  if (url.pathname === '/api/proactive/fire' && req.method === 'POST') {
    // The gate's hook, and the entry point a host cron would use later. The same
    // session cookie as every other private route: firing a slot is not a new
    // capability, it is a message she would have written on her own clock.
    const body = await readRequestBody(req).catch(() => null)
    let slot = 'manual'
    try { slot = String(JSON.parse(body || '{}').slot || 'manual') } catch {}
    const item = proactiveFire(slot)
    console.log(`[sofia-gateway] proactive: ${slot} fired by hand (${item.id})`)
    sendJson(res, 200, { ok: true, item })
    return
  }

  // --- her hands on the stage ------------------------------------------------
  // Every other way a window moves starts from words: a typed turn is read by
  // stageIntent, a voice turn by the live tool loop. The agent that builds this
  // app talks to the gateway over its own API and has neither, so "move the
  // window to the left" arrived as prose and the window sat still. One route,
  // the exact event the other two lanes already broadcast, so there is still
  // only one way a window moves.
  if (url.pathname === '/api/stage/control' && req.method === 'POST') {
    const body = await readRequestBody(req).catch(() => null)
    let asked = {}
    try { asked = JSON.parse(body || '{}') || {} } catch {}
    const action = String(asked.action || '').toLowerCase()
    const allowed = ['move', 'resize', 'maximize', 'minimize', 'close', 'close_all', 'tile', 'focus']
    if (!allowed.includes(action)) {
      sendJson(res, 400, { error: `action must be one of ${allowed.join(', ')}` })
      return
    }
    const event = { kind: 'control', action }
    for (const key of ['target', 'position']) {
      if (asked[key] !== undefined)
        event[key] = String(asked[key]).toLowerCase()
    }
    for (const key of ['x', 'y', 'width', 'height']) {
      if (Number.isFinite(Number(asked[key])))
        event[key] = Number(asked[key])
    }
    broadcastToStage(event)
    console.log(`[sofia-gateway] stage: control ${action}${event.position ? ` ${event.position}` : ''}${event.target ? ` ${event.target}` : ''} -> ${stageClients.size} tab(s)`)
    sendJson(res, 200, { ok: true, event, tabs: stageClients.size })
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

// A refused upgrade still answers in HTTP. Destroying the socket with no status
// line makes Caddy invent 502 and Cloudflare pass it on, so a stranger opening
// the voice socket reads as "app down" everywhere. Write the status, then close.
function refuseUpgrade(socket, status, body) {
  try {
    socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\n`
      + 'Connection: close\r\n'
      + 'Content-Type: text/plain; charset=utf-8\r\n'
      + `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  }
  catch {
    socket.destroy()
  }
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  if (url.pathname !== '/api/live/stream') {
    refuseUpgrade(socket, 404, 'not found')
    return
  }
  if (!isAuthed(req)) {
    refuseUpgrade(socket, 401, 'unauthorized')
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})

wss.on('connection', (ws) => {
  const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)) }

  // Tool calls are executed HERE, not in the browser: the key stays on the
  // server, and the page has no business deciding whether a command runs.
  //
  // ONE context for the whole conversation. A fresh object per call threw
  // `lastPage` away, so the very next `browse` had nothing to act on and she
  // told him she could not see a page she had just opened herself.
  let currentCall = ''
  const toolCtx = {
    base: HERMES_BASE,
    key: hermesKey(),
    lastPage: null,
    onPanel: (panel) => {
      // A page she opened by voice has to be visible to a typed "click ..." a
      // minute later, so the remembered page is updated on both paths.
      if (panel?.kind === 'live')
        rememberPage(panel)
      send({ type: 'panel', ...panel })
    },
    onProgress: (p) => send({ type: 'tool', name: currentCall, state: 'running', ...p }),
  }

  // Every answer carries the stage state, so she always knows what is on
  // screen even after a page was opened three turns ago.
  function stageLine() {
    return toolCtx.lastPage
      ? `\n[stage: a page is open beside you — ${toolCtx.lastPage.url}. Use browse to act on it.]`
      : '\n[stage: nothing is open yet. Call show_panel with kind live to put a page on screen.]'
  }

  const bridge = new LiveBridge({
    emit: (evt) => {
      if (evt.type !== 'toolCall') {
        send(evt)
        return
      }
      // Every function call gets exactly one response, in order. A missing
      // response stalls the model's turn forever, so failures answer too.
      void (async () => {
        for (const call of evt.functionCalls) {
          currentCall = String(call.name || '')
          send({ type: 'tool', name: call.name, state: 'started', args: call.args })
          const result = await executeToolCall(call, toolCtx)
          // The model must never be the only thing that knows whether the
          // stage changed: the answer now says it.
          if (typeof result?.response?.result === 'string')
            result.response.result += stageLine()
          console.log(`[sofia-gateway] live: tool ${call.name} -> ${String(result.response.result).replace(/\s+/g, ' ').slice(0, 160)}`)
          send({ type: 'tool', name: call.name, state: 'done', ok: !String(result.response.result).startsWith('That did not work'), result: String(result.response.result).slice(0, 300) })
          bridge.sendToolResponse([result])
        }
      })()
    },
    systemInstruction: SYSTEM_INSTRUCTION,
    tools: LIVE_TOOLS,
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
  const clock = proactiveStatus()
  console.log(`[sofia-gateway] proactive: slots=${clock.slots.join(',')} (${clock.timezone}) now=${clock.now} state=${clock.statePath}`)
  startProactive()
})
