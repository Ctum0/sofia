// Probe: does the Live API accept `realtimeInputConfig.automaticActivityDetection`?
//
// The gateway's setup payload carries no VAD config, so Gemini's defaults decide
// when a spoken turn ends. Measured on production with `vad-latency-gate.mjs`,
// that default costs ~1278 ms from speech end to the input transcript arriving —
// which is most of the 1450 ms a person waits before hearing her. The documented
// knob is `silenceDurationMs`; the Live setup is validated strictly (one unknown
// field closes the socket with 1007 before setupComplete), so prove each variant
// here before any code depends on it.
//
// node:22 has a global WebSocket, so this needs no dependency.
// Usage: node scripts/probe-vad.mjs [full|minimal]
import { readFileSync } from 'node:fs'

const MODE = process.argv[2] || 'full'
const KEY = (process.env.GEMINI_KEY || readFileSync(process.env.GEMINI_KEY_FILE || '/home/ctum/secrets/gemini.key', 'utf8')).trim()
const MODEL = process.env.LIVE_MODEL || 'gemini-3.8-live'
const HOST = 'generativelanguage.googleapis.com'
const PATH = '/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent'

const vad = MODE === 'minimal'
  ? { silenceDurationMs: 500 }
  : {
      silenceDurationMs: 500,
      prefixPaddingMs: 300,
      startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
      endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
    }

const setup = {
  model: `models/${MODEL}`,
  generationConfig: {
    responseModalities: ['AUDIO'],
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: process.env.LIVE_VOICE || 'Leda' } } },
  },
  inputAudioTranscription: {},
  outputAudioTranscription: {},
  realtimeInputConfig: { automaticActivityDetection: vad },
}

console.log(`mode=${MODE}`)
console.log('vad=' + JSON.stringify(vad))

const ws = new WebSocket(`wss://${HOST}${PATH}?key=${encodeURIComponent(KEY)}`)
ws.binaryType = 'arraybuffer'
const t0 = Date.now()
const timer = setTimeout(() => {
  console.log(`TIMEOUT after ${Date.now() - t0} ms — no setupComplete, no error`)
  process.exit(1)
}, 15000)

ws.onopen = () => {
  console.log(`ws open after ${Date.now() - t0} ms`)
  ws.send(JSON.stringify({ setup }))
}
ws.onmessage = async (evt) => {
  const text = typeof evt.data === 'string'
    ? evt.data
    : new TextDecoder().decode(evt.data instanceof ArrayBuffer ? evt.data : await evt.data.arrayBuffer())
  const msg = JSON.parse(text)
  if (msg.setupComplete) {
    clearTimeout(timer)
    console.log(`SETUP_COMPLETE after ${Date.now() - t0} ms — the field is accepted`)
    ws.close()
    process.exit(0)
  }
  if (msg.error) {
    clearTimeout(timer)
    console.log(`ERROR ${msg.error.code}: ${msg.error.message}`)
    ws.close()
    process.exit(1)
  }
}
ws.onerror = () => { console.log('socket error'); process.exit(1) }
ws.onclose = (e) => { console.log(`closed ${e.code} ${e.reason || ''}`) }
