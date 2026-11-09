// The auth surface, enumerated instead of assumed.
//
// Every other gate asks "does the product work for me". This one asks the
// opposite question: what does the server answer to a stranger? Its output is
// the table — path, status without a session, and the reason that status is
// correct — so "the gate covers everything" is a measurement, not a reading of
// server.mjs. It also probes the WebSocket upgrade, which is the one route that
// produces no HTTP response at all unless it is explicitly refused.
//
// Dependency-free on purpose (node:http only): it must run anywhere, including
// the QA container, without a package install.
import { randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

const BASE = process.env.BASE || 'https://sofia.ctum.org'
const PASSWORD = process.env.SOFIA_PASSWORD || process.env.PASSWORD || ''
const results = []
const rows = []
const step = (n, ok, d = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`)
}

// path, expected status, method, and why that status is the right one
const SURFACE = [
  ['/', 200, 'GET', 'the gate itself: login form, never the stage'],
  ['/index.html', 401, 'GET', 'the app shell, behind the gate'],
  ['/settings', 401, 'GET', 'a real stage route with no session'],
  ['/assets/app.js', 401, 'GET', 'built JS bundle, behind the gate'],
  ['/api/live/info', 401, 'GET', 'names the live model and voice'],
  ['/api/live/stream', 401, 'GET', 'plain GET on the voice socket path'],
  ['/api/anything', 401, 'GET', 'unknown api route must not enumerate'],
  ['/v1/models', 401, 'GET', 'Hermes proxy: would leak the model list'],
  ['/v1/chat/completions', 401, 'POST', 'Hermes proxy: would spend his tokens'],
  ['/public/voice-client.mjs', 401, 'GET', 'harness code'],
  ['/public/voice-test.html', 401, 'GET', 'harness page'],
  ['/healthz', 200, 'GET', 'uptime probe: readiness only, no secret value'],
  ['/manifest.webmanifest', 200, 'GET', 'PWA manifest, needed pre-auth to install'],
  ['/favicon.svg', 200, 'GET', 'brand pixel, asked for by the login page'],
  ['/og.png', 200, 'GET', 'brand pixel'],
  ['/sw.js', 200, 'GET', 'PWA kill switch must reach a locked-out browser'],
  ['/?reset=1', 200, 'GET', 'stale-shell recovery; acts only on the caller'],
  ['/api/logout', 302, 'GET', 'drop the cookie, works while locked out'],
  ['/login', 302, 'GET', 'alias to /'],
]

async function probe(path, method, accept, cookie) {
  const headers = {}
  if (accept) headers.accept = accept
  if (cookie) headers.cookie = cookie
  const res = await fetch(`${BASE}${path}`, {
    method,
    redirect: 'manual',
    headers,
    body: method === 'POST' ? '' : undefined,
  })
  const body = await res.text()
  return { status: res.status, body, headers: res.headers }
}

function upgrade(path, cookie) {
  return new Promise((resolve) => {
    const u = new URL(`${BASE}${path}`)
    const mod = u.protocol === 'https:' ? httpsRequest : httpRequest
    const req = mod({
      hostname: u.hostname,
      servername: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        ...(cookie ? { Cookie: cookie } : {}),
      },
    })
    let settled = false
    const done = (v) => {
      if (settled) return
      settled = true
      try { req.destroy() } catch {}
      resolve(v)
    }
    req.on('upgrade', (res, socket) => { socket.destroy(); done({ status: res.statusCode, upgraded: true }) })
    req.on('response', (res) => { res.resume(); done({ status: res.statusCode, upgraded: false }) })
    req.on('error', (e) => done({ status: 0, error: e.code || e.message }))
    req.setTimeout(15000, () => done({ status: 0, error: 'timeout' }))
    req.end()
  })
}

console.log(`surface vs ${BASE}\n`)
for (const [path, expect, method, why] of SURFACE) {
  let got
  try {
    got = await probe(path, method)
  }
  catch (e) {
    got = { status: 0, body: String(e), headers: new Headers() }
  }
  const ok = got.status === expect
  rows.push({ path, method, status: got.status, expect, why, ok })
  let extra = ''
  // A 401 must not be a different page wearing a 401: assert the body.
  if (expect === 401 && ok && !got.body.includes('unauthorized'))
    extra = ` body=${got.body.slice(0, 40)}`
  if (path === '/' && ok && (!got.body.includes('name="password"') || !got.body.includes('<title>Sofia</title>')))
    extra = ' login page missing form or title'
  if (path === '/healthz' && ok) {
    let h = {}
    try { h = JSON.parse(got.body) } catch {}
    if (!['set', 'missing'].includes(h.key)) extra = ` key field=${JSON.stringify(h.key)}`
    if (h.ok !== true) extra = ` ok=${h.ok}`
  }
  if (path === '/manifest.webmanifest' && ok && !got.body.includes('"name":"Sofia"'))
    extra = ' manifest not branded'
  if (path === '/sw.js' && ok && !got.body.includes('unregister'))
    extra = ' kill switch missing'
  if (path === '/?reset=1' && ok && !String(got.headers.get('clear-site-data') || '').includes('storage'))
    extra = ' no clear-site-data header'
  step(`${method} ${path} -> ${expect}`, ok && !extra, ok ? why : `got ${got.status}${extra}`)
}

// The public 200s must not be a smuggled app. Named checks above cover the payloads;
// this covers the class: no file paths and no upstream brand in anything public.
const publicPaths = SURFACE.filter(([, s]) => s === 200).map(([p]) => p)
for (const p of publicPaths) {
  let body = ''
  try { body = (await probe(p, 'GET')).body } catch {}
  const leak = /\/home\/ctum|SOFIA_PASSWORD|AIRI/.exec(body)
  step(`public ${p} leaks no path, secret or brand`, !leak, leak ? `found ${leak[0]}` : 'clean')
}

// Content negotiation is a gate-shaped hole if it is not pinned: a request that
// asks for HTML gets the login page with 200 on *any* path. That is correct for a
// browser and confusing for every scanner, so prove both answers are deliberate.
const htmlApi = await probe('/v1/models', 'GET', 'text/html')
step(
  'Accept: text/html on /v1/models answers the login page, not the model list',
  htmlApi.status === 200 && htmlApi.body.includes('name="password"') && !htmlApi.body.includes('"data"'),
  `${htmlApi.status} ${htmlApi.body.length}B`,
)

// The upgrade is the route the earlier gates could not see: with no session the
// handler used to destroy the socket with no status line, so Caddy invented 502
// and Cloudflare passed it on.
const refused = await upgrade('/api/live/stream', '')
step('WS upgrade with no cookie is refused with 401', refused.status === 401, JSON.stringify(refused))
const notLive = await upgrade('/api/nope', '')
step('WS upgrade on an unknown path is refused with 404', notLive.status === 404, JSON.stringify(notLive))

// Refusal must be specific, not a blanket "voice is off": the same probe with a
// real session has to reach 101, or the gate is passing for the wrong reason.
let cookie = ''
if (PASSWORD) {
  const login = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: PASSWORD }).toString(),
  })
  cookie = (login.headers.getSetCookie?.() || [])[0]?.split(';')[0] || ''
  step('login issues a session cookie', login.status === 302 && cookie.startsWith('sofia_session='), `${login.status} ${cookie.slice(0, 20)}…`)
  const setCookie = (login.headers.getSetCookie?.() || [])[0] || ''
  step('cookie is HttpOnly, Secure, SameSite', /HttpOnly/i.test(setCookie) && /Secure/i.test(setCookie) && /SameSite=Lax/i.test(setCookie), setCookie.slice(0, 80))
}
else {
  step('login issues a session cookie', false, 'no SOFIA_PASSWORD in env — pass it, do not skip')
}

if (cookie) {
  const accepted = await upgrade('/api/live/stream', cookie)
  step('WS upgrade with a session reaches 101', accepted.status === 101 && accepted.upgraded === true, JSON.stringify(accepted))
  const authed = await probe('/api/live/info', 'GET', null, cookie)
  step('GET /api/live/info with a session answers 200', authed.status === 200, `${authed.status}`)
}

console.log('\nSURFACE')
for (const r of rows)
  console.log(`  ${String(r.status).padStart(3)}  ${r.method.padEnd(4)} ${r.path.padEnd(26)} ${r.why}`)

const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} checks passed`)
process.exit(passed === results.length ? 0 : 1)
