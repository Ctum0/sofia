// VAD cut-off gate — the cost of a tight end-of-speech threshold.
//
// `silenceDurationMs` was lowered to 500 to cut the hangover before a reply
// (1278 -> 972 ms to the transcript, 1450 -> 1192 ms to first audio). Every
// tightening buys speed with one risk: she decides the turn is over while he is
// still talking, answers the first half, and talks over the second.
//
// vad-latency-gate cannot see that: its fake mic is one burst of speech followed
// by 20 s of silence, so there is nothing to interrupt. This gate feeds a single
// spoken turn with an internal pause — `/qa/mic-pause600.wav` is 1.9 s of
// speech, 0.6 s of digital silence (a breath / a comma), then the same 1.9 s
// again, then 6 s of silence, so the turn genuinely ends at 4.40 s.
//
//   PASS  = first reply audio arrives AFTER 4.40 s  (she waited for the whole turn)
//   FAIL  = she speaks during the pause or over sentence two  -> threshold too tight
//
// Build the fixture once, inside the QA container:
//   ffmpeg -y -i mic-one-line.wav -f lavfi -t 0.6 -i anullsrc=r=16000:cl=mono \
//     -f lavfi -t 6 -i anullsrc=r=16000:cl=mono -filter_complex \
//     "[0:a]atrim=0:1.9,asplit=2[x1][x2];[x1][1:a][x2][2:a]concat=n=4:v=0:a=1[out]" \
//     -map "[out]" -ar 16000 -ac 1 mic-pause600.wav        # -> 10.40 s
//
// The pause is deliberately 600 ms: shorter than the 800 ms Gemini default on
// purpose, so a client that "works" here works for a real speaker who pauses.
const BASE = process.env.BASE || 'http://127.0.0.1:3005'
const PASSWORD = process.env.SOFIA_PASSWORD || ''
const SPEECH_END_S = Number(process.env.SPEECH_END_S || 4.40)

const { chromium } = await import('playwright')

const results = []
function step(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const browser = await chromium.launch({
  args: [
    '--no-sandbox',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--use-file-for-fake-audio-capture=/qa/mic-pause600.wav',
    '--autoplay-policy=user-gesture-required',
  ],
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

  await page.evaluate(() => {
    window.__vad = { t: {} }
    const stamp = (k) => { if (!(k in window.__vad.t)) window.__vad.t[k] = performance.now() }
    const watch = () => {
      const voice = window.__sofiaVoice
      const s = voice?.stats
      if (s && s.frames > 0) stamp('firstFrame')
      if (s && s.chunksPlayed > 0) stamp('firstPlayed')
      const tr = voice?.transcripts || []
      if (tr.some(x => x.startsWith('in:'))) stamp('inTranscript')
      window.__vad.frames = s?.frames || 0
      window.__vad.chunksPlayed = s?.chunksPlayed || 0
      window.__vad.transcripts = tr.slice(-6)
      requestAnimationFrame(watch)
    }
    requestAnimationFrame(watch)
  })

  const talk = await page.waitForSelector('#sofia-talk', { timeout: 45000 }).catch(() => null)
  step('Talk control is on the stage', !!talk, talk ? '' : 'no #sofia-talk')
  await page.click('#sofia-talk')
  const live = await page.waitForFunction(() => window.__sofiaVoice?.status === 'live', null, { timeout: 45000 })
    .then(() => true).catch(() => false)
  step('live session ready', live, await page.evaluate(() => window.__sofiaVoice?.status))

  const got = await page.waitForFunction(() => window.__vad?.t?.firstPlayed, null, { timeout: 60000, polling: 100 })
    .then(() => true).catch(() => false)
  if (!got) {
    step('reply audio arrived', false, `frames=${await page.evaluate(() => window.__vad?.frames)}`)
    throw new Error('no reply audio within 60 s')
  }
  step('reply audio arrived', true, '')

  const v = await page.evaluate(() => window.__vad)
  const speechEnd = v.t.firstFrame + SPEECH_END_S * 1000
  const early = Math.round(speechEnd - v.t.firstPlayed)
  const hangover = Math.round(v.t.firstPlayed - speechEnd)

  console.log(`\nMEASURED (ms): first-frame→played=${Math.round(v.t.firstPlayed - v.t.firstFrame)}`
    + ` speechEnd→played=${hangover} frames=${v.frames}`)
  console.log(`TRANSCRIPTS: ${JSON.stringify(v.transcripts)}`)

  step('she did not answer over him — reply comes after the whole turn',
    v.t.firstPlayed >= speechEnd, `${early} ms early`)
  step('she still answered (turn was not swallowed)', hangover < 15000, `${hangover} ms after speech end`)
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
