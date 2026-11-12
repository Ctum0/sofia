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
import { openPage, runBrowse, stageIntent } from './intent.mjs'
import { recordTurn } from './memory.mjs'
import { SseReasoningFilter, stripReasoningFromBody } from './reasoning-filter.mjs'
import { checkPassword, clearCookie, isAuthed, loginPage, makeSession, parseCookies, sessionCookie } from './auth.mjs'
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

// The voice lane's OPERATING RULES — what she can do, not who she is.
//
// Who she is comes from her character card, the same card the text lane sends as
// its system prompt. Before this split the voice path had a hand-written persona
// and the text path had the card, so she was one person when typing and a
// slightly different one when speaking: same name, different voice, different
// humour, no `+`-register personality. One card, both lanes.
//
// `LIVE_SYSTEM_INSTRUCTION` still replaces the whole thing for an experiment.
const VOICE_RULES = [
  'You have hands: call `ask_hermes` whenever he wants something actually done or looked up — a server checked, a command run, a file read, the web searched, a fact remembered or recalled. Call `local_time` for the time or date. Do not answer those yourself and never claim you did something you did not call a tool for.',
  'You have a screen. When he asks to see, show or open ANYTHING visual — a website, a picture, a logo, a page — you MUST call `show_panel` in that same turn. Do not describe a page as open, and never say something is on the stage, unless the `show_panel` call succeeded. Several windows may be open at once; each call opens or raises one. `browse` works inside a page you opened — click by visible text, type into a field, press Enter, scroll, read the page aloud, list the links, go back, reload, or goto another address; to search, click the search box, fill it, press Enter, then read. `control_avatar` changes your own size and place — when he says "get smaller", "shrink", "move left", "come back", "bigger" or "reset", that is this tool: ACTUALLY call it, do not say you did.',
  'How you sound over the voice channel: say it, do not read it. No markdown, no lists, no URLs, no code, no bullet points — speak the meaning in one or two sentences unless he asks for detail.',
  'Forms: `browse` with action "select" picks a dropdown option by its label, "check" ticks or unticks a box (say "off" to untick), "date" types an ISO date into a date field. Use "look" first to see the fields and their labels, and use `fill` for ordinary text fields — including passwords he asks you to type.',
  '`browse` with action "look" tells you what is actually on screen — whether a dialog, a CAPTCHA or an error message is in the way, where the cursor is, which buttons are visible. Use it when an action seemed not to work, or before clicking something you cannot see the name of; `read` gives you the page text, `look` gives you the state.',
  '`recall` is your memory of him: call it before asking something he may have already told you, and whenever he says "do you remember" or "what do you know about me". `remember` keeps a fact he wants you to hold on to. Both reach every conversation on every device, so treat what `recall` returns as things you genuinely know.',
  '`show_chart` draws a chart when numbers are easier to see than to hear — "show me", "graph that", "how does it compare". Give it the labels and the values; it renders the picture on the stage.',
  '`control_window` arranges what is already on screen — resize, move (left, centre or right), maximise, minimise, close, focus, tile, close_all. Use it when he says "move that window", "close them", "make it bigger" or words to that effect, and give it a target: "last", "first", or a window id.',
  'Narrate, then act: say in one short clause what you are about to do BEFORE calling a slow tool ("pulling that up", "let me check"), then make the call. Never leave him in silence while a page loads, and never claim a result before the tool returns.',
  'When a tool returns an error, say plainly that it did not work and what it said. Never invent a result.',
  'Never say you cannot see what is on screen, and never guess. Every tool answer ends with a `[stage: …]` line — that is what is really open right now. If you are unsure, call `browse` with action links or read and look.',
].join(' ')

/**
 * The instruction one Live session runs on: her card's persona first (identity,
 * temperament, how she talks), then the rules that make the tools honest.
 * `card` arrives from the stage, which is the only place that has the card.
 */
export function composeVoiceInstruction(card = '') {
  if (process.env.LIVE_SYSTEM_INSTRUCTION)
    return process.env.LIVE_SYSTEM_INSTRUCTION
  const persona = String(card || '').trim()
  return persona ? `${persona}\n\n${VOICE_RULES}` : VOICE_RULES
}

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
// The fork's stock card, matched by the words that only it carries, in every
// language, and the persona she is given instead.
//
// This migration is load-bearing, and changing the built-in text made it more so.
// A stored card is split into fields and any field equal to *a locale's* built-in
// is treated as unedited (`splitCard`), so once the ja default stopped being
// AIRI's text, a device's stored ja VTuber description stopped matching a variant
// and became a USER EDIT — stranded forever and now synced to the server as one.
// So the old wording is matched on its own identity markers, not by comparing
// against the current default, and it is reset to the new default.
const LEGACY_PERSONA_MARKERS = /VTuber|experimental virtual|実験的なバーチャル|AI virtual|Иру|伊噜|伊嚕|อีรุ|15\s*(?:years? old|year-old|歳|años|ans|세|лет|ปี|tuổi|岁|歲)/i
const SOFIA_OPERATOR_PERSONA = [
  'Your name is Sofia. You are Sithum\'s assistant: calm, quick, and direct.',
  '',
  'You are not a character performing a role, and you do not speak like a cartoon. You speak the way a capable colleague speaks — plainly, in short sentences, with the odd dry remark when the moment earns it. No catchphrases, no filler, no exclamation marks to sound eager.',
  '',
  'You have your own judgement. If an instruction will not work, or there is a better way, say so before doing it. You would rather be useful than agreeable.',
  '',
  'You care about his time. You do not repeat what he just said, you do not explain what he can see, and you do not pad an answer to sound thorough. When he asks for something done, you do it and say what happened, including when it failed.',
  '',
  'You are warm with him, in the way someone is warm who has worked with a person for a long time: brief, familiar, never gushing.',
].join('\n')

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
          // A device that already saved the old VTuber card keeps it. Rewritten
          // once here, matched on a line only that text carries, because base.yaml
          // is the default for NEW cards and cannot reach one already stored. A
          // card the owner edited never matches and is left alone.
          if (typeof node.description === 'string' && LEGACY_PERSONA_MARKERS.test(node.description)) {
            node.description = SOFIA_OPERATOR_PERSONA;
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
// to be read before it is forwarded (see intentFromText).
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

  // A brain that accepts the connection and never answers used to hold this
  // socket open forever: the user's turn simply never completed, with no error
  // anywhere, and the page sat there. `/healthz` already guards itself this way
  // (4 s); a real turn needs longer, and a JSON 504 is something the page can
  // show. The timeout is cleared when the response finishes, so a long stream
  // that is still producing is not cut mid-sentence.
  const UPSTREAM_TIMEOUT_MS = Number(process.env.HERMES_UPSTREAM_TIMEOUT_MS || 120_000)
  upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
    upstream.destroy(new Error(`Hermes did not answer within ${Math.round(UPSTREAM_TIMEOUT_MS / 1000)} s`))
    if (!res.headersSent) {
      sendJson(res, 504, {
        error: 'gateway_timeout',
        message: 'the brain did not answer in time — say so and offer to try again',
      })
    }
  })
  res.on('close', () => upstream.destroy())

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

// Every event carries the tab it belongs to.
//
// Without that, `close everything` in one tab closed every window in every tab:
// two people sharing the deployment were one stage, and even two gates running
// in sequence could clear each other's windows (measured: a gate's own
// `close everything` removed another run's window mid-assertion). A tab is a
// stage; it announces itself with `?tab=` and an event with no `tab` is only
// delivered to the tab that produced it.
function broadcastToStage(event, tab = '') {
  const tagged = { ...event, tab: tab || event.tab || '' }
  const line = `data: ${JSON.stringify(tagged)}\n\n`
  for (const res of stageClients) {
    // A broadcast with no tab is not for a specific tab (the typed lane cannot
    // know it), so it goes everywhere — except when the event names one.
    if (tagged.tab && res.tab && tagged.tab !== res.tab)
      continue
    try { res.write(line) }
    catch { stageClients.delete(res) }
  }
}

// The last page this gateway put on screen. A typed turn has no browser state
// of its own, so "click the search box" has to attach to something — this is it.
// (It sat above the matcher that moved to intent.mjs; deleting that block took
// the declaration with it, and the references below became a runtime
// ReferenceError that `node --check` cannot see.)
let stageLastPage = null

// Exported so a gate can seed the one piece of state a typed turn depends on.
// The product sets it from the panel a voice turn broadcasts, which the
// `the mislabelled page is remembered` check already covers end to end.
export function rememberPage(page) {
  if (page?.sid)
    stageLastPage = { sid: page.sid, url: page.url || stageLastPage?.url || '', title: page.title || '' }
}

async function runStageIntent(intent, { tab = '' } = {}) {
  if (intent.browse) {
    const target = intent.browse.sid || stageLastPage?.sid
    if (!target) {
      console.log(`[sofia-gateway] text: ${intent.browse.action} needs a page and none is open`)
      return
    }
    // The same command builder the voice lane uses. Building the payload twice
    // is what let a typed "type hello" send its words as the selector and a
    // typed "scroll down" send the word where pixels belong.
    const result = await runBrowse(intent.browse, { sid: target })
    const body = result.body
    // `tick` is what makes her clicks visible: without it the window keeps the
    // picture it took when the page opened and every action looks ignored. It
    // fires whether the action worked or not — a failed click must still show
    // him the real page, never a picture from a minute ago.
    // Never an empty url: the stage treats a url-less live event as an update to
    // an existing window, and an empty address is how a tick used to arrive
    // looking like a new blank page.
    broadcastToStage({
      kind: 'live',
      sid: body.sid || target,
      url: body.url || stageLastPage?.url || '',
      title: body.title || '',
      tick: Date.now(),
    }, tab)
    if (!result.ok)
      throw new Error(body.error || `status ${result.status}`)
    rememberPage(body)
    console.log(`[sofia-gateway] text: ${intent.browse.action} -> ${body.url || body.title || 'done'}`)
    return
  }

  for (const event of intent.events) {
    if (event.kind === 'open') {
      const page = await openPage(event.url)
      rememberPage({ ...page, url: page.url || event.url })
      console.log(`[sofia-gateway] text: opened ${page.url || event.url}`)
      broadcastToStage({ kind: 'live', sid: page.sid, url: page.url || event.url, title: page.title || '' }, tab)
      continue
    }
    broadcastToStage(event, tab)
    console.log(`[sofia-gateway] text: ${event.kind} ${event.action} -> tab ${tab || '(all)'} (${stageClients.size} open)`)
  }
}

/**
 * A typed turn has no tools. Everything the typed lane can do is decided here,
 * before Hermes sees the message — including reading a page, whose whole point
 * is that her answer comes from the page and not from the chat history. So this
 * returns the body to forward, not just a side effect.
 */
export async function intentFromText(body, { tab = '' } = {}) {
  let payload
  try { payload = JSON.parse(body.toString('utf8')) }
  catch {
    console.log(`[sofia-gateway] text: unreadable body (${body?.length ?? 'no'} bytes)`)
    return { body }
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
    return { body }

  // Reading is the one intent whose result has to travel with the request.
  // Running it out of band and then proxying the original body left Hermes
  // answering from chat history: the page was read, and nothing downstream ever
  // saw it. The text goes into the turn as an observation the model can use.
  if (intent.browse?.action === 'read' || intent.browse?.action === 'links') {
    const target = stageLastPage?.sid
    if (!target)
      return { body }
    try {
      const result = await runBrowse(intent.browse, { sid: target })
      broadcastToStage({ kind: 'live', sid: result.body.sid || target, url: result.body.url || stageLastPage?.url || '', title: result.body.title || '', tick: Date.now() }, tab)
      if (!result.ok)
        throw new Error(result.body.error || `status ${result.status}`)
      rememberPage(result.body)
      const observed = intent.browse.action === 'read'
        ? `The page (${result.body.url || stageLastPage?.url || 'open page'}) shows:\n${String(result.body.text || '').slice(0, 4000)}`
        : `The links on ${result.body.url || 'the page'} are:\n${(result.body.links || []).slice(0, 40).map(l => `- ${l.text} -> ${l.href}`).join('\n')}`
      // `message === lastUser` is an identity check on the objects that came out
      // of this same parse: nothing here clones them. A future `structuredClone`
      // of `messages` would make every comparison false and turn this injection
      // into a silent no-op, so keep it a map over the parsed array.
      const rewritten = {
        ...payload,
        messages: messages.map(message => (message === lastUser
          ? { ...message, content: `${text}\n\n[stage: the gateway already read the open page for you. Answer from this, and do not claim you cannot see it.]\n${observed}` }
          : message)),
      }
      console.log(`[sofia-gateway] text: ${intent.browse.action} -> ${String(result.body.text || '').length} chars handed to Hermes`)
      return { body: Buffer.from(JSON.stringify(rewritten), 'utf8') }
    }
    catch (error) {
      console.log(`[sofia-gateway] text: intent failed (${String(error && error.message || error).slice(0, 100)})`)
      return { body }
    }
  }

  // Everything else stays OUT of band, on purpose. Awaiting it made every typed
  // turn wait for a page to open before Hermes could answer, so a slow `open`
  // turned into "no window appeared" and a stalled browser into a stalled
  // reply. Only `read` and `links` need to be inside the request, because only
  // they produce text for the answer; a window appearing does not.
  runStageIntent(intent, { tab }).catch(error =>
    console.log(`[sofia-gateway] text: intent failed (${String(error && error.message || error).slice(0, 100)})`),
  )
  return { body }
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
    // before handing the message to Hermes. It AWAITS, because a read has to
    // rewrite the turn — running it out of band let Hermes answer from chat
    // history while the page sat there already read.
    if (url.pathname.endsWith('/chat/completions') && req.method === 'POST') {
      console.log(`[sofia-gateway] text: chat turn ${req.method} ${url.pathname}`)
      const body = await readRequestBody(req).catch(() => null)
      if (body) {
        // Memory is fed by both lanes, so a fact he types is known to her when
        // he speaks it later. Honcho derives observations from these messages;
        // without this, typed turns were invisible to memory entirely.
        try {
          const parsed = JSON.parse(body.toString('utf8'))
          const lastUser = [...(parsed.messages || [])].reverse().find(m => m?.role === 'user')
          const said = typeof lastUser?.content === 'string'
            ? lastUser.content
            : Array.isArray(lastUser?.content) ? lastUser.content.map(p => p?.text || '').join(' ') : ''
          if (said && !said.includes('[stage:'))
            void recordTurn({ from: 'user', text: said, sessionId: 'general' }).catch(() => {})
        }
        catch {}
        // The tab rides on the request so a typed `close everything` is scoped to
        // the stage that asked for it, instead of clearing every open tab.
        // The tab travels as a cookie because the chat request is made by the
        // provider's own fetch, which the stage does not wrap. Without it, one
        // tab's `close everything` cleared every other tab's windows.
        const cookies = parseCookies(req.headers.cookie || '')
        const prepared = await intentFromText(body, { tab: String(cookies.sofia_tab || req.headers['x-sofia-tab'] || url.searchParams.get('tab') || '') })
        proxyToHermes(req, res, url, prepared.body)
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
    res.tab = String(url.searchParams.get('tab') || '')
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
      const routes = { '/api/browse/open': '/open', '/api/browse/act': '/act', '/api/browse/close': '/close', '/api/browse/touch': '/touch' }
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
    // Scoped like every other stage event: an agent moving "the window" should
    // move one stage's window, not every open tab's.
    broadcastToStage(event, String(asked.tab || req.headers['x-sofia-tab'] || url.searchParams.get('tab') || ''))
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
    const pages = Array.isArray(toolCtx.pages) ? toolCtx.pages : []
    if (!pages.length)
      return '\n[stage: nothing is open yet. Call show_panel with kind live to put a page on screen.]'
    // Every page, with its id, because with two windows open "click the link" is
    // ambiguous. Naming them is what lets the model pass `target`.
    const lines = pages.slice(0, 8).map(page => `— id ${page.sid}: ${page.title || '(untitled)'} ${page.url}`)
    return `\n[stage: ${pages.length} page(s) open beside you:\n${lines.join('\n')}\nUse browse with target (a title or url fragment, or "last"/"first") to say which one.]`
  }

  // The stage is the only place with her character card, and it can only send it
  // after the socket opens. So the instruction starts from the rules alone and is
  // replaced once a `persona` message arrives — before `start()` opens the socket
  // to Google, which is why the client sends it as its first message.
  let voiceCard = ''
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
          // "Act while talking": the model was told to say what it is doing
          // BEFORE the call returns (see VOICE_RULES), and a tool that takes
          // twenty seconds otherwise leaves twenty seconds of silence. The
          // stage is told which one is running so it can show it too.
          const startedAt = Date.now()
          const progress = setInterval(() => {
            send({ type: 'tool', name: call.name, state: 'running', ms: Date.now() - startedAt })
          }, 1500)
          let result
          try {
            result = await executeToolCall(call, toolCtx)
          }
          finally {
            clearInterval(progress)
          }
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
    systemInstruction: () => composeVoiceInstruction(voiceCard),
    tools: LIVE_TOOLS,
  }).startAfterPersona()

  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString('utf8')) }
    catch { return }

    if (msg.type === 'persona' && typeof msg.text === 'string') {
      // Her card, from the only place that has it. Sent before anything else, so
      // the socket to Google opens with the same personality the text lane uses.
      voiceCard = msg.text.slice(0, 20000)
      // The socket to Google is held until this arrives (or 400 ms passes), so
      // the session is built with her card rather than the rules alone.
      bridge.beginWhenReady?.()
      send({ type: 'persona', ok: true, chars: voiceCard.length })
      return
    }
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

// A gate imports this module to exercise `intentFromText` with a fake chat body;
// binding a port in the same process would fight the running gateway. The
// switch is opt-in, so production behaviour is byte-for-byte unchanged.
if (process.env.SOFIA_NO_LISTEN === '1') {
  console.log('[sofia-gateway] SOFIA_NO_LISTEN=1 — not binding a port (imported by a gate)')
}
else {
server.listen(PORT, HOST, () => {
  console.log(`[sofia-gateway] http://${HOST}:${PORT}  stage=${DIST}  hermes=${HERMES_BASE}`)
  console.log(`[sofia-gateway] key: ${hermesKey() ? 'loaded' : 'MISSING — /v1 will answer 503'}  trace=${TRACE}  reasoning=${KEEP_REASONING ? 'kept' : 'stripped'}`)
  console.log(`[sofia-gateway] live: ws /api/live/stream -> ${DEFAULT_MODEL} (${DEFAULT_VOICE})`)
  const clock = proactiveStatus()
  console.log(`[sofia-gateway] proactive: slots=${clock.slots.join(',')} (${clock.timezone}) now=${clock.now} state=${clock.statePath}`)
  startProactive()
})
}
