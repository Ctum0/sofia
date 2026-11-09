// About-dialog + composer-state gate, at RENDER level.
//
// Why this exists: the About dialog was "fixed" once (6f75cced6) by editing
// packages/stage-ui/.../about/about-content.vue, and production still showed
// upstream links — the stage renders a SECOND About in
// packages/stage-layouts/.../InteractiveArea/Actions/About.vue, which passes its
// own `links` prop and overrides the stage-ui default. A source grep plus a
// bundle grep both come back clean for the string that is actually on screen, so
// this has to be asserted in a browser, on the dialog, after a real click.
//
// Also asserts the composer's send button, because "it looks active while empty"
// is a recurring report and the disabled styling is the thing that regresses.
//
// Runs in mcr.microsoft.com/playwright:v1.64.1-jammy --network host with
// SOFIA_PASSWORD in the env. Exits non-zero on any failure.
import { chromium } from 'playwright'

const BASE = process.env.BASE || 'http://127.0.0.1:8787'
const PASSWORD = process.env.SOFIA_PASSWORD || process.env.PASSWORD || ''
const fail = []
const step = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fail.push(name)
}

if (!PASSWORD) {
  console.log('no SOFIA_PASSWORD')
  process.exit(2)
}

const browser = await chromium.launch({ args: ['--no-sandbox'] })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
const page = await ctx.newPage()
const consoleErrors = []
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)) })

try {
  // log in through the real form, so the gate also fails if the form breaks
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.fill('input[name=password]', PASSWORD)
  await page.click('button[type=submit]')
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(7000)

  /* ---------------- composer send button ---------------- */
  const readSend = () => page.evaluate(() => {
    const b = document.querySelector('[data-testid="chat-send-button"], [data-testid="mobile-send-button"]')
    if (!b)
      return null
    const cs = getComputedStyle(b)
    return { disabled: b.disabled === true, bg: cs.backgroundColor, color: cs.color, opacity: cs.opacity }
  })

  const emptySend = await readSend()
  step('send button is on the stage', !!emptySend, JSON.stringify(emptySend))
  step('send button is disabled while the composer is empty', emptySend?.disabled === true)

  const textarea = await page.$('textarea')
  step('composer textarea exists', !!textarea)
  if (textarea) {
    await textarea.click()
    await textarea.type('about-gate', { delay: 30 })
    await page.waitForTimeout(500)
    const filledSend = await readSend()
    step('send button is enabled once text is typed', filledSend?.disabled === false, JSON.stringify(filledSend))
    step('empty vs filled is visually distinct, not just a prop',
      !!emptySend && !!filledSend
        && (emptySend.bg !== filledSend.bg || emptySend.opacity !== filledSend.opacity || emptySend.color !== filledSend.color),
      `empty ${emptySend?.bg} / ${emptySend?.opacity} vs filled ${filledSend?.bg} / ${filledSend?.opacity}`)
    await textarea.fill('')
    await page.waitForTimeout(400)
    step('send button goes back to disabled when emptied', (await readSend())?.disabled === true)
  }

  /* ---------------- About dialog ---------------- */
  const trigger = await page.evaluate(() => {
    const el = [...document.querySelectorAll('button, [role="button"]')]
      .find(e => /^about$/i.test((e.getAttribute('title') || e.getAttribute('aria-label') || '').trim()))
    if (!el)
      return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), visible: !!(r.width && r.height) }
  })
  step('About trigger found with a real box', !!trigger?.visible, JSON.stringify(trigger))

  if (trigger?.visible) {
    await page.mouse.click(trigger.x, trigger.y) // a synthetic .click() lies about Vue state
    await page.waitForTimeout(1800)
    const dialog = await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"]')
      if (!d)
        return null
      return {
        text: d.innerText,
        links: [...d.querySelectorAll('a')].map(a => a.getAttribute('href') || '').filter(Boolean),
        painted: !!(d.offsetWidth && d.offsetHeight),
      }
    })
    step('About dialog opens and paints', !!dialog?.painted)
    if (dialog) {
      console.log('  links: ' + JSON.stringify(dialog.links))
      step('dialog carries no "AIRI" text', !/AIRI/i.test(dialog.text))
      step('no "(null)" version placeholder', !/\(null\)/.test(dialog.text))
      step('no upstream links (airi.moeru.ai / moeru-ai)', !dialog.links.some(h => /moeru\.ai|moeru-ai/.test(h)))
      step('dialog keeps the Sofia links', dialog.links.some(h => /sofia\.ctum\.org/.test(h))
        && dialog.links.some(h => /github\.com\/Ctum0\/sofia/.test(h)))
      await page.screenshot({ path: '/qa/about-gate.png' })
    }
  }

  const pageText = await page.evaluate(() => document.body.innerText)
  step('stage body carries no "Project AIRI"', !/Project\s+AIRI/i.test(pageText))
} finally {
  console.log(`console errors: ${consoleErrors.length}${consoleErrors.length ? ` (first: ${consoleErrors[0]})` : ''}`)
  await browser.close()
}

console.log(fail.length ? `\n${fail.length} FAILED` : '\nALL PASS')
process.exit(fail.length ? 1 : 0)
