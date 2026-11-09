// Text-lane gate through the real UI: password -> stage -> typed message ->
// answer in a bubble, with model reasoning asserted absent.
//
// History: this file used to drive AIRI's onboarding wizard ("Setup with your
// provider" -> OpenAI Compatible -> model list). A configured install no longer
// shows that wizard at all — auth-gate asserts its absence — so the old first
// click timed out on every run and the gate reported a defect that did not
// exist. It now starts where a person starts: the password gate.
//
// Runs inside the Playwright container with --network host. Exits non-zero on
// any failed step; it is a gate, not a demo.
import { chromium } from 'playwright'

const BASE = process.env.BASE || 'http://127.0.0.1:8787'
const PASSWORD = process.env.SOFIA_PASSWORD || process.env.PASSWORD || ''
const PROMPT = 'Say only: UI-GATE-OK'
const ANSWER = 'UI-GATE-OK'
const results = []
function step(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const countOf = (text, needle) => text.split(needle).length - 1

if (!PASSWORD) {
  console.log('no SOFIA_PASSWORD')
  process.exit(2)
}

const browser = await chromium.launch({ args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.fill('input[name=password]', PASSWORD)
  await page.click('button[type=submit]')
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(
    () => document.body && !document.body.innerText.includes('Private assistant'),
    null,
    { timeout: 45000 },
  )
  step('signed in', true)

  await page.waitForTimeout(6000)
  const body0 = await page.evaluate(() => document.body.innerText)
  step('no onboarding wizard', !/Setup with your provider/i.test(body0))

  const composer = page.locator('textarea[placeholder="Say something..."]')
  await composer.waitFor({ timeout: 30000 })
  step('composer on the stage', true)

  await composer.click()
  await composer.fill(PROMPT)

  // Send is not guaranteed to be Enter: AIRI has a send-mode setting, so try
  // the documented chords and verify each attempt by whether the user's own
  // bubble appeared (the prompt appears once; the answer never repeats it).
  let sentWith = null
  for (const combo of ['Enter', 'Control+Enter', 'Meta+Enter']) {
    await composer.press(combo)
    await page.waitForTimeout(1500)
    const t = await page.evaluate(() => document.body.innerText)
    if (countOf(t, PROMPT) >= 1) { sentWith = combo; break }
    await page.keyboard.press('Escape')
  }
  if (!sentWith) {
    const candidates = page.locator('button[aria-label*="end" i], button[aria-label*="ubmit" i], button[type="submit"]')
    const n = await candidates.count()
    for (let i = 0; i < n; i++) {
      try {
        await candidates.nth(i).click({ timeout: 2000 })
        await page.waitForTimeout(1500)
        const t = await page.evaluate(() => document.body.innerText)
        if (countOf(t, PROMPT) >= 1) { sentWith = `button#${i}`; break }
      }
      catch {}
    }
  }
  step('message sent', !!sentWith, sentWith || 'no chord or button sent it')

  if (sentWith) {
    const t0 = Date.now()
    await page.waitForFunction(
      a => document.body.innerText.split('\n').map(s => s.trim()).includes(a),
      ANSWER,
      { timeout: 180000 },
    )
    step('answer arrived', true, `${((Date.now() - t0) / 1000).toFixed(1)}s`)

    const text = await page.evaluate(() => document.body.innerText)
    const leaked = /The user says|I should output|Let me think|reasoning:/i.test(text)
    step('no reasoning in the bubble', !leaked, leaked ? 'thinking text visible' : 'clean')

    const line = text.split('\n').map(s => s.trim()).find(s => s === ANSWER)
    step('answer is the requested text', !!line, line || 'not found')
    console.log('\nBODY TEXT:\n' + text.slice(0, 700))
  }
  else {
    console.log('\nBODY TEXT (stuck):\n' + (await page.evaluate(() => document.body.innerText)).slice(0, 700))
  }

  await page.screenshot({ path: '/qa/ui-gate.png' })
}
catch (err) {
  step('flow completed', false, String(err).slice(0, 300))
  try { await page.screenshot({ path: '/qa/ui-gate-fail.png' }) } catch {}
}
finally {
  await browser.close()
  const failed = results.filter(r => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
}
