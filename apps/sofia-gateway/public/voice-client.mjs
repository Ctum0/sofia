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
// Autoplay: both AudioContexts are created and resumed inside the Talk click
// (unlock()), each fed a silent 20 ms buffer. That is the thing Chrome, Safari
// and Firefox all accept as proof the page may make sound; a context created
// later — e.g. when the first reply chunk arrives — stays suspended and the
// reply is simply never heard. If a context is suspended later (iOS lock
// screen, tab switch, a headset connecting) the statechange handler resumes it.
//
// Deliberately dependency-free and framework-free: the AIRI stage imports this
// module, and so does the test harness. Nothing here knows about Vue.

const CAPTURE_SAMPLE_RATE = 16000
const PLAYBACK_SAMPLE_RATE = 24000
// One envelope cell per 20 ms of played audio: fine enough for a mouth, coarse
// enough that a reply costs a few hundred numbers instead of a copy of the PCM.
const ENVELOPE_CELL = 0.02
// A live session that has produced no audio frame for this long is not
// capturing, whatever the socket says. Say so instead of looking healthy.
const SILENCE_LIMIT_MS = 2000

// Inline worklet: a resampler plus a pure framer. It must not touch
// btoa/atob/TextEncoder — those are absent in AudioWorkletGlobalScope and their
// absence silently kills the processor (that bug cost a day on the previous
// build). It must not assume the context honours the requested rate either:
// Safari hands back the hardware rate, and sending 44.1 kHz samples labelled
// 16 kHz makes speech fast and high, so the decimation happens here, from the
// rate the context actually reports.
const WORKLET_SOURCE = `
class SofiaFramer extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const opts = (options && options.processorOptions) || {}
    this.frameSamples = opts.frameSamples || 512
    const target = opts.targetRate || 16000
    const input = opts.inputRate || sampleRate
    // Input samples consumed per output sample: 1 at 16 kHz, 3 at 48 kHz,
    // 2.756 at 44.1 kHz.
    this.ratio = input / target
    this.buffer = new Float32Array(this.frameSamples)
    this.filled = 0
    this.pos = 0
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel || channel.length === 0) return true
    const n = channel.length
    let pos = this.pos
    while (pos < n) {
      const i = pos | 0
      const frac = pos - i
      const a = channel[i]
      // Linear interpolation, with the fractional position carried between
      // process() calls so no sample is dropped at a block boundary.
      const b = i + 1 < n ? channel[i + 1] : a
      this.buffer[this.filled++] = a + (b - a) * frac
      if (this.filled === this.frameSamples) {
        this.port.postMessage({ pcm: this.buffer, rms: rms(this.buffer) })
        this.buffer = new Float32Array(this.frameSamples)
        this.filled = 0
      }
      pos += this.ratio
    }
    this.pos = pos - n
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

/** Constraints worth having, but never worth failing over on a real device. */
const PREFERRED_AUDIO = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
}

export class SofiaVoice {
  constructor({ url, onEvent } = {}) {
    this.url = url || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/live/stream`
    this.onEvent = onEvent || (() => {})
    this.ws = null
    this.micStream = null
    this.captureCtx = null
    this.playbackCtx = null
    this.source = null
    this.node = null
    this.sink = null
    this.sources = new Set()
    this.playCursor = 0
    this.playingUntil = 0
    this.envelope = []
    this.ready = false
    this.watchdog = null
    this.lastFrames = 0
    this.lastFrameAt = 0
    this.blockedNoticed = false
    // One object a human and the QA gate both read. `frames` counts worklet
    // frames delivered; `framesSent` counts frames the gateway accepted.
    this.stats = {
      frames: 0,
      framesSent: 0,
      bytesSent: 0,
      chunksPlayed: 0,
      bytesPlayed: 0,
      lastRms: 0,
      levelPeak: 0,
      captureState: 'none',
      playbackState: 'none',
      captureRate: 0,
      playbackRate: 0,
      micWarning: '',
      lastError: '',
      lastEvent: '',
      errors: [],
    }
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
      ws.onclose = (e) => {
        clearTimeout(timer)
        this.ready = false
        this.emit('socket-close', { code: e.code })
        reject(new Error(`gateway live socket closed (${e.code}) before it was ready`))
      }
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
        if (msg.type === 'error') {
          this.stats.lastError = String(msg.message || 'live error').slice(0, 200)
          this.stats.errors.push(this.stats.lastError)
        }
        this.emit(msg.type, msg)
      }
    })
    return this
  }

  // --- audio contexts --------------------------------------------------------

  /**
   * Create both contexts and prove to the browser that this page may play
   * sound. Must be called from the click itself — not after an await — because
   * Safari ties the permission to the gesture, not to the document.
   */
  unlock() {
    const capture = this.createCaptureContext()
    const playback = this.createPlaybackContext()
    this.resume(capture)
    this.resume(playback)
    this.playSilence(capture)
    this.playSilence(playback)
    return { capture: capture.state, playback: playback.state }
  }

  createCaptureContext() {
    if (this.captureCtx) return this.captureCtx
    const ctx = this.newContext(CAPTURE_SAMPLE_RATE)
    this.captureCtx = ctx
    this.stats.captureRate = ctx.sampleRate
    this.watchState(ctx, 'captureState')
    return ctx
  }

  createPlaybackContext() {
    if (this.playbackCtx) return this.playbackCtx
    const ctx = this.newContext(PLAYBACK_SAMPLE_RATE)
    this.playbackCtx = ctx
    this.stats.playbackRate = ctx.sampleRate
    this.watchState(ctx, 'playbackState')
    return ctx
  }

  /**
   * A requested rate is a hint: some browsers throw for a rate they do not
   * like, some hand back the hardware rate. The worklet resamples to 16 kHz
   * either way and an AudioBufferSourceNode resamples its buffer to the context
   * rate, so a fallback context is still correct.
   */
  newContext(sampleRate) {
    try {
      return new AudioContext({ sampleRate, latencyHint: 'interactive' })
    }
    catch {
      return new AudioContext()
    }
  }

  watchState(ctx, key) {
    const sync = () => {
      this.stats[key] = ctx.state
      if (ctx.state === 'suspended') {
        // iOS suspends on lock/unlock, and a headset swap can too. Ask again;
        // if the page has been interacted with at all this succeeds silently.
        this.resume(ctx)
      }
      else if (ctx.state === 'running' && key === 'playbackState') {
        // The clock was frozen while suspended, so anything scheduled against
        // it is in the past. Re-anchor on the next chunk.
        this.playCursor = 0
      }
    }
    if (typeof ctx.addEventListener === 'function')
      ctx.addEventListener('statechange', sync)
    else
      ctx.onstatechange = sync
    sync()
  }

  resume(ctx) {
    if (!ctx) return 'none'
    if (ctx.state === 'running') return ctx.state
    try {
      const p = ctx.resume()
      if (p && typeof p.catch === 'function')
        p.catch(e => this.warn('audio', `could not start audio: ${e?.name || 'Error'}`))
    }
    catch (e) {
      this.warn('audio', `could not start audio: ${e?.name || 'Error'}`)
    }
    return ctx.state
  }

  /** One silent frame: what Chrome and Safari both accept as an unlock. */
  playSilence(ctx) {
    try {
      const buffer = ctx.createBuffer(1, Math.max(1, Math.round(ctx.sampleRate * 0.02)), ctx.sampleRate)
      const src = ctx.createBufferSource()
      src.buffer = buffer
      src.connect(ctx.destination)
      src.start(0)
    }
    catch (e) {
      this.warn('audio', `unlock buffer failed: ${e?.name || 'Error'}`)
    }
  }

  // --- microphone ------------------------------------------------------------

  /** Ask the browser for the mic and start framing audio to the gateway. */
  async startMic() {
    if (this.micStream) return
    // Reuse the context the click unlocked; creating it here (after an await)
    // is what left the old client silent on Safari.
    const capture = this.createCaptureContext()
    this.resume(capture)

    this.micStream = await this.acquireMic()
    this.watchTracks()

    if (typeof capture.audioWorklet?.addModule !== 'function')
      throw new Error('this browser cannot run the audio worklet (needs a modern browser and https)')

    const blob = new Blob([WORKLET_SOURCE], { type: 'text/javascript' })
    const url = URL.createObjectURL(blob)
    try {
      await capture.audioWorklet.addModule(url)
    }
    finally {
      URL.revokeObjectURL(url)
    }

    this.source = capture.createMediaStreamSource(this.micStream)
    this.node = new AudioWorkletNode(capture, 'sofia-framer', {
      processorOptions: {
        frameSamples: 512,
        targetRate: CAPTURE_SAMPLE_RATE,
        inputRate: capture.sampleRate,
      },
    })

    this.node.port.onmessage = (e) => {
      const { pcm, rms } = e.data
      this.stats.frames += 1
      this.stats.lastRms = rms
      if (!this.ready) return
      const data = floatToPcm16Base64(pcm)
      this.ws.send(JSON.stringify({ type: 'audio', data }))
      this.stats.framesSent += 1
      this.stats.bytesSent += data.length * 0.75
    }

    // A worklet only runs when something downstream pulls it. A zero-gain sink
    // into the destination does that without echoing the mic to the speakers.
    this.sink = capture.createGain()
    this.sink.gain.value = 0
    this.source.connect(this.node)
    this.node.connect(this.sink)
    this.sink.connect(capture.destination)

    this.startWatchdog()
    this.emit('mic-started', { sampleRate: capture.sampleRate, rate: capture.sampleRate })
  }

  /**
   * Preferred constraints first; on a device that cannot satisfy them, or one
   * another app already holds, fall back to a bare audio request. A person
   * pressing Talk with headphones deserves a working mic, not a constraint
   * error.
   */
  async acquireMic() {
    const media = navigator.mediaDevices
    if (!media || typeof media.getUserMedia !== 'function')
      throw this.micError('SecurityError', 'this browser has no microphone API (needs https and a modern browser)')

    try {
      return await media.getUserMedia({ audio: PREFERRED_AUDIO })
    }
    catch (err) {
      const name = err?.name || 'Error'
      const retryable = [
        'OverconstrainedError',
        'ConstraintNotSatisfiedError',
        'NotReadableError',
        'TrackStartError',
        'AbortError',
        'TypeError',
      ].includes(name)
      if (!retryable) throw this.micError(name, err?.message || 'microphone failed')
      this.emit('mic-retry', { message: `${name} on the preferred settings — retrying with plain audio` })
      try {
        return await media.getUserMedia({ audio: true })
      }
      catch (err2) {
        throw this.micError(err2?.name || 'Error', err2?.message || 'microphone failed')
      }
    }
  }

  /** Turn a DOMException into something a person can act on. */
  micError(name, message) {
    const readable = {
      NotAllowedError: 'microphone permission denied — allow the mic for this site, then press Talk',
      PermissionDeniedError: 'microphone permission denied — allow the mic for this site, then press Talk',
      NotFoundError: 'no microphone found — plug one in or pick an input device',
      DevicesNotFoundError: 'no microphone found — plug one in or pick an input device',
      NotReadableError: 'the microphone is busy in another app or tab — close it, then press Talk',
      TrackStartError: 'the microphone is busy in another app or tab — close it, then press Talk',
      OverconstrainedError: 'this microphone cannot meet the requested settings',
      SecurityError: 'the microphone needs https (or localhost)',
      AbortError: 'the browser aborted the microphone request — try again',
    }[name] || message || 'microphone failed'
    const text = `${name}: ${readable}`.slice(0, 200)
    this.stats.lastError = text
    this.stats.errors.push(text)
    const error = new Error(text)
    error.name = name
    return error
  }

  watchTracks() {
    for (const track of this.micStream.getAudioTracks()) {
      track.onmute = () => this.warn('mic', 'the microphone was muted by the system or another app')
      track.onunmute = () => this.clearWarning()
      track.onended = () => this.warn('mic', 'the microphone disconnected — press Talk again')
    }
  }

  // --- honesty about a dead capture ------------------------------------------

  startWatchdog() {
    this.lastFrames = 0
    this.lastFrameAt = Date.now()
    clearInterval(this.watchdog)
    this.watchdog = setInterval(() => this.checkCapture(), 500)
  }

  /**
   * Silence and a dead graph look identical on the wire (no frames either way),
   * so measure the graph, not the promise. Two seconds with no worklet frame or
   * a non-running context is a failure the person can see and act on.
   */
  checkCapture() {
    if (!this.micStream) return
    const now = Date.now()
    if (this.captureCtx) this.stats.captureState = this.captureCtx.state
    if (this.playbackCtx) this.stats.playbackState = this.playbackCtx.state

    if (this.stats.frames !== this.lastFrames) {
      this.lastFrames = this.stats.frames
      this.lastFrameAt = now
    }
    if (this.playbackCtx && this.playbackCtx.state !== 'running' && this.stats.chunksPlayed > 0 && !this.blockedNoticed) {
      this.blockedNoticed = true
      this.warn('playback', 'replies are blocked by the browser — press Talk again and allow sound')
    }
    if (now - this.lastFrameAt < SILENCE_LIMIT_MS) return
    if (this.captureCtx && this.captureCtx.state !== 'running')
      this.warn('capture', 'the microphone is blocked by the browser — press Talk again and allow sound')
    else
      this.warn('capture', 'mic is silent — check permission and input device')
  }

  warn(kind, message) {
    const text = String(message).slice(0, 160)
    if (this.stats.micWarning === text) return
    this.stats.micWarning = text
    this.stats.lastError = text
    this.emit('warn', { kind, message: text })
  }

  clearWarning() {
    if (!this.stats.micWarning) return
    this.stats.micWarning = ''
    this.emit('warn-cleared')
  }

  // --- send / receive --------------------------------------------------------

  sendText(text) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify({ type: 'text', text }))
    return true
  }

  /** Queue 24 kHz PCM16 so consecutive chunks play with no gap or overlap. */
  enqueueAudio(b64) {
    const ctx = this.createPlaybackContext()
    this.resume(ctx)

    const floats = pcm16Base64ToFloat32(b64)
    const buffer = ctx.createBuffer(1, floats.length, PLAYBACK_SAMPLE_RATE)
    buffer.copyToChannel(floats, 0)

    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(ctx.destination)
    this.sources.add(src)
    src.onended = () => {
      this.sources.delete(src)
      try { src.disconnect() } catch {}
    }

    const now = ctx.currentTime
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

  // Barge-in: drop everything queued so the user's voice wins. The context
  // stays alive on purpose — closing it here meant the next reply chunk built a
  // fresh context outside any gesture, which is how replies went silent.
  stopPlayback() {
    for (const src of this.sources) {
      try { src.stop() } catch {}
      try { src.disconnect() } catch {}
    }
    this.sources.clear()
    this.playCursor = 0
    this.playingUntil = 0
    this.envelope = []
  }

  async stop() {
    clearInterval(this.watchdog)
    this.watchdog = null
    try { this.node?.disconnect() } catch {}
    try { this.sink?.disconnect() } catch {}
    try { this.source?.disconnect() } catch {}
    try { this.micStream?.getTracks().forEach(t => t.stop()) } catch {}
    try { await this.captureCtx?.close() } catch {}
    this.stopPlayback()
    try { await this.playbackCtx?.close() } catch {}
    this.micStream = null
    this.captureCtx = null
    this.playbackCtx = null
    this.source = null
    this.node = null
    this.sink = null
    this.stats.captureState = 'closed'
    this.stats.playbackState = 'closed'
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'close' }))
      this.ws.close()
    }
    this.ready = false
  }
}
