// Server-side Gemini Live session.
//
// The browser never holds a Google credential: it connects to this gateway and
// the gateway holds the socket to Google. That was not the first design —
// ephemeral tokens (auth_tokens + ?access_token=) are the documented path for a
// direct browser connection, but this key's API version rejects them
// ("1008 Permission denied on the service") and does not know
// `liveConnectConstraints` at all. Proxying is strictly better anyway: one
// trust boundary, and the key stays on the host.
//
// Wire shapes (both directions) are the Live API's own:
//   out: { setup } -> { setupComplete } -> { clientContent | realtimeInput }
//   in : { serverContent: { modelTurn, inputTranscription, outputTranscription, turnComplete } }
//        { toolCall } { goAway } { error }
import { readFileSync } from 'node:fs'

import WsClient from 'ws'

const HOST = 'generativelanguage.googleapis.com'
const PATH = '/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent'
const KEY_FILE = process.env.GEMINI_KEY_FILE || '/home/ctum/secrets/gemini.key'

export const DEFAULT_MODEL = process.env.LIVE_MODEL || 'gemini-3.8-live'
export const DEFAULT_VOICE = process.env.LIVE_VOICE || 'Aoede'

function geminiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim()
  return readFileSync(KEY_FILE, 'utf8').trim()
}

/**
 * One live conversation. `emit` receives plain objects so the caller decides
 * who to fan them out to (today: one browser socket).
 */
export class LiveBridge {
  constructor({ emit, model = DEFAULT_MODEL, voice = DEFAULT_VOICE, systemInstruction, tools } = {}) {
    this.emit = emit || (() => {})
    this.model = model
    this.voice = voice
    this.systemInstruction = systemInstruction
    this.tools = tools
    this.ws = null
    this.ready = false
    this.closed = false
  }

  start() {
    const url = `wss://${HOST}${PATH}?key=${encodeURIComponent(geminiKey())}`
    this.ws = new WsClient(url, { perMessageDeflate: false })

    this.ws.on('open', () => {
      const setup = {
        model: `models/${this.model}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } } },
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      }
      if (this.systemInstruction) setup.systemInstruction = { parts: [{ text: this.systemInstruction }] }
      if (this.tools?.length) setup.tools = this.tools
      this.ws.send(JSON.stringify({ setup }))
    })

    this.ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw.toString('utf8')) }
      catch { return }

      if (msg.setupComplete) {
        this.ready = true
        this.emit({ type: 'ready', model: this.model, voice: this.voice })
        return
      }

      if (msg.serverContent) {
        const sc = msg.serverContent
        for (const part of sc.modelTurn?.parts || []) {
          if (part.inlineData?.data) {
            this.emit({ type: 'audio', data: part.inlineData.data, mimeType: part.inlineData.mimeType || 'audio/pcm;rate=24000' })
          }
          else if (part.text) {
            this.emit({ type: 'text', text: part.text })
          }
        }
        if (sc.outputTranscription?.text) this.emit({ type: 'transcript', dir: 'out', text: sc.outputTranscription.text })
        if (sc.inputTranscription?.text) this.emit({ type: 'transcript', dir: 'in', text: sc.inputTranscription.text })
        if (sc.interrupted) this.emit({ type: 'interrupted' })
        if (sc.turnComplete) this.emit({ type: 'turnComplete' })
        return
      }

      if (msg.toolCall) {
        this.emit({ type: 'toolCall', functionCalls: msg.toolCall.functionCalls || [] })
        return
      }

      if (msg.goAway) {
        this.emit({ type: 'goAway', timeLeft: msg.goAway.timeLeft })
        return
      }

      if (msg.error) {
        this.emit({ type: 'error', code: msg.error.code, message: msg.error.message })
      }
    })

    this.ws.on('close', (code, reason) => {
      this.closed = true
      this.ready = false
      this.emit({ type: 'closed', code, reason: reason?.toString?.().slice(0, 200) || '' })
    })

    this.ws.on('error', (err) => {
      this.emit({ type: 'error', message: err.message })
    })

    return this
  }

  /** Raw PCM16 mono 16 kHz, base64 — the format Live expects from a mic. */
  sendAudioBase64(b64) {
    if (!this.ready || this.closed) return
    this.ws.send(JSON.stringify({ realtimeInput: { audio: { data: b64, mimeType: 'audio/pcm;rate=16000' } } }))
  }

  sendText(text) {
    if (!this.ready || this.closed) return false
    this.ws.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } }))
    return true
  }

  sendToolResponse(functionResponses) {
    if (!this.ready || this.closed) return
    this.ws.send(JSON.stringify({ toolResponse: { functionResponses } }))
  }

  close() {
    this.closed = true
    try { this.ws?.close() } catch {}
  }
}
