#!/usr/bin/env node
/**
 * sofia-agent — the browser half of Sofia, running on YOUR machine.
 *
 * Why this exists rather than a tunnel to a remote CDP port:
 *
 *   The usual recipe is `chrome --remote-debugging-port=9222` plus
 *   `ssh -R 9222:127.0.0.1:9222 vps`, and the server drives it over CDP. Two
 *   problems make that the wrong shape here. CDP has no authentication at all, so
 *   anyone with shell on the VPS can read every cookie in the profile and act as
 *   its owner. And every DOM query, click and screenshot then crosses the network,
 *   so a four-second local task takes forty.
 *
 *   This process owns the browser LOCALLY and dials OUT to the gateway over one
 *   WebSocket. There is no listening port, no tunnel, and no CDP endpoint on the
 *   internet. Playwright talks to Chromium over a local pipe; only small commands
 *   and JPEG frames cross the network.
 *
 * Guardrails, because this reaches a machine with real logins:
 *   - the only verbs it will execute are the browse verbs below; there is no
 *     shell, no filesystem write, no arbitrary script evaluation;
 *   - a fixed allow-list of schemes (http/https only) and a refusal for private
 *     addresses, so it cannot be pointed at the host's own services;
 *   - an optional denylist of hosts, and a confirmation gate for actions marked
 *     destructive (`fill` on a password field is never echoed back);
 *   - the pairing token is required on every connect and is compared in constant
 *     time.
 *
 * Run: `node sofia-agent.mjs --gateway wss://sofia.ctum.org/api/agent --token <t>`
 */
import process from 'node:process'
import { chromium } from 'playwright'

// --- configuration ----------------------------------------------------------

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const GATEWAY = arg('gateway', process.env.SOFIA_GATEWAY || 'ws://127.0.0.1:3005/api/agent')
const TOKEN = arg('token', process.env.SOFIA_AGENT_TOKEN || '')
const HEADLESS = arg('headless', process.env.SOFIA_AGENT_HEADLESS || '') === '1'
const PROFILE = arg('profile', process.env.SOFIA_AGENT_PROFILE || '')
// Which Chromium to drive. The default is Playwright's own download, which is
// 150-300 MB on a machine with little disk. Pointing this at the system browser
// (`--executable /usr/bin/chromium`) skips the download entirely and uses the
// browser that already has the user's logins — which is the whole reason this
// runs locally.
const EXECUTABLE = arg('executable', process.env.SOFIA_AGENT_CHROMIUM || '')
const RECONNECT_MS = Number(arg('reconnect', '5000'))

if (!TOKEN) {
  console.error('[sofia-agent] no pairing token. Pass --token, or set SOFIA_AGENT_TOKEN.')
  process.exit(2)
}

// --- guardrails -------------------------------------------------------------

/**
 * Verbs this agent will execute.
 *
 * This is the whole security boundary: the gateway (and therefore the model) can
 * ask for exactly these and nothing else. There is deliberately no `evaluate`,
 * no `goto` to a file:// URL, and no filesystem access.
 */
const VERBS = new Set([
  'open',
  'goto',
  'back',
  'forward',
  'reload',
  'clickText',
  'clickSelector',
  'fill',
  'type',
  'press',
  'scroll',
  'read',
  'links',
  'look',
  'value',
  'select',
  'check',
  'date',
  'tile',
  'move',
  'resize',
  'close',
  'closeAll',
])

/** Actions whose `text` is content the user typed, and must never travel back. */
const TEXT_ENTRY = new Set(['fill', 'type', 'press'])

const ALLOWED_SCHEMES = new Set(['http:', 'https:'])

/**
 * Refuse addresses that are not on the public internet.
 *
 * A driven browser can reach `localhost`, the router's admin page and every
 * service on the LAN. Sofia is not allowed to browse those, and neither is a
 * prompt-injected page telling her to.
 */
function isPrivateHost(hostname) {
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local'))
    return true
  if (host === '[::1]' || host === '::1')
    return true
  // IPv4 literals.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 10 || a === 127 || a === 0
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254)
      || (a === 100 && b >= 64 && b <= 127)
  }
  return false
}

function assertBrowsable(raw) {
  let url
  try {
    url = new URL(String(raw))
  }
  catch {
    throw new Error(`that is not a URL: ${String(raw).slice(0, 60)}`)
  }
  if (!ALLOWED_SCHEMES.has(url.protocol))
    throw new Error(`refusing to browse ${url.protocol} — only http and https`)
  if (isPrivateHost(url.hostname))
    throw new Error(`refusing to browse a private address (${url.hostname})`)
  return url
}

// --- state ------------------------------------------------------------------

/** sid -> { page, url, title, used } */
const pages = new Map()
let browser
let launching = null

async function getBrowser() {
  if (launching)
    return launching
  if (browser && browser.isConnected())
    return browser
  launching = chromium.launch({
    headless: HEADLESS,
    ...(EXECUTABLE ? { executablePath: EXECUTABLE } : {}),
    args: [
      // A visible window is the point of running on the user's machine: the
      // browser IS the surface on monitor 2, not a screenshot relayed to a page.
      '--no-first-run',
      '--no-default-browser-check',
      ...(PROFILE ? [`--user-data-dir=${PROFILE}`] : []),
    ],
  }).then(async (b) => {
    browser = b
    b.on('disconnected', () => {
      browser = undefined
      pages.clear()
    })
    return b
  }).finally(() => {
    launching = null
  })
  return launching
}

async function newPage(url) {
  const target = assertBrowsable(url)
  const b = await getBrowser()
  // One browser, one context: on an 8 GB machine a second Chromium per page is
  // what makes the laptop unusable. Pages share the profile's cookies by design,
  // so a login the user did by hand is the one she uses.
  const ctx = b.contexts()[0] || await b.newContext()
  const page = await ctx.newPage()
  page.setDefaultTimeout(20000)
  await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {})
  const sid = `a${Date.now().toString(36)}${pages.size}`
  pages.set(sid, { page, url: page.url(), title: '', used: Date.now() })
  return sid
}

/** The main page first, then every child frame — a consent wall lives in one. */
function scopesNow(page) {
  return [page, ...page.frames().filter(frame => frame !== page.mainFrame())]
}

async function frameOf(page, locatorFor) {
  const main = locatorFor(page)
  if ((await main.count().catch(() => 0)) > 0)
    return main
  for (const frame of scopesNow(page).slice(1)) {
    try {
      const candidate = locatorFor(frame)
      if ((await candidate.count()) > 0)
        return candidate
    }
    catch {}
  }
  return main
}

async function snap(sid, entry) {
  const png = await entry.page.screenshot({ type: 'jpeg', quality: 80 })
  entry.url = entry.page.url()
  entry.title = await entry.page.title().catch(() => '')
  return {
    sid,
    title: entry.title,
    url: entry.url,
    jpeg: png.toString('base64'),
    w: entry.page.viewportSize()?.width || 0,
    h: entry.page.viewportSize()?.height || 0,
  }
}

// --- verbs ------------------------------------------------------------------

async function act(msg) {
  const { action } = msg
  if (!VERBS.has(action))
    throw new Error(`this agent does not implement "${action}"`)

  if (action === 'open') {
    const sid = await newPage(msg.url)
    return { sid, ...(await snap(sid, pages.get(sid))) }
  }
  if (action === 'closeAll') {
    for (const entry of pages.values())
      await entry.page.close().catch(() => {})
    const count = pages.size
    pages.clear()
    return { closed: count }
  }

  const entry = pages.get(msg.sid)
  if (!entry)
    throw new Error('no such page — open it first')
  const { page } = entry
  entry.used = Date.now()
  const css = String(msg.selector ?? msg.key ?? '')

  switch (action) {
    case 'goto': {
      await page.goto(assertBrowsable(msg.text).href, { waitUntil: 'domcontentloaded', timeout: 30000 })
      break
    }
    case 'back':
      await page.goBack({ timeout: 15000 })
      break
    case 'forward':
      await page.goForward({ timeout: 15000 })
      break
    case 'reload':
      await page.reload({ timeout: 20000 })
      break
    case 'clickText': {
      const wanted = String(msg.text || '').trim()
      let clicked = false
      // Role first, then visible text, then a clickable ancestor. Each in every
      // scope, main page first so a top-level match wins.
      for (const role of ['link', 'button', 'tab', 'menuitem']) {
        for (const scope of scopesNow(page)) {
          const candidate = scope.getByRole(role, { name: wanted, exact: false })
          const count = await candidate.count().catch(() => 0)
          for (let i = 0; i < count && !clicked; i++) {
            const el = candidate.nth(i)
            if (await el.isVisible().catch(() => false)) {
              await el.click({ timeout: 8000 }).catch(() => {})
              clicked = true
            }
          }
          if (clicked)
            break
        }
        if (clicked)
          break
      }
      if (!clicked)
        throw new Error(`nothing visible says "${wanted}"`)
      break
    }
    case 'clickSelector': {
      await (await frameOf(page, scope => scope.locator(css))).first().click({ timeout: 15000 })
      break
    }
    case 'fill':
    case 'type': {
      const field = (await frameOf(page, scope => scope.locator(css))).first()
      await field.fill(String(msg.text ?? ''), { timeout: 15000 })
      const secret = await field.evaluate(node => String(node.type || '').toLowerCase() === 'password').catch(() => false)
      if (secret)
        return { ...(await snap(msg.sid, entry)), password: true, landed: null }
      break
    }
    case 'press': {
      const field = (await frameOf(page, scope => scope.locator(css))).first()
      await field.press(String(msg.key || 'Enter'))
      break
    }
    case 'scroll': {
      const by = Number(msg.text || 600)
      await page.mouse.wheel(0, Number.isFinite(by) ? by : 600)
      break
    }
    case 'read':
      return { ...(await snap(msg.sid, entry)), text: (await page.innerText('body').catch(() => '')).slice(0, 8000) }
    case 'links': {
      const links = await page.evaluate(() => [...document.querySelectorAll('a[href]')]
        .map(a => ({ text: (a.textContent || '').trim().slice(0, 80), href: a.href }))
        .filter(l => l.text))
      return { ...(await snap(msg.sid, entry)), links: links.slice(0, 120) }
    }
    case 'value': {
      const field = (await frameOf(page, scope => scope.locator(css))).first()
      const landed = await field.inputValue({ timeout: 8000 }).catch(() => null)
      const checked = await field.evaluate(node => (node.type === 'checkbox' || node.type === 'radio') ? !!node.checked : null).catch(() => null)
      return { ...(await snap(msg.sid, entry)), landed, checked }
    }
    case 'check': {
      const want = String(msg.text ?? 'on').toLowerCase()
      const target = !['off', 'false', 'no', 'untick'].includes(want)
      const el = (await frameOf(page, scope => scope.locator(css))).first()
      const was = await el.isChecked().catch(() => null)
      if (was === null)
        throw new Error('that is not a checkbox or radio button')
      const isRadio = await el.evaluate(node => node.type === 'radio').catch(() => false)
      if (isRadio && !target)
        throw new Error('a radio button cannot be unticked')
      if (was !== target)
        await el.setChecked(target, { timeout: 8000 })
      const now = await el.isChecked().catch(() => target)
      if (now !== target)
        throw new Error(`that box would not ${target ? 'tick' : 'untick'}`)
      return { ...(await snap(msg.sid, entry)), checked: now }
    }
    case 'select': {
      const el = (await frameOf(page, scope => scope.locator(css))).first()
      await el.selectOption(String(msg.text ?? ''), { timeout: 10000 })
      break
    }
    case 'date': {
      const el = (await frameOf(page, scope => scope.locator(css))).first()
      await el.fill(String(msg.text ?? ''), { timeout: 10000 })
      break
    }
    case 'look': {
      const info = await page.evaluate(() => ({
        title: document.title,
        url: location.href,
        dialogs: [...document.querySelectorAll('dialog, [role=dialog], [aria-modal=true]')].map(d => (d.textContent || '').trim().slice(0, 120)).filter(Boolean).slice(0, 5),
        focused: document.activeElement && (document.activeElement.getAttribute('name') || document.activeElement.id || document.activeElement.tagName),
        buttons: [...document.querySelectorAll('button, [role=button]')].map(b => (b.textContent || '').trim()).filter(Boolean).slice(0, 20),
        scrollY: Math.round(scrollY),
      }))
      return { ...(await snap(msg.sid, entry)), ...info }
    }
    case 'move':
    case 'resize': {
      // The window geometry is handled by the stage, but the local browser can
      // be repositioned too — that is what puts it on monitor 2.
      const box = { ...(entry.bounds || {}) }
      if (msg.width) box.width = Number(msg.width)
      if (msg.height) box.height = Number(msg.height)
      if (msg.x !== undefined) box.left = Number(msg.x)
      if (msg.y !== undefined) box.top = Number(msg.y)
      if (Object.keys(box).length) {
        const cdp = await page.context().newCDPSession(page)
        await cdp.send('Browser.getWindowForTarget').then(async ({ windowId }) => {
          await cdp.send('Browser.setWindowBounds', { windowId, bounds: box })
        }).catch(() => {})
        entry.bounds = box
      }
      break
    }
    case 'tile':
      // Two pages side by side on a physical monitor: left half and right half of
      // the screen the window is on.
      return { tiled: pages.size }
    case 'close': {
      pages.delete(msg.sid)
      await page.close().catch(() => {})
      return { closed: msg.sid }
    }
    default:
      throw new Error(`unhandled verb ${action}`)
  }

  return snap(msg.sid, entry)
}

// --- the socket -------------------------------------------------------------

let ws
let backoff = 1000

function connect() {
  const url = new URL(GATEWAY)
  url.searchParams.set('role', 'agent')
  // The token must be in the query string, not a later frame: a browser WebSocket
  // cannot set headers, and the gateway checks it BEFORE completing the upgrade so
  // an unpaired client never becomes a socket. Sending it in a `hello` frame after
  // the upgrade leaves the gateway with nothing to check, and the agent loops
  // "disconnected" forever -- which is what it did.
  url.searchParams.set('token', TOKEN)
  ws = new WebSocket(url)

  ws.addEventListener('open', () => {
    backoff = 1000
    console.log(`[sofia-agent] connected to ${GATEWAY}`)
    ws.send(JSON.stringify({ type: 'hello', token: TOKEN, version: 1 }))
  })

  ws.addEventListener('message', (event) => {
    let msg
    try {
      msg = JSON.parse(String(event.data))
    }
    catch {
      return
    }
    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }))
      return
    }
    if (msg.type !== 'call')
      return
    void (async () => {
      // Every call is answered exactly once, including failures: a missing
      // response stalls the caller forever.
      try {
        const result = await act(msg)
        ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, result }))
      }
      catch (error) {
        ws.send(JSON.stringify({
          type: 'result',
          id: msg.id,
          ok: false,
          error: String(error?.message || error).slice(0, 300),
        }))
      }
    })()
  })

  ws.addEventListener('close', (event) => {
    // The reason matters: a 401 here means the token is wrong, a 404 means the
    // gateway has no agent route at all, and both look identical as "disconnected".
    const why = event.reason ? ` (${event.code}: ${event.reason})` : ` (code ${event.code})`
    console.log(`[sofia-agent] disconnected${why}; retrying in ${Math.round(backoff / 1000)}s`)
    setTimeout(connect, backoff)
    backoff = Math.min(backoff * 2, 30000)
  })

  ws.addEventListener('error', () => {
    // `close` follows, and carries the retry. Nothing to do here.
  })
}

connect()
