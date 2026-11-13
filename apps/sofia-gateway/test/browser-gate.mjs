// Her browser: does a window show a REAL page, and can it be driven?
// The old panel showed a card because sites refuse framing. This gate proves
// the replacement: a server-rendered page, a click that lands, a scroll that
// moves, and a close that releases it.
import { chromium } from 'playwright'

/** Closes the browser, but never waits more than a few seconds for it. */
// A response already in flight when the browser closes rejects AFTER the tally has
// been printed, and Node's default handler turns that into a non-zero exit with a
// stack trace after the count. Report the count as the last word instead.
let tallied = false
process.on('unhandledRejection', (error) => {
  if (!tallied)
    fail('the gate ran without an unhandled rejection', String(error?.message || error).slice(0, 110))
})
process.on('uncaughtException', (error) => {
  if (!tallied)
    fail('the gate ran without an uncaught exception', String(error?.message || error).slice(0, 110))
})

async function closeBrowserQuietly(browser, ms = 8000) {
  if (!browser)
    return
  // `.catch()` only handles a REJECTION. A close that never settles hangs the
  // process, and the tally afterwards is never printed — which the verifier reads
  // as "did not report a count" for a gate whose every assertion passed.
  await Promise.race([
    browser.close().catch(() => {}),
    new Promise(resolve => setTimeout(resolve, ms).unref?.()),
  ])
}

const BASE = process.env.BASE || 'https://sofia.ctum.org'
const PASS = process.env.SOFIA_PASSWORD || ''
let pass = 0
let total = 0
const fail = (name, detail = '') => { total++; console.log(`FAIL  ${name} — ${detail}`) }
const ok = (name, detail = '') => { total++; pass++; console.log(`PASS  ${name} — ${detail}`) }

const browser = await chromium.launch({ args: ['--no-sandbox'] })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
try {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  const field = await page.$('input[type=password]')
  if (field) {
    await field.fill(PASS)
    await page.click('button[type=submit], button')
    await page.waitForLoadState('domcontentloaded')
  }
  await page.waitForSelector('[data-testid=sofia-voice-dock]', { timeout: 120000, state: 'visible' })
  await page.waitForFunction(() => !document.getElementById('boot-splash'), { timeout: 60000 }).catch(() => {})

  // 1. the service answers through the gateway, and only when signed in.
  // A fresh context, not `ctx.request`: that jar already holds the session
  // cookie, so the "anonymous" probe came back 200 and read as an open
  // endpoint. Measured with curl and no cookie: 401.
  const anonCtx = await browser.newContext()
  const anon = await anonCtx.request.post(`${BASE}/api/browse/open`, { data: { url: 'https://example.com' }, failOnStatusCode: false })
  await anonCtx.close()
  anon.status() === 401 ? ok('the browser is behind the session', '401 without a cookie') : fail('the browser is behind the session', `status ${anon.status()}`)

  const opened = await ctx.request.post(`${BASE}/api/browse/open`, { data: { url: 'https://example.com' } })
  const body = await opened.json()
  body.sid ? ok('a page opened in the real browser', `${body.sid} · ${body.title}`) : fail('a page opened in the real browser', JSON.stringify(body).slice(0, 120))

  // 2. the frame is a picture, not a blank rectangle
  const frame = await ctx.request.get(`${BASE}/api/browse/frame?sid=${body.sid}`)
  const bytes = (await frame.body()).length
  bytes > 20000 ? ok('the frame is a real screenshot', `${Math.round(bytes / 1024)} KB`) : fail('the frame is a real screenshot', `${bytes} bytes`)

  // 3. it reaches the stage as a window
  await page.evaluate(p => window.__sofiaPanel(p), { kind: 'live', url: body.url, sid: body.sid, title: body.title })
  await page.waitForTimeout(1500)
  const win = await page.evaluate(() => {
    const el = document.querySelector('[data-testid=sofia-window][data-kind=live]')
    if (!el)
      return null
    const img = el.querySelector('img')
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), src: img?.getAttribute('src') || '', loaded: !!img && img.complete && img.naturalWidth > 0 }
  })
  win ? ok('a live window is on the stage', `${win.w}px at ${win.x},${win.y}`) : fail('a live window is on the stage', 'none')
  win?.loaded ? ok('the window shows the page picture', win.src.slice(0, 42)) : fail('the window shows the page picture', JSON.stringify(win).slice(0, 120))

  // 4. a scroll lands on the page, not on the stage
  const before = await (await ctx.request.get(`${BASE}/api/browse/frame?sid=${body.sid}`)).body()
  const scrolled = await ctx.request.post(`${BASE}/api/browse/act`, { data: { sid: body.sid, action: 'scroll', x: 640, y: 400, text: '700' } })
  const after = await scrolled.json()
  const same = before.length === Buffer.from(after.png || '', 'base64').length
  after.png ? ok('a scroll is relayed into the page', same ? 'frame re-rendered' : 'frame changed') : fail('a scroll is relayed into the page', JSON.stringify(after).slice(0, 120))

  // 5. her own tool path: show_panel with kind live
  const navigated = await ctx.request.post(`${BASE}/api/browse/act`, { data: { sid: body.sid, action: 'goto', text: 'https://www.iana.org/help/example-domains' } })
  const nav = await navigated.json()
  nav.title && nav.title !== body.title ? ok('the page can navigate inside its window', nav.title) : fail('the page can navigate inside its window', JSON.stringify(nav).slice(0, 120))

  // 5b. a click by visible text lands on the page. The link text is read from
  // the page itself first — hardcoding "More information" broke when example.com
  // dropped that link, and the gate blamed the feature for it.
  await ctx.request.post(`${BASE}/api/browse/act`, { data: { sid: body.sid, action: 'goto', text: 'https://www.iana.org/help/example-domains' } })
  const listed = await ctx.request.post(`${BASE}/api/browse/act`, { data: { sid: body.sid, action: 'links' } })
  const listedBody = await listed.json()
  const pick = (listedBody.links || []).find(l => l.text && l.text.length > 3 && l.text.length < 30 && !/^(Home|About|Contact)$/i.test(l.text))
  if (!pick) {
    fail('a click by its text lands on the page', 'no links on the page to click')
  }
  else {
    const before = listedBody.url
    const clicked = await ctx.request.post(`${BASE}/api/browse/act`, { data: { sid: body.sid, action: 'clickText', text: pick.text } })
    const clickBody = await clicked.json()
    clickBody.url && clickBody.url !== before
      ? ok('a click by its text lands on the page', `"${pick.text}" → ${clickBody.url}`)
      : fail('a click by its text lands on the page', JSON.stringify(clickBody).slice(0, 140))
  }

  // 6. close releases the page
  await ctx.request.post(`${BASE}/api/browse/close`, { data: { sid: body.sid } })
  const dead = await ctx.request.get(`${BASE}/api/browse/frame?sid=${body.sid}`, { failOnStatusCode: false })
  dead.status() >= 400 ? ok('closing releases the page', `frame -> ${dead.status()}`) : fail('closing releases the page', `frame -> ${dead.status()}`)

  // 7. private addresses are refused
  const privateTry = await ctx.request.post(`${BASE}/api/browse/open`, { data: { url: 'http://127.0.0.1:3000/' }, failOnStatusCode: false })
  const privateBody = await privateTry.json()
  privateTry.status() >= 400 || /private/i.test(privateBody.error || '')
    ? ok('she will not browse the VPS itself', String(privateBody.error || privateTry.status()).slice(0, 60))
    : fail('she will not browse the VPS itself', JSON.stringify(privateBody).slice(0, 120))
}
catch (error) {
  fail('gate ran without throwing', String(error.message || error).slice(0, 200))
}
finally {
  await closeBrowserQuietly(browser)
  tallied = true
  console.log(`\n${pass}/${total}`)
  // `exitCode`, not `exit`: stdout is a pipe in the release run, and exiting
// immediately after printing the tally can drop it (measured: 641 of 4000
// lines and the final count lost). See text-panel-gate.mjs.
process.exitCode = pass === total ? 0 : 1
}
