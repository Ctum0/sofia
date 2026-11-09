// Hermes-as-hands gate: does the voice model actually CALL a tool, does the
// gateway execute it against real Hermes, and does she speak the real result?
//
// Run from apps/sofia-gateway so `ws` resolves:
//   BASE=http://127.0.0.1:8789 SOFIA_PASSWORD=$(cat ~/secrets/sofia-password) node test/tool-gate.mjs
//
// Exits non-zero on any of: no ready, no tool call, tool error, no spoken reply,
// or a reply that does not contain the value the tool actually produced.
//
// Why sequential steps instead of turn counting: the Live API emits
// `turnComplete` twice around a tool call (once when the model pauses to call,
// once when it has spoken the answer), so event-order assumptions make a passing
// run look like a failure.
import WsClient from 'ws'

const BASE = process.env.BASE || 'http://127.0.0.1:8789'
const PASSWORD = process.env.SOFIA_PASSWORD || ''
const WS_URL = BASE.replace(/^http/, 'ws') + '/api/live/stream'
const STEP_TIMEOUT_MS = Number(process.env.STEP_TIMEOUT_MS || 90_000)
const t0 = Date.now()
const el = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const TURNS = [
  {
    say: 'What time is it in Sri Lanka right now? Use your tool to check, do not guess.',
    expectTool: 'local_time',
    expectReply: /\d{1,2}[:.]\d{2}|\d{1,2} (am|pm|o'clock)/i,
  },
  {
    say: 'Ask Hermes to run the command hostname on the server, then tell me what it printed.',
    expectTool: 'ask_hermes',
    expectReply: /vmi|hour|minute|six|eight|four|nine|seven|fifty/i,
  },
]

const stats = { ready: false, tools: [], replies: [], errors: [], audio: 0 }

function fail(why) {
  console.log('\n--- summary ---')
  console.log('ready:', stats.ready)
  console.log('tool events:', stats.tools.map(t => `${t.name}:${t.state}`).join(' ') || 'none')
  console.log('tool results:', stats.tools.filter(t => t.state === 'done').map(t => `${t.name} -> ${String(t.result).slice(0, 200)}`))
  console.log('spoken replies:', stats.replies)
  console.log('audio chunks:', stats.audio)
  console.log('errors:', stats.errors.length ? stats.errors : 'none')
  console.log(`result: FAIL — ${why}`)
  try { ws.close() } catch {}
  process.exit(1)
}

function pass(why) {
  console.log('\n--- summary ---')
  console.log('ready:', stats.ready)
  console.log('tool events:', stats.tools.map(t => `${t.name}:${t.state}`).join(' '))
  console.log('tool results:', stats.tools.filter(t => t.state === 'done').map(t => `${t.name} -> ${String(t.result).slice(0, 200)}`))
  console.log('spoken replies:', stats.replies)
  console.log('audio chunks:', stats.audio)
  console.log('errors:', stats.errors.length ? stats.errors : 'none')
  console.log(`result: PASS — ${why}`)
  try { ws.close() } catch {}
  process.exit(0)
}

async function login() {
  const res = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: PASSWORD }),
    redirect: 'manual',
  })
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0]
  if (!cookie || !cookie.includes('sofia_session=')) {
    console.error(`login failed: ${res.status} (${cookie || 'no cookie'})`)
    process.exit(1)
  }
  return cookie
}

/** Wait until `pred()` is true, polling the event log. */
async function until(label, pred) {
  const deadline = Date.now() + STEP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (pred()) return
    await sleep(100)
  }
  fail(`step timed out: ${label}`)
}

const cookie = await login()
console.log(`[${el()}] logged in`)

const ws = new WsClient(WS_URL, { headers: { cookie } })
let replyCursor = 0

ws.on('message', (raw) => {
  let msg
  try { msg = JSON.parse(raw.toString('utf8')) } catch { return }

  if (msg.type === 'ready') {
    stats.ready = true
    console.log(`[${el()}] live ready — ${msg.model}/${msg.voice}`)
    run().catch(e => fail(`unexpected ${e.message}`))
    return
  }
  if (msg.type === 'tool') {
    stats.tools.push(msg)
    if (msg.state === 'started') console.log(`[${el()}] TOOL CALL ${msg.name} args=${JSON.stringify(msg.args || {})}`)
    if (msg.state === 'running') console.log(`[${el()}]   running run=${msg.runId || '-'}`)
    if (msg.state === 'done') console.log(`[${el()}]   result: ${String(msg.result).slice(0, 220)}`)
    return
  }
  if (msg.type === 'transcript' && msg.dir === 'out') {
    stats.replies.push(msg.text)
    return
  }
  if (msg.type === 'audio') { stats.audio += 1; return }
  if (msg.type === 'error') {
    stats.errors.push(`${msg.code || ''} ${msg.message}`.slice(0, 250))
    fail(`live error: ${stats.errors.at(-1)}`)
  }
})

async function run() {
  for (const [i, turn] of TURNS.entries()) {
    const toolBefore = stats.tools.length
    const replyBefore = replyCursor
    const before = Date.now()
    console.log(`[${el()}] turn ${i + 1}: ${turn.say}`)
    ws.send(JSON.stringify({ type: 'text', text: turn.say }))

    await until('tool call', () => stats.tools.slice(toolBefore).some(t => t.state === 'started'))
    const call = stats.tools.slice(toolBefore).find(t => t.name === turn.expectTool && t.state === 'started')
    if (!call) fail(`turn ${i + 1}: model called something other than ${turn.expectTool}`)

    await until('tool result', () => stats.tools.slice(toolBefore).some(t => t.name === turn.expectTool && t.state === 'done'))
    const done = stats.tools.slice(toolBefore).find(t => t.name === turn.expectTool && t.state === 'done')
    if (done.ok === false) fail(`turn ${i + 1}: ${turn.expectTool} returned an error result`)
    console.log(`[${el()}] tool round trip ${((Date.now() - before) / 1000).toFixed(2)}s`)

    await until('spoken reply', () => stats.replies.slice(replyBefore).join(' ').trim().length > 0)
    await sleep(2500) // let the sentence land before judging it
    const reply = stats.replies.slice(replyBefore).join(' ').trim()
    console.log(`[${el()}] she said: "${reply}"`)
    if (!turn.expectReply.test(reply)) fail(`turn ${i + 1}: reply "${reply.slice(0, 160)}" does not contain the tool's result`)
    replyCursor = stats.replies.length
  }
  if (!stats.audio) fail('no audio arrived — she never spoke')
  pass(`${TURNS.length} tool turns, real results, spoken back with ${stats.audio} audio chunks`)
}

ws.on('close', (code) => { if (code !== 1000) console.log(`[${el()}] closed ${code}`) })
ws.on('error', (e) => fail(`socket error: ${e.message}`))
setTimeout(() => fail('overall timeout'), 240_000)
