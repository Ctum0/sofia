// Acts as the browser: connects to the gateway's live socket, asks for one
// spoken sentence, and asserts audio actually comes back through the proxy.
//
// Run with cwd = apps/sofia-gateway so `ws` resolves from node_modules.
import WsClient from 'ws'

const URL = process.env.URL || 'ws://127.0.0.1:8787/api/live/stream'
const t0 = Date.now()
const el = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`

const stats = { ready: false, audioChunks: 0, audioBytes: 0, mimes: new Set(), transcripts: [], turnComplete: false, errors: [] }
const ws = new WsClient(URL)
let done = false

function finish(code) {
  if (done) return
  done = true
  try { ws.close() } catch {}
  console.log('\n--- summary ---')
  console.log('ready:', stats.ready)
  console.log('audio chunks:', stats.audioChunks, 'bytes:', stats.audioBytes)
  console.log('mime types:', [...stats.mimes].join(', ') || '-')
  console.log('transcripts:', stats.transcripts.length ? stats.transcripts.slice(-3) : '-')
  console.log('turnComplete:', stats.turnComplete)
  console.log('errors:', stats.errors.length ? stats.errors : 'none')
  process.exit(code)
}

ws.on('open', () => console.log(`[${el()}] connected to gateway`))
ws.on('message', (raw) => {
  let msg
  try { msg = JSON.parse(raw.toString('utf8')) } catch { return }

  if (msg.type === 'ready') {
    stats.ready = true
    console.log(`[${el()}] live ready — model ${msg.model}, voice ${msg.voice}`)
    ws.send(JSON.stringify({ type: 'text', text: 'Say hello to Sithum in one short sentence.' }))
    console.log(`[${el()}] text turn sent through gateway`)
    setTimeout(() => finish(stats.audioChunks > 0 ? 0 : 1), 25000)
    return
  }
  if (msg.type === 'audio') {
    stats.audioChunks += 1
    stats.audioBytes += Buffer.from(msg.data, 'base64').length
    if (msg.mimeType) stats.mimes.add(msg.mimeType)
    return
  }
  if (msg.type === 'transcript') {
    stats.transcripts.push(`${msg.dir}: ${msg.text}`)
    return
  }
  if (msg.type === 'turnComplete') {
    stats.turnComplete = true
    console.log(`[${el()}] turnComplete`)
    finish(stats.audioChunks > 0 ? 0 : 1)
    return
  }
  if (msg.type === 'error') {
    stats.errors.push(`${msg.code || ''} ${msg.message}`.slice(0, 250))
    console.log(`[${el()}] error:`, stats.errors.at(-1))
    finish(1)
    return
  }
  if (msg.type === 'closed') {
    console.log(`[${el()}] closed code=${msg.code}`)
    if (!stats.turnComplete) finish(stats.audioChunks > 0 ? 0 : 1)
  }
})
ws.on('close', () => finish(stats.audioChunks > 0 && stats.turnComplete ? 0 : 1))
ws.on('error', (e) => { stats.errors.push(e.message); finish(1) })
