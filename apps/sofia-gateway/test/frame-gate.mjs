// The window must show the page moving. Until now every gate asserted the URL
// the service returned — which is a fact about the server, not about what a
// human sees. This gate hashes the pixels the window puts on the screen before
// and after she clicks, and fails if they are identical.
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

async function say(text) {
  return page.evaluate(async (t) => {
    const r = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'hermes', stream: false, messages: [{ role: 'user', content: t }] }),
    })
    return r.status
  }, text)
}

// What the window is actually displaying: the img source it points at, and a
// hash of those exact bytes.
async function picture() {
  return page.evaluate(async () => {
    const el = document.querySelector('[data-testid=sofia-window][data-kind=live]')
    if (!el)
      return null
    const img = el.querySelector('img')
    if (!img || !img.src)
      return null
    const res = await fetch(img.src, { credentials: 'include' })
    const buf = await res.arrayBuffer()
    const digest = await crypto.subtle.digest('SHA-256', buf)
    const hash = Array.from(new Uint8Array(digest)).slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('')
    const r = el.getBoundingClientRect()
    return {
      src: img.src,
      hash,
      bytes: buf.byteLength,
      url: el.getAttribute('data-url') || '',
      x: Math.round(r.x),
      w: Math.round(r.width),
      vw: window.innerWidth,
    }
  })
}

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

  // 1. a page is on the stage
  await say('open example.com and show me')
  await page.waitForFunction(() => !!document.querySelector('[data-testid=sofia-window][data-kind=live] img'), { timeout: 90000 })
    .catch(() => {})
  const first = await picture()
  first ? ok('a live page is on the stage', `${first.bytes} bytes at ${first.x}`) : fail('a live page is on the stage', 'no window')

  // 2. her click changes what the window shows. The label is discovered, not
  // hardcoded: a gate that names a link which later changes its wording fails
  // for a reason that has nothing to do with the product.
  const label = first
    ? await page.evaluate(async (src) => {
        const sid = new URL(src).searchParams.get('sid')
        if (!sid)
          return ''
        const r = await fetch('/api/browse/act', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ sid, action: 'links' }),
        })
        const body = await r.json().catch(() => ({}))
        const link = (body.links || []).find(l => l.text && l.text.length < 40)
        return link ? link.text : ''
      }, first.src)
    : ''
  label ? ok('the page offers a link to click', label) : fail('the page offers a link to click', 'none found')

  if (first) {
    await say(`click the ${label} link`)
    await page.waitForTimeout(5000)
    const second = await picture()
    if (!second) {
      fail('her click changes the picture in the window', 'the window went away')
    }
    else {
      const moved = second.hash !== first.hash
      const advanced = second.src !== first.src
      moved && advanced
        ? ok('her click changes the picture in the window', `${first.hash} -> ${second.hash} · ${second.url}`)
        : fail('her click changes the picture in the window', `identical ${second.hash} · src advanced ${advanced}`)
    }
  }
  else {
    fail('her click changes the picture in the window', 'skipped, nothing to click')
  }

  // 3. the left half of the stage is usable
  await say('move the window to the left')
  await page.waitForTimeout(2500)
  const leftSide = await picture()
  leftSide && leftSide.x < leftSide.vw / 2
    ? ok('a window can sit on the left half', `x=${leftSide.x} of ${leftSide.vw}`)
    : fail('a window can sit on the left half', leftSide ? `x=${leftSide.x} of ${leftSide.vw}` : 'no window')

  // 4. and back to the right
  await say('move the window to the right')
  await page.waitForTimeout(2500)
  const rightSide = await picture()
  rightSide && rightSide.x > rightSide.vw / 2
    ? ok('and it can go back to the right', `x=${rightSide.x} of ${rightSide.vw}`)
    : fail('and it can go back to the right', rightSide ? `x=${rightSide.x} of ${rightSide.vw}` : 'no window')

  // 5. closing leaves the stage empty instead of reopening itself
  await say('close everything')
  await page.waitForTimeout(2500)
  const after = await page.evaluate(() => document.querySelectorAll('[data-testid=sofia-window]').length)
  after === 0 ? ok('closing does not reopen the page', '0 windows') : fail('closing does not reopen the page', `${after} left`)
}
finally {
  // Close FIRST, then print. The tally used to be printed before an awaited
  // `browser.close()`, so if that close hangs or the container is torn down while
  // it waits, the count is never written and the verifier says "did not report a
  // count" for a gate whose every assertion passed.
  await browser.close().catch(() => {})
  console.log(`\n${pass}/${total}`)
  // No process.exit(): it truncates stdout on a pipe, which is how this gate
  // once finished having printed a single line.
  process.exitCode = (pass === total && total > 0) ? 0 : 1
}
