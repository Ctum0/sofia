// windows-responsive-gate.mjs — a window she opens must fit the screen he is
// actually holding, and must never land on her when there is room beside her.
//
// Why this gate exists (measured, not theorised): `windows-gate.mjs` reads a
// 1440x900 viewport only, where the 620 px default clears her shoulder by
// 164 px. On the live build 2026-11-10 the same code at 1024x768 started the
// window at x=356 while her shoulder was 430 (74 px over her) and at 768x900
// at x=100 vs shoulder 576 (476 px over her) — a tablet or a landscape phone,
// where the dock does mount, so it is a real user path. At 390x844 nothing
// rendered at all, because the layer was mounted `v-if="!isMobile"`.
//
// The assertions are properties, never the numbers this build happens to
// produce: inside the viewport, at-or-right-of the shoulder when there is room,
// low enough to clear her head when there is not, and a close that works.
//
// Run inside sofia-qa:
//   docker exec -e BASE=https://sofia.ctum.org \
//     -e SOFIA_PASSWORD="$(cat secrets/sofia-password)" sofia-qa \
//     sh -c "cd /qa && node windows-responsive-gate.mjs"
import { chromium } from 'playwright'

/** Closes the browser, but never waits more than a few seconds for it. */
// A response already in flight when the browser closes rejects AFTER the tally has
// been printed, and Node's default handler turns that into a non-zero exit with a
// stack trace after the count. Report the count as the last word instead.
let tallied = false
process.on('unhandledRejection', (error) => {
  if (!tallied)
    step('gate', 'the gate ran without an unhandled rejection', false, String(error?.message || error).slice(0, 110))
})
process.on('uncaughtException', (error) => {
  if (!tallied)
    step('gate', 'the gate ran without an uncaught exception', false, String(error?.message || error).slice(0, 110))
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
const PASSWORD = process.env.SOFIA_PASSWORD || ''
const SHOT_DIR = process.env.SHOT_DIR || '/qa'
const VIEWPORTS = [
  { name: 'desktop-1440', width: 1440, height: 900 },
  { name: 'laptop-1280', width: 1280, height: 800 },
  { name: 'tablet-1024', width: 1024, height: 768 },
  { name: 'narrow-768', width: 768, height: 900 },
  { name: 'phone-390', width: 390, height: 844 },
]
// A window narrower than this is a caption, not a window: below it the layout
// must stop squeezing her and go low and wide instead.
const MIN_BESIDE = 360

const results = []
const step = (vp, n, ok, d = '') => {
  results.push({ vp, n, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${vp.padEnd(13)} ${n}${d ? ` — ${d}` : ''}`)
}

const browser = await chromium.launch({
  args: ['--no-sandbox', '--autoplay-policy=user-gesture-required',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
})

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({
    permissions: ['microphone'],
    viewport: { width: vp.width, height: vp.height },
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(String(e).slice(0, 120)))
  try {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    const f = await page.$('input[type=password]')
    if (f) {
      await f.fill(PASSWORD)
      await page.click('button[type=submit], button')
      await page.waitForLoadState('domcontentloaded')
    }
    await page.waitForSelector('textarea, [placeholder*="Say something"]', { timeout: 120000 })
    // The splash is fixed and z-index 10000 for ~13 s; measuring under it is fine,
    // clicking through it is not.
    await page.waitForSelector('section.startup-screen', { state: 'detached', timeout: 90000 })

    const opened = await page.evaluate(() => {
      const entry = window.__sofiaPanel
      if (typeof entry !== 'function')
        return false
      entry({ kind: 'image', url: '/og.png', title: 'Sofia' })
      return true
    })
    step(vp.name, 'the stage exposes a window entry point', opened)

    // The column narrows on a 0.45 s transition that starts with the window. On a
    // cold page the main thread is still loading chunks, so a fixed 600 ms wait
    // measured the PRE-narrow column (1440 wide at desktop → shoulder 1080) and
    // then judged a window that was correctly placed beside a 605 px shoulder as
    // "no room beside her". Settle on the real width, bounded, then measure —
    // and keep the samples so a stale read can never hide again.
    const colW = () => page.evaluate(() => {
      const c = document.querySelector('.stage-column')
      return c ? Math.round(c.getBoundingClientRect().width) : null
    })
    const samples = []
    for (let i = 0; i < 34; i++) {
      samples.push(await colW())
      const n = samples.length
      if (n >= 3 && samples[n - 1] === samples[n - 2] && samples[n - 2] === samples[n - 3])
        break
      await page.waitForTimeout(150)
    }
    const m = await page.evaluate(() => {
      const col = document.querySelector('.stage-column')
      const cb = col ? col.getBoundingClientRect() : null
      const wins = [...document.querySelectorAll('[data-testid=sofia-window]')].map((w) => {
        const r = w.getBoundingClientRect()
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
      })
      return {
        vw: innerWidth,
        vh: innerHeight,
        col: cb ? { x: Math.round(cb.x), w: Math.round(cb.width) } : null,
        wins,
      }
    })

    const shoulder = m.col ? Math.round(m.col.x + 0.75 * m.col.w) : Math.round(m.vw * 0.42)
    const beside = m.vw - shoulder - 48 >= MIN_BESIDE
    const w0 = m.wins[0]

    step(vp.name, 'a window renders', m.wins.length === 1, m.wins.length === 1
      ? `${w0.x},${w0.y} ${w0.w}x${w0.h}  viewport ${m.vw}x${m.vh}  shoulder ${shoulder}  colW ${samples.join('→')}  mode ${beside ? 'beside' : 'low'}`
      : `rendered ${m.wins.length}`)

    if (w0) {
      step(vp.name, 'it is fully inside the viewport',
        w0.x >= 0 && w0.y >= 0 && w0.x + w0.w <= m.vw && w0.y + w0.h <= m.vh,
        `right ${w0.x + w0.w}<=${m.vw}  bottom ${w0.y + w0.h}<=${m.vh}`)

      if (beside) {
        step(vp.name, 'it starts at or right of her shoulder', w0.x >= shoulder, `${w0.x} >= ${shoulder}`)
      }
      else {
        step(vp.name, 'with no room beside her it stays low and wide',
          w0.y >= Math.round(m.vh * 0.42) - 2 && w0.w >= m.vw - 49,
          `y ${w0.y} >= ${Math.round(m.vh * 0.42)}  w ${w0.w} >= ${m.vw - 49}`)
      }

      // A window that cannot be closed is a trap on a small screen.
      await page.click('[data-testid=sofia-window-close]')
      await page.waitForTimeout(300)
      const after = await page.evaluate(() => document.querySelectorAll('[data-testid=sofia-window]').length)
      step(vp.name, 'its close button removes it', after === 0, `windows after close: ${after}`)
    }

    if (vp.name === 'narrow-768' || vp.name === 'phone-390') {
      await page.evaluate(() => window.__sofiaPanel?.({ kind: 'image', url: '/og.png', title: 'Sofia' }))
      await page.waitForTimeout(400)
      const p = `${SHOT_DIR}/windows-${vp.name}.png`
      await page.screenshot({ path: p, fullPage: false })
      console.log(`      shot: ${p}`)
    }
  }
  catch (e) {
    step(vp.name, 'run completed', false, String(e).slice(0, 200))
  }
  await ctx.close()
}

await closeBrowserQuietly(browser)
const failed = results.filter(r => !r.ok)
// Printed after the close, not before: a tally written before an awaited close
// can be lost if the close hangs. See frame-gate.mjs.
tallied = true
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
// `exitCode`, not `exit`: stdout is a pipe in the release run, and exiting
// immediately after printing the tally can drop it (measured: 641 of 4000 lines
// and the final count lost). See text-panel-gate.mjs.
if (failed.length)
  console.log('FAILED:', failed.map(f => `${f.vp}: ${f.n}`).join(' | '))
else
  console.log('ALL PASS')
process.exitCode = failed.length ? 1 : 0
