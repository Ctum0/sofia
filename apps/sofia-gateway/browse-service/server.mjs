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
const IDLE_MS = Number(process.env.IDLE_MS || 180000)

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
    console.log(`[sofia-browser] reaped idle page ${sid}`)
  }
}
setInterval(reapIdle, 60000).unref()

async function getBrowser() {
  if (browser?.isConnected())
    return browser
  browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--mute-audio'],
  })
  return browser
}

async function newPage(url) {
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
  await page.waitForTimeout(1200)
  const sid = `p${Date.now().toString(36)}${pages.size}`
  pages.set(sid, { page, ctx, used: Date.now() })
  return sid
}

async function snap(sid) {
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

async function act({ sid, action, x, y, text, key }) {
  const entry = pages.get(sid)
  if (!entry)
    throw new Error('no such page')
  const { page } = entry
  switch (action) {
    case 'click':
      await page.mouse.click(Number(x), Number(y))
      break
    case 'scroll':
      await page.mouse.move(Number(x || VIEWPORT.width / 2), Number(y || VIEWPORT.height / 2))
      await page.mouse.wheel(0, Number(text || 400))
      break
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
    if (url.pathname === '/open') {
      const sid = await newPage(String(body.url))
      return send(200, await snap(sid))
    }
    if (url.pathname === '/act')
      return send(200, await act(body))
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
    send(400, { error: String(error.message || error) })
  }
})

server.listen(PORT, '0.0.0.0', () => console.log(`[sofia-browser] listening on ${PORT}`))

for (const sig of ['SIGINT', 'SIGTERM'])
  process.on(sig, async () => { await browser?.close().catch(() => {}); process.exit(0) })
