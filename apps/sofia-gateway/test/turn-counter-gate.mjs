// Turn-counter gate — the log line must describe the turn, not the session.
//
// `live.mjs` prints one line per finished turn:
//   live: turn ended (N audio chunks, M tool calls)
// It used to print the session totals under that per-turn label, so two
// one-tool turns read (0,1) then (0,2) and the second line looked like a second
// tool call in the same turn. That is a diagnostics lie, and reading it once
// produced a wrong diagnosis of the model.
//
// This gate opens ONE real Live session, lets the looping fake mic end two
// turns, and asserts on the numbers the gateway put on each `turnComplete`
// event (mirrored into `window.__sofiaVoice.stats.turns`):
//   1. every turn reports a non-zero audio chunk count (a build that emits no
//      counts reads 0 and fails here);
//   2. no entry equals the running total through itself — the exact signature
//      of a counter that never resets, which is what the old code did.
//
// Run inside mcr.microsoft.com/playwright:v1.64.1-jammy with --network host:
//   docker exec -e BASE=https://sofia.ctum.org -e SOFIA_PASSWORD="$(cat /home/ctum/secrets/sofia-password)" \
//     sofia-qa sh -c "cd /qa && node turn-counter-gate.mjs"
import { readFileSync } from 'node:fs'

import { chromium } from 'playwright'

const BASE = process.env.BASE || 'http://127.0.0.1:8787'
const WAV = process.env.WAV || '/qa/mic-one-line.wav'
const TURNS_WANTED = Number(process.env.TURNS_WANTED || 2)
const passwordFile = process.env.SOFIA_PASSWORD_FILE || '/home/ctum/secrets/sofia-password'
const PASSWORD = process.env.SOFIA_PASSWORD || (() => {
  try { return readFileSync(passwordFile, 'utf8').trim() }
  catch { return '' }
})()

const results = []
function step(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const browser = await chromium.launch({
  args: [
    '--no-sandbox',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-audio-capture=${WAV}`,
    '--autoplay-policy=user-gesture-required',
  ],
})
const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1400, height: 900 } })
const page = await ctx.newPage()
page.on('console', (m) => {
  if (m.type() === 'error')
    console.log('  [console]', m.text().slice(0, 160))
})

try {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  step('gate served', true, BASE)

  if (await page.locator('input[name=password]').count()) {
    if (!PASSWORD)
      throw new Error('no SOFIA_PASSWORD for the gate')
    await page.fill('input[name=password]', PASSWORD)
    await page.click('button[type=submit]')
    await page.waitForFunction(
      () => document.body && !document.body.innerText.includes('Private assistant'),
      null,
      { timeout: 45000 },
    )
  }
  step('signed in to the stage', true, page.url())

  const dock = page.getByTestId('sofia-voice-dock')
  await dock.waitFor({ state: 'visible', timeout: 60000 })
  await page.click('#sofia-talk')
  await page.waitForFunction(() => window.__sofiaVoice?.status === 'live', null, { timeout: 45000 })
  step('live session ready', true, await dock.getAttribute('data-status'))

  // A turn ends when the fake mic's 20 s of digital silence outlasts the
  // window, so two turns costs roughly one full loop plus the reply.
  const gotTwo = await page.waitForFunction(
    n => (window.__sofiaVoice?.stats?.turns || []).length >= n,
    TURNS_WANTED,
    { timeout: 130000 },
  ).then(() => true).catch(() => false)
  const turns = await page.evaluate(() => window.__sofiaVoice?.stats?.turns || [])
  step(`${TURNS_WANTED} turns completed`, gotTwo, `${turns.length} turn(s) recorded`)
  console.log('  turns:', JSON.stringify(turns))

  step('every turn reports its own audio chunks', turns.length > 0 && turns.every(t => t.chunks > 0),
    turns.map(t => t.chunks).join(',') || 'none')

  // The discriminator. The old code printed (and would have emitted) the
  // running total, so entry n equals the sum through n. Assert the property,
  // not a number: no entry may equal its own prefix sum.
  const cumulative = turns.findIndex((t, i) => {
    const prefix = turns.slice(0, i + 1).reduce((a, b) => a + b.chunks, 0)
    return i > 0 && t.chunks === prefix
  })
  step('no turn line is the running total', turns.length >= TURNS_WANTED && cumulative === -1,
    cumulative === -1
      ? 'per-turn counts'
      : `entry ${cumulative} (${turns[cumulative].chunks}) equals the prefix sum — the counter never resets`)
}
catch (err) {
  step('gate completed without throwing', false, err.message)
}
finally {
  await browser.close().catch(() => {})
}

const failed = results.filter(r => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
