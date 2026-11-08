// Voice gate: browser mic -> gateway -> Gemini Live -> spoken reply -> playback.
//
// Runs headless in the Playwright image with a fake microphone fed the WAV at
// /qa/mic-hello.wav. Chromium loops that file, so Live hears a real sentence.
import { chromium } from 'playwright'

const BASE = process.env.BASE || 'http://127.0.0.1:8787'
const WAV = process.env.WAV || '/qa/mic-hello.wav'
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
    `--use-file-for-fake-audio-capture=${WAV}`,
    '--autoplay-policy=no-user-gesture-required',
  ],
})
const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1000, height: 700 } })
const page = await ctx.newPage()
page.on('console', (m) => { if (m.type() === 'error') console.log('  [console]', m.text().slice(0, 160)) })

try {
  await page.goto(`${BASE}/public/voice-test.html`, { waitUntil: 'domcontentloaded' })
  step('harness loads', true)

  await page.getByRole('button', { name: 'Start voice' }).click()

  await page.waitForFunction(() => window.__sofia?.ready === true, null, { timeout: 30000 })
  step('live session ready', true, await page.evaluate(() => document.getElementById('state').textContent))

  await page.waitForFunction(() => (window.__sofia?.framesSent || 0) > 0, null, { timeout: 20000 })
  const frames = await page.evaluate(() => window.__sofia.framesSent)
  step('mic frames reach the gateway', frames > 0, `${frames} frames`)

  // The fake mic repeats a real sentence; Live should transcribe what it hears.
  const heard = await page.waitForFunction(
    () => (window.__sofia?.transcripts || []).some(t => t.startsWith('in:') && t.replace('in:', '').trim().length > 8),
    null,
    { timeout: 45000 },
  ).then(() => true).catch(() => false)
  const transcripts = await page.evaluate(() => window.__sofia.transcripts)
  step('Live transcribed the spoken audio', heard, heard ? transcripts.filter(t => t.startsWith('in:')).slice(-1)[0].slice(0, 90) : 'no input transcript')

  // Answer must be spoken back as audio, not just transcribed.
  const played = await page.waitForFunction(() => (window.__sofia?.chunksPlayed || 0) > 0, null, { timeout: 60000 })
    .then(() => true).catch(() => false)
  const stats = await page.evaluate(() => ({ chunks: window.__sofia.chunksPlayed, events: window.__sofia.events.length, errors: window.__sofia.errors }))
  step('reply audio played in the browser', played, `${stats.chunks} chunks queued`)

  const outLine = (await page.evaluate(() => window.__sofia.transcripts)).filter(t => t.startsWith('out:')).slice(-1)[0]
  step('reply was spoken text', !!outLine, (outLine || 'none').slice(0, 100))
  step('no errors', stats.errors.length === 0, stats.errors.join('; ') || 'none')

  await page.screenshot({ path: '/qa/voice-gate.png' })
  console.log('\nALL TRANSCRIPTS:\n' + (await page.evaluate(() => window.__sofia.transcripts)).join('\n').slice(0, 600))
}
catch (err) {
  step('flow completed', false, String(err).slice(0, 250))
  try { await page.screenshot({ path: '/qa/voice-gate-fail.png' }) } catch {}
}
finally {
  await browser.close()
  const failed = results.filter(r => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
}
