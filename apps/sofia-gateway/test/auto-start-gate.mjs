// auto-start-gate.mjs — does the stage come back listening without hunting for
// a button, and does it keep quiet for someone who never agreed?
//
// The product promise is "always listening"; the browser promise is "no audio
// without a gesture". Both are honoured by consent + first gesture: after one
// successful Talk, any pointer-down or key on the page opens a Live session on
// the next visit. This gate proves all three states:
//   1 fresh browser   -> idle, no session, nothing stored
//   2 press Talk      -> live, consent stored
//   3 reload + click  -> live again with no press on the button
import { chromium } from 'playwright'

const BASE = process.env.BASE || 'https://sofia.ctum.org'
const PASSWORD = process.env.SOFIA_PASSWORD || ''
const results = []
const step = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=user-gesture-required'] })
const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1280, height: 860 } })
const page = await ctx.newPage()

const status = () => page.evaluate(() => document.querySelector('[data-testid=sofia-voice-dock]')?.dataset.status || 'none')
const waitStatus = async (want, ms) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await status() === want) return true
    await page.waitForTimeout(250)
  }
  return false
}
const consent = () => page.evaluate(() => localStorage.getItem('sofia-voice-auto'))

try {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  const field = await page.$('input[type=password]')
  if (field) {
    await field.fill(PASSWORD)
    await page.click('button[type=submit], button')
    await page.waitForLoadState('domcontentloaded')
  }

  // 1. a browser that never consented stays silent
  await page.waitForSelector('#sofia-talk', { timeout: 120000, state: 'visible' })
  await page.waitForTimeout(4000)
  const fresh = await status()
  const freshConsent = await consent()
  step('fresh browser stays idle', fresh === 'idle', `status ${fresh}`)
  step('nothing stored without consent', freshConsent === null, `sofia-voice-auto=${freshConsent}`)

  // 2. one press is consent
  await page.click('#sofia-talk')
  const wentLive = await waitStatus('live', 40000)
  step('one press opens the session', wentLive, `status ${await status()}`)
  step('consent is stored', (await consent()) === '1', `sofia-voice-auto=${await consent()}`)

  await page.click('#sofia-talk')
  const stopped = await waitStatus('idle', 15000)
  step('Stop closes it', stopped, `status ${await status()}`)
  await page.waitForTimeout(8000) // Live slot cooldown between the two sessions

  // 3. next visit: it listens on the first gesture, not on the button
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#sofia-talk', { timeout: 120000, state: 'visible' })
  await page.waitForTimeout(2500)
  step('reload does not auto-connect before a gesture', (await status()) === 'idle', `status ${await status()}`)

  await page.mouse.click(640, 300) // anywhere but the button
  const resumed = await waitStatus('live', 45000)
  step('first gesture resumes the conversation', resumed, `status ${await status()}`)

  if (resumed)
    await page.click('#sofia-talk').catch(() => {})
} catch (error) {
  step('gate ran without throwing', false, String(error).slice(0, 180))
} finally {
  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length}`)
  await browser.close()
  // `exitCode`, not `exit`: stdout is a pipe in the release run, and exiting
// immediately after printing the tally can drop it (measured: 641 of 4000
// lines and the final count lost). See G15 in scripts/ci/guards.mjs.
process.exitCode = failed.length ? 1 : 0
}
