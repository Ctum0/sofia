/**
 * Proves the agent drives a real browser, end to end, with no gateway involved.
 *
 * The guardrail test covers what the agent REFUSES. This one covers what it
 * DOES: a local WebSocket server plays the gateway's part, sends real `call`
 * messages, and the agent answers from a real Chromium. Without it, the agent
 * could be "secure" simply by not working.
 *
 * Run: `node test/browser.test.mjs`
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// `ws` is not a root dependency; it is what the gateway itself uses, and it lives
// in the pnpm store. Resolved explicitly rather than added to the agent, which
// must stay installable on a laptop with a single dependency.
const require = createRequire(import.meta.url)
const wsPath = require.resolve('ws', { paths: [new URL('../../sofia-gateway', import.meta.url).pathname] })
//  is CommonJS: the server constructor is a property of the module object,
// not a named ESM export.
const wsModule = require(wsPath)
const WebSocketServer = wsModule.WebSocketServer

const AGENT = fileURLToPath(new URL('../sofia-agent.mjs', import.meta.url))
const TOKEN = 'test-token-local'

let pass = 0
let total = 0
const ok = (name, detail = '') => { total++; pass++; console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`) }
const fail = (name, detail = '') => { total++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }

// A gateway stand-in. The agent dials out to it, exactly as it will in production.
const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
await new Promise(resolve => wss.once('listening', resolve))
const port = wss.address().port

const agent = spawn(process.execPath, [AGENT, '--gateway', `ws://127.0.0.1:${port}/`, '--token', TOKEN], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, SOFIA_AGENT_HEADLESS: '1' },
})
let agentLog = ''
agent.stdout.on('data', (chunk) => { agentLog += String(chunk) })
agent.stderr.on('data', (chunk) => { agentLog += String(chunk) })

const connection = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`the agent never connected. Log:\n${agentLog}`)), 20000)
  wss.once('connection', (socket) => { clearTimeout(timer); resolve(socket) })
})

// The agent announces itself first; the harness accepts whatever it sends.
await new Promise((resolve) => {
  connection.once('message', (raw) => {
    try {
      const hello = JSON.parse(String(raw))
      hello.token === TOKEN
        ? ok('the agent introduces itself with its token', `version ${hello.version}`)
        : fail('the agent introduces itself with its token', String(raw).slice(0, 60))
    }
    catch {
      fail('the agent introduces itself with its token', String(raw).slice(0, 60))
    }
    resolve()
  })
})

let nextId = 0
const call = (body) => new Promise((resolve, reject) => {
  const id = String(++nextId)
  const timer = setTimeout(() => reject(new Error(`call ${body.action} timed out`)), 60000)
  const onMessage = (raw) => {
    let msg
    try {
      msg = JSON.parse(String(raw))
    }
    catch {
      return
    }
    if (msg.type !== 'result' || msg.id !== id)
      return
    clearTimeout(timer)
    connection.off('message', onMessage)
    msg.ok ? resolve(msg.result) : reject(new Error(msg.error))
  }
  connection.on('message', onMessage)
  connection.send(JSON.stringify({ type: 'call', id, ...body }))
})

// --- a real page ------------------------------------------------------------

let sid = ''
try {
  const opened = await call({ action: 'open', url: 'https://example.com' })
  sid = opened.sid
  ok('opens a real page in a real browser', `${opened.url} · ${opened.sid}`)

  // The frame is a JPEG now, not a PNG: the relay sends frames continuously and
  // PNG re-encoding per request was most of the bandwidth.
  const jpeg = Buffer.from(opened.jpeg || '', 'base64')
  jpeg.length > 2000 && jpeg[0] === 0xFF && jpeg[1] === 0xD8
    ? ok('the frame is a real JPEG', `${Math.round(jpeg.length / 1024)} KB`)
    : fail('the frame is a real JPEG', `${jpeg.length} bytes, first two ${jpeg[0]}, ${jpeg[1]}`)

  const read = await call({ action: 'read', sid })
  const describesExample = /documentation examples/i.test(read.text || '')
  describesExample
    ? ok('reads the page text', `${String(read.text).length} chars`)
    : fail('reads the page text', String(read.text || '').slice(0, 60))

  const links = await call({ action: 'links', sid })
  Array.isArray(links.links) && links.links.length > 0
    ? ok('lists the page links', `${links.links.length} links`)
    : fail('lists the page links', JSON.stringify(links.links || []).slice(0, 60))

  const clicked = await call({ action: 'clickText', sid, text: 'Learn more' })
  const landedOnIana = /iana\.org/.test(clicked.url || '')
  landedOnIana
    ? ok('clicks a link by its visible text', clicked.url)
    : fail('clicks a link by its visible text', clicked.url || 'no url')

  // The guardrail has to hold through the socket too, not just in a unit test.
  let refused = false
  try {
    await call({ action: 'goto', sid, text: 'http://169.254.169.254/latest/meta-data/' })
  }
  catch (error) {
    refused = /private address/i.test(String(error.message))
  }
  refused
    ? ok('refuses a private address over the socket', 'cloud metadata endpoint blocked')
    : fail('refuses a private address over the socket', 'the agent browsed it')

  let refusedVerb = false
  try {
    await call({ action: 'evaluate', sid, text: 'process.exit(0)' })
  }
  catch (error) {
    refusedVerb = /does not implement/i.test(String(error.message))
  }
  refusedVerb
    ? ok('refuses a verb it does not have', 'no arbitrary evaluation')
    : fail('refuses a verb it does not have', 'the agent ran it')
}
catch (error) {
  fail('the agent completed a real browser session', String(error.message).slice(0, 140))
}
finally {
  await call({ action: 'closeAll' }).catch(() => {})
  agent.kill('SIGTERM')
  wss.close()
}

if (agentLog.trim())
  console.log(`\n--- agent log ---\n${agentLog.trim().split('\n').slice(-6).join('\n')}`)

console.log(`\n${pass}/${total}`)
process.exit(pass === total ? 0 : 1)
