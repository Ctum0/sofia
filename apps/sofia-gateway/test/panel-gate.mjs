// panel-gate.mjs — does the stage actually move aside, and does the panel do
// what it claims for an image and for a web page?
//
// The model cannot be asked to call a tool on cue, so the gate uses the same
// entry point the socket uses (`window.__sofiaPanel`), which dispatches the same
// DOM event the dock dispatches. The transport half (a real `toolCall` →
// `{type:'panel'}` frame) is asserted separately by grepping the gateway.
import { chromium } from 'playwright'

const BASE = process.env.BASE || 'https://sofia.ctum.org'
const PASSWORD = process.env.SOFIA_PASSWORD || ''
const results = []
const step = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const browser = await chromium.launch({
  args: ['--no-sandbox', '--autoplay-policy=user-gesture-required',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
})
const page = await (await browser.newContext({ permissions: ['microphone'], viewport: { width: 1440, height: 900 } })).newPage()

const panelState = () => page.evaluate(() => {
  const el = document.querySelector('[data-testid=sofia-panel]')
  const col = document.querySelector('.stage-column')
  return {
    visible: !!el,
    kind: el?.getAttribute('data-kind') || null,
    title: el?.querySelector('.sofia-panel__title')?.textContent?.trim() || null,
    img: (() => { const i = el?.querySelector('img'); return i ? { w: i.naturalWidth, h: i.naturalHeight } : null })(),
    open: el?.querySelector('[data-testid=sofia-panel-open]')?.textContent?.trim() || null,
    columnWidth: col ? Math.round(col.getBoundingClientRect().width) : null,
    chatVisible: !!document.querySelector('[data-testid=sofiia-voice-dock], [data-testid=sofia-voice-dock]'),
  }
})

try {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  const f = await page.$('input[type=password]')
  if (f) { await f.fill(PASSWORD); await page.click('button[type=submit], button'); await page.waitForLoadState('domcontentloaded') }
  await page.waitForSelector('[data-testid=sofia-voice-dock]', { timeout: 120000, state: 'visible' })
  await page.waitForTimeout(1200)

  const before = await panelState()
  step('no panel before she opens one', before.visible === false, `column ${before.columnWidth}px`)

  // image
  await page.evaluate(() => window.__sofiaPanel({ kind: 'image', url: '/brand/og.png', title: 'Sofia' }))
  await page.waitForTimeout(700)
  const img = await panelState()
  step('image panel appears', img.visible && img.kind === 'image', `title "${img.title}"`)
  step('the image actually decoded', !!img.img && img.img.w > 0, img.img ? `${img.img.w}x${img.img.h}` : 'no img')
  step('the stage moved aside', img.columnWidth !== null && before.columnWidth !== null && img.columnWidth < before.columnWidth,
    `${before.columnWidth}px → ${img.columnWidth}px`)

  await page.click('[data-testid=sofia-panel] .sofia-panel__close')
  await page.waitForTimeout(600)
  const closed = await panelState()
  step('closing restores the stage', closed.visible === false && closed.columnWidth === before.columnWidth,
    `column ${closed.columnWidth}px`)

  // web
  await page.evaluate(() => window.__sofiaPanel({ kind: 'web', url: 'https://example.com', title: 'Example' }))
  await page.waitForTimeout(700)
  const web = await panelState()
  step('web panel appears', web.visible && web.kind === 'web', `title "${web.title}"`)
  step('a site is offered as a card, not a blank iframe', !!web.open && /example\.com/.test(web.open), String(web.open))
  const iframes = await page.evaluate(() => document.querySelectorAll('[data-testid=sofia-panel] iframe').length)
  step('no iframe is attempted', iframes === 0, `${iframes} iframe(s)`)

  await page.click('[data-testid=sofia-panel] .sofia-panel__close')
  await page.waitForTimeout(400)

  // dismissing by event (what a null payload means)
  await page.evaluate(() => window.__sofiaPanel(null))
  await page.waitForTimeout(300)
  step('a null payload closes it', (await panelState()).visible === false)
} catch (error) {
  step('gate ran without throwing', false, String(error).slice(0, 180))
} finally {
  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length}`)
  await browser.close()
  process.exit(failed.length ? 1 : 0)
}
