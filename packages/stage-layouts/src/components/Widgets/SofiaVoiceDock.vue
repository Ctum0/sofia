<script setup lang="ts">
import { errorMessageFromUnknown } from '@proj-airi/stage-shared'
import { useSpeakingStore } from '@proj-airi/stage-ui/stores/audio'
import { computed, onBeforeUnmount, ref, shallowRef } from 'vue'

/**
 * Sofia's live voice dock.
 *
 * The button opens one Gemini Live session through the gateway (`/public/voice-client.mjs`
 * holds the browser half); the same module drives the mouth. The stage already
 * renders `useSpeakingStore().mouthOpenSize` into the Live2D `ParamMouthOpenY`, so
 * the only job here is to turn the level envelope of the audio being played into
 * that value — the mouth follows the 24 kHz PCM the model actually sent, not a
 * timer and not the microphone.
 *
 * Two things this file must get right, because both failures are invisible:
 * the module is preloaded and the audio contexts are unlocked *inside* the click
 * (browsers grant sound only to a context created or resumed while a gesture is
 * being handled), and `stats` is mirrored onto `window.__sofiaVoice` so a person
 * — or the QA gate — can see frames, context states and the last error instead
 * of guessing why nobody is talking.
 */

type Status = 'idle' | 'connecting' | 'live' | 'error'

interface VoiceEvent {
  type: string
  dir?: 'in' | 'out'
  text?: string
  message?: string
  model?: string
  resumed?: boolean
  retrying?: boolean
  attempt?: number
}

interface VoiceStats {
  frames: number
  framesSent: number
  chunksPlayed: number
  captureState: string
  playbackState: string
  captureRate: number
  playbackRate: number
  micWarning: string
  lastError: string
  errors: string[]
  levelPeak?: number
}

interface VoiceClient {
  stats: VoiceStats
  unlock: () => { capture: string, playback: string }
  getLevel: () => number
  isPlaying: () => boolean
  connect: () => Promise<void>
  startMic: () => Promise<void>
  stop: () => Promise<void>
}

interface VoiceClientModule {
  SofiaVoice: new (options: { onEvent: (event: VoiceEvent) => void }) => VoiceClient
}

declare global {
  interface Window {
    __sofiaVoice: Record<string, unknown>
  }
}

const speaking = useSpeakingStore()

const status = ref<Status>('idle')
const level = ref(0)
const detail = ref('')
const voice = shallowRef<VoiceClient | null>(null)

let frame = 0
let peak = 0

// One object for the QA gate to read, rather than a global per render. It
// carries the client's own `stats` verbatim, so frames and context states are
// visible without reaching inside the module.
const transcripts: string[] = []
const telemetry: Record<string, unknown> = {
  status: 'idle',
  level: 0,
  peak: 0,
  frames: 0,
  framesSent: 0,
  chunksPlayed: 0,
  captureState: 'none',
  playbackState: 'none',
  detail: '',
  lastError: '',
  transcripts,
  errors: [] as string[],
  stats: null,
}
window.__sofiaVoice = telemetry

const label = computed(() => {
  if (status.value === 'live')
    return 'Stop'
  if (status.value === 'connecting')
    return 'Connecting…'
  if (status.value === 'error')
    return 'Retry'
  return 'Talk'
})

let clientModule: Promise<VoiceClientModule> | null = null

function loadClient(): Promise<VoiceClientModule> {
  // Served by the gateway next to the stage, so the harness and the product run
  // the same bytes. `@vite-ignore` keeps the bundler from trying to resolve it.
  clientModule ??= import(/* @vite-ignore */ '/public/voice-client.mjs') as Promise<VoiceClientModule>
  return clientModule
}

function handleEvent(event: VoiceEvent) {
  if (event.type === 'ready') {
    // A second `ready` means the gateway swapped the Google socket underneath a
    // conversation that is already open — the Talk button never moved.
    status.value = 'live'
    detail.value = event.resumed ? '' : event.model || ''
  }
  else if (event.type === 'goAway' || event.type === 'reconnecting') {
    // Not fatal: the server is re-opening the upstream socket with the stored
    // resumption handle. Say so instead of leaving the dock lying about state.
    detail.value = 'reconnecting…'
  }
  else if (event.type === 'gone' || (event.type === 'closed' && event.retrying === false)) {
    // The gateway gave up after its retry budget: this really is over, and the
    // person gets a sentence plus a Talk button that starts a fresh session.
    status.value = 'error'
    detail.value = String(event.message || `live session ended${event.type === 'closed' ? ' — press Talk to restart' : ''}`).slice(0, 120)
  }
  else if (event.type === 'error') {
    status.value = 'error'
    detail.value = String(event.message || 'live error').slice(0, 120)
  }
  else if (event.type === 'transcript') {
    transcripts.push(`${event.dir === 'out' ? 'out' : 'in'}:${event.text}`)
  }
  else if (event.type === 'warn' || event.type === 'mic-retry') {
    // Not fatal — the session is still open — but it is the only explanation
    // the person gets for hearing nothing or not being heard.
    detail.value = String(event.message || '').slice(0, 120)
  }
  else if (event.type === 'warn-cleared' && status.value === 'live') {
    detail.value = ''
  }
}

/** Built before the click so `unlock()` can run synchronously inside it. */
const prepared = shallowRef<VoiceClient | null>(null)
void loadClient()
  .then(({ SofiaVoice }) => { prepared.value = new SofiaVoice({ onEvent: handleEvent }) })
  .catch(() => {})

function tick() {
  const client = voice.value
  if (!client)
    return

  const value = client.getLevel()
  level.value = value
  const mouth = Math.min(100, Math.round(value * 100))
  if (mouth > peak)
    peak = mouth

  if (client.isPlaying()) {
    speaking.nowSpeaking = true
    speaking.mouthOpenSize = mouth
  }
  else if (speaking.nowSpeaking) {
    speaking.nowSpeaking = false
    speaking.mouthOpenSize = 0
  }

  const stats = client.stats
  telemetry.status = status.value
  telemetry.level = Math.round(value * 100)
  telemetry.peak = peak
  telemetry.frames = stats.frames
  telemetry.framesSent = stats.framesSent
  telemetry.chunksPlayed = stats.chunksPlayed
  telemetry.captureState = stats.captureState
  telemetry.playbackState = stats.playbackState
  telemetry.detail = detail.value
  telemetry.lastError = stats.lastError
  telemetry.errors = stats.errors
  telemetry.stats = stats

  frame = requestAnimationFrame(tick)
}

async function start() {
  status.value = 'connecting'
  detail.value = ''
  peak = 0
  try {
    let client = prepared.value
    prepared.value = null
    if (!client) {
      const { SofiaVoice } = await loadClient()
      client = new SofiaVoice({ onEvent: handleEvent })
    }
    voice.value = client
    // Mirrored before the first tick so a human (or the gate) can read the
    // context states while the session is still connecting.
    telemetry.stats = client.stats
    // The click already unlocked; this covers the path where the module was
    // still loading then, and is a no-op when the contexts are running.
    client.unlock()
    await client.connect()
    await client.startMic()
    status.value = 'live'
    frame = requestAnimationFrame(tick)
  }
  catch (error) {
    status.value = 'error'
    detail.value = errorMessageFromUnknown(error, 'live failed').slice(0, 120)
    telemetry.lastError = detail.value
    await stop()
    status.value = 'error'
  }
}

async function stop() {
  if (frame) {
    cancelAnimationFrame(frame)
    frame = 0
  }
  const client = voice.value
  voice.value = null
  try {
    await client?.stop()
  }
  catch {}
  level.value = 0
  speaking.nowSpeaking = false
  speaking.mouthOpenSize = 0
  if (status.value !== 'error')
    status.value = 'idle'
}

function toggle() {
  if (status.value === 'live' || status.value === 'connecting') {
    void stop()
    return
  }
  // Synchronously, inside the gesture: an AudioContext created or resumed after
  // an await is denied on Safari and silently suspended on Chrome, which is how
  // a working session ends up mute.
  const target = voice.value ?? prepared.value
  target?.unlock()
  void start()
}

onBeforeUnmount(() => {
  void stop()
})
</script>

<template>
  <div
    class="sofia-voice"
    data-testid="sofia-voice-dock"
    :data-status="status"
    :data-level="Math.round(level * 100)"
    :data-peak="peak"
  >
    <button
      id="sofia-talk"
      type="button"
      class="sofia-voice__button"
      :class="{ 'is-live': status === 'live', 'is-error': status === 'error' }"
      :aria-label="status === 'live' ? 'Stop talking to Sofia' : 'Talk to Sofia'"
      @click="toggle"
    >
      <span class="sofia-voice__dot" />
      <span>{{ label }}</span>
    </button>
    <span class="sofia-voice__meter" aria-hidden="true">
      <i :style="{ transform: `scaleX(${Math.max(0.02, level)})` }" />
    </span>
    <span v-if="detail" class="sofia-voice__detail">{{ detail }}</span>
  </div>
</template>

<style scoped>
.sofia-voice {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.25rem 0 0.5rem;
  justify-content: center;
  font-size: 0.75rem;
  color: color-mix(in srgb, var(--sofia-text, #f5e6d3) 82%, transparent);
}

.sofia-voice__button {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.35rem 0.85rem;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--sofia-accent, #7b1f2b) 85%, transparent);
  background: var(--sofia-panel, #171012);
  color: var(--sofia-text, #f5e6d3);
  font-size: 0.75rem;
  letter-spacing: 0.02em;
  cursor: pointer;
  transition: border-color 160ms ease, background 160ms ease;
}

.sofia-voice__button:hover {
  border-color: var(--sofia-accent-hover, #a3283a);
  background: color-mix(in srgb, var(--sofia-accent, #7b1f2b) 32%, var(--sofia-panel, #171012));
}

.sofia-voice__button.is-live {
  border-color: var(--sofia-accent-hover, #a3283a);
  background: color-mix(in srgb, var(--sofia-accent, #7b1f2b) 68%, var(--sofia-panel, #171012));
  color: var(--sofia-text, #f5e6d3);
}

.sofia-voice__button.is-error {
  border-color: rgb(240 120 110 / 70%);
  color: rgb(255 200 195);
}

.sofia-voice__dot {
  width: 0.4rem;
  height: 0.4rem;
  border-radius: 999px;
  background: color-mix(in srgb, var(--sofia-accent-hover, #a3283a) 70%, transparent);
}

.sofia-voice__button.is-live .sofia-voice__dot {
  background: var(--sofia-accent-hover, #a3283a);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--sofia-accent-hover, #a3283a) 26%, transparent);
}

.sofia-voice__meter {
  display: inline-block;
  width: 4.5rem;
  height: 0.25rem;
  border-radius: 999px;
  overflow: hidden;
  background: color-mix(in srgb, var(--sofia-accent-hover, #a3283a) 22%, transparent);
}

.sofia-voice__meter i {
  display: block;
  height: 100%;
  width: 100%;
  transform-origin: left center;
  background: linear-gradient(90deg, var(--sofia-accent, #7b1f2b), var(--sofia-accent-hover, #a3283a));
  transition: transform 60ms linear;
}

.sofia-voice__detail {
  max-width: 12rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.7;
}
</style>
