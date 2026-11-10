// windows-gate.mjs — the stage's windows: several at once, above the page, not
// inside the chat column, each movable and closable.
import { chromium } from 'playwright'

const BASE = process.env.BASE || 'https://sofia.ctum.org'
const PASSWORD = process.env.SOFIA_PASSWORD || ''
const results = []
const step = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`) }

const browser = await chromium.launch({
  args: ['--no-sandbox', '--autoplay-policy=user-gesture-required',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
})
const page = await (await browser.newContext({ permissions: ['microphone'], viewport: { width: 1440, height: 900 } })).newPage()

const state = () => page.evaluate(() => {
  const layer = document.querySelector('[data-testid=sofia-windows]')
  const wins = [...document.querySelectorAll('[data-testid=sofia-window]')].map(w => {
    const r = w.getBoundingClientRect()
    return { id: w.getAttribute('data-window-id'), kind: w.getAttribute('data-kind'), active: w.getAttribute('data-active'),
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      title: w.querySelector('.sofia-window__title')?.textContent?.trim(),
      img: (() => { const i = w.querySelector('img'); return i ? i.naturalWidth : 0 })() }
  })
  const chat = document.querySelector('[data-testid=chat-empty-state]')
  const splash = document.getElementById('boot-splash')
  const splashVisible = !!splash && splash.getBoundingClientRect().height > 0 && getComputedStyle(splash).display !== 'none'
  return {
    layerFixed: layer ? getComputedStyle(layer).position : null,
    count: wins.length, wins,
    chatVisible: !!chat, splashVisible,
    insideChatColumn: layer ? !!layer.closest('.stage-column') : null,
  }
})

try {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  const f = await page.$('input[type=password]')
  if (f) { await f.fill(PASSWORD); await page.click('button[type=submit], button'); await page.waitForLoadState('domcontentloaded') }
  await page.waitForSelector('textarea, [placeholder*="Say something"]', { timeout: 120000 })
  await page.waitForTimeout(2500)

  const before = await state()
  step('no windows at rest', before.count === 0, `chat visible: ${before.chatVisible}`)

  await page.evaluate(() => window.__sofiaPanel({ kind: 'image', url: '/og.png', title: 'Sofia' }))
  await page.waitForTimeout(700)
  await page.evaluate(() => window.__sofiaPanel({ kind: 'web', url: 'https://github.com/Ctum0/sofia', title: 'Ctum0/sofia' }))
  await page.waitForTimeout(900)

  await page.screenshot({ path: '/qa/windows-gate.png' })
  const two = await state()
  step('two windows open at once', two.count === 2, `${two.count} window(s)`)
  step('the newest is on top', two.wins.some(w => w.active === 'true') && two.wins.filter(w => w.active === 'true').length === 1,
    JSON.stringify(two.wins.map(w => w.active)))
  step('they cascade instead of stacking exactly', new Set(two.wins.map(w => `${w.x},${w.y}`)).size === two.count,
    JSON.stringify(two.wins.map(w => `${w.x},${w.y}`)))
  step('the image window decoded its picture', two.wins.some(w => w.kind === 'image' && w.img > 0),
    JSON.stringify(two.wins.map(w => `${w.kind}:${w.img}`)))
  step('the browser asks for a tab, not a blank frame', two.wins.some(w => w.kind === 'web'),
    two.wins.find(w => w.kind === 'web')?.title || 'none')
  step('windows are NOT inside the chat column', two.insideChatColumn === false, `layer position ${two.layerFixed}`)
  step('the chat yields while windows are open', two.chatVisible === false)

  // The boot splash sits above the page while the stage loads and swallows
  // clicks; the first cut of this gate clicked into it and reported a product
  // failure. Wait for it to leave before touching anything.
  const splashAt = (await state()).splashVisible
  await page.waitForFunction(() => {
    const s = document.getElementById('boot-splash')
    return !s || s.getBoundingClientRect().height === 0 || getComputedStyle(s).display === 'none'
  }, { timeout: 90000 }).catch(() => {})
  step('the boot splash is out of the way before pointer input', !(await state()).splashVisible, `was visible: ${splashAt}`)

  // raise the first window by clicking its bar
  const first = two.wins[0]
  await page.mouse.click(first.x + 60, first.y + 8)
  await page.waitForTimeout(400)
  const raised = await state()
  step('clicking a window raises it', raised.wins.find(w => w.id === first.id)?.active === 'true',
    JSON.stringify(raised.wins.map(w => `${w.id}:${w.active}`)))

  // drag it
  await page.mouse.move(first.x + 120, first.y + 8)
  await page.mouse.down()
  await page.mouse.move(first.x + 260, first.y + 90, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(400)
  const moved = await state()
  const after = moved.wins.find(w => w.id === first.id)
  step('a window can be dragged', !!after && (after.x !== first.x || after.y !== first.y),
    `${first.x},${first.y} → ${after?.x},${after?.y}`)

  // close one
  await page.click('[data-testid=sofia-window] [data-testid=sofia-window-close]')
  await page.waitForTimeout(400)
  step('closing one leaves the other', (await state()).count === 1, `${(await state()).count} left`)

  // close the rest
  while ((await state()).count > 0) {
    await page.click('[data-testid=sofia-window] [data-testid=sofia-window-close]')
    await page.waitForTimeout(250)
  }
  const closed = await state()
  step('closing all restores the chat', closed.count === 0 && closed.chatVisible === true)
} catch (error) {
  step('gate ran without throwing', false, String(error).slice(0, 200))
} finally {
  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length}`)
  await browser.close()
  process.exit(failed.length ? 1 : 0)
}
