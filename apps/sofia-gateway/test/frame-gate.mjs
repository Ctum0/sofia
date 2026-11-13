// The window must show the page moving. Until now every gate asserted the URL
// the service returned — which is a fact about the server, not about what a
// human sees. This gate hashes the pixels the window puts on the screen before
// and after she clicks, and fails if they are identical.
import { chromium } from 'playwright'

/** Closes the browser, but never waits more than a few seconds for it. */
// A response already in flight when the browser closes rejects AFTER the tally has
// been printed, and Node's default handler turns that into a non-zero exit with a
// stack trace after the count — the verifier then reports "did not report a count"
// for a gate that finished. These handlers keep the printed count as the last word,
// and still FAIL loudly if the throw happened BEFORE the tally, which is a real
// error rather than teardown noise.
// `fail(...)`, not `console.log`: only `fail` increments `total`, so a bare log
// leaves `pass === total` true and `finally` still exits 0 — a false green with a
// FAIL line above it. This is the subtle half of the bug that made a truncated run
// look like a pass.
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
const ok = (n, d = '') => { total++; pass++; console.log(`PASS  ${n}${d ? ` — ${d}` : ''}`) }
const fail = (n, d = '') => { total++; console.log(`FAIL  ${n}${d ? ` — ${d}` : ''}`) }

// The assertions this gate is defined to run. Without it, an abort mid-run reports
// a SHORTER tally that still reads `pass === total` — a false green. The guards
// below stop the process dying with a stack trace after the tally, which is what
// made an early abort look like a crash instead of a truncated gate; this constant
// is what makes the truncation visible.
const EXPECTED = 6
let completed = false

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
  //
  // Every read here tolerates the document going away. The turn closes every
  // window on the stage, and the page that reports the result can be re-rendered
  // under it; an `evaluate` that throws took the whole gate down at this exact
  // assertion twice, and the count afterwards read "5/6" for a behaviour that
  // worked.
  await say('close everything')
  await page.waitForTimeout(3000)
  let after = null
  for (let attempt = 0; attempt < 6 && after !== 0; attempt += 1) {
    after = await page.evaluate(() => document.querySelectorAll('[data-testid=sofia-window]').length)
      .catch(() => null)
    if (after !== 0)
      await page.waitForTimeout(700).catch(() => {})
  }
  after === 0 ? ok('closing does not reopen the page', '0 windows') : fail('closing does not reopen the page', after === null ? 'the stage became unreachable' : `${after} left`)

  completed = true
}
catch (error) {
  // An abort is a FAIL, not a short successful run.
  fail('the gate ran to completion', String(error?.message || error).slice(0, 110))
}
finally {
  // Close FIRST, then print. The tally used to be printed before an awaited
  // `browser.close()`, so if that close hangs or the container is torn down while
  // it waits, the count is never written and the verifier says "did not report a
  // count" for a gate whose every assertion passed.
  await closeBrowserQuietly(browser)
  tallied = true
  console.log(`\n${pass}/${total}`)
  // Three ways to be red, and only one of them is an assertion that failed:
  // a skipped assertion (total < EXPECTED) and an aborted run (completed false)
  // are just as red, because both mean the gate checked less than it claims.
  // Only when the abort was not already recorded by the `catch` above, which
  // already called `fail(...)` and counted itself. Two FAIL lines for one abort
  // makes the numerator and the denominator both wrong.
  if (!completed && pass === total)
    fail('the gate ran every assertion', `it stopped after ${total} of ${EXPECTED}`)
  process.exitCode = (pass === total && total === EXPECTED && completed) ? 0 : 1
}
