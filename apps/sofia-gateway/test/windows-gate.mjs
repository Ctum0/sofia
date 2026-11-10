// windows-gate.mjs — the stage's windows: several at once, above the page, not
// inside the chat column, each movable and closable.
//
// Pointer assertions read HIT-TESTING, not visibility. The defect this gate was
// written after: `section.startup-screen` (a Vue Teleport overlay, z-index
// 10000) stayed on screen for ~13 s after login and swallowed every click, while
// a visibility check on `#boot-splash` — a different, already-removed element —
// reported "splash gone". A gate that certifies the wrong element passes for the
// wrong reason, so the two checks below are (a) does an overlay still intercept
// a point, and (b) is this predicate able to see an overlay at all.
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
      z: getComputedStyle(w).zIndex,
      title: w.querySelector('.sofia-window__title')?.textContent?.trim(),
      img: (() => { const i = w.querySelector('img'); return i ? i.naturalWidth : 0 })() }
  })
  const chat = document.querySelector('[data-testid=chat-empty-state]')
  const col = document.querySelector('.stage-column')
  const cr = col ? col.getBoundingClientRect() : null
  const splash = document.getElementById('boot-splash')
  const splashVisible = !!splash && splash.getBoundingClientRect().height > 0 && getComputedStyle(splash).display !== 'none'
  return {
    layerFixed: layer ? getComputedStyle(layer).position : null,
    count: wins.length, wins,
    chatVisible: !!chat, splashVisible,
    insideChatColumn: layer ? !!layer.closest('.stage-column') : null,
    vw: innerWidth, vh: innerHeight,
    col: cr ? { x: Math.round(cr.x), w: Math.round(cr.width), right: Math.round(cr.right) } : null,
  }
})

// What is actually under this point? The whole point of the gate.
const hitAt = (x, y) => page.evaluate(([x, y]) => {
  const el = document.elementFromPoint(x, y)
  if (!el) return { tag: null, cls: '', windowId: null, overlay: null }
  const win = el.closest('[data-testid=sofia-window]')
  const ov = el.closest('.startup-screen, #boot-splash')
  return {
    tag: el.tagName.toLowerCase(),
    cls: typeof el.className === 'string' ? el.className.slice(0, 48) : '',
    windowId: win ? win.getAttribute('data-window-id') : null,
    overlay: ov ? `${ov.tagName.toLowerCase()}.${(typeof ov.className === 'string' ? ov.className : '').split(' ')[0]}` : null,
  }
}, [x, y])

// Does anything from the splash/overlay family intercept the viewport?
const overlayHits = () => page.evaluate(() => {
  const hits = []
  for (const f of [0.25, 0.5, 0.75]) {
    for (const g of [0.25, 0.5, 0.75]) {
      const el = document.elementFromPoint(Math.round(innerWidth * f), Math.round(innerHeight * g))
      const ov = el && el.closest('.startup-screen, #boot-splash')
      if (ov)
        hits.push(`${Math.round(innerWidth * f)},${Math.round(innerHeight * g)} → ${ov.tagName.toLowerCase()}.${(typeof ov.className === 'string' ? ov.className : '').split(' ')[0]}`)
    }
  }
  const s = document.querySelector('.startup-screen')
  const sDisplay = s ? getComputedStyle(s).display : 'absent'
  const sPointer = s ? getComputedStyle(s).pointerEvents : 'absent'
  return { hits, sDisplay, sPointer, sPresent: !!s }
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
  // `18273e680` moved the windows into her right shoulder so they never cover
  // her. This assertion existed then and the live-window rewrite (`28994c745`)
  // dropped it, so the gate went on printing a green count while the property it
  // was written for went unread (16/16 at `b4af81cf1` → 15/15 afterwards, and the
  // missing one was this). Property, not value: anything that starts at or right
  // of 75 % of the stage column is off her centre.
  const shoulder = two.col ? two.col.x + two.col.w * 0.75 : null
  step('what she opens stays in the right shoulder, never over her centre',
    !!shoulder && two.wins.length > 0 && two.wins.every(w => w.x >= shoulder),
    `column ${two.col?.x}..${two.col?.right} shoulder≥${Math.round(shoulder ?? 0)}, windows ${JSON.stringify(two.wins.map(w => w.x))}`)
  step('no window spills past the viewport edge',
    two.wins.length > 0 && two.wins.every(w => w.x >= 0 && w.y >= 0 && w.x + w.w <= two.vw && w.y + w.h <= two.vh),
    JSON.stringify(two.wins.map(w => `${w.x}+${w.w}/${two.vw} , ${w.y}+${w.h}/${two.vh}`)))

  // (a) Wait until nothing overlay-shaped intercepts the viewport. `#boot-splash`
  // is the static HTML splash; `section.startup-screen` is the Vue one and is the
  // element that actually ate the clicks. Neither may hit-test.
  await page.waitForFunction(() => {
    const s = document.querySelector('.startup-screen')
    const hidden = !s || getComputedStyle(s).display === 'none' || getComputedStyle(s).pointerEvents === 'none'
    const b = document.getElementById('boot-splash')
    const bootGone = !b || getComputedStyle(b).display === 'none' || getComputedStyle(b).pointerEvents === 'none'
    if (!hidden || !bootGone) return false
    for (const f of [0.25, 0.5, 0.75]) {
      for (const g of [0.25, 0.5, 0.75]) {
        const el = document.elementFromPoint(Math.round(innerWidth * f), Math.round(innerHeight * g))
        if (el && el.closest('.startup-screen, #boot-splash')) return false
      }
    }
    return true
  }, { timeout: 90000 }).catch(() => {})
  const ov = await overlayHits()
  step('no splash overlay intercepts the viewport', ov.hits.length === 0,
    `intercepts: ${ov.hits.length ? ov.hits.join(' | ') : 0}; .startup-screen display=${ov.sDisplay} pointer-events=${ov.sPointer} present=${ov.sPresent}`)

  // (b) Is that predicate able to see an overlay? Inject one and watch it fail.
  const first = two.wins[0]
  const barX = first.x + Math.round(first.w / 2)
  const barY = first.y + 16
  const barClean = await hitAt(barX, barY)
  step('the top window\'s title bar takes the pointer', barClean.windowId === first.id,
    `at ${barX},${barY} → ${barClean.tag}.${barClean.cls} windowId=${barClean.windowId} overlay=${barClean.overlay}`)
  await page.evaluate(() => {
    const d = document.createElement('div')
    d.id = '__gate_overlay'
    d.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.01)'
    document.body.appendChild(d)
  })
  const barBlocked = await hitAt(barX, barY)
  await page.evaluate(() => document.getElementById('__gate_overlay')?.remove())
  const barCleanAgain = await hitAt(barX, barY)
  step('the hit-test assertion can see an overlay (discriminating)', barBlocked.windowId === null && barCleanAgain.windowId === first.id,
    `injected → ${barBlocked.tag}.${barBlocked.cls} windowId=${barBlocked.windowId}; removed → windowId=${barCleanAgain.windowId}`)

  // raise the first window by clicking its bar
  await page.mouse.click(barX, barY)
  await page.waitForTimeout(400)
  const raised = await state()
  step('clicking a window raises it', raised.wins.find(w => w.id === first.id)?.active === 'true',
    JSON.stringify(raised.wins.map(w => `${w.id}:${w.active}:z${w.z}`)))

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

  // Pushed hard at the top-left the window must stop at 0 instead of leaving the
  // screen where it cannot be grabbed back. This clamp came with the plain-mouse
  // drag rewrite and the live-window rewrite dropped the assertion, not the code.
  await page.mouse.move((after?.x ?? first.x) + 120, (after?.y ?? first.y) + 8)
  await page.mouse.down()
  await page.mouse.move(-500, -500, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(350)
  const clamped = (await state()).wins.find(w => w.id === first.id)
  step('a window dragged at the edge stops instead of leaving the screen',
    !!clamped && clamped.x >= 0 && clamped.y >= 0 && clamped.x + clamped.w <= two.vw && clamped.y + clamped.h <= two.vh,
    `${after?.x},${after?.y} → ${clamped?.x},${clamped?.y} (w ${clamped?.w}, vw ${two.vw})`)

  // close one. The selector is scoped to a specific window: a bare
  // `[data-testid=sofia-window] [data-testid=sofia-window-close]` matches every
  // window's button, and once two windows overlap (which the edge-clamp drag
  // makes them do) Playwright either waits 30 s for the one element it is
  // allowed to act on or waits for a button that is covered — the gate then
  // reports a product failure that is really its own selector.
  const closeBtn = id => `[data-testid=sofia-window][data-window-id="${id}"] [data-testid=sofia-window-close]`
  await page.click(closeBtn((await state()).wins.find(w => w.active === 'true')?.id ?? first.id))
  await page.waitForTimeout(400)
  // A close that misses is a harness problem until it misses twice: the click
  // can land while the layer is re-rendering. Retry once, then assert — and
  // re-read the window's position first, because the drag above moved it and a
  // click at its old coordinates lands on nothing.
  let left = (await state()).count
  if (left !== 1) {
    const now = (await state()).wins.find(w => w.id === first.id)
    const cur = now ?? first
    await page.mouse.click(cur.x + Math.round(cur.w / 2), cur.y + 16)
    await page.waitForTimeout(400)
    const closeAgain = await page.$('[data-testid=sofia-window-close]')
    if (closeAgain)
      await closeAgain.click({ force: true }).catch(() => {})
    await page.waitForTimeout(600)
    left = (await state()).count
  }
  step('closing one leaves the other', left === 1, `${left} left`)

  // close the rest, newest first, scoped by id for the same reason as above
  while ((await state()).count > 0) {
    const left2 = await state()
    const top = left2.wins.find(w => w.active === 'true') ?? left2.wins[left2.wins.length - 1]
    await page.click(closeBtn(top.id))
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
