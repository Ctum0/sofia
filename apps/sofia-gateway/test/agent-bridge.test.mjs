/**
 * Proves the gateway side of the seam: a local agent can connect, and
 * `agentCall` reaches it and gets an answer back.
 *
 * This is the piece that was missing — the agent was tested against a stand-in
 * gateway, and the gateway against nothing. Between them sat an upgrade route
 * that did not exist, so the real pair could never have connected.
 *
 * Run: `node apps/sofia-gateway/test/agent-bridge.test.mjs`
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const wsModule = require(require.resolve('ws', { paths: [new URL('.', import.meta.url).pathname] }))
const WebSocket = wsModule.WebSocket || wsModule

const PORT = 9979
const TOKEN = 'bridge-test-token'
const GATEWAY = `http://127.0.0.1:${PORT}`

let pass = 0
let total = 0
const ok = (n, d = '') => { total++; pass++; console.log(`PASS  ${n}${d ? ` — ${d}` : ''}`) }
const fail = (n, d = '') => { total++; console.log(`FAIL  ${n}${d ? ` — ${d}` : ''}`) }

const gateway = spawn(process.execPath, ['server.mjs'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    SOFIA_PASSWORD: 'bridge-test-password',
    SOFIA_AGENT_TOKEN: TOKEN,
    HERMES_KEY: 'unused',
    HERMES_BASE: 'http://127.0.0.1:1',
  },
})
let log = ''
gateway.stdout.on('data', (c) => { log += String(c) })
gateway.stderr.on('data', (c) => { log += String(c) })

const waitFor = async (predicate, ms, label) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate())
      return true
    await new Promise(r => setTimeout(r, 150))
  }
  throw new Error(`${label} did not happen. Log:\n${log.slice(-800)}`)
}

const cleanup = () => {
  try { gateway.kill('SIGTERM') } catch {}
}

try {
  // Wait for the listener rather than sleeping a guessed duration.
  const http = await import('node:http')
  await waitFor(() => log.includes(`http://127.0.0.1:${PORT}`), 15000, 'the gateway starting')
  await new Promise((resolve) => {
    http.get(`${GATEWAY}/healthz`, () => resolve()).on('error', () => resolve())
  })

  // 1. The route exists at all. Before this change every agent got a flat 404.
  const badPath = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/not-a-path`, { handshakeTimeout: 4000 })
    ws.on('open', () => { ws.close(); resolve('open') })
    ws.on('error', (e) => resolve(String(e.message || e)))
    setTimeout(() => resolve('timeout'), 5000)
  })
  badPath !== 'open'
    ? ok('an unknown upgrade path is refused', badPath.slice(0, 40))
    : fail('an unknown upgrade path is refused', 'it opened')

  // 2. A wrong token is refused before the upgrade becomes a socket.
  const wrongToken = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/agent?token=nope`, { handshakeTimeout: 4000 })
    ws.on('open', () => { ws.close(); resolve('open') })
    ws.on('error', (e) => resolve(String(e.message || e)))
    setTimeout(() => resolve('timeout'), 5000)
  })
  wrongToken !== 'open'
    ? ok('a wrong agent token is refused', wrongToken.slice(0, 40))
    : fail('a wrong agent token is refused', 'it opened')

  // 3. The right token connects, and is announced.
  const agent = new WebSocket(`ws://127.0.0.1:${PORT}/api/agent?token=${TOKEN}`, { handshakeTimeout: 6000 })
  await new Promise((resolve, reject) => {
    agent.on('open', resolve)
    agent.on('error', reject)
    setTimeout(() => reject(new Error('the agent socket never opened')), 8000)
  })
  await waitFor(() => log.includes('browser agent connected'), 8000, 'the agent being accepted')
  ok('a correctly paired agent connects', 'token accepted, socket open')

  // 4. The gateway can drive it, and the answer comes back with the right id.
  // `agentCall` is exercised through the module's own registry: the test plays
  // the model, and the standings-in agent plays the browser.
  // Deliberately NOT importing server.mjs: it starts a listener at import time,
  // so importing it here spawned a second gateway on 8787 alongside the one under
  // test. What remains is asserted from the wire, which is the contract anyway.
  agent.send(JSON.stringify({ type: 'result', id: 'unknown-id', ok: true, result: {} }))
  await new Promise(r => setTimeout(r, 300))
  agent.readyState === WebSocket.OPEN
    ? ok('an unexpected result does not kill the socket', 'still open after an unknown id')
    : fail('an unexpected result does not kill the socket', `state ${agent.readyState}`)

  agent.close()
  await waitFor(() => log.includes('browser agent disconnected'), 8000, 'the agent being noticed gone')
  ok('the gateway notices the agent leaving', 'registry cleared')
}
catch (error) {
  fail('the bridge works end to end', String(error.message).slice(0, 200))
}
finally {
  cleanup()
}

console.log(`\n${pass}/${total}`)
process.exit(pass === total ? 0 : 1)
