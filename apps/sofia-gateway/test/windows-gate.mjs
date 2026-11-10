// windows-gate.mjs — the stage's windows: several at once, above the page, not
// inside the chat column, each movable and closable.
//
// Readiness trap, measured 2026-11-10: `section.startup-screen` is
// `position: fixed; z-index: 10000` and stays mounted for ~12.6 s after login
// on a cold load. While it is up, elementFromPoint() at a window's own title bar
// returns the splash, so a real click never reaches the window and both the
// raise and the drag report as product failures — they were the gate clicking
// through an overlay. Wait for the splash to DETACH before asserting pointer
// interaction; a timeout here is a genuine failure and must not be swallowed.
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
  // `18273e680` moved the windows to the right shoulder so they stop landing on
  // her. That is only a claim until a rectangle says so, so the column she is
  // drawn in comes back with every reading.
  const col = document.querySelector('.stage-column')
  const cb = col ? col.getBoundingClientRect() : null
  return {
    layerFixed: layer ? getComputedStyle(layer).position : null,
    count: wins.length, wins,
    chatVisible: !!chat,
    insideChatColumn: layer ? !!layer.closest('.stage-column') : null,
    vw: innerWidth,
    vh: innerHeight,
    col: cb ? { x: Math.round(cb.x), w: Math.round(cb.width), right: Math.round(cb.right) } : null,
  }
})

try {
  const t0 = Date.now()
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  const f = await page.$('input[type=password]')
  if (f) { await f.fill(PASSWORD); await page.click('button[type=submit], button'); await page.waitForLoadState('domcontentloaded') }
  await page.waitForSelector('textarea, [placeholder*="Say something"]', { timeout: 120000 })

  // The splash is above everything until the startup resources finish; wait for
  // it to leave the DOM, then confirm nothing intercepts the top of the stage.
  await page.waitForSelector('section.startup-screen', { state: 'detached', timeout: 90000 })
  const splashGoneAt = Date.now() - t0
  const topHit = await page.evaluate(() => {
    const el = document.elementFromPoint(200, 200)
    return el ? `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ').filter(Boolean).slice(0, 2).join('.')}` : null
  })
  step('the startup splash is gone and the stage takes pointer events', !/startup-screen/.test(topHit || ''), `splash detached at +${splashGoneAt} ms, hit ${topHit}`)
  await page.waitForTimeout(400)

  const before = await state()
  step('no windows at rest', before.count === 0, `chat visible: ${before.chatVisible}`)

  await page.evaluate(() => window.__sofiaPanel({ kind: 'image', url: '/og.png', title: 'Sofia' }))
  await page.waitForTimeout(700)
  await page.evaluate(() => window.__sofiaPanel({ kind: 'web', url: 'https://github.com/Ctum0/sofia', title: 'Ctum0/sofia' }))
  await page.waitForTimeout(900)

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
  // Property, not pixel count: she stands at the centre of the stage column, so
  // anything she opens must begin in its right shoulder. Measured on the build
  // that introduced the change: column 0..806, windows at 772 and 802 — the
  // canvas sliver they clip is background, not her (crop read back by eye).
  const colCentre = two.col ? two.col.x + two.col.w / 2 : null
  const shoulder = two.col ? two.col.x + two.col.w * 0.75 : null
  step('what she opens stays in the right shoulder, never over her centre',
    two.wins.length > 0 && two.wins.every(w => w.x >= shoulder),
    `column ${two.col?.x}..${two.col?.right} centre ${Math.round(colCentre ?? 0)} shoulder≥${Math.round(shoulder ?? 0)}, windows ${JSON.stringify(two.wins.map(w => w.x))}`)
  step('no window spills past the viewport edge',
    two.wins.every(w => w.x >= 0 && w.x + w.w <= two.vw),
    `vw ${two.vw}, right edges ${JSON.stringify(two.wins.map(w => w.x + w.w))}`)

  // raise the first window by clicking its bar
  const first = two.wins[0]
  await page.mouse.click(first.x + 60, first.y + 20)
  await page.waitForTimeout(400)
  const raised = await state()
  step('clicking a window raises it', raised.wins.find(w => w.id === first.id)?.active === 'true',
    JSON.stringify(raised.wins.map(w => `${w.id}:${w.active}`)))

  // drag it
  await page.mouse.move(first.x + 60, first.y + 20)
  await page.mouse.down()
  await page.mouse.move(first.x + 200, first.y + 110, { steps: 10 })
  await page.mouse.up()
  await page.waitForTimeout(400)
  const moved = await state()
  const after = moved.wins.find(w => w.id === first.id)
  step('a window can be dragged', !!after && (after.x !== first.x || after.y !== first.y),
    `${first.x},${first.y} → ${after?.x},${after?.y}`)

  // The clamp added with the plain-mouse drag: pushed hard at the left edge the
  // window must stop on screen, because a window off the viewport cannot be
  // grabbed back.
  const barX = after.x + 60
  await page.mouse.move(barX, after.y + 20)
  await page.mouse.down()
  await page.mouse.move(2, after.y + 20, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  const clamped = (await state()).wins.find(w => w.id === first.id)
  step('a window dragged at the edge stops instead of leaving the screen',
    !!clamped && clamped.x >= 0 && clamped.y >= 0 && clamped.x + clamped.w <= two.vw,
    `${after.x},${after.y} → ${clamped?.x},${clamped?.y} (w ${clamped?.w}, vw ${two.vw})`)

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
