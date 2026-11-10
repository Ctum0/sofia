// Barge-in gate — when the person talks over her, does her voice actually stop?
//
// Gemini's VAD owns turn-taking on the server side and announces an
// interruption with `serverContent.interrupted`, which the gateway forwards as
// `{type:'interrupted'}`. The audio queue, however, lives in the browser. With
// no branch for that event the queue played on to the end and her mouth kept
// moving: measured on the build before this gate existed, `interrupted` arrived
// and `isPlaying()` stayed true for the remaining ~3 s of queued speech.
//
// A Live session cannot be made to interrupt on cue — the model decides — so the
// deterministic half is here: a real WebSocket server sends real 24 kHz PCM and
// then a real `interrupted` frame at a known moment, and the module the stage
// imports (`/public/voice-client.mjs`, served by the gateway itself) has to
// silence the queue and drop the in-flight tail. The non-deterministic half
// (Gemini emitting the event) is covered by `live-gateway-probe.mjs` and the
// gateway's own `live.mjs`, which forwards `sc.interrupted`.
//
// Mixed content: a page on https:// may not open ws://127.0.0.1. That is why
// BASE defaults to the container's plain-http port — the same artefact, same
// module, just not TLS.
//
// Run last-ish; needs no app password file when SOFIA_PASSWORD is passed.
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'

import { chromium } from 'playwright'

const BASE = process.env.BASE || 'http://127.0.0.1:3005'
const WS_PORT = Number(process.env.WS_PORT || 8799)
const PASSWORD = process.env.SOFIA_PASSWORD || (() => {
  try { return readFileSync('/home/ctum/secrets/sofia-password', 'utf8').trim() }
  catch { return '' }
})()

const results = []
function step(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// --- a WebSocket server with no dependencies ---------------------------------
// Node ships a WebSocket *client*; a test needs the other end. Text frames only,
// server-to-client (unmasked), which is all this gate sends.

function wsFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.alloc(2)
    header[1] = len
  }
  else if (len < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(len, 2)
  }
  else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  header[0] = 0x81 // FIN + text
  return Buffer.concat([header, payload])
}

/** 0.5 s of a 440 Hz tone as 24 kHz PCM16, base64 — exactly what the gateway relays. */
function toneChunk() {
  const rate = 24000
  const samples = rate / 2
  const buf = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    const v = Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 8000)
    buf.writeInt16LE(v, i * 2)
  }
  return buf.toString('base64')
}

const CHUNKS_BEFORE = 60 // 30 s of speech queued: a headless audio clock runs
// faster than wall time, so a short queue drains before the measurement and a
// dead interrupt looks like a working one. The tail below is what proves it.
const TAIL_CHUNKS = 3 // chunks already on the wire when the interrupt lands

const timeline = { ready: 0, chunks: 0, interrupted: 0, tail: 0 }
let control = null

function serve(ws) {
  const send = (obj) => {
    try { ws.write(wsFrame(JSON.stringify(obj))) }
    catch {}
  }
  send({ type: 'ready', model: 'gate-mock', voice: 'none' })
  timeline.ready += 1
  for (let i = 0; i < CHUNKS_BEFORE; i++) {
    setTimeout(() => { send({ type: 'audio', data: toneChunk() }); timeline.chunks += 1 }, 20 * i)
  }
  // The interrupt is fired by the gate, not by a clock: the browser needs an
  // unpredictable amount of time to push 60 buffers through an AudioContext, and
  // a timed interrupt either lands before she is speaking or after the queue has
  // drained — both of which make this gate lie.
  control = {
    interrupt() {
      send({ type: 'interrupted' })
      timeline.interrupted += 1
      for (let i = 0; i < TAIL_CHUNKS; i++) {
        setTimeout(() => { send({ type: 'audio', data: toneChunk() }); timeline.tail += 1 }, 150 + 130 * i)
      }
    },
  }
}

const server = createServer((req, res) => {
  res.writeHead(426, { 'content-type': 'text/plain' })
  res.end('websocket only')
})
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key']
  if (!key) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
    socket.destroy()
    return
  }
  const accept = createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )
  socket.on('error', () => {})
  socket.on('data', () => {}) // client frames (close/ping) are not interesting here
  serve(socket)
})
await new Promise(resolve => server.listen(WS_PORT, '127.0.0.1', resolve))
console.log(`mock Live server on ws://127.0.0.1:${WS_PORT}`)

const browser = await chromium.launch({
  args: [
    '--no-sandbox',
    // Strict policy on purpose: a context that never got the click's permission
    // is a silent reply, which is a different bug this gate must not mask.
    '--autoplay-policy=user-gesture-required',
  ],
})
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } })
const page = await ctx.newPage()
const consoleErrors = []
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })

const qa = (fn, arg) => page.evaluate(fn, arg)

try {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  const needsLogin = await page.locator('input[name=password]').count()
  if (needsLogin) {
    if (!PASSWORD) throw new Error('login form present but no SOFIA_PASSWORD')
    await page.fill('input[name=password]', PASSWORD)
    await page.click('button[type=submit]')
    await page.waitForFunction(() => document.body && !document.body.innerText.includes('Private assistant'), null, { timeout: 45000 })
  }
  step('signed in', true, page.url())

  // Import once, then create the client inside the click so `unlock()` runs in
  // the gesture — the same discipline the dock uses.
  await qa(async ({ port }) => {
    const mod = await import('/public/voice-client.mjs')
    const btn = document.createElement('button')
    btn.id = 'qa-barge'
    btn.textContent = 'qa'
    btn.style.cssText = 'position:fixed;left:8px;top:8px;z-index:2147483647;width:40px;height:40px'
    document.body.appendChild(btn)
    btn.addEventListener('click', () => {
      const client = new mod.SofiaVoice({
        url: `ws://127.0.0.1:${port}`,
        onEvent: (e) => { (window.__qaEvents ||= []).push(e.type) },
      })
      window.__qa = client
      client.unlock()
      client.connect()
        .then(() => { window.__qaReady = true })
        .catch((err) => { window.__qaErr = String(err) })
    })
  }, { port: WS_PORT })

  await page.click('#qa-barge')

  const ready = await page.waitForFunction(() => window.__qaReady === true || !!window.__qaErr, null, { timeout: 20000 })
    .then(() => true).catch(() => false)
  if (!ready) throw new Error('client never reached ready against the mock server')
  const err = await qa(() => window.__qaErr)
  if (err) throw new Error(err)
  step('client connected to the Live socket', true, `${timeline.chunks} chunks sent before the interrupt`)

  const running = await page.waitForFunction(() => {
    const s = window.__qa?.stats
    return !!s && s.playbackState === 'running'
  }, null, { timeout: 15000 }).then(() => true).catch(() => false)
  const st = await qa(() => window.__qa.stats)
  step('playback context is running (not suspended)', running, `state=${st?.playbackState} rate=${st?.playbackRate}`)

  // Before the interrupt: she really is speaking, and most of the queue is in.
  const speaking = await page.waitForFunction(n => window.__qa?.isPlaying() === true && (window.__qa?.stats?.chunksPlayed || 0) >= n, CHUNKS_BEFORE, { timeout: 30000 })
    .then(() => true).catch(() => false)
  const before = await qa(() => ({
    chunks: window.__qa.stats.chunksPlayed,
    playing: window.__qa.isPlaying(),
    level: window.__qa.getLevel(),
  }))
  step('audio is playing before the interruption', speaking && before.playing,
    `chunksPlayed=${before.chunks} level=${Number(before.level).toFixed(3)}`)

  // Now interrupt, with the queue still full.
  if (!control)
    throw new Error('mock control not ready')
  control.interrupt()

  // The interrupt lands while ~3 s of speech is still queued.
  const sawInterrupt = await page.waitForFunction(() => (window.__qa?.stats?.interruptions || 0) > 0, null, { timeout: 6000 })
    .then(() => true).catch(() => false)
  step('interrupted event reached the client', sawInterrupt,
    sawInterrupt ? `interruptions=${(await qa(() => window.__qa.stats.interruptions))}` : 'never counted — the client does not handle `interrupted`')

  // 800 ms after the frame: long enough for all three tail chunks to land.
  await page.waitForTimeout(800)
  const after = await qa(() => ({
    chunks: window.__qa.stats.chunksPlayed,
    playing: window.__qa.isPlaying(),
    level: window.__qa.getLevel(),
    dropped: window.__qa.stats.droppedAfterInterrupt,
    peak: window.__qa.stats.levelPeak,
  }))
  const silent = !after.playing && Number(after.level) === 0
  step('her voice stopped when the person spoke', silent,
    `isPlaying=${after.playing} level=${Number(after.level).toFixed(3)} (before: ${Number(before.level).toFixed(3)})`)
  step('the in-flight tail was discarded, not spoken', (after.dropped || 0) >= 1,
    `droppedAfterInterrupt=${after.dropped ?? 'undefined'} of ${timeline.tail} sent after the interrupt`)
  step('no further audio entered playback after the interruption', after.chunks === before.chunks,
    `chunksPlayed ${before.chunks} -> ${after.chunks} (all ${CHUNKS_BEFORE} pre-interrupt frames were queued before the frame)`)

  const errors = await qa(() => window.__qa?.stats?.errors || [])
  step('no client errors', errors.length === 0, errors.join('; ') || 'none')
  const dial6121 = consoleErrors.filter(l => l.includes('localhost:6121')).length
  step('no dev-socket dial', dial6121 === 0, `${dial6121} x localhost:6121`)

  await page.screenshot({ path: '/qa/barge-in.png' })
  console.log(`\nTIMELINE: ${JSON.stringify(timeline)}`)
  console.log(`MEASURED: ${JSON.stringify({ before, after })}`)
}
catch (error) {
  step('flow completed', false, String(error).slice(0, 250))
  try { await page.screenshot({ path: '/qa/barge-in-fail.png' }) } catch {}
}
finally {
  await browser.close()
  server.close()
  const failed = results.filter(r => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
}
