// proactive-gate.mjs — does she actually speak first?
//
// The claim is the product's tagline, so it gets a gate that starts where a
// person starts: the password gate, a real stage, and an empty conversation.
// What it proves, in order:
//   1. the gateway's clock can fire a slot and hold it as pending;
//   2. a page that opens later collects it and sends it through the chat
//      pipeline's notice path;
//   3. her line lands in the stored conversation, not just in a console log —
//      the marker prints her actual reply and the DOM is asserted to contain it;
//   4. she acknowledges, so the queue empties and the same line cannot arrive
//      twice.
//
// Run inside the Playwright container (it needs a browser, unlike the
// dependency-free gates):
//   docker exec -e SOFIA_PASSWORD=... -e BASE=https://sofia.ctum.org -w /qa sofia-qa node proactive-gate.mjs
import { chromium } from 'playwright'

const BASE = process.env.BASE || 'https://sofia.ctum.org'
const PASSWORD = process.env.SOFIA_PASSWORD || process.env.PASSWORD || ''
const SLOT = process.env.SLOT || '07:00'
const DELIVER_TIMEOUT = Number(process.env.DELIVER_TIMEOUT_MS || 150_000)

const results = []
function step(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

if (!PASSWORD) {
  console.log('no SOFIA_PASSWORD')
  process.exit(2)
}

const browser = await chromium.launch({ args: ['--no-sandbox'] })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()

const sofiaLog = []
let deliveredLine = ''
page.on('console', (message) => {
  const text = message.text()
  if (!text.includes('[sofia] proactive'))
    return
  sofiaLog.push(text.slice(0, 200))
  console.log('  page>', text.slice(0, 200))
  const match = text.match(/delivered: (.+)$/)
  if (match)
    deliveredLine = match[1]
})

const api = (path, init) => page.evaluate(async ([p, i]) => {
  const res = await fetch(p, i || undefined)
  const body = await res.text()
  let json = null
  try { json = JSON.parse(body) } catch {}
  return { status: res.status, json, body: body.slice(0, 300) }
}, [path, init || null])

try {
  // --- a person's path in ---------------------------------------------------
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.fill('input[name=password]', PASSWORD)
  await page.click('button[type=submit]')
  await page.waitForFunction(
    () => document.body && !document.body.innerText.includes('Private assistant'),
    null,
    { timeout: 45_000 },
  )
  step('signed in through the password form', true)

  await page.waitForFunction(() => !!document.querySelector('textarea'), null, { timeout: 45_000 })
  step('stage is up', true)

  // --- 1. the clock can fire a slot ----------------------------------------
  const fired = await api('/api/proactive/fire', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slot: SLOT }),
  })
  const id = fired.json?.item?.id || ''
  step('a slot can be fired', fired.status === 200 && !!id, `id=${id} slot=${SLOT}`)

  // --- 2. it is held for a page that opens later ----------------------------
  const pending = await api('/api/proactive/pending')
  const held = (pending.json?.items || []).some(item => item.id === id)
  step('the slot waits for a page', held, `pending=${(pending.json?.items || []).length}`)
  const clock = pending.json?.status || {}
  step('the clock reports its slots', Array.isArray(clock.slots) && clock.slots.length > 0,
    `slots=${(clock.slots || []).join(',')} tz=${clock.timezone} now=${clock.now}`)

  // --- 3. a load collects it and she speaks --------------------------------
  // A reload is the honest case: the slot fired while nothing was watching.
  await page.reload({ waitUntil: 'domcontentloaded' })
  const started = Date.now()
  while (!deliveredLine && Date.now() - started < DELIVER_TIMEOUT)
    await page.waitForTimeout(1000)

  step('she speaks without being asked', !!deliveredLine, deliveredLine ? `${((Date.now() - started) / 1000).toFixed(1)}s` : `after ${DELIVER_TIMEOUT / 1000}s`)
  if (deliveredLine)
    console.log(`  her line: ${deliveredLine}`)

  // --- 4. it is in the conversation, not only in a log ---------------------
  // The marker carries her real reply, so the DOM must contain its opening.
  const needle = deliveredLine.slice(0, 24).trim()
  const inDom = needle.length > 8
    ? await page.evaluate(text => document.body.innerText.includes(text), needle)
    : false
  step('her line is in the conversation on screen', inDom, `"${needle}…"`)

  // --- 5. acknowledged, so it cannot arrive twice --------------------------
  const afterPending = await api('/api/proactive/pending')
  const stillThere = (afterPending.json?.items || []).some(item => item.id === id)
  step('the slot is acknowledged', !stillThere, `pending=${(afterPending.json?.items || []).length}`)

  await page.screenshot({ path: '/qa/proactive.png' })
  console.log('  screenshot: /qa/proactive.png')
}
catch (error) {
  step('gate ran to completion', false, String(error?.message || error).slice(0, 200))
}
finally {
  await browser.close().catch(() => {})
}

const passed = results.filter(r => r.ok).length
console.log(`\n${passed}/${results.length} ${passed === results.length ? 'PASS' : 'FAIL'} — proactive`)
process.exit(passed === results.length ? 0 : 1)
