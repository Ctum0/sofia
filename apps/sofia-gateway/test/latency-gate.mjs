// Latency gate — how long from "he stops talking" to "she is audible"?
//
// Phase 0.5's done-when says a turn answers "in under ~1.2 s", and the design
// table claims 2.4-3.2 s to first sound on this stack. Both numbers have lived
// in documents; neither was ever measured by a gate, so nobody knows which one
// is true. This gate measures the segments a browser can see, through the
// gateway the product actually serves:
//
//   connect  -> socket open   (gateway accepts the upgrade, mints, dials Google)
//   ready    -> Live setup complete on the upstream socket
//   turn     -> text sent to the socket until the first audio chunk arrives
//               (model turn detection + generation + network, the dominant cost)
//   played   -> the same chunk actually scheduled on the audio clock
//
// A text turn is used on purpose: a Live session cannot be made to interrupt or
// finish a spoken sentence on cue, so an audio-input measurement would be a
// clock race rather than a number. The model path after the input is accepted is
// the same one a spoken turn takes.
//
// Runs in mcr.microsoft.com/playwright:v1.64.1-jammy --network host, no install
// beyond the playwright package that image's siblings already carry.
const BASE = process.env.BASE || 'http://127.0.0.1:3005'
const PASSWORD = process.env.SOFIA_PASSWORD || ''

const { chromium } = await import('playwright')

const results = []
function step(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const browser = await chromium.launch({
  args: ['--no-sandbox', '--autoplay-policy=user-gesture-required'],
})
const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1200, height: 800 } })
const page = await ctx.newPage()
const consoleErrors = []
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })

try {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  const passwordField = await page.$('input[type=password]')
  if (passwordField) {
    await passwordField.fill(PASSWORD)
    await page.click('button[type=submit], button')
    await page.waitForLoadState('domcontentloaded')
  }
  step('signed in', true, BASE)

  // A real click, so both AudioContexts may run under the strict autoplay
  // policy. Building them outside a gesture is the defect this project already
  // paid for once (a passing gate over a browser that stayed mute).
  await page.evaluate(() => {
    const b = document.createElement('button')
    b.id = 'lat-probe'
    b.textContent = 'probe'
    b.style.cssText = 'position:fixed;left:8px;top:8px;z-index:99999'
    document.body.append(b)
  })
  await page.evaluate(() => {
    document.querySelector('#lat-probe').addEventListener('click', async () => {
      const t = { click: performance.now() }
      const mod = await import(/* @vite-ignore */ '/public/voice-client.mjs')
      const voice = new mod.SofiaVoice({
        onEvent: (e) => { t[`ev:${e.type}`] ??= performance.now() },
      })
      t.unlock = performance.now()
      voice.unlock()
      t.connectStart = performance.now()
      try {
        await voice.connect()
      }
      catch (err) {
        window.__lat = { ...t, error: String(err) }
        return
      }
      t.ready = performance.now()
      t.send = performance.now()
      voice.sendText('Say exactly: "Sofia is here." One short sentence, nothing else.')
      const tick = () => {
        if (voice.stats.chunksPlayed > 0 || performance.now() - t.send > 20000) {
          t.firstPlayed = performance.now()
          window.__lat = { ...t, chunksPlayed: voice.stats.chunksPlayed, playbackState: voice.stats.playbackState }
          return
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  })
  await page.click('#lat-probe')

  // waitForFunction resolves the *predicate's* value (the truthy number), not the
  // object — read the state back with evaluate.
  await page.waitForFunction(() => window.__lat && window.__lat.firstPlayed, null, { timeout: 45000, polling: 100 })
    .catch(() => null)
  const lat = await page.evaluate(() => window.__lat || null)
  if (!lat || lat.error) {
    step('live session opened from a real gesture', false, lat?.error || 'no timings recorded')
    throw new Error('probe never completed')
  }

  step('both audio contexts running after the gesture', lat.playbackState === 'running',
    `playback=${lat.playbackState} chunksPlayed=${lat.chunksPlayed}`)

  const sockMs = Math.round((lat['ev:socket-open'] || lat.connectStart) - lat.connectStart)
  const readyMs = Math.round(lat.ready - lat.connectStart)
  const firstAudioMs = Math.round((lat['ev:audio'] || lat.firstPlayed) - lat.send)
  const turnMs = Math.round(lat.firstPlayed - lat.send)

  console.log(`\nMEASURED (ms): socket-open=${sockMs} ready=${readyMs} first-audio=${firstAudioMs} played=${turnMs}`)

  // The product promise, stated as the number it is. 1200 ms is phase 0.5's
  // line; the design table's 2400-3200 ms is what the stack was assumed to cost.
  step('turn answers inside 1200 ms (phase 0.5 done-when)', turnMs <= 1200, `${turnMs} ms`)
  step('turn answers inside the 3200 ms design assumption', turnMs <= 3200, `${turnMs} ms`)
  step('socket opens inside 1000 ms', sockMs <= 1000, `${sockMs} ms`)
  step('no page errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | ') || 'none')
}
catch (err) {
  step('flow completed', false, String(err).slice(0, 250))
}
finally {
  await browser.close()
  const failed = results.filter(r => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
}
