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
 */

type Status = 'idle' | 'connecting' | 'live' | 'error'

interface VoiceEvent {
  type: string
  dir?: 'in' | 'out'
  text?: string
  message?: string
  model?: string
}

interface VoiceStats {
  framesSent: number
  chunksPlayed: number
  errors: string[]
  levelPeak?: number
}

interface VoiceClient {
  stats: VoiceStats
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

// One object for the QA gate to read, rather than a global per render.
const transcripts: string[] = []
const telemetry: Record<string, unknown> = {
  status: 'idle',
  level: 0,
  peak: 0,
  framesSent: 0,
  chunksPlayed: 0,
  transcripts,
  errors: [] as string[],
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

async function loadClient(): Promise<VoiceClientModule> {
  // Served by the gateway next to the stage, so the harness and the product run
  // the same bytes. `@vite-ignore` keeps the bundler from trying to resolve it.
  return await import(/* @vite-ignore */ '/public/voice-client.mjs') as VoiceClientModule
}

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

  telemetry.status = status.value
  telemetry.level = Math.round(value * 100)
  telemetry.peak = peak
  telemetry.framesSent = client.stats.framesSent
  telemetry.chunksPlayed = client.stats.chunksPlayed
  telemetry.errors = client.stats.errors

  frame = requestAnimationFrame(tick)
}

async function start() {
  status.value = 'connecting'
  detail.value = ''
  peak = 0
  try {
    const { SofiaVoice } = await loadClient()
    const client = new SofiaVoice({
      onEvent: (event) => {
        if (event.type === 'ready') {
          status.value = 'live'
          detail.value = event.model || ''
        }
        else if (event.type === 'error') {
          status.value = 'error'
          detail.value = String(event.message || 'live error').slice(0, 120)
        }
        else if (event.type === 'transcript') {
          transcripts.push(`${event.dir === 'out' ? 'out' : 'in'}:${event.text}`)
        }
      },
    })
    voice.value = client
    await client.connect()
    await client.startMic()
    status.value = 'live'
    frame = requestAnimationFrame(tick)
  }
  catch (error) {
    status.value = 'error'
    detail.value = errorMessageFromUnknown(error, 'live failed').slice(0, 120)
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
  if (status.value === 'live' || status.value === 'connecting')
    void stop()
  else
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
  color: rgb(245 226 200 / 82%);
}

.sofia-voice__button {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.35rem 0.85rem;
  border-radius: 999px;
  border: 1px solid rgb(245 192 106 / 45%);
  background: rgb(28 18 12 / 72%);
  color: rgb(245 214 160);
  font-size: 0.75rem;
  letter-spacing: 0.02em;
  cursor: pointer;
  transition: border-color 160ms ease, background 160ms ease;
}

.sofia-voice__button:hover {
  border-color: rgb(245 192 106 / 85%);
  background: rgb(40 25 16 / 82%);
}

.sofia-voice__button.is-live {
  border-color: rgb(245 192 106);
  background: rgb(72 42 18 / 85%);
  color: rgb(255 236 205);
}

.sofia-voice__button.is-error {
  border-color: rgb(240 120 110 / 70%);
  color: rgb(255 200 195);
}

.sofia-voice__dot {
  width: 0.4rem;
  height: 0.4rem;
  border-radius: 999px;
  background: rgb(245 192 106 / 60%);
}

.sofia-voice__button.is-live .sofia-voice__dot {
  background: rgb(245 192 106);
  box-shadow: 0 0 0 3px rgb(245 192 106 / 22%);
}

.sofia-voice__meter {
  display: inline-block;
  width: 4.5rem;
  height: 0.25rem;
  border-radius: 999px;
  overflow: hidden;
  background: rgb(245 192 106 / 18%);
}

.sofia-voice__meter i {
  display: block;
  height: 100%;
  width: 100%;
  transform-origin: left center;
  background: linear-gradient(90deg, #f5c06a, #f08a6a);
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
