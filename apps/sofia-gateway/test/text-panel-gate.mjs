// The typed path: a message in the chat box has no tools, so the gateway opens
// the window itself and pushes it out of band. This gate is the one that would
// have caught "she says GitHub is open, and nothing is".
import { chromium } from 'playwright'

const BASE = process.env.BASE || 'https://sofia.ctum.org'
const PASS = process.env.SOFIA_PASSWORD || ''
let pass = 0
let total = 0
const ok = (n, d = '') => { total++; pass++; console.log(`PASS  ${n}${d ? ` — ${d}` : ''}`) }
const fail = (n, d = '') => { total++; console.log(`FAIL  ${n}${d ? ` — ${d}` : ''}`) }

const browser = await chromium.launch({ args: ['--no-sandbox'] })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()

try {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  const field = await page.$('input[type=password]')
  if (field) {
    await field.fill(PASS)
    await page.click('button[type=submit], button')
    await page.waitForLoadState('domcontentloaded')
  }
  await page.waitForSelector('[data-testid=sofia-voice-dock]', { timeout: 120000, state: 'visible' })
  await page.waitForTimeout(2500)

  // 1. the stream is behind the session
  const stranger = await (await browser.newContext()).request.post(`${BASE}/api/events`, { failOnStatusCode: false, data: {} })
  stranger.status() === 401 || stranger.status() === 405
    ? ok('the stage stream is behind the session', `status ${stranger.status()}`)
    : fail('the stage stream is behind the session', `status ${stranger.status()}`)

  // 2. nothing is on screen before the turn
  const before = await page.evaluate(() => document.querySelectorAll('[data-testid=sofia-window]').length)
  before === 0 ? ok('no window before the turn') : fail('no window before the turn', `${before} open`)

  // 3. a typed turn opens a real window
  await page.evaluate(async () => {
    await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'hermes',
        stream: false,
        messages: [{ role: 'user', content: 'open github and show me' }],
      }),
    })
  })
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=sofia-window]').length > 0, { timeout: 60000 })
    .catch(() => {})
  const win = await page.evaluate(() => {
    const el = document.querySelector('[data-testid=sofia-window]')
    if (!el)
      return null
    const r = el.getBoundingClientRect()
    return { kind: el.getAttribute('data-kind'), x: Math.round(r.x), w: Math.round(r.width) }
  })
  win ? ok('a typed turn opens a window', `${win.kind} at ${win.x}, ${win.w}px`) : fail('a typed turn opens a window', 'none appeared')

  // 4. it is a real page, not a card
  const img = await page.evaluate(() => {
    const el = document.querySelector('[data-testid=sofia-window][data-kind=live] img')
    return el ? { src: el.getAttribute('src') || '', loaded: el.complete && el.naturalWidth > 0 } : null
  })
  img?.loaded ? ok('the window shows the page', img.src.slice(0, 40)) : fail('the window shows the page', JSON.stringify(img))

  // 5. it does not cover her, and it does not live in the chat column
  const insideChat = await page.evaluate(() => !!document.querySelector('[data-testid=sofia-window]')?.closest('.stage-column, [data-testid=chat-empty-state], textarea'))
  insideChat ? fail('the window is not inside the chat') : ok('the window is not inside the chat')

  // 5a. typing does everything voice can do. The text lane is Hermes with no
  // function calling, so every one of these is a gateway-side intent; if one
  // breaks, the capability silently exists only when he speaks.
  const say = async (text) => {
    await page.evaluate(async t => {
      await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'hermes', stream: false, messages: [{ role: 'user', content: t }] }),
      })
    }, text)
    await page.waitForTimeout(1500)
  }

  // Her rendered size, not the variable that is supposed to drive it: a CSS
  // variable set and never consumed passed this gate for a whole afternoon.
  const avatarBox = async () => page.evaluate(() => {
    const el = document.querySelector('.avatar-shell') || document.querySelector('canvas')
    if (!el)
      return null
    const r = el.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height) }
  })

  // Her size survives a reload, so the baseline must be a known size: a gate
  // that measured whatever the last session left behind called a working
  // command broken (541px -> 541px) because she was already at 0.65.
  await page.evaluate(() => window.__sofiaPanel({ kind: 'avatar', action: 'reset' }))
  await page.waitForTimeout(800)
  const big = await avatarBox()
  await say('make yourself smaller')
  const small = await avatarBox()
  const ratio = big && small && big.h > 0 ? small.h / big.h : 1
  ratio < 0.9 && ratio > 0.5
    ? ok('a typed turn shrinks her on screen', `${big?.h}px -> ${small?.h}px (${ratio.toFixed(2)})`)
    : fail('a typed turn shrinks her on screen', `${big?.h}px -> ${small?.h}px (${ratio.toFixed(2)})`)
  // Twice must be smaller than once, or the repeat is a silent no-op.
  await say('make yourself smaller')
  const smaller = await avatarBox()
  small && smaller && small.h > 0 && smaller.h < small.h
    ? ok('and saying it twice goes further', `${small?.h}px -> ${smaller?.h}px`)
    : fail('and saying it twice goes further', `${small?.h}px -> ${smaller?.h}px`)
  await say('come back to your usual place')
  const restored = await avatarBox()
  const backRatio = big && restored && big.h > 0 ? restored.h / big.h : 1
  backRatio > 0.9
    ? ok('and the reset puts her back', `${restored?.h}px (${backRatio.toFixed(2)})`)
    : fail('and the reset puts her back', `${restored?.h}px (${backRatio.toFixed(2)})`)

  await say('click sign in')
  await page.waitForTimeout(2500)
  const clickedUrl = await page.evaluate(() => {
    const el = document.querySelector('[data-testid=sofia-window][data-kind=live]')
    return el ? (el.getAttribute('data-url') || el.textContent || '').slice(0, 80) : ''
  })
  const clicked = String(clickedUrl).toLowerCase()
  clicked.includes('login') || clicked.includes('sign')
    ? ok('a typed turn clicks inside the page', clickedUrl)
    : fail('a typed turn clicks inside the page', `saw "${clickedUrl}"`)

  await say('close everything')
  const left = await page.evaluate(() => document.querySelectorAll('[data-testid=sofia-window]').length)
  left === 0 ? ok('a typed turn closes every window', '0 left') : fail('a typed turn closes every window', `${left} left`)

  await say('open github and show me')
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=sofia-window]').length > 0, { timeout: 60000 }).catch(() => {})

  // Leave one window up: the refresh check later in this gate needs something
  // to survive, and an empty stage would pass it for the wrong reason.
  await say('open github and show me')
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=sofia-window]').length > 0, { timeout: 60000 }).catch(() => {})

  // 5b. the Talk button is still there with a window open
  const dock = await page.evaluate(() => {
    const el = document.querySelector('[data-testid=sofia-voice-dock]')
    if (!el)
      return null
    const r = el.getBoundingClientRect()
    return { visible: r.width > 0 && r.height > 0, x: Math.round(r.x), y: Math.round(r.y) }
  })
  dock?.visible
    ? ok('the Talk button survives a window', `${dock.x},${dock.y}`)
    : fail('the Talk button survives a window', JSON.stringify(dock))

  // 5c. she can change her own size
  const preResize = await avatarBox()
  await page.evaluate(() => window.__sofiaPanel({ kind: 'avatar', action: 'set', scale: 0.7 }))
  await page.waitForTimeout(700)
  const postResize = await avatarBox()
  const resizeRatio = preResize && postResize && preResize.h > 0 ? postResize.h / preResize.h : 1
  Math.abs(resizeRatio - 0.7) < 0.08
    ? ok('she can resize herself on screen', `${preResize?.h}px -> ${postResize?.h}px (${resizeRatio.toFixed(2)})`)
    : fail('she can resize herself on screen', `${preResize?.h}px -> ${postResize?.h}px (${resizeRatio.toFixed(2)})`)
  await page.evaluate(() => window.__sofiaPanel({ kind: 'avatar', action: 'reset' }))

  // 5d. a refresh does not throw the stage away
  const beforeReload = await page.evaluate(() => document.querySelectorAll('[data-testid=sofia-window]').length)
  await page.reload({ waitUntil: 'domcontentloaded' })
  const field2 = await page.$('input[type=password]')
  if (field2) {
    await field2.fill(PASS)
    await page.click('button[type=submit], button')
    await page.waitForLoadState('domcontentloaded')
  }
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=sofia-window]').length > 0, { timeout: 60000 }).catch(() => {})
  const afterReload = await page.evaluate(() => document.querySelectorAll('[data-testid=sofia-window]').length)
  afterReload >= beforeReload && afterReload > 0
    ? ok('the stage survives a refresh', `${beforeReload} → ${afterReload} window(s)`)
    : fail('the stage survives a refresh', `${beforeReload} → ${afterReload}`)

  // 6. the chat can be put away and brought back. A window takes the space by
  // design, so close it first — the toggle is about the chat, not about windows.
  await page.evaluate(() => window.__sofiaPanel(null))
  await page.waitForTimeout(400)
  const toggle = await page.$('[data-testid=sofia-chat-toggle]')
  if (!toggle) {
    fail('the chat has a toggle')
  }
  else {
    await toggle.evaluate(el => el.click())
    await page.waitForTimeout(500)
    const hidden = await page.evaluate(() => !document.querySelector('textarea, [placeholder*="Say something"]'))
    hidden ? ok('the chat can be hidden') : fail('the chat can be hidden', 'input still visible')
    await page.evaluate(() => document.querySelector('[data-testid=sofia-chat-toggle]')?.click())
    await page.waitForTimeout(500)
    const back = await page.evaluate(() => !!document.querySelector('textarea, [placeholder*="Say something"]'))
    back ? ok('the chat can be brought back') : fail('the chat can be brought back', 'input did not return')
  }
}
catch (error) {
  fail('gate ran without throwing', String(error.message || error).slice(0, 160))
}
finally {
  await browser.close()
  console.log(`\n${pass}/${total}`)
  process.exit(pass === total ? 0 : 1)
}
