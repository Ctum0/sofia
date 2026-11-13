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
    // Her card, exactly as the dock hands it over: the persona must be the one
    // the text lane uses, or voice and text are two different people.
    const v = new SofiaVoice({
      // The card the stage would send. Fetch it the same way the dock does, so a
      // voice turn is answered by the personality the text lane uses.
      persona: (() => {
        try {
          const raw = localStorage.getItem('airi-cards')
          const parsed = raw ? JSON.parse(raw) : null
          const first = parsed && (Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0])
          const card = first?.card || first || {}
          return [card.systemPrompt, card.description, card.personality, card.scenario]
            .filter(p => typeof p === 'string' && p.trim()).join('\n')
        }
        catch { return '' }
      })(),
      onEvent: (e) => {
        // `state` and `dir` are what make event ORDER meaningful: a tool's
        // started/done pair and whose transcript it is.
        window.__vEvents.push({
          type: e.type,
          state: e.state || null,
          dir: e.dir || null,
          name: e.name || null,
          kind: e.kind || null,
          url: e.url || null,
          result: e.result || null,
          // The persona identity arrives on `ready`; without these two it reads
          // as 0 chars and the proof of whose words reached the session is gone.
          instructionChars: e.instructionChars || 0,
          instructionHead: e.instructionHead || '',
        })
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

  // Whose words reached the session. A behavioural probe ("ask her something only
  // the card would make her say") cannot be a gate — it waits on a model reply and
  // flakes — so this reads the deterministic fact the bridge reports at setup:
  // how long the instruction was, and how it begins. The rules alone are ~1.6 k
  // chars; a card on top is longer, and the head must contain a phrase from it.
  const readyInfo = await page.evaluate(() => {
    const evt = (window.__vEvents || []).find(e => e.type === 'ready')
    return evt ? { chars: evt.instructionChars || 0, head: evt.instructionHead || '' } : null
  }).catch(() => null)
  if (!readyInfo) {
    fail('the session was built with her card, not the rules alone', 'no ready event carried the instruction')
  }
  else {
    // The default persona now lives in base.yaml; its first line is distinctive.
    const cardLoaded = readyInfo.chars > 2500 && /Sithum|assistant|calm, quick/i.test(readyInfo.head)
    cardLoaded
      ? ok('the session was built with her card, not the rules alone', `${readyInfo.chars} chars: ${readyInfo.head.slice(0, 50)}`)
      : fail('the session was built with her card, not the rules alone', `${readyInfo.chars} chars: ${readyInfo.head.slice(0, 70)}`)
    // And it must not be the fork's stock VTuber text.
    const stock = /VTuber|15 years old|anime/i.test(readyInfo.head)
    stock
      ? fail('the instruction is not the stock VTuber card', readyInfo.head.slice(0, 70))
      : ok('the instruction is not the stock VTuber card', 'no VTuber wording in the head')
  }
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

  // 4. act while talking: the call is announced before it finishes.
  //
  // The failure this catches is silence. A tool that takes twenty seconds used
  // to leave twenty seconds of nothing, and the only evidence of that from
  // outside is the order of events: `started` must arrive, and the narration must
  // be spoken before `done`. Asserting the ORDER is the part that has teeth — a
  // session that says nothing and a session that answers late look identical if
  // you only check that a reply exists.
  await page.evaluate(() => { window.__vEvents.length = 0 })
  await ask('Open https://example.com now and tell me you are doing it as you do. Do not wait for it to finish before speaking.')
  let announced = false
  let announcedBeforeDone = false
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(1000)
    // Labels are `type` + optional `state` for tools, and `transcript:<dir>` for
    // speech. Both come from the same event stream, so the ORDER of the two is
    // the only thing that can prove she spoke while working.
    const seen = await page.evaluate(() => (window.__vEvents || []).map(e => {
      if (e.type === 'transcript')
        return `transcript:${e.dir || 'unknown'}`
      return e.state ? `${e.type}:${e.state}` : e.type
    }))
    const startedAt = seen.findIndex(label => label === 'tool:started')
    const doneAt = seen.findIndex(label => label === 'tool:done')
    // Any outgoing transcript before the tool finished is speech while working.
    const spokeEarly = seen.some((label, index) => label === 'transcript:out' && (doneAt === -1 || index < doneAt))
    if (startedAt !== -1)
      announced = true
    if (startedAt !== -1 && spokeEarly)
      announcedBeforeDone = true
    if (doneAt !== -1 && spokeEarly)
      break
    if (doneAt !== -1 && i > 6)
      break
  }
  announced
    ? ok('a slow tool announces itself before it finishes', 'started seen before done')
    : fail('a slow tool announces itself before it finishes', 'no started event')
  announcedBeforeDone
    ? ok('she speaks while the tool is still running', 'outgoing transcript before the tool finished')
    : fail('she speaks while the tool is still running', 'silence until the result')

  await page.evaluate(() => window.__pv?.stop?.()).catch(() => {})
}
catch (error) {
  fail('gate ran without throwing', String(error && error.message || error).slice(0, 160))
}
finally {
  log(`\n${pass}/${total}`)
  await browser.close()
  // `exitCode`, not `exit`: stdout is a pipe in the release run, and exiting
// immediately after printing the tally can drop it (measured: 641 of 4000
// lines and the final count lost). See text-panel-gate.mjs.
process.exitCode = pass === total && total >= 3 ? 0 : 1
}
