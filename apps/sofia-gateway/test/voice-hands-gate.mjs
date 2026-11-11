// voice-hands-gate.mjs — the half the other gates never touched: can the MODEL,
// over a real Live session, drive the tools that move her body and the page?
// windows-gate proves the browser renders; text-panel-gate proves a typed turn
// can drive it. Neither proves voice can, so "she cannot resize herself" could
// come back without a red gate. This one asks her, in a session, to call
// control_avatar, show_panel and browse, and measures the stage.
import { chromium } from 'playwright'

const BASE = process.env.BASE || 'https://sofia.ctum.org'
const PASSWORD = process.env.SOFIA_PASSWORD || ''
const log = (...a) => console.log(...a)

let pass = 0
let total = 0
const ok = (n, d = '') => { total++; pass++; log(`PASS  ${n}${d ? ` — ${d}` : ''}`) }
const fail = (n, d = '') => { total++; log(`FAIL  ${n}${d ? ` — ${d}` : ''}`) }

const browser = await chromium.launch({
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
})
const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
page.on('console', m => { const t = m.text(); if (t.includes('[sofia]')) log('  page>', t.slice(0, 150)) })

const ask = async (text) => {
  await page.evaluate(t => window.__pv?.sendText(t), text)
}

try {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  const f = await page.$('input[type=password]')
  if (f) {
    await f.fill(PASSWORD)
    await page.click('button[type=submit], button')
    await page.waitForLoadState('domcontentloaded')
  }
  await page.waitForSelector('[data-testid=sofia-voice-dock]', { timeout: 120000, state: 'visible' })

  const started = await page.evaluate(async () => {
    window.__vEvents = []
    const { SofiaVoice } = await import('/public/voice-client.mjs')
    const v = new SofiaVoice({
      onEvent: (e) => {
        window.__vEvents.push({ type: e.type, name: e.name || null, kind: e.kind || null, url: e.url || null, result: e.result || null })
        if (e.type === 'panel')
          window.dispatchEvent(new CustomEvent('sofia:panel', { detail: e }))
      },
    })
    window.__pv = v
    await v.connect()
    await v.startMic()
    await new Promise(r => setTimeout(r, 1500))
    return { ready: v.ready }
  })
  log(`session ready=${started.ready}`)
  started.ready ? ok('a real Live session opened') : fail('a real Live session opened')
  if (!started.ready) {
    log('\n0/1')
    await browser.close()
    process.exit(1)
  }

  const avatarBox = () => page.evaluate(() => {
    const el = document.querySelector('.avatar-shell') || document.querySelector('canvas')
    if (!el)
      return null
    const r = el.getBoundingClientRect()
    const t = getComputedStyle(el).transform
    return { h: Math.round(r.height), t }
  })

  const before = await avatarBox()

  // 1. her own body, by voice
  await ask('Call control_avatar now with action set and scale 0.65. Do not speak, just call the tool.')
  let shrank = null
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1000)
    const now = await avatarBox()
    if (before && now && now.h > 0 && now.h < before.h * 0.85) {
      shrank = now
      break
    }
  }
  shrank
    ? ok('by voice, she can make herself smaller', `${before.h}px -> ${shrank.h}px`)
    : fail('by voice, she can make herself smaller', `${before?.h}px -> ${(await avatarBox())?.h}px`)

  // 2. a page, by voice
  await ask('Call show_panel now with kind live and url https://example.com. Do not speak, just call the tool.')
  let win = null
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(1000)
    win = await page.evaluate(() => {
      const el = document.querySelector('[data-testid=sofia-window]')
      if (!el)
        return null
      const r = el.getBoundingClientRect()
      return { kind: el.getAttribute('data-kind'), url: el.getAttribute('data-url') || '', w: Math.round(r.width) }
    })
    if (win)
      break
  }
  win && win.w > 0 ? ok('by voice, she can open a real page', `${win.kind} ${win.url}`) : fail('by voice, she can open a real page', 'no window')

  // 3. an action inside it, by voice
  await ask('Call browse now with action read. Do not speak, just call the tool.')
  let read = null
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1000)
    read = await page.evaluate(() => {
      const done = (window.__vEvents || []).filter(e => e.type === 'tool' && e.name === 'browse')
      return done.length ? String(done.at(-1).result || '') : null
    })
    if (read)
      break
  }
  read && /example|documentation|domain/i.test(read)
    ? ok('by voice, she can read the page she opened', read.slice(0, 70))
    : fail('by voice, she can read the page she opened', String(read).slice(0, 90))

  await page.evaluate(() => window.__pv?.stop?.()).catch(() => {})
}
catch (error) {
  fail('gate ran without throwing', String(error && error.message || error).slice(0, 160))
}
finally {
  log(`\n${pass}/${total}`)
  await browser.close()
  process.exit(pass === total && total >= 3 ? 0 : 1)
}
