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
//        { toolCall } { goAway } { sessionResumptionUpdate } { error }
//
// ## Why this file reconnects to Google behind the browser's back
//
// A Live *connection* has a hard cap around ten minutes and a Live *session*
// only reaches its audio cap with context-window compression on. Before this
// was handled, the socket to Google went away at ~10 min while the browser's
// socket to us stayed open: the dock still read "Stop", nothing was logged to
// the person, and the only symptom was Sofia going quiet mid-conversation
// forever. The fix is one layer down from the UI — keep the browser socket
// open, keep the resumption handle, and re-open the Google socket under it:
//
//   setup  ->  sessionResumption: {}                 (ask for handles)
//   recv   ->  sessionResumptionUpdate.newHandle     (store it)
//   recv   ->  goAway                                (reconnect NOW, same handle)
//   close  ->  unexpected? reconnect with the handle (up to MAX_RECONNECT)
//
// `contextWindowCompression` is what makes a long conversation possible at all;
// `triggerTokens` is a SIBLING of `slidingWindow`, never a field inside it —
// nesting it closes the socket with 1007 before setup completes.
import { readFileSync } from 'node:fs'

import WsClient from 'ws'

const HOST = 'generativelanguage.googleapis.com'
const PATH = '/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent'
const KEY_FILE = process.env.GEMINI_KEY_FILE || '/home/ctum/secrets/gemini.key'

export const DEFAULT_MODEL = process.env.LIVE_MODEL || 'gemini-3.8-live'
export const DEFAULT_VOICE = process.env.LIVE_VOICE || 'Leda'

// How many times one conversation may re-open the Google socket before we tell
// the person it is over. A resumption handle is valid for two hours, so three
// is generous; more than that means the account or the network is the problem.
const MAX_RECONNECT = 3
const RECONNECT_DELAY_MS = 400

function geminiKey() {
  if (process.env.GEMINI_API_KEY)
    return process.env.GEMINI_API_KEY.trim()
  return readFileSync(KEY_FILE, 'utf8').trim()
}

/**
 * One live conversation. `emit` receives plain objects so the caller decides
 * who to fan them out to (today: one browser socket).
 */
export class LiveBridge {
  constructor({ emit, model = DEFAULT_MODEL, voice = DEFAULT_VOICE, systemInstruction, tools, resumeHandle = null } = {}) {
    this.emit = emit || (() => {})
    this.model = model
    this.voice = voice
    this.systemInstruction = systemInstruction
    this.tools = tools
    this.ws = null
    this.ready = false
    this.retired = false
    this.resumeHandle = resumeHandle
    this.attempts = 0
    this.reconnecting = false
    this.droppedFrames = 0
  }

  /** The setup payload, rebuilt per socket so it can carry the resume handle. */
  setupPayload() {
    const setup = {
      model: `models/${this.model}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } } },
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      // Long conversations: without this the audio-only session hits its cap
      // and there is nothing to reconnect to. triggerTokens is a sibling.
      contextWindowCompression: { slidingWindow: {}, triggerTokens: 16384 },
      // Ask for resumption handles; carry the last one when we already have it.
      sessionResumption: this.resumeHandle ? { handle: this.resumeHandle } : {},
    }
    // How long the server waits after he stops talking before it decides the
    // turn is over - which is almost the whole of the hangover a person feels
    // before she answers. A documented knob, not a guess: `probe-vad.mjs` shows
    // this payload reaching setupComplete on gemini-3.8-live, while an unknown
    // field closes the socket with 1007 before setup ever completes.
    //
    // 1100 ms. A threshold is a clock, and a clock cannot tell a finished
    // sentence from a breath: any value T cuts every pause longer than T. The
    // question is therefore not "what is fastest" but "which pauses are real
    // speech", and that is measurable — a fixture with silence inside the turn
    // asks it directly (`vad-cutoff-gate.mjs`, `SPEECH_END_S` set to the true
    // end of both clauses).
    //
    // Measured on gemini-3.8-live (scratch containers from the serving image,
    // one Live session at a time; "hangover" = true speech end -> first audio
    // on a clean single turn, from vad-latency-gate):
    //   setting              hango.  600 ms breath   1000 ms pause
    //   500 ms                1192    cut -1689 ms    (not tested)
    //   700 ms (was shipped)  1309    survives        cut -1762 ms, clause lost
    //   Gemini defaults       1450    (not tested)    cut -1595 ms
    //   1100 + END_LOW        1467    survives        cut -1745 ms (sensitivity
    //                                                 is not a timer: no effect)
    //   1100 ms               1467    survives        7/7, both clauses
    // 1000 ms is an ordinary thinking pause. Paying 158 ms once per turn to stop
    // answering half a sentence is the trade; 700 -> 1100 costs less than the
    // 500 -> 700 step did. Both 700 and Gemini's own default cut the 1 s pause,
    // so this is not over-tuning a working default - the default fails too.
    //   LIVE_VAD=off        -> leave Gemini's defaults alone
    //   LIVE_SILENCE_MS     -> the hangover (default 1100)
    //   LIVE_PREFIX_PAD_MS  -> audio kept from *before* speech was detected
    //   LIVE_END_SENSITIVITY-> END_SENSITIVITY_{LOW,HIGH}; accepted by the API
    //                          but measured to change nothing here.
    const vadOff = (process.env.LIVE_VAD || '').toLowerCase() === 'off'
    const silenceMs = Number(process.env.LIVE_SILENCE_MS || 1100)
    const padMs = Number(process.env.LIVE_PREFIX_PAD_MS || 300)
    // Sensitivity is the *evidence* knob, silenceDurationMs is the *clock*. A
    // clock can only be beaten by waiting longer, which taxes every real turn;
    // asking for more certainty that he stopped is a different trade, so it is
    // kept separately tunable and sent only when set (empty = Gemini's default).
    const endSens = (process.env.LIVE_END_SENSITIVITY || '').trim()
    if (!vadOff && Number.isFinite(silenceMs)) {
      setup.realtimeInputConfig = {
        automaticActivityDetection: {
          silenceDurationMs: silenceMs,
          ...(Number.isFinite(padMs) ? { prefixPaddingMs: padMs } : {}),
          ...(endSens ? { endOfSpeechSensitivity: endSens } : {}),
        },
      }
    }
    if (this.systemInstruction)
      setup.systemInstruction = { parts: [{ text: this.systemInstruction }] }
    if (this.tools?.length)
      setup.tools = this.tools
    return setup
  }

  start() {
    this.openSocket('initial')
    return this
  }

  openSocket(reason) {
    const url = `wss://${HOST}${PATH}?key=${encodeURIComponent(geminiKey())}`
    const ws = new WsClient(url, { perMessageDeflate: false })
    this.ws = ws
    const resumed = Boolean(this.resumeHandle)

    ws.on('open', () => {
      if (this.ws !== ws)
        return
      ws.send(JSON.stringify({ setup: this.setupPayload() }))
    })

    ws.on('message', (raw) => {
      if (this.ws !== ws)
        return // a socket we already replaced
      let msg
      try { msg = JSON.parse(raw.toString('utf8')) }
      catch { return }

      if (msg.setupComplete) {
        this.ready = true
        this.attempts = 0
        this.emit({ type: 'ready', model: this.model, voice: this.voice, resumed, reason })
        return
      }

      if (msg.sessionResumptionUpdate) {
        const u = msg.sessionResumptionUpdate
        if (u.resumable !== false && u.newHandle)
          this.resumeHandle = u.newHandle
        this.emit({ type: 'resumption', resumable: u.resumable !== false, handle: u.newHandle ? `${String(u.newHandle).slice(0, 8)}…` : null })
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
        if (sc.outputTranscription?.text)
          this.emit({ type: 'transcript', dir: 'out', text: sc.outputTranscription.text })
        if (sc.inputTranscription?.text)
          this.emit({ type: 'transcript', dir: 'in', text: sc.inputTranscription.text })
        if (sc.interrupted)
          this.emit({ type: 'interrupted' })
        if (sc.turnComplete)
          this.emit({ type: 'turnComplete' })
        return
      }

      if (msg.toolCall) {
        this.emit({ type: 'toolCall', functionCalls: msg.toolCall.functionCalls || [] })
        return
      }

      if (msg.goAway) {
        // The server is about to drop this socket. Take the new one ourselves,
        // under the same browser socket, while the old one is still draining.
        this.emit({ type: 'goAway', timeLeft: msg.goAway.timeLeft })
        this.scheduleReconnect('goAway')
        return
      }

      if (msg.error) {
        this.emit({ type: 'error', code: msg.error.code, message: msg.error.message })
      }
    })

    ws.on('close', (code, reasonStr) => {
      if (this.ws !== ws)
        return
      this.ready = false
      const reason = reasonStr?.toString?.().slice(0, 200) || ''
      if (this.retired) {
        this.emit({ type: 'closed', code, reason, retrying: false })
        return
      }
      this.emit({ type: 'closed', code, reason, retrying: this.attempts < MAX_RECONNECT })
      this.scheduleReconnect(`closed ${code}`)
    })

    ws.on('error', (err) => {
      if (this.ws !== ws)
        return
      this.emit({ type: 'error', message: err.message })
    })
  }

  scheduleReconnect(why) {
    if (this.retired || this.reconnecting)
      return
    if (this.attempts >= MAX_RECONNECT) {
      this.retired = true
      this.ready = false
      this.emit({ type: 'gone', message: `live session ended (${why}) and could not be resumed` })
      return
    }
    this.reconnecting = true
    this.attempts += 1
    this.ready = false
    this.emit({ type: 'reconnecting', reason: why, attempt: this.attempts, resuming: Boolean(this.resumeHandle) })
    setTimeout(() => {
      this.reconnecting = false
      if (this.retired)
        return
      this.openSocket(why)
    }, RECONNECT_DELAY_MS)
  }

  /** Raw PCM16 mono 16 kHz, base64 — the format Live expects from a mic. */
  sendAudioBase64(b64) {
    if (!this.ready || this.retired || !this.ws || this.ws.readyState !== WsClient.OPEN) {
      this.droppedFrames += 1
      return false
    }
    this.ws.send(JSON.stringify({ realtimeInput: { audio: { data: b64, mimeType: 'audio/pcm;rate=16000' } } }))
    return true
  }

  sendText(text) {
    if (!this.ready || this.retired || !this.ws || this.ws.readyState !== WsClient.OPEN)
      return false
    this.ws.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } }))
    return true
  }

  sendToolResponse(functionResponses) {
    if (!this.ready || this.retired || !this.ws || this.ws.readyState !== WsClient.OPEN)
      return
    this.ws.send(JSON.stringify({ toolResponse: { functionResponses } }))
  }

  close() {
    this.retired = true
    this.ready = false
    try { this.ws?.close() }
    catch {}
  }
}
