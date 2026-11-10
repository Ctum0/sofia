<script setup lang="ts">
// One floating window. Not a chat bubble, not a column: a thing she opened on
// the stage, which he can move, stack, and close.
import { computed, ref } from 'vue'

export interface SofiaWindowState {
  id: string
  kind: 'image' | 'web'
  url: string
  title: string
  x: number
  y: number
  w: number
  h: number
  z: number
}

const props = defineProps<{ win: SofiaWindowState, active: boolean }>()
const emit = defineEmits<{
  close: [id: string]
  focus: [id: string]
  move: [payload: { id: string, x: number, y: number }]
}>()

const host = computed(() => {
  try { return new URL(props.win.url, window.location.origin).host || 'this site' }
  catch { return 'this site' }
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
  const x = Math.max(0, Math.min(window.innerWidth - props.win.w, originX + event.clientX - startX))
  const y = Math.max(0, Math.min(window.innerHeight - 80, originY + event.clientY - startY))
  emit('move', { id: props.win.id, x, y })
}

function onUp() {
  dragging.value = false
  document.removeEventListener('mousemove', onMove)
  document.removeEventListener('mouseup', onUp)
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
    :data-active="active ? 'true' : 'false'"
    class="sofia-window"
    :class="{ 'sofia-window--active': active, 'sofia-window--dragging': dragging }"
    :style="{ left: `${win.x}px`, top: `${win.y}px`, width: `${win.w}px`, height: `${win.h}px`, zIndex: win.z }"
    @mousedown="emit('focus', win.id)"
  >
    <header class="sofia-window__bar" @mousedown="onDown">
      <span class="sofia-window__dot" aria-hidden="true" />
      <span class="sofia-window__title">{{ win.title || host }}</span>
      <span class="sofia-window__host">{{ host }}</span>
      <button v-if="win.kind === 'web'" type="button" class="sofia-window__btn" title="Open in a real tab" @click="openExternal">↗</button>
      <button type="button" class="sofia-window__btn" data-testid="sofia-window-close" aria-label="Close window" @click="emit('close', win.id)">✕</button>
    </header>

    <div v-if="win.kind === 'image'" class="sofia-window__body">
      <img :src="win.url" :alt="win.title || 'image'">
    </div>

    <div v-else class="sofia-window__body sofia-window__body--web">
      <p class="sofia-window__wtitle">{{ win.title || host }}</p>
      <p class="sofia-window__note">Sites refuse to be embedded, so this one opens in a real tab — or ask her to read it for you.</p>
      <button type="button" class="sofia-window__open" @click="openExternal">Open {{ host }}</button>
    </div>
  </section>
</template>

<style scoped>
.sofia-window {
  position: fixed;
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
