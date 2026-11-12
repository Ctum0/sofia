// Sofia's hands on the web: a real Chromium, one page per window.
//
// The stage never iframes a site — X-Frame-Options and CSP make that a blank
// rectangle. Instead each window gets a page here, and the window shows a
// screenshot plus relays clicks, scrolling and typing back to it.
//
// Reached only by the gateway on the docker network (never published).
import http from 'node:http'
import dns from 'node:dns/promises'
import net from 'node:net'
// The Playwright image ships browsers, not a resolvable ESM package; allow the
// caller to point at the module the QA container already has.
const pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const chromium = pw.chromium || pw.default?.chromium
if (!chromium)
  throw new Error(`playwright did not export chromium (${process.env.PLAYWRIGHT_MODULE || 'playwright'})`)

const PORT = Number(process.env.PORT || 8790)
const MAX_PAGES = Number(process.env.MAX_PAGES || 8)
const VIEWPORT = { width: 1280, height: 800 }

/** Refuse to fetch the VPS's own network, metadata endpoints, and localhost. */
async function assertPublic(url) {
  const u = new URL(url)
  if (!/^https?:$/.test(u.protocol))
    throw new Error('only http and https')
  const addrs = net.isIP(u.hostname) ? [{ address: u.hostname }] : await dns.lookup(u.hostname, { all: true })
  for (const { address } of addrs) {
    if (/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|::1|fc|fd|fe80)/i.test(address)
      || address === '::' || address.startsWith('::ffff:127'))
      throw new Error(`refusing to browse a private address (${address})`)
  }
  return u.toString()
}

let browser
const pages = new Map() // sid -> { page, ctx, used }
// A live page keeps rendering when nobody is looking: one GitHub tab measured
// 490-595 % CPU on this host, because the page runs its own animation, timers
// and telemetry forever. Two levers were measured, and only one works:
//
//   freezing the page (`Page.setWebLifecycleState: frozen`) stops the page's
//     timers but leaves Chromium's software-GPU helper spinning — measured at
//     585 % *after* a successful freeze. Rejected, and removed rather than left
//     in as plausible-looking code.
//   closing the page, and the browser behind it, stops everything: 0.00 %.
//
// So idle means gone. The window's `/frame` reads and every action refresh
// `used`, so a page someone is actually looking at is never idle; only an
// abandoned one is, which is precisely the one pinning five cores for nothing.
const IDLE_MS = Number(process.env.IDLE_MS || 180000)
// Once the last page is gone there is nothing to keep the browser for. A short
// grace lets a burst of windows reuse it instead of paying a cold start each.
const BROWSER_IDLE_MS = Number(process.env.BROWSER_IDLE_MS || 30000)

let lastUsed = Date.now()

// A gate that forgets to close leaves a page behind, and four of those turn
// every later "open" into "no room: 4 pages open" (seen 2026-11-10). Pages are
// cheap to reopen and expensive to leak.
function reapIdle() {
  const now = Date.now()
  for (const [sid, entry] of pages) {
    if (now - (entry.used || 0) < IDLE_MS)
      continue
    pages.delete(sid)
    entry.ctx.close().catch(() => {})
    console.log(`[sofia-browser] reaped idle page ${entry.page.url?.().slice(0, 60) || sid}`)
  }
  // The browser is kept only while it has a page. Reaping runs first, so
  // `pages.size === 0` is reachable by construction: an earlier version closed
  // the browser after 60 s while pages lived for 180, so the two timers
  // contradicted each other and the browser outlived the threshold meant to
  // stop it.
  if (browser && pages.size === 0 && now - lastUsed >= BROWSER_IDLE_MS) {
    const closing = browser
    browser = undefined
    console.log(`[sofia-browser] closing idle browser after ${Math.round((now - lastUsed) / 1000)}s with no page`)
    closing.close().catch(() => {})
  }
}
setInterval(reapIdle, 5000).unref()

async function getBrowser() {
  if (browser?.isConnected())
    return browser
  browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--mute-audio'],
  })
  return browser
}

async function newPage(url) {
  lastUsed = Date.now()
  // A full slate must never turn into an error the user sees: the oldest page
  // is the one nobody is looking at. (Four leaked pages made every "open" fail
  // with "no room" on 2026-11-10.)
  if (pages.size >= MAX_PAGES) {
    let oldest = null
    for (const [sid, entry] of pages) {
      if (!oldest || (entry.used || 0) < (oldest[1].used || 0))
        oldest = [sid, entry]
    }
    if (oldest) {
      pages.delete(oldest[0])
      await oldest[1].ctx.close().catch(() => {})
      console.log(`[sofia-browser] evicted ${oldest[0]} to make room`)
    }
  }
  const safe = await assertPublic(url)
  const b = await getBrowser()
  const ctx = await b.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, locale: 'en-US' })
  const page = await ctx.newPage()
  page.setDefaultTimeout(20000)
  await page.goto(safe, { waitUntil: 'domcontentloaded', timeout: 25000 })
  // domcontentloaded is early: his screenshot showed GitHub's header with a
  // blank body because the picture was taken before the paint settled.
  await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {})
  await page.waitForTimeout(1200)
  const sid = `p${Date.now().toString(36)}${pages.size}`
  pages.set(sid, { page, ctx, used: Date.now() })
  return sid
}

async function snap(sid) {
  lastUsed = Date.now()
  const entry = pages.get(sid)
  if (!entry)
    throw new Error('no such page')
  entry.used = Date.now()
  const buf = await entry.page.screenshot({ type: 'png' })
  return {
    sid,
    title: await entry.page.title(),
    url: entry.page.url(),
    png: buf.toString('base64'),
    w: VIEWPORT.width,
    h: VIEWPORT.height,
  }
}

async function act({ sid, action, x, y, text, key, selector }) {
  lastUsed = Date.now()
  const entry = pages.get(sid)
  if (!entry)
    throw new Error('no such page')
  const { page } = entry
  // `selector`, `key` and `text` mean three different things and used to be
  // interchangeable swords: `fill` read its locator from `key`, so a typed
  // "type hello" asked for locator("hello") and timed out, and a caller that
  // sent `selector` had its locator silently ignored — the text landed in the
  // first field on the page instead of the named one. Accept the named field
  // first, then the historical spellings, so an old caller keeps working while
  // a new one is exact.
  const css = String(selector ?? key ?? text ?? '')
  switch (action) {
    case 'click':
      await page.mouse.click(Number(x), Number(y))
      break
    case 'scroll': {
      // A direction word is not a pixel count. `Number("down")` is NaN, and
      // Playwright answers a NaN wheel with "Input.dispatchMouseEvent: Invalid
      // parameters" — a protocol error that reads like a broken browser while
      // the page simply never scrolled.
      const delta = Number(text)
      if (!Number.isFinite(delta))
        throw new Error(`scroll needs pixels, got "${String(text)}"`)
      await page.mouse.move(Number(x || VIEWPORT.width / 2), Number(y || VIEWPORT.height / 2))
      await page.mouse.wheel(0, delta)
      break
    }
    case 'type':
      await page.keyboard.type(String(text || ''))
      break
    case 'key':
      await page.keyboard.press(String(key || 'Enter'))
      break
    case 'back':
      await page.goBack({ timeout: 15000 }).catch(() => {})
      break
    case 'forward':
      await page.goForward({ timeout: 15000 }).catch(() => {})
      break
    case 'reload':
      await page.reload({ timeout: 20000 }).catch(() => {})
      break
    case 'goto':
      await page.goto(await assertPublic(String(text)), { waitUntil: 'domcontentloaded', timeout: 25000 })
      break
    case 'clickText': {
      // Click the thing by what it says, not by where it is: coordinates go
      // stale the moment the page scrolls or a cookie banner appears.
      //
      // `.first()` on getByText is wrong on real sites: GitHub's "Sign in" first
      // match is a visually-hidden <span> inside the link, so the click waits
      // 15 s for an element that can never become visible and the action fails
      // while a perfectly good link sits beside it. Prefer a real control by
      // role, then any *visible* element whose text matches, then its clickable
      // ancestor.
      const wanted = String(text || '').trim()
      const roles = ['link', 'button', 'tab', 'menuitem']
      let clicked = false
      for (const role of roles) {
        const candidate = page.getByRole(role, { name: wanted, exact: false })
        const count = await candidate.count().catch(() => 0)
        for (let i = 0; i < count; i++) {
          const el = candidate.nth(i)
          if (await el.isVisible().catch(() => false)) {
            await el.click({ timeout: 8000 })
            clicked = true
            break
          }
        }
        if (clicked)
          break
      }
      if (!clicked) {
        const matches = page.getByText(wanted, { exact: false })
        const count = await matches.count().catch(() => 0)
        for (let i = 0; i < count; i++) {
          const el = matches.nth(i)
          if (!(await el.isVisible().catch(() => false)))
            continue
          const target = el.locator('xpath=ancestor-or-self::a | ancestor-or-self::button | ancestor-or-self::*[@role="button"][1]').first()
          const useIt = (await target.count().catch(() => 0)) > 0 ? target : el
          await useIt.click({ timeout: 8000 })
          clicked = true
          break
        }
      }
      if (!clicked) {
        // Never a bare "not found": the caller cannot retry without knowing
        // what is actually clickable here, and a blind retry is how she ends up
        // narrating a click that never happened.
        const offers = await page.evaluate(() => [...document.querySelectorAll('a[href], button, [role=button], [role=tab], input[type=submit]')]
          .filter(el => el.getClientRects().length > 0)
          .map(el => (el.textContent || el.value || el.getAttribute('aria-label') || '').trim())
          .filter(t => t && t.length < 60)).catch(() => [])
        const unique = [...new Set(offers)].slice(0, 12)
        throw new Error(`nothing visible on the page says "${wanted}". The page offers: ${unique.join(' | ') || 'no clickable controls'}`)
      }
      break
    }
    case 'clickSelector':
      if (!css)
        throw new Error('clickSelector needs a CSS selector')
      await page.locator(css).first().click({ timeout: 15000 })
      break
    case 'fill': {
      if (!css)
        throw new Error('fill needs a CSS selector for the field')
      // Report what actually landed: a fill that types into the wrong box is
      // the failure this contract exists to prevent, and only the page can say
      // whether the named field is the one that received the text. `landed` is
      // returned, not just checked here, so a gate can assert on it instead of
      // inferring success from "the call did not throw".
      const field = page.locator(css).first()
      const words = String(text || '')
      await field.fill(words, { timeout: 15000 })
      const landed = await field.inputValue().catch(() => undefined)
      if (landed !== undefined && landed !== words)
        throw new Error(`typed into ${css} but it reads "${landed.slice(0, 40)}"`)
      return { ...(await snap(sid)), landed: landed ?? null, selector: css }
    }
    case 'value': {
      // The only way to read an input's value: `read` returns innerText, which
      // never contains what a form field holds.
      if (!css)
        throw new Error('value needs a CSS selector')
      const landed = await page.locator(css).first().inputValue({ timeout: 8000 }).catch(() => null)
      return { ...(await snap(sid)), landed, selector: css }
    }
    case 'press':
      await page.keyboard.press(String(key || 'Enter'))
      break
    case 'read':
      return { ...(await snap(sid)), text: (await page.evaluate(() => document.body?.innerText || '')).slice(0, 6000) }
    case 'links':
      return {
        ...(await snap(sid)),
        links: await page.evaluate(() => [...document.querySelectorAll('a[href]')]
          .slice(0, 40)
          .map(a => ({ text: (a.textContent || '').trim().slice(0, 80), href: a.href }))
          .filter(l => l.text)),
      }
    default:
      throw new Error(`unknown action ${action}`)
  }
  await page.waitForTimeout(700)
  return snap(sid)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > 1e6)
        reject(new Error('body too large'))
    })
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}) }
      catch { reject(new Error('bad json')) }
    })
    req.on('error', reject)
  })
}

const server = http.createServer(async (req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  // The caller has to redraw the window even when the action failed, and it can
  // only do that if the failure names the page. An error reply of `{error}`
  // alone made every miss leave yesterday's pixels on screen.
  let askedSid = ''
  try {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/healthz') {
      return send(200, { ok: true, pages: pages.size, browser: !!browser?.isConnected() })
    }
    if (req.method === 'GET' && url.pathname === '/frame') {
      const s = await snap(url.searchParams.get('sid'))
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
      return res.end(Buffer.from(s.png, 'base64'))
    }
    if (req.method !== 'POST')
      return send(405, { error: 'POST only' })

    const body = await readBody(req)
    askedSid = String(body.sid || '')
    if (url.pathname === '/open') {
      const sid = await newPage(String(body.url))
      return send(200, await snap(sid))
    }
    if (url.pathname === '/act')
      return send(200, await act(body))
    if (url.pathname === '/touch') {
      // A window on screen is being looked at, and that is evidence of use even
      // though it sends no other traffic: the stage refetches a frame only when
      // the page changed, so a static page emits nothing for minutes. Without
      // this the reaper takes a page away from a window the user can still see,
      // and the next click on it fails silently.
      const entry = pages.get(body.sid)
      if (!entry)
        return send(404, { error: 'no such page' })
      entry.used = Date.now()
      lastUsed = Date.now()
      return send(200, { ok: true, sid: body.sid })
    }
    if (url.pathname === '/close') {
      const entry = pages.get(body.sid)
      if (entry) {
        pages.delete(body.sid)
        await entry.ctx.close().catch(() => {})
      }
      return send(200, { ok: true, pages: pages.size })
    }
    return send(404, { error: 'no route' })
  }
  catch (error) {
    send(400, { error: String(error.message || error), sid: askedSid || undefined })
  }
})

server.listen(PORT, '0.0.0.0', () => console.log(`[sofia-browser] listening on ${PORT}`))

for (const sig of ['SIGINT', 'SIGTERM'])
  process.on(sig, async () => { await browser?.close().catch(() => {}); process.exit(0) })
