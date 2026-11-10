// Does a Sofia voice conversation survive the Gemini Live connection cap?
//
// A Live *connection* is capped at about ten minutes; the API announces the end
// with a `goAway` frame and then closes. Before item R the gateway passed
// goAway to the page and did nothing else, so the browser socket stayed open
// while the Google socket died: the dock still read "Stop" and Sofia was simply
// silent forever. This gate is the acceptance test that build order phase 0.5
// always named and nobody had run — "a session survives past 11 minutes".
//
// What it does: logs in, opens the real `/api/live/stream` socket, streams
// silence at 100 ms intervals exactly like the mic lane, asks for one word at
// ~60 s and asks again past the cap, and requires an answer AFTER the cap. It
// also prints every non-audio event with its timestamp so the reconnect is
// visible (`reconnecting`, `ready resumed:true`) rather than inferred.
//
//   BASE=https://sofia.ctum.org SOFIA_PASSWORD=... node session-longevity-gate.mjs
//   LONGEVITY_S=660   how long to stay connected (default 700 s ≈ 11.7 min)
//
// Node builtins only apart from the WebSocket client, which Node 22 has built in;
// on an older node it falls back to the `ws` package so it still runs on the host.
import { Buffer } from 'node:buffer'

const BASE = (process.env.BASE || 'https://sofia.ctum.org').replace(/\/$/, '')
const PASSWORD = process.env.SOFIA_PASSWORD || process.env.PASSWORD || ''
const LONGEVITY_S = Number(process.env.LONGEVITY_S || 700)
const ASK_FIRST_AT_S = Number(process.env.ASK_FIRST_AT_S || 60)
const REPLY_TIMEOUT_MS = 30_000

const t0 = Date.now()
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`
const log = (...a) => console.log(`[${el()}]`, ...a)

const results = []
function check(name, pass, detail = '') {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function makeSocketClass() {
  if (typeof globalThis.WebSocket === 'function') return globalThis.WebSocket
  const mod = await import('ws')
  return mod.default
}

async function login() {
  if (!PASSWORD) {
    console.error('no SOFIA_PASSWORD in env and no password file readable here')
    process.exit(2)
  }
  const res = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: PASSWORD }).toString(),
    redirect: 'manual',
  })
  const setCookie = res.headers.getSetCookie?.() || []
  const cookie = setCookie.map(c => c.split(';')[0]).join('; ')
  if (!cookie) {
    console.error(`login failed: HTTP ${res.status}, no cookie`)
    process.exit(2)
  }
  log(`login ok (HTTP ${res.status})`)
  return cookie
}

const WebSocketImpl = await makeSocketClass()
const cookie = await login()

const stats = {
  framesSent: 0,
  audioChunks: 0,
  chunksBeforeCap: 0,
  chunksAfterCap: 0,
  transcripts: 0,
  reconnecting: 0,
  goAway: 0,
  readyCount: 0,
  resumedReady: 0,
  closedBeforeEnd: 0,
  gone: 0,
  errors: [],
}

const askTwoInMs = LONGEVITY_S * 1000
let askTwoAt = 0
let answeredFirst = false
let answeredSecond = false
let firstDialAt = Date.now() + ASK_FIRST_AT_S * 1000

const silence = Buffer.alloc(3200).toString('base64') // 100 ms @16 kHz mono PCM16
const wsUrl = `${BASE.replace(/^http/, 'ws')}/api/live/stream`
log(`opening ${wsUrl}`)
const ws = new WebSocketImpl(wsUrl, { headers: { Cookie: cookie } })
ws.binaryType = 'arraybuffer'

const send = (obj) => {
  try {
    ws.send(JSON.stringify(obj))
  }
  catch (err) {
    stats.errors.push(String(err?.message || err))
  }
}

ws.addEventListener('open', () => {
  log('socket open')
  check('gateway live socket accepts an authenticated client', true)
})

ws.addEventListener('message', (evt) => {
  let msg
  try {
    msg = JSON.parse(typeof evt.data === 'string' ? evt.data : Buffer.from(evt.data).toString('utf8'))
  }
  catch {
    return
  }
  if (msg.type === 'audio') {
    stats.audioChunks += 1
    if (answeredFirst && Date.now() < askTwoAt - 1000) stats.chunksBeforeCap += 1
    if (answeredSecond) stats.chunksAfterCap += 1
    return
  }
  if (msg.type === 'transcript') {
    stats.transcripts += 1
    return
  }
  log('event', JSON.stringify(msg).slice(0, 200))
  if (msg.type === 'ready') {
    stats.readyCount += 1
    if (msg.resumed) stats.resumedReady += 1
  }
  if (msg.type === 'reconnecting') stats.reconnecting += 1
  if (msg.type === 'goAway') stats.goAway += 1
  if (msg.type === 'closed') stats.closedBeforeEnd += 1
  if (msg.type === 'gone') stats.gone += 1
  if (msg.type === 'error') stats.errors.push(String(msg.message || msg.code || 'live error'))
})

ws.addEventListener('error', () => {
  stats.errors.push('socket error')
})

ws.addEventListener('close', (evt) => {
  log(`socket closed ${evt.code} ${evt.reason || ''}`)
})

// Keep the mic lane busy: silence at the same cadence the worklet uses. Idle
// audio is what a real conversation looks like between sentences.
const pump = setInterval(() => {
  if (ws.readyState !== 1) return
  send({ type: 'audio', data: silence })
  stats.framesSent += 1
}, 100)

let askedFirst = false
let askedSecond = false
const timers = []

timers.push(setTimeout(() => {
  askedFirst = true
  const before = stats.audioChunks + stats.transcripts
  log(`ask #1 (before the cap): ${before} reply units so far`)
  send({ type: 'text', text: 'Say exactly: one.' })
  setTimeout(() => {
    answeredFirst = stats.audioChunks + stats.transcripts > before
    check('she answers before the cap', answeredFirst, `+${stats.audioChunks + stats.transcripts - before} units`)
  }, REPLY_TIMEOUT_MS)
}, ASK_FIRST_AT_S * 1000))

timers.push(setTimeout(() => {
  askedSecond = true
  askTwoAt = Date.now()
  const before = stats.audioChunks + stats.transcripts
  log(`ask #2 (PAST the ${Math.round(LONGEVITY_S / 60)} min mark, ${stats.framesSent} frames sent): ${before} reply units so far`)
  send({ type: 'text', text: 'Say exactly: two.' })
  setTimeout(() => {
    answeredSecond = stats.audioChunks + stats.transcripts > before
    if (answeredSecond) stats.chunksAfterCap = Math.max(stats.chunksAfterCap, stats.audioChunks)
    check('she still answers past the connection cap', answeredSecond, `+${stats.audioChunks + stats.transcripts - before} units, ${stats.chunksAfterCap} audio chunks after`)
    finish()
  }, REPLY_TIMEOUT_MS)
}, askTwoInMs))

function finish() {
  clearInterval(pump)
  for (const t of timers) clearTimeout(t)
  try { ws.close() } catch {}
  console.log('\n--- summary ---')
  console.log(JSON.stringify(stats, null, 2))
  check('the session did not end for good', stats.gone === 0, `gone=${stats.gone}`)
  check('reply audio was produced at all', stats.audioChunks > 0, `${stats.audioChunks} chunks`)
  // A rotation is not guaranteed inside the budget (measured: one run stayed on
  // the same upstream socket for 13 min). Assert the PROPERTY — any swap that
  // did happen was resumed successfully — and print the counts either way, so a
  // pass never hides "nothing was exercised".
  if (stats.goAway + stats.closedBeforeEnd > 0) {
    check('a socket swap was resumed', stats.resumedReady > 0, `goAway x${stats.goAway}, closed x${stats.closedBeforeEnd}, ready x${stats.readyCount} (resumed x${stats.resumedReady})`)
  }
  else {
    console.log(`NOTE  no upstream rotation inside ${Math.round(LONGEVITY_S / 60)} min (ready x${stats.readyCount}) — duration proven, rotation recovery is proven by probe-resume.mjs`)
  }
  const failed = results.filter(r => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length === 0 ? 0 : 1)
}

// Never hang forever.
setTimeout(() => {
  check('gate finished within its budget', false, 'timeout')
  finish()
}, (LONGEVITY_S + 120) * 1000).unref?.()
