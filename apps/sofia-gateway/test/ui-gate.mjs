// End-to-end proof through the real UI: onboarding -> Hermes model -> typed
// message -> answer in the bubble, with reasoning asserted absent.
//
// Runs inside the Playwright container with --network host so it can reach the
// gateway on 127.0.0.1:8787. Deterministic on purpose: this is a gate, not a
// demo, so every step asserts and the process exits non-zero on failure.
import { chromium } from 'playwright'

const BASE = process.env.BASE || 'http://127.0.0.1:8787'
const PROMPT = 'Say only: UI-GATE-OK'
const results = []
function step(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const countOf = (text, needle) => text.split(needle).length - 1

const browser = await chromium.launch({ args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.getByText('Setup with your provider', { exact: true }).click({ timeout: 60000 })
  step('onboarding opens', true)

  await page.getByText('OpenAI Compatible', { exact: true }).first().click()
  await page.getByRole('button', { name: /^Next$/ }).click()
  step('provider picked', true)

  await page.locator('input[placeholder="https://api.openai.com/v1"]').fill(`${BASE}/v1`)
  await page.locator('input[placeholder="API Key"]').fill('local-gateway-injects-real-key')
  await page.getByRole('button', { name: /^Next$/ }).click()

  // The app fetches /v1/models here; the brain's model id is the assertion.
  await page.getByText('Choose model').waitFor({ timeout: 60000 })
  const modelVisible = await page.getByText('sofia', { exact: true }).first().isVisible()
  step('model list came from Hermes', modelVisible, modelVisible ? 'model "sofia" listed' : 'not listed')

  await page.getByText('sofia', { exact: true }).first().click()
  await page.getByRole('button', { name: /Save and Continue/ }).click()
  step('provider saved', true)

  const composer = page.locator('textarea[placeholder="Say something..."]')
  await composer.waitFor({ timeout: 30000 })
  await composer.click()
  await composer.fill(PROMPT)

  // Send is not guaranteed to be Enter: AIRI has a send-mode setting, so try
  // the documented chords and then any send button, verifying each attempt by
  // whether the user's own bubble appeared.
  let sentWith = null
  for (const combo of ['Enter', 'Control+Enter', 'Meta+Enter']) {
    await composer.press(combo)
    await page.waitForTimeout(1500)
    const t = await page.evaluate(() => document.body.innerText)
    // The prompt appears once (the user's own bubble) as soon as it is sent;
    // the answer never repeats it, so one occurrence is the signal.
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
    // The answer is a line equal to the requested text; the prompt line is
    // "Say only: UI-GATE-OK", so an exact-line match cannot be the echo.
    const ANSWER = PROMPT.replace('Say only: ', '')
    await page.waitForFunction(
      (a) => document.body.innerText.split('\n').map(s => s.trim()).includes(a),
      ANSWER,
      { timeout: 180000 },
    )
    step('answer arrived', true, `${((Date.now() - t0) / 1000).toFixed(1)}s`)

    const text = await page.evaluate(() => document.body.innerText)
    const leaked = /The user says|I should output|Let me think|reasoning:/i.test(text)
    step('no reasoning in the bubble', !leaked, leaked ? 'thinking text visible' : 'clean')

    const answerLine = text.split('\n').map(s => s.trim())
      .find(s => /UI-GATE-OK/.test(s) && !new RegExp(PROMPT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(s))
    step('answer is the requested text', !!answerLine, answerLine || 'not found')
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
