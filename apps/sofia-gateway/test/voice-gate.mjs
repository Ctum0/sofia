// Voice gate — the stage, not the harness.
//
// The old gate drove /public/voice-test.html, which proved the bridge but not
// the product: the stage could still have no Talk control and no lip sync. This
// one logs in like a person, presses the dock's Talk button on the stage, feeds
// a real sentence through a fake microphone, and reads the mouth value the
// component writes from the played 24 kHz PCM.
//
// Autoplay is left at the strict policy — the one a real browser applies and
// Safari enforces hardest. That is deliberate: with `no-user-gesture-required`
// the gate passed while a person's session was mute, because the browser was
// never given the chance to deny the AudioContext the client was creating
// outside the click. A build that does not unlock audio inside the gesture now
// fails here instead of on his desk.
//
// Run inside mcr.microsoft.com/playwright:v1.64.1-jammy with --network host.
import { readFileSync } from 'node:fs'

import { chromium } from 'playwright'

const BASE = process.env.BASE || 'http://127.0.0.1:8787'
// The fake mic LOOPS this file, so the gap between one repetition and the next
// is its trailing silence — and the model only ends a turn when that gap is
// longer than `silenceDurationMs`. mic-hello.wav's tail is 853 ms, so from the
// moment live.mjs moved to 1100 ms this gate failed with "peak 0, no reply"
// while the product was healthy: the fixture had no end-of-turn left to give.
// mic-one-line.wav is 1.85 s of speech + 20.0 s of digital silence.
const WAV = process.env.WAV || '/qa/mic-one-line.wav'
const THRESHOLD_MS = Number(process.env.LIVE_SILENCE_MS || 1100)
const passwordFile = process.env.SOFIA_PASSWORD_FILE || '/home/ctum/secrets/sofia-password'
const PASSWORD = process.env.SOFIA_PASSWORD || (() => {
  try { return readFileSync(passwordFile, 'utf8').trim() }
  catch { return '' }
})()

const results = []
function step(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// A fixture is a claim about the product, so it is measured before it is used.
// Node builtins only: RIFF/WAVE 16-bit PCM -> total length and the trailing
// silence the looping fake mic turns into the gap between two turns.
function wavShape(path) {
  const buf = readFileSync(path)
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error(`${path} is not a RIFF/WAVE file`)
  let off = 12
  let fmt = null
  let data = null
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    const body = off + 8
    if (id === 'fmt ')
      fmt = { channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) }
    if (id === 'data')
      data = { start: body, size: Math.min(size, buf.length - body) }
    off = body + size + (size % 2)
  }
  if (!fmt || !data)
    throw new Error(`${path} has no fmt/data chunk`)
  if (fmt.bits !== 16)
    throw new Error(`${path} is ${fmt.bits}-bit; this audit reads 16-bit PCM only`)
  const frame = 2 * fmt.channels
  const frames = Math.floor(data.size / frame)
  let lastLoud = -1
  for (let i = frames - 1; i >= 0; i--) {
    let peak = 0
    for (let c = 0; c < fmt.channels; c++)
      peak = Math.max(peak, Math.abs(buf.readInt16LE(data.start + i * frame + c * 2)))
    if (peak > 300) { lastLoud = i; break }
  }
  return {
    totalMs: Math.round((frames / fmt.rate) * 1000),
    trailingMs: Math.round(((frames - 1 - lastLoud) / fmt.rate) * 1000),
    rate: fmt.rate,
  }
}

let shape = null
try { shape = wavShape(WAV) }
catch (err) {
  step('fixture is readable', false, err.message)
}
if (shape) {
  // +300 ms of margin: the model needs the silence to *exceed* the window, and
  // a fixture tuned to the edge fails intermittently for reasons of its own.
  const ok = shape.trailingMs >= THRESHOLD_MS + 300
  step('fixture can end a turn (tail longer than the window)', ok,
    `${WAV} ${shape.totalMs} ms total, ${shape.trailingMs} ms tail vs ${THRESHOLD_MS} ms window`)
  if (!ok) {
    console.log('\n  The fixture cannot produce an end-of-turn, so every later assertion would')
    console.log('  measure the file instead of the product. Pad it:')
    console.log(`    ffmpeg -y -i ${WAV} -f lavfi -t 3 -i anullsrc=r=${shape.rate}:cl=mono \\`)
    console.log('      -filter_complex "[0:a][1:a]concat=n=2:v=0:a=1[out]" -map "[out]" \\')
    console.log(`      -ar ${shape.rate} -ac 1 ${WAV.replace(/\.wav$/, '-pad.wav')}`)
  }
} else {
  console.log('\n  Cannot read the fixture; refusing to run the gate against a file it cannot audit.')
}
const fixtureUsable = !!shape && shape.trailingMs >= THRESHOLD_MS + 300
if (!fixtureUsable) {
  // Refuse rather than run: the failure that follows would be blamed on the
  // product (it reads as "peak 0, no reply"), which is how two runs were spent.
  const failed = results.filter(r => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(1)
}

const browser = await chromium.launch({
  args: [
    '--no-sandbox',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-audio-capture=${WAV}`,
    '--autoplay-policy=user-gesture-required',
  ],
})
const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1400, height: 900 } })
const page = await ctx.newPage()
const consoleErrors = []
page.on('console', (m) => {
  if (m.type() === 'error') {
    const text = m.text()
    consoleErrors.push(text)
    console.log('  [console]', text.slice(0, 160))
  }
})
const stats = () => page.evaluate(() => window.__sofiaVoice?.stats || null)
// Declared here so `finally` can stop it even when the gate throws early.
let sampler

try {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
  step('gate served', true, BASE)

  // The door: a password field, then the stage.
  const needsLogin = await page.locator('input[name=password]').count()
  if (needsLogin) {
    if (!PASSWORD) {
      step('app password available', false, 'no SOFIA_PASSWORD for the gate')
      throw new Error('missing password')
    }
    await page.fill('input[name=password]', PASSWORD)
    await page.click('button[type=submit]')
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(
      () => document.body && !document.body.innerText.includes('Private assistant'),
      null,
      { timeout: 45000 },
    )
  }
  step('signed in to the stage', true, page.url())

  // peak and chunksPlayed are live values on the client, and they reset to 0
  // when a session is replaced. They also vanish when the DOCUMENT is replaced:
  // the stage performs one more main-frame navigation about 200 ms after the
  // password form is submitted, so a sampler installed with page.evaluate died
  // with that document and the maxima stayed 0 while the client reported 13
  // chunks played — the gate failed for a harness reason and read as "reply
  // audio never played".
  //
  // So the maxima are tracked HERE, in the gate process, by polling. No page
  // navigation can reach them, and an init script is not the answer: it would
  // reset the maxima on every navigation, moving the same defect rather than
  // fixing it.
  const maxima = { chunks: 0, peak: 0 }
  let samplerError = ''
  sampler = setInterval(() => {
    page.evaluate(() => ({
      chunks: window.__sofiaVoice?.stats?.chunksPlayed || 0,
      peak: window.__sofiaVoice?.peak || 0,
    })).then((sample) => {
      if (sample.chunks > maxima.chunks) maxima.chunks = sample.chunks
      if (sample.peak > maxima.peak) maxima.peak = sample.peak
    }).catch((error) => { samplerError = String(error?.message || error).slice(0, 120) })
  }, 200)
  page.on('close', () => clearInterval(sampler))

  const dock = page.getByTestId('sofia-voice-dock')
  await dock.waitFor({ state: 'visible', timeout: 60000 })
  step('Talk dock renders on the stage', true, await dock.getAttribute('data-status'))

  await page.click('#sofia-talk')
  await page.waitForFunction(
    () => window.__sofiaVoice?.status === 'live',
    null,
    { timeout: 45000 },
  )
  step('live session ready', true, await dock.getAttribute('data-status'))

  // The bug this gate used to hide: a context that exists but is suspended.
  const running = await page.waitForFunction(() => {
    const s = window.__sofiaVoice?.stats
    return !!s && s.captureState === 'running' && s.playbackState === 'running'
  }, null, { timeout: 20000 }).then(() => true).catch(() => false)
  const live = await stats()
  step('audio contexts running', running,
    `capture=${live?.captureState} (${live?.captureRate} Hz) playback=${live?.playbackState} (${live?.playbackRate} Hz)`)

  await page.waitForFunction(() => (window.__sofiaVoice?.frames || 0) > 0, null, { timeout: 25000 })
  step('mic frames reach the gateway', true, `${await page.evaluate(() => window.__sofiaVoice.frames)} frames`)

  const heard = await page.waitForFunction(
    () => (window.__sofiaVoice?.transcripts || []).some(t => t.startsWith('in:') && t.slice(3).trim().length > 8),
    null,
    { timeout: 45000 },
  ).then(() => true).catch(() => false)
  const transcripts = await page.evaluate(() => window.__sofiaVoice.transcripts)
  step('Live transcribed the spoken audio', heard, heard ? transcripts.filter(t => t.startsWith('in:')).slice(-1)[0].slice(0, 90) : 'no input transcript')

  // chunksPlayed lives on the client's stats object (the dock mirrors the whole
  // stats blob); reading a top-level field made this assertion time out while
  // 14 chunks had in fact played.
  // The old form ended in `.catch(() => null).then(() => true)`, so `played` was
  // ALWAYS true: the gate printed "0 chunks" and PASSed. Assert the measurement.
  // Let playback settle before reading, so the number in the log is the number
  // that played rather than whatever the first poll caught mid-reply.
  const settleDeadline = Date.now() + 12000
  let previous = -1
  while (Date.now() < settleDeadline && maxima.chunks !== previous) {
    previous = maxima.chunks
    await page.waitForTimeout(750)
  }
  const chunks = maxima.chunks
  const playing = await stats()
  step('reply audio played on the stage', chunks > 0 && playing?.playbackState === 'running',
    `${chunks} chunks (live ${playing?.chunksPlayed ?? 0}), playback=${playing?.playbackState}`)

  // Lip sync: the mouth comes from the envelope of the PCM that is playing.
  // Same reason as the chunk count: measured in this process, not in a document
  // that can be replaced under it.
  const mouthDeadline = Date.now() + 30000
  while (Date.now() < mouthDeadline && maxima.peak <= 10)
    await page.waitForTimeout(250)
  const mouthMoved = maxima.peak > 10
  const peak = maxima.peak
  step('mouth moved with the reply (peak 0-100)', mouthMoved, `peak ${peak}`)

  // A capture that produces no frames must say so, not sit in 'live'.
  const after = await stats()
  step('mic is not reported silent', !after?.micWarning, after?.micWarning || 'none')

  if (samplerError)
    step('the gate could sample the stage', false, samplerError)
  const errors = await page.evaluate(() => window.__sofiaVoice?.errors || [])
  step('no live errors', errors.length === 0, errors.join('; ') || 'none')
  // The mods server channel lives at ws://localhost:6121 in the upstream dev
  // stack. In production that host does not exist, so any attempt is a bug: a
  // once-a-second reconnect loop and console noise on every client.
  const devSocketDials = consoleErrors.filter(line => line.includes('localhost:6121')).length
  step('no dev-socket dial in production', devSocketDials === 0, `${devSocketDials} x localhost:6121`)

  await page.screenshot({ path: '/qa/voice-stage.png' })
  console.log('\nSTATS: ' + JSON.stringify({
    frames: after?.frames,
    framesSent: after?.framesSent,
    chunksPlayed: after?.chunksPlayed,
    chunksMax: chunks,
    peakMax: peak,
    captureState: after?.captureState,
    playbackState: after?.playbackState,
    micWarning: after?.micWarning,
    lastError: after?.lastError,
  }))
  console.log('\nTRANSCRIPTS:\n' + transcripts.join('\n').slice(0, 600))
}
catch (err) {
  step('flow completed', false, String(err).slice(0, 250))
  try { await page.screenshot({ path: '/qa/voice-stage-fail.png' }) } catch {}
}
finally {
  clearInterval(sampler)
  await browser.close()
  const failed = results.filter(r => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
}
