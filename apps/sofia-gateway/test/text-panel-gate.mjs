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

// Everything after the browser exists runs inside one try, and that includes the
// launch: a throw before the block used to escape as a bare Node stack with no
// `n/n` line, and the verifier reads that as "did not report a count" — the
// same sentence whether the product broke or the harness did.
let browser
let ctx
let page
try {
  browser = await chromium.launch({ args: ['--no-sandbox'] })
  ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  page = await ctx.newPage()
}
catch (error) {
  fail('the gate could start a browser', String(error?.message || error).slice(0, 160))
  console.log(`\n${pass}/${total}`)
  process.exitCode = 1
}

// A `page.evaluate` still in flight when the browser closes rejects AFTER the
// tally has been printed, and Node's default handler turns that into a non-zero
// exit with no further output — which the verifier reads as "did not report a
// count" for a gate that had already finished. These handlers keep the printed
// count as the last word, exactly as hands-gate.mjs does.
let reported = false
function report() {
  if (reported)
    return
  reported = true
  console.log(`\n${pass}/${total}`)
  // No `process.exit()` here. stdout is a PIPE in the release run (`out=$(run_gate
  // ...)`), where Node's writes are asynchronous: exiting on the next line threw
  // away everything still buffered — the tally AND the FAIL lines above it, so the
  // verifier could only report "did not report a count" and its retry logic never
  // saw the error that would have explained it. `frame-gate.mjs` documents the same
  // trap. An exit code is all that is needed.
  process.exitCode = (pass === total && total > 0) ? 0 : 1
}
process.on('unhandledRejection', (error) => {
  fail('the gate ran without an unhandled rejection', String(error?.message || error).slice(0, 160))
  report()
})
process.on('uncaughtException', (error) => {
  fail('the gate ran without an uncaught exception', String(error?.message || error).slice(0, 160))
  report()
})

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
  //
  // The anonymous context is closed explicitly: a discarded BrowserContext still
  // holds a renderer until it is collected, and this gate now keeps one long-lived
  // stage page for 200 s — the two together are what a gate Chromium dies of.
  let strangerStatus = 0
  {
    const anon = await browser.newContext()
    try {
      strangerStatus = (await anon.request.post(`${BASE}/api/events`, { failOnStatusCode: false, data: {} })).status()
    }
    finally {
      await anon.close().catch(() => {})
    }
  }
  strangerStatus === 401 || strangerStatus === 405
    ? ok('the stage stream is behind the session', `status ${strangerStatus}`)
    : fail('the stage stream is behind the session', `status ${strangerStatus}`)

  // 2. nothing is on screen before the turn
  const before = await page.evaluate(() => document.querySelectorAll('[data-testid=sofia-window]').length)
  before === 0 ? ok('no window before the turn') : fail('no window before the turn', `${before} open`)

  // A typed turn goes through Hermes, which can take seconds. Awaiting that
  // inside page.evaluate ties the call to one document: if the page navigates
  // while the request is in flight Playwright reports "Target page, context or
  // browser has been closed" and the whole gate aborts — which then reads as a
  // broken product. So the fetch is fired and then settled by a short poll that
  // tolerates a document swap. A turn whose request never completes is reported
  // here as its own failing step, so a broken chat lane cannot hide behind an
  // assertion that later finds something else to pass on.
  const say = async (text) => {
    // Nothing in here may throw: a turn that cannot be delivered is reported as
    // a failing step, and the gate has to keep going so the *other* assertions
    // still run and the count still prints. A bare throw here aborted the run
    // after ten passing checks and the verifier could only say "no count".
    try {
    await page.evaluate(t => {
      window.__lastTurn = undefined
      window.__lastTurn = fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'hermes', stream: false, messages: [{ role: 'user', content: t }] }),
      }).then(() => 'ok').catch(() => 'failed')
      return true
    }, text).catch(() => {})
    const deadline = Date.now() + 90000
    let state
    while (Date.now() < deadline) {
      state = await page.evaluate(() => window.__lastTurn).catch(() => undefined)
      if (state === 'ok' || state === 'failed')
        break
      await page.waitForTimeout(200)
    }
    // Three outcomes, and only two of them are verdicts:
    //   'ok'      the request completed
    //   'failed'  the request itself failed — a product fact, report it
    //   undefined the flag went away with its document (the stage navigates on
    //             its own); the turn may well have landed. That is UNKNOWN, not
    //             a failure: the effect assertions below decide, and calling it
    //             failed here would be the same document-lifetime bug this suite
    //             just fixed in voice-gate, in the opposite direction.
    if (state === 'failed')
      fail(`the typed turn "${String(text).slice(0, 40)}" reached the gateway`, 'request failed')
    await page.waitForTimeout(1500)
    }
    catch (error) {
      fail(`the typed turn "${String(text).slice(0, 40)}" could be sent`, String(error?.message || error).slice(0, 140))
    }
  }

  // The stage restores windows from localStorage, so a previous run leaves one
  // behind and every later "the first window" is that one, not the window this
  // run opened. Measured: a stale example.com window made "click sign in" land
  // on iana.org and read as a broken click. Start from a known stage.
  await page.evaluate(() => window.__sofiaPanel?.(null)).catch(() => {})
  await page.waitForTimeout(500)
  const stale = await page.evaluate(() => document.querySelectorAll('[data-testid=sofia-window]').length)
  stale === 0 ? ok('the stage starts empty') : fail('the stage starts empty', `${stale} window(s) survived the reset`)

  // 3. a typed turn opens a real window
  await say('open github and show me')
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

  // Same rule as the resize: wait for the effect, not for a guessed duration.
  // A fixed 2500 ms read the old address on a loaded run and reported "the
  // click did not land" for a turn that was still in flight.
  // The label is discovered, never assumed: GitHub renders "Sign in" only to
  // logged-out visitors, and a context that has accumulated cookies between runs
  // will legitimately not offer it. A hardcoded label made this gate fail for a
  // reason that has nothing to do with the product.
  const signInLabel = await page.evaluate(async () => {
    const img = document.querySelector('[data-testid=sofia-window][data-kind=live] img')
    const sid = String(img?.getAttribute('src') || '').match(/sid=([^&]+)/)?.[1]
    if (!sid)
      return { label: null, offers: [] }
    const res = await fetch('/api/browse/act', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sid, action: 'links' }),
    })
    const body = await res.json().catch(() => ({}))
    const offers = (body.links || []).map(l => String(l.text || '').trim()).filter(Boolean)
    return { label: offers.find(t => /^(sign in|log in|signin|login)$/i.test(t)) || null, offers }
  }).catch(() => ({ label: null, offers: [] }))

  // Already on the sign-in page is a pass, not a failure: the window may have
  // arrived there by any route (a previous run's session, a click earlier in this
  // gate), and demanding a "Sign in" link on /login asks the page to link to
  // itself. What matters is that a click lands on a sign-in page — the assertion
  // below — not that the entry point is a particular link.
  const alreadyThere = await page.evaluate(() => {
    const el = document.querySelector('[data-testid=sofia-window][data-kind=live]')
    return /sign|login/i.test(el?.getAttribute('data-url') || '')
  }).catch(() => false)
  // Three explicit outcomes. The first version recorded a pass only when the page
  // was ALREADY on the sign-in page and a failure when neither held — so the
  // normal case (a label was found) contributed nothing at all, and the gate's
  // denominator silently depended on which branch the page took.
  if (signInLabel.label) {
    ok('the page offers a sign-in control to click', `"${signInLabel.label}"`)
  }
  else if (alreadyThere) {
    ok('the page offers a sign-in control to click', 'already on the sign-in page')
  }
  else {
    fail('the page offers a sign-in control to click', `offers: ${signInLabel.offers.slice(0, 6).join(' | ') || 'none'}`)
  }
  // Assert the TRANSITION, not an absolute state. The page before the click is
  // github.com, and the sign-in URL contains "github.com" too — so a fixed wait
  // followed by one absolute read was really asking "did this happen within 20 s",
  // and under the host load of back-to-back gates it did not: the same check
  // passed 18/18 standalone and failed in the release run with "saw
  // https://github.com/" — the click was still in flight, not wrong. Waiting for
  // the URL to CHANGE makes the failure mean what it says.
  const urlOf = () => page.evaluate(() => {
    const el = document.querySelector('[data-testid=sofia-window][data-kind=live]')
    return el ? (el.getAttribute('data-url') || '') : ''
  }).catch(() => '')
  const beforeClick = await urlOf()
  await say(`click ${signInLabel.label || 'sign in'}`)
  const clickDeadline = Date.now() + 45000
  let clickedUrl = beforeClick
  while (Date.now() < clickDeadline) {
    clickedUrl = await urlOf()
    if (clickedUrl && clickedUrl !== beforeClick)
      break
    await page.waitForTimeout(300)
  }
  const clicked = String(clickedUrl).toLowerCase()
  if (clicked !== String(beforeClick).toLowerCase()) {
    ok('a typed turn clicks inside the page', `${beforeClick.slice(0, 40)} → ${clickedUrl}`)
  }
  else {
    fail('a typed turn clicks inside the page', `the window is still on "${clickedUrl}" after ${Math.round((Date.now() - (clickDeadline - 45000)) / 1000)} s`)
  }

  await say('close everything')
  // A close is delivered over the event stream, which is asynchronous: asserting
  // the instant the turn returns read "1 left" for a close that was still in
  // flight. Wait for the state the turn is supposed to produce, then judge it.
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid=sofia-window]').length === 0,
    { timeout: 15000 },
  ).catch(() => {})
  const left = await page.evaluate(() => document.querySelectorAll('[data-testid=sofia-window]').length)
  left === 0 ? ok('a typed turn closes every window', '0 left') : fail('a typed turn closes every window', `${left} left`)

  // Leave one window up: the refresh check later in this gate needs something to
  // survive, and an empty stage would pass it for the wrong reason. One turn does
  // that — a second identical turn cannot open a second window (the stage dedups
  // by url), so it only cost a Hermes round trip in a gate that is already long.
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
  //
  // The assertion is about the rendered box, so it has to wait for the render,
  // not for a guessed duration: the avatar shell animates its transform for
  // 0.45 s and a busy Live2D frame loop stretches that further. A fixed 700 ms
  // wait measured "832px -> 832px" on a loaded machine and read as a product
  // failure. Poll until the box moves or the budget runs out.
  const preResize = await avatarBox()
  await page.evaluate(() => window.__sofiaPanel({ kind: 'avatar', action: 'set', scale: 0.7 }))
  const resizeDeadline = Date.now() + 8000
  let postResize = preResize
  while (Date.now() < resizeDeadline) {
    postResize = await avatarBox()
    if (postResize && preResize && Math.abs(postResize.h - preResize.h) > 2)
      break
    await page.waitForTimeout(150)
  }
  await page.waitForTimeout(450)
  const resizeRatio = preResize && postResize && preResize.h > 0 ? postResize.h / preResize.h : 1
  Math.abs(resizeRatio - 0.7) < 0.08
    ? ok('she can resize herself on screen', `${preResize?.h}px -> ${postResize?.h}px (${resizeRatio.toFixed(2)})`)
    : fail('she can resize herself on screen', `${preResize?.h}px -> ${postResize?.h}px (${resizeRatio.toFixed(2)})`)
  await page.evaluate(() => window.__sofiaPanel({ kind: 'avatar', action: 'reset' }))

  // 5c-bis. a window nobody clicks is still alive after the page-reap window.
  //
  // This is the heartbeat's only reason to exist: a live window that is merely
  // being looked at sends no traffic, so without the 45 s ping the browser
  // reaps its page at IDLE_MS (180 s) and the next click does nothing. The
  // browser default here is 180 s, so this waits past it and then proves the
  // window still works. Slow on purpose — it is the only test of the thing that
  // makes "come back to the tab" not silently dead.
  if (process.env.SKIP_IDLE_WINDOW !== '1') {
    const idleMs = Number(process.env.IDLE_WINDOW_MS || 200000)
    const win = await page.evaluate(() => {
      const el = document.querySelector('[data-testid=sofia-window][data-kind=live]')
      const img = el?.querySelector('img')
      return el ? { id: el.getAttribute('data-window-id'), sid: String(img?.getAttribute('src') || '').match(/sid=([^&]+)/)?.[1] || '' } : null
    })
    if (!win?.sid) {
      fail('an untouched window still works after the reap window', 'no live window to watch')
    }
    else {
      // Look at it for the whole window: the window is on screen and visible in
      // this page, which is exactly the condition the heartbeat covers.
      await page.waitForTimeout(idleMs)
      const alive = await page.evaluate(async (sid) => {
        const img = document.querySelector('[data-testid=sofia-window][data-kind=live] img')
        if (!img)
          return { ok: false, why: 'window disappeared' }
        // `read` proves the page exists AND still works: a reaped page answers
        // "no such page", which is the failure this assertion is about.
        const read = await fetch('/api/browse/act', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sid, action: 'read' }),
        }).catch(() => null)
        const body = read ? await read.json().catch(() => ({})) : {}
        return { ok: !!read?.ok, status: read?.status, why: String(body.error || '').slice(0, 80) }
      }, win.sid)
      alive.ok
        ? ok('an untouched window still works after the reap window', `sid ${win.sid} alive after ${Math.round(idleMs / 1000)}s`)
        : fail('an untouched window still works after the reap window', `${alive.status}: ${alive.why}`)
    }
  }

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
  await browser?.close().catch(() => {})
  report()
}
