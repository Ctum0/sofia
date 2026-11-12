<script setup lang="ts">
/* eslint-disable style/max-statements-per-line -- compact one-liners read better here than six-line guard clauses */
// One floating window. Not a chat bubble, not a column: a thing she opened on
// the stage, which he can move, stack, and close.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

export interface SofiaWindowState {
  id: string
  kind: 'image' | 'web' | 'live'
  url: string
  sid?: string
  title: string
  x: number
  y: number
  w: number
  h: number
  z: number
  tick?: number
}

const props = defineProps<{ win: SofiaWindowState, active: boolean }>()
const emit = defineEmits<{
  close: [id: string]
  focus: [id: string]
  move: [payload: { id: string, x: number, y: number }]
  retitle: [payload: { id: string, title: string, url: string }]
}>()

const host = computed(() => {
  try {
    return new URL(props.win.url, window.location.origin).host || 'this site'
  }
  catch {
    return 'this site'
  }
})

// --- a live page -------------------------------------------------------------
// The browser service renders 1280x800; the window shows that picture and maps
// a click back into page coordinates. No iframe anywhere: real sites refuse.
const PAGE = { w: 1280, h: 800 }
const frameTick = ref(0)
const frameData = ref('')
const busy = ref(false)
const frameSrc = computed(() => frameData.value || `/api/browse/frame?sid=${encodeURIComponent(props.win.sid || '')}&t=${frameTick.value}`)

// The page changed under her: take a new picture. Without this the window shows
// the frame from when it opened and every click she makes looks ignored.
watch(() => props.win.tick, (next) => {
  if (!next || !props.win.sid)
    return
  frameData.value = ''
  frameTick.value = next
})

async function act(action: string, extra: Record<string, unknown> = {}) {
  if (!props.win.sid || busy.value)
    return
  busy.value = true
  try {
    const res = await fetch('/api/browse/act', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sid: props.win.sid, action, ...extra }),
    })
    const body = await res.json()
    if (body?.png) {
      frameData.value = `data:image/png;base64,${body.png}`
      if (body.url)
        emit('retitle', { id: props.win.id, title: body.title || props.win.title, url: body.url })
    }
  }
  catch { /* a dead page shows its last frame; the toolbar can reload */ }
  finally { busy.value = false }
}

// One place that records "the user touched this window", so the idle deadline is
// about real use rather than about which child received the event.
function onAnyInteraction() {
  emit('focus', props.win.id)
  touchInteraction()
}

function onPageClick(event: MouseEvent) {
  touchInteraction()
  const img = event.currentTarget as HTMLImageElement
  const rect = img.getBoundingClientRect()
  const x = Math.round((event.clientX - rect.left) * (PAGE.w / rect.width))
  const y = Math.round((event.clientY - rect.top) * (PAGE.h / rect.height))
  void act('click', { x, y })
}

function onWheel(event: WheelEvent) {
  touchInteraction()
  const img = event.currentTarget as HTMLImageElement
  const rect = img.getBoundingClientRect()
  const x = Math.round((event.clientX - rect.left) * (PAGE.w / rect.width))
  const y = Math.round((event.clientY - rect.top) * (PAGE.h / rect.height))
  void act('scroll', { x, y, text: String(Math.sign(event.deltaY) * 500) })
}

onMounted(() => {
  if (props.win.kind === 'live')
    frameTick.value++
})

// --- when a live window is allowed to keep its page alive ------------------
//
// The browser suspends a page nobody has used, and resumes it from its URL when
// it is needed again, so a missed heartbeat costs a ~2 s wake-up, not a dead
// window. The rule is therefore about *use*, not about being on screen:
//
//   visible AND the tab is in front AND something has happened on it recently
//   -> beat, so the page stays live and a click is instant
//
//   on screen but untouched for INTERACTION_IDLE_MS -> stop beating: the
//   browser suspends it and the CPU goes away. The window keeps its last frame
//   and says so; the first click or key brings it back.
//
// A window left open on a foreground tab overnight is exactly the case that
// measured 595 % CPU, so it must go quiet even though it is visible.
const INTERACTION_IDLE_MS = 5 * 60 * 1000
let heartbeat: ReturnType<typeof setInterval> | undefined
let lastInteraction = Date.now()
const sleeping = ref(false)

function beat() {
  if (!props.win.sid || document.visibilityState !== 'visible')
    return
  if (Date.now() - lastInteraction > INTERACTION_IDLE_MS) {
    // Long enough untouched: let it suspend. The frame on screen stays.
    if (!sleeping.value) {
      sleeping.value = true
      stopHeartbeat()
    }
    return
  }
  void fetch('/api/browse/touch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sid: props.win.sid }),
  }).catch(() => {})
}
function startHeartbeat() {
  if (heartbeat || props.win.kind !== 'live' || !props.win.sid)
    return
  beat()
  heartbeat = setInterval(beat, 45000)
}
function stopHeartbeat() {
  if (heartbeat)
    clearInterval(heartbeat)
  heartbeat = undefined
}
// Any real interaction counts as use, and wakes a sleeping page.
function touchInteraction() {
  lastInteraction = Date.now()
  if (sleeping.value) {
    sleeping.value = false
    // The next frame fetch resumes the page from its URL.
    frameData.value = ''
    frameTick.value += 1
  }
  startHeartbeat()
}
// A tab in the background is not being looked at, so it must not keep a page
// alive: stop on hide, resume on return, and stop for good on unmount.
function onVisibility() {
  if (document.visibilityState === 'visible') {
    lastInteraction = Date.now()
    startHeartbeat()
  }
  else {
    stopHeartbeat()
  }
}
// A window can mount before it knows its page: `showPanel` creates a live window
// with `sid: ''` and the panel event patches the real one in afterwards, so a
// mount-time-only guard skips exactly those windows.
watch(() => props.win.sid, () => startHeartbeat())

onMounted(() => {
  touchInteraction()
  document.addEventListener('visibilitychange', onVisibility)
})
onBeforeUnmount(() => {
  stopHeartbeat()
  document.removeEventListener('visibilitychange', onVisibility)
})

const dragging = ref(false)
let startX = 0
let startY = 0
let originX = 0
let originY = 0

// Plain mouse events with document listeners. Pointer capture on a child of a
// `position: fixed` layer did not fire in headless Chromium — the first gate run
// could neither raise nor drag a window.
function onMove(event: MouseEvent) {
  if (!dragging.value)
    return
  // A mouseup released outside the page (browser chrome, OS bar, past the viewport)
  // is never delivered to document, so the window follows the cursor forever with
  // `--dragging` on and swallows every click on its own ✕. A move with no button
  // held IS the missed release.
  if (event.buttons === 0) {
    onUp()
    return
  }
  const x = Math.max(0, Math.min(window.innerWidth - props.win.w, originX + event.clientX - startX))
  const y = Math.max(0, Math.min(window.innerHeight - 80, originY + event.clientY - startY))
  emit('move', { id: props.win.id, x, y })
}

function onUp() {
  dragging.value = false
  document.removeEventListener('mousemove', onMove)
  document.removeEventListener('mouseup', onUp)
  window.removeEventListener('blur', onUp)
}

function onDown(event: MouseEvent) {
  if ((event.target as HTMLElement).closest('button'))
    return
  emit('focus', props.win.id)
  dragging.value = true
  startX = event.clientX
  startY = event.clientY
  originX = props.win.x
  originY = props.win.y
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
  // A drag interrupted by the tab losing focus (alt-tab, a native dialog) never
  // gets its mouseup either.
  window.addEventListener('blur', onUp)
}

function openExternal() {
  window.open(props.win.url, '_blank', 'noopener,noreferrer')
}
</script>

<template>
  <section
    data-testid="sofia-window"
    :data-window-id="win.id"
    :data-kind="win.kind"
    :data-url="win.url || ''"
    :data-active="active ? 'true' : 'false'"
    class="sofia-window"
    :class="{ 'sofia-window--active': active, 'sofia-window--dragging': dragging }"
    :style="{ left: `${win.x}px`, top: `${win.y}px`, width: `${win.w}px`, height: `${win.h}px`, zIndex: win.z }"
    @mousedown="onAnyInteraction"
  >
    <header class="sofia-window__bar" @mousedown="onDown">
      <span class="sofia-window__dot" aria-hidden="true" />
      <span class="sofia-window__title">{{ win.title || host }}</span>
      <span class="sofia-window__host">{{ host }}</span>
      <button v-if="win.kind === 'web'" type="button" class="sofia-window__btn" title="Open in a real tab" @click="openExternal">
        ↗
      </button>
      <button type="button" class="sofia-window__btn" data-testid="sofia-window-close" aria-label="Close window" @click="emit('close', win.id)">
        ✕
      </button>
    </header>

    <div v-if="win.kind === 'image'" class="sofia-window__body">
      <img :src="win.url" :alt="win.title || 'image'">
    </div>

    <div v-else-if="win.kind === 'live'" class="sofia-window__body sofia-window__body--live">
      <div class="sofia-window__tools">
        <button type="button" class="sofia-window__btn" title="Back" @click="act('back')">
          ←
        </button>
        <button type="button" class="sofia-window__btn" title="Reload" @click="act('reload')">
          ⟳
        </button>
        <span class="sofia-window__urltab">{{ host }}</span>
      </div>
      <img
        class="sofia-window__page"
        :src="frameSrc"
        alt=""
        draggable="false"
        @pointerdown="onPageClick"
        @wheel.prevent="onWheel"
      >
      <!-- Sleeping on purpose: the page was suspended to stop it burning CPU,
           and the click that wakes it also acts on it. Saying so is the
           difference between a deliberate sleep and a window that looks broken. -->
      <p v-if="sleeping" class="sofia-window__asleep">
        Asleep to save power — click to wake
      </p>
    </div>

    <div v-else class="sofia-window__body sofia-window__body--web">
      <p class="sofia-window__wtitle">
        {{ win.title || host }}
      </p>
      <p class="sofia-window__note">
        Sites refuse to be embedded, so this one opens in a real tab — or ask her to read it for you.
      </p>
      <button type="button" class="sofia-window__open" @click="openExternal">
        Open {{ host }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.sofia-window {
  position: fixed;
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid #2a1a1e;
  border-radius: 14px;
  background: #171012;
  box-shadow: 0 26px 70px -24px rgb(0 0 0 / 0.85);
  transition: box-shadow 0.2s ease, border-color 0.2s ease;
}
.sofia-window--active { border-color: #7b1f2b; box-shadow: 0 30px 80px -22px rgb(0 0 0 / 0.9); }
.sofia-window--dragging { transition: none; }
.sofia-window__bar {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.55rem 0.7rem;
  border-bottom: 1px solid #2a1a1e;
  background: #1d1215;
  cursor: grab;
  user-select: none;
}
.sofia-window__dot { width: 0.5rem; height: 0.5rem; border-radius: 999px; background: #7b1f2b; }
.sofia-window__title { font-size: 0.8rem; color: #f5e6d3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sofia-window__host { margin-left: auto; font-size: 0.7rem; color: #8f7a72; }
.sofia-window__btn {
  border: 1px solid #3a2226;
  background: transparent;
  color: #c98b8b;
  border-radius: 7px;
  width: 1.6rem;
  height: 1.6rem;
  cursor: pointer;
}
.sofia-window__btn:hover { background: #2a1a1e; color: #f5e6d3; }
.sofia-window__body { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; padding: 0.7rem; }
.sofia-window__body img { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 10px; }
.sofia-window__body--live { flex-direction: column; align-items: stretch; padding: 0; gap: 0; }
.sofia-window__tools {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.35rem 0.55rem;
  border-bottom: 1px solid #2a1a1e;
  background: #140e10;
}
.sofia-window__urltab { font-size: 0.7rem; color: #8f7a72; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sofia-window__page { width: 100%; flex: 1; min-height: 0; object-fit: fill; cursor: crosshair; border-radius: 0 0 13px 13px; }
.sofia-window__body--live { position: relative; }
.sofia-window__asleep {
  position: absolute;
  left: 0.5rem;
  bottom: 0.5rem;
  margin: 0;
  padding: 0.25rem 0.55rem;
  border-radius: 999px;
  background: #171012e6;
  border: 1px solid #3a2226;
  color: #c98b8b;
  font-size: 0.7rem;
  pointer-events: none;
}
.sofia-window__body--web { flex-direction: column; gap: 0.5rem; text-align: center; }
.sofia-window__wtitle { color: #f5e6d3; font-size: 0.95rem; }
.sofia-window__note { color: #8f7a72; font-size: 0.76rem; max-width: 26rem; }
.sofia-window__open {
  border: 1px solid #7b1f2b;
  background: #7b1f2b;
  color: #f5e6d3;
  border-radius: 999px;
  padding: 0.4rem 0.95rem;
  font-size: 0.78rem;
  cursor: pointer;
}
.sofia-window__open:hover { background: #a3283a; }
</style>
