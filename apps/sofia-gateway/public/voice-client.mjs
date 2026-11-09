// Sofia voice client — the browser half of the Live bridge.
//
// Capture: mic -> AudioContext at 16 kHz -> AudioWorklet (inline, blob URL, so
// there is no worklet file to cache wrongly) -> Float32 frames -> Int16 -> base64
// -> gateway. Playback: 24 kHz PCM16 from the gateway -> AudioBuffer queue with a
// running start-time cursor so chunks butt together without gaps or overlaps.
//
// Lip sync: every played chunk also contributes a level envelope (RMS per 20 ms
// window, anchored to the playback clock). The stage polls getLevel() while the
// session is live, so the mouth moves from the audio that is actually heard
// rather than from a timer or from the mic.
//
// Deliberately dependency-free and framework-free: the AIRI stage imports this
// module, and so does the test harness. Nothing here knows about Vue.

const CAPTURE_SAMPLE_RATE = 16000
const PLAYBACK_SAMPLE_RATE = 24000
// One envelope cell per 20 ms of played audio: fine enough for a mouth, coarse
// enough that a reply costs a few hundred numbers instead of a copy of the PCM.
const ENVELOPE_CELL = 0.02

// Inline worklet: a pure framer. It must not touch btoa/atob/TextEncoder — those
// are absent in AudioWorkletGlobalScope and their absence silently kills the
// processor (that bug cost a day on the previous build).
const WORKLET_SOURCE = `
class SofiaFramer extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.frameSamples = (options && options.processorOptions && options.processorOptions.frameSamples) || 512
    this.buffer = new Float32Array(this.frameSamples)
    this.filled = 0
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true
    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.filled++] = channel[i]
      if (this.filled === this.frameSamples) {
        this.port.postMessage({ pcm: this.buffer, rms: rms(this.buffer) })
        this.buffer = new Float32Array(this.frameSamples)
        this.filled = 0
      }
    }
    return true
  }
}
function rms(frame) {
  let sum = 0
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
  return Math.sqrt(sum / frame.length)
}
registerProcessor('sofia-framer', SofiaFramer)
`

export function floatToPcm16Base64(float32) {
  const pcm = new Int16Array(float32.length)
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]))
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF
  }
  const bytes = new Uint8Array(pcm.buffer)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk)
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  return btoa(binary)
}

export function pcm16Base64ToFloat32(b64) {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const pcm = new Int16Array(bytes.buffer)
  const out = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 0x8000
  return out
}

/**
 * Speech RMS lands around 0.03-0.2; a raw value barely moves a mouth. The curve
 * below maps that band onto 0..1 with a soft knee, so quiet syllables still
 * register and loud ones do not peg at full open.
 */
export function levelFromRms(rms) {
  if (!Number.isFinite(rms) || rms <= 0)
    return 0
  return Math.max(0, Math.min(1, Math.sqrt(rms) * 2.6))
}

export class SofiaVoice {
  constructor({ url, onEvent } = {}) {
    this.url = url || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/live/stream`
    this.onEvent = onEvent || (() => {})
    this.ws = null
    this.micStream = null
    this.captureCtx = null
    this.playbackCtx = null
    this.node = null
    this.sink = null
    this.playCursor = 0
    this.playingUntil = 0
    this.envelope = []
    this.ready = false
    this.stats = { framesSent: 0, bytesSent: 0, chunksPlayed: 0, bytesPlayed: 0, lastRms: 0, levelPeak: 0, errors: [] }
  }

  emit(type, detail) {
    this.stats.lastEvent = type
    this.onEvent({ type, ...detail })
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url)
      this.ws = ws
      const timer = setTimeout(() => reject(new Error('gateway live socket did not open')), 10000)

      ws.onopen = () => { clearTimeout(timer); this.emit('socket-open') }
      ws.onerror = () => { clearTimeout(timer); reject(new Error('gateway live socket error')) }
      ws.onclose = (e) => { this.ready = false; this.emit('socket-close', { code: e.code }) }
      ws.onmessage = (evt) => {
        let msg
        try { msg = JSON.parse(evt.data) }
        catch { return }
        if (msg.type === 'ready') {
          this.ready = true
          clearTimeout(timer)
          this.emit('ready', { model: msg.model, voice: msg.voice })
          resolve()
          return
        }
        if (msg.type === 'audio') {
          this.enqueueAudio(msg.data)
          return
        }
        if (msg.type === 'error') this.stats.errors.push(msg.message)
        this.emit(msg.type, msg)
      }
    })
    return this
  }

  /** Ask the browser for the mic and start framing audio to the gateway. */
  async startMic() {
    if (this.micStream) return
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })

    this.captureCtx = new AudioContext({ sampleRate: CAPTURE_SAMPLE_RATE })
    if (this.captureCtx.state === 'suspended') await this.captureCtx.resume()

    const blob = new Blob([WORKLET_SOURCE], { type: 'text/javascript' })
    const url = URL.createObjectURL(blob)
    try {
      await this.captureCtx.audioWorklet.addModule(url)
    }
    finally {
      URL.revokeObjectURL(url)
    }

    const source = this.captureCtx.createMediaStreamSource(this.micStream)
    this.node = new AudioWorkletNode(this.captureCtx, 'sofia-framer', {
      processorOptions: { frameSamples: 512 },
    })

    this.node.port.onmessage = (e) => {
      const { pcm, rms } = e.data
      this.stats.lastRms = rms
      if (!this.ready) return
      const data = floatToPcm16Base64(pcm)
      this.ws.send(JSON.stringify({ type: 'audio', data }))
      this.stats.framesSent += 1
      this.stats.bytesSent += data.length * 0.75
    }

    // A worklet only runs when something downstream pulls it. A zero-gain sink
    // into the destination does that without echoing the mic to the speakers.
    this.sink = this.captureCtx.createGain()
    this.sink.gain.value = 0
    source.connect(this.node)
    this.node.connect(this.sink)
    this.sink.connect(this.captureCtx.destination)

    this.emit('mic-started', { sampleRate: this.captureCtx.sampleRate })
  }

  sendText(text) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify({ type: 'text', text }))
    return true
  }

  /** Queue 24 kHz PCM16 so consecutive chunks play with no gap or overlap. */
  enqueueAudio(b64) {
    if (!this.playbackCtx) {
      this.playbackCtx = new AudioContext({ sampleRate: PLAYBACK_SAMPLE_RATE })
    }
    if (this.playbackCtx.state === 'suspended') this.playbackCtx.resume()

    const floats = pcm16Base64ToFloat32(b64)
    const buffer = this.playbackCtx.createBuffer(1, floats.length, PLAYBACK_SAMPLE_RATE)
    buffer.copyToChannel(floats, 0)

    const src = this.playbackCtx.createBufferSource()
    src.buffer = buffer
    src.connect(this.playbackCtx.destination)

    const now = this.playbackCtx.currentTime
    if (this.playCursor < now + 0.02) this.playCursor = now + 0.02
    const start = this.playCursor
    src.start(start)
    this.playCursor += buffer.duration
    this.playingUntil = this.playCursor

    this.recordEnvelope(floats, start)

    this.stats.chunksPlayed += 1
    this.stats.bytesPlayed += floats.length * 2
    this.emit('audio-played', { chunksPlayed: this.stats.chunksPlayed })
  }

  /** Turn one played chunk into timed level cells, so the mouth follows the audio. */
  recordEnvelope(floats, start) {
    const samplesPerCell = Math.max(1, Math.round(PLAYBACK_SAMPLE_RATE * ENVELOPE_CELL))
    for (let offset = 0; offset < floats.length; offset += samplesPerCell) {
      const end = Math.min(floats.length, offset + samplesPerCell)
      let sum = 0
      for (let i = offset; i < end; i++) sum += floats[i] * floats[i]
      const rms = Math.sqrt(sum / Math.max(1, end - offset))
      const level = levelFromRms(rms)
      this.envelope.push({ t: start + offset / PLAYBACK_SAMPLE_RATE, level })
      if (level > this.stats.levelPeak) this.stats.levelPeak = level
    }
  }

  /** True while queued audio is still ahead of the playback clock. */
  isPlaying() {
    if (!this.playbackCtx) return false
    return this.playbackCtx.currentTime < this.playingUntil - 0.02
  }

  /**
   * Mouth level 0..1 for the audio playing right now. Cells are pruned as the
   * clock passes them, so the array stays a few chunks long.
   */
  getLevel() {
    if (!this.playbackCtx || this.envelope.length === 0) return 0
    const now = this.playbackCtx.currentTime
    while (this.envelope.length > 1 && this.envelope[1].t <= now - ENVELOPE_CELL) this.envelope.shift()
    if (!this.isPlaying() && this.envelope[0].t > now) return 0
    let level = 0
    for (const cell of this.envelope) {
      if (cell.t > now) break
      level = cell.level
    }
    if (!this.isPlaying()) return 0
    return level
  }

  // Barge-in: drop everything queued so the user's voice wins.
  stopPlayback() {
    if (!this.playbackCtx) return
    this.playCursor = 0
    this.playingUntil = 0
    this.envelope = []
    this.playbackCtx.close().catch(() => {})
    this.playbackCtx = null
  }

  async stop() {
    try { this.node?.disconnect() } catch {}
    try { this.sink?.disconnect() } catch {}
    try { this.micStream?.getTracks().forEach(t => t.stop()) } catch {}
    try { await this.captureCtx?.close() } catch {}
    this.micStream = null
    this.captureCtx = null
    this.stopPlayback()
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'close' }))
      this.ws.close()
    }
    this.ready = false
  }
}
