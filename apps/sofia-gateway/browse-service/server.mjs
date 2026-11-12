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
// sid -> { page, ctx, url, title, used, sus }  (`sus` = suspended, page is gone)
const pages = new Map()

// --- what "idle" means, and why -------------------------------------------
//
// A live page keeps rendering when nobody is looking: one GitHub tab measured
// 490-595 % CPU on this host, because the page runs its own animation, timers
// and telemetry forever. Freezing the page (`Page.setWebLifecycleState:
// frozen`) was measured and does NOT stop it — still 585 % after a successful
// freeze — so that approach is gone rather than left in as plausible code.
//
// The policy is a suspend, not a kill. A page nobody has touched for
// SUSPEND_MS is closed and its URL is remembered; the sid stays valid, and the
// next `/frame` or `/act` on it reopens the same URL so the window the user can
// still see comes back to life instead of showing a dead frame forever. Only a
// page nobody has used for FORGET_MS is really dropped.
//
// Measured, and the measurement changed the design: with 5 pages open, 3
// suspended and 3 live, CPU was 555-587 %. The cost is per LIVE page (each gets
// its own renderer and keeps the software-GPU helper busy), so a partial suspend
// buys nothing. What buys everything is reaching zero live pages, at which point
// BROWSER_IDLE_MS closes the browser.
//
// A live window heartbeats and is therefore never suspended; only abandoned
// pages are. So this window can be short — it only governs how long a page
// nobody is looking at keeps its process — as long as it is longer than the gap
// between a window's beats.
const SUSPEND_MS = Number(process.env.SUSPEND_MS || 120000)
const FORGET_MS = Number(process.env.FORGET_MS || 3600000)
// Once nothing is live at all, keep the browser warm briefly so a burst of
// windows does not pay a cold start each, then close it: even an empty browser
// retains helper processes.
const BROWSER_IDLE_MS = Number(process.env.BROWSER_IDLE_MS || 30000)
// A profile on disk is what makes a login survive a suspend. Without it every
// resume is a fresh, logged-out browser, which would make the suspend useless
// for the one workflow that needs it most.
const PROFILE_DIR = process.env.PROFILE_DIR || '/profile'

let lastUsed = Date.now()
let inFlight = 0

/** Run something against the browser while the reaper is not allowed to close it. */
async function withBrowser(fn) {
  inFlight += 1
  lastUsed = Date.now()
  try {
    return await fn()
  }
  finally {
    inFlight -= 1
  }
}

function reapIdle() {
  const now = Date.now()
  for (const [sid, entry] of pages) {
    const idleFor = now - (entry.used || 0)
    if (!entry.sus && idleFor >= SUSPEND_MS) {
      // Suspend: the URL outlives the page, so the sid can be resumed.
      const url = entry.page?.url?.() || entry.url
      entry.sus = true
      entry.url = url
      entry.title = entry.title || ''
      // Close the PAGE, never the context: with a persistent profile every page
      // shares one context, so closing it would suspend every other window too.
      const closing = entry.page
      entry.page = undefined
      closing?.close().catch(() => {})
      console.log(`[sofia-browser] suspended idle page ${sid} (${String(url).slice(0, 60)})`)
    }
    if (idleFor >= FORGET_MS && pages.size > 0) {
      pages.delete(sid)
      console.log(`[sofia-browser] forgot page ${sid} after ${Math.round(idleFor / 1000)}s`)
    }
  }
  const live = [...pages.values()].filter(entry => entry.page).length
  if (browser && live === 0 && inFlight === 0 && now - lastUsed >= BROWSER_IDLE_MS) {
    const closing = browser
    browser = undefined
    console.log(`[sofia-browser] closing idle browser after ${Math.round((now - lastUsed) / 1000)}s with no live page`)
    closing.close().catch(() => {})
  }
}
setInterval(reapIdle, 5000).unref()

// `launchPersistentContext` resolves to a BrowserContext, not a Browser: it has
// no `isConnected()`, and asking it for one made every /healthz and every
// suspended page throw. A context is usable while its browser is, so that is
// what the checks read.
function browserAlive() {
  try {
    const impl = browser?.browser?.()
    return !!impl && impl.isConnected()
  }
  catch {
    return false
  }
}

async function getBrowser() {
  if (browserAlive())
    return browser
  // A persistent profile: cookies and logins live on disk, so a suspend or a
  // cold start does not log Sithum out of everything he signed into by hand.
  browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    viewport: VIEWPORT,
    locale: 'en-US',
    deviceScaleFactor: 1,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--mute-audio'],
  })
  console.log(`[sofia-browser] launched with profile ${PROFILE_DIR}`)
  return browser
}

/** Open a URL in a fresh page of the persistent profile. */
async function openIn(url) {
  const ctx = await getBrowser()
  const page = await ctx.newPage()
  page.setDefaultTimeout(20000)
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 })
  // domcontentloaded is early: a screenshot showed GitHub's header with a blank
  // body because the picture was taken before the paint settled.
  await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {})
  await page.waitForTimeout(1200)
  return page
}

async function newPage(url) {
  lastUsed = Date.now()
  if (pages.size >= MAX_PAGES) {
    // Evict the idlest page, suspended ones first: they cost nothing to lose
    // beyond their position in the list.
    let oldest = null
    for (const [sid, entry] of pages) {
      const score = (entry.sus ? 0 : 1e15) + (entry.used || 0)
      if (!oldest || score < oldest[1])
        oldest = [sid, score]
    }
    if (oldest) {
      const entry = pages.get(oldest[0])
      pages.delete(oldest[0])
      entry?.page?.close().catch(() => {})
      console.log(`[sofia-browser] evicted ${oldest[0]} to make room`)
    }
  }
  const safe = await assertPublic(url)
  const page = await openIn(safe)
  const sid = `p${Date.now().toString(36)}${pages.size}`
  pages.set(sid, { page, url: page.url(), title: '', used: Date.now(), sus: false })
  return sid
}

/** The page behind a sid, resuming it from its remembered URL if it is suspended. */
async function pageFor(sid) {
  const entry = pages.get(sid)
  if (!entry)
    throw new Error('no such page')
  entry.used = Date.now()
  lastUsed = Date.now()
  if (entry.page)
    return entry
  if (!entry.url)
    throw new Error('that page expired — open it again')
  // Resume: same sid, same URL, same profile, so the window that is still on
  // screen starts working again instead of showing a dead frame.
  entry.page = await openIn(entry.url)
  entry.sus = false
  console.log(`[sofia-browser] resumed page ${sid} (${String(entry.url).slice(0, 60)})`)
  return entry
}

async function snap(sid) {
  return withBrowser(async () => {
  const entry = await pageFor(sid)
  const buf = await entry.page.screenshot({ type: 'png' })
  return {
    sid,
    title: await entry.page.title(),
    url: entry.page.url(),
    png: buf.toString('base64'),
    w: VIEWPORT.width,
    h: VIEWPORT.height,
    suspended: false,
  }
  })
}

async function act({ sid, action, x, y, text, key, selector }) {
  return withBrowser(async () => {
  const entry = await pageFor(sid)
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
    case 'look':
      // What a person sees, not what the DOM says: a modal, a CAPTCHA, a red
      // error banner, a chart — none of it appears in innerText, which is why
      // "she clicked the wrong thing" was invisible to her. The caption is a
      // cheap description built from what IS inspectable, and the pixels are
      // returned so a model with vision can look at the rest.
      return {
        ...(await snap(sid)),
        caption: await page.evaluate(() => {
          const visible = el => !!(el.getClientRects().length)
          const dialogs = [...document.querySelectorAll('[role=dialog], dialog[open], [aria-modal=true]')]
            .filter(visible)
            .map(el => (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 160))
          const alerts = [...document.querySelectorAll('[role=alert], [aria-live=assertive], .error, .alert, [class*=error i]')]
            .filter(visible)
            .map(el => (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120))
            .filter(Boolean)
          const focused = document.activeElement
          const field = focused && /^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName)
            ? (focused.getAttribute('aria-label') || focused.getAttribute('name') || focused.id || focused.tagName).slice(0, 60)
            : null
          const buttons = [...document.querySelectorAll('button, [role=button], input[type=submit]')]
            .filter(visible)
            .map(el => (el.textContent || el.value || '').trim())
            .filter(t => t && t.length < 40)
          return {
            title: document.title,
            url: location.href,
            dialogs,
            alerts,
            focusedField: field,
            buttons: [...new Set(buttons)].slice(0, 12),
            scroll: { y: Math.round(scrollY), height: Math.round(document.body.scrollHeight) },
          }
        }),
      }
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
  })
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
      const live = [...pages.values()].filter(entry => entry.page).length
      const suspended = pages.size - live
      return send(200, { ok: true, pages: pages.size, live, suspended, browser: browserAlive(), suspendMs: SUSPEND_MS })
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
    if (url.pathname === '/close-all') {
      // The verifier opens pages and does not always close them, and the cost is
      // per LIVE page: five leaked pages held this container at ~550 % CPU for the
      // whole idle window. Whoever opened them is the one who should reclaim
      // them, so the release calls this when it is done.
      // Read the entries BEFORE clearing the map: clearing first made every
      // close a no-op, so the pages survived the call that exists to remove them.
      const entries = [...pages.values()]
      const count = entries.length
      pages.clear()
      for (const entry of entries)
        await entry.page?.close().catch(() => {})
      const closing = browser
      browser = undefined
      await closing?.close().catch(() => {})
      console.log(`[sofia-browser] closed everything (${count} page(s)) on request`)
      return send(200, { ok: true, closed: count })
    }
    if (url.pathname === '/close') {
      const entry = pages.get(body.sid)
      if (entry) {
        pages.delete(body.sid)
        // Close the PAGE. With a persistent profile every page shares one
        // context, so closing the context would sign Sithum out of every other
        // window and wipe the profile's cookies with it.
        await entry.page?.close().catch(() => {})
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
