// Voice gate — the stage, not the harness.
//
// The old gate drove /public/voice-test.html, which proved the bridge but not
// the product: the stage could still have no Talk control and no lip sync. This
// one logs in like a person, presses the dock's Talk button on the stage, feeds
// a real sentence through a fake microphone, and reads the mouth value the
// component writes from the played 24 kHz PCM.
//
// Run inside mcr.microsoft.com/playwright:v1.64.1-jammy with --network host.
import { readFileSync } from 'node:fs'

import { chromium } from 'playwright'

const BASE = process.env.BASE || 'http://127.0.0.1:8787'
const WAV = process.env.WAV || '/qa/mic-hello.wav'
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

const browser = await chromium.launch({
  args: [
    '--no-sandbox',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-audio-capture=${WAV}`,
    '--autoplay-policy=no-user-gesture-required',
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

  await page.waitForFunction(() => (window.__sofiaVoice?.framesSent || 0) > 0, null, { timeout: 25000 })
  step('mic frames reach the gateway', true, `${await page.evaluate(() => window.__sofiaVoice.framesSent)} frames`)

  const heard = await page.waitForFunction(
    () => (window.__sofiaVoice?.transcripts || []).some(t => t.startsWith('in:') && t.slice(3).trim().length > 8),
    null,
    { timeout: 45000 },
  ).then(() => true).catch(() => false)
  const transcripts = await page.evaluate(() => window.__sofiaVoice.transcripts)
  step('Live transcribed the spoken audio', heard, heard ? transcripts.filter(t => t.startsWith('in:')).slice(-1)[0].slice(0, 90) : 'no input transcript')

  const played = await page.waitForFunction(() => (window.__sofiaVoice?.chunksPlayed || 0) > 0, null, { timeout: 60000 })
    .then(() => true).catch(() => false)
  const chunks = await page.evaluate(() => window.__sofiaVoice?.chunksPlayed || 0)
  step('reply audio played on the stage', played, `${chunks} chunks`)

  // Lip sync: the mouth comes from the envelope of the PCM that is playing.
  const mouthMoved = await page.waitForFunction(() => (window.__sofiaVoice?.peak || 0) > 10, null, { timeout: 30000 })
    .then(() => true).catch(() => false)
  const peak = await page.evaluate(() => window.__sofiaVoice?.peak || 0)
  step('mouth moved with the reply (peak 0-100)', mouthMoved, `peak ${peak}`)

  const errors = await page.evaluate(() => window.__sofiaVoice?.errors || [])
  step('no live errors', errors.length === 0, errors.join('; ') || 'none')
  // The mods server channel lives at ws://localhost:6121 in the upstream dev
  // stack. In production that host does not exist, so any attempt is a bug: a
  // once-a-second reconnect loop and console noise on every client.
  const devSocketDials = consoleErrors.filter(line => line.includes('localhost:6121')).length
  step('no dev-socket dial in production', devSocketDials === 0, `${devSocketDials} x localhost:6121`)

  await page.screenshot({ path: '/qa/voice-stage.png' })
  console.log('\nTRANSCRIPTS:\n' + transcripts.join('\n').slice(0, 600))
}
catch (err) {
  step('flow completed', false, String(err).slice(0, 250))
  try { await page.screenshot({ path: '/qa/voice-stage-fail.png' }) } catch {}
}
finally {
  await browser.close()
  const failed = results.filter(r => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
}
