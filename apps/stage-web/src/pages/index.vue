<script setup lang="ts">
/* eslint-disable style/max-statements-per-line -- compact one-liners read better here than six-line guard clauses */
import Header from '@proj-airi/stage-layouts/components/Layouts/Header.vue'
import InteractiveArea from '@proj-airi/stage-layouts/components/Layouts/InteractiveArea.vue'
import MobileInteractiveArea from '@proj-airi/stage-layouts/components/Layouts/MobileInteractiveArea.vue'
import SofiaWindows from '@proj-airi/stage-layouts/components/Widgets/SofiaWindows.vue'

import { BackgroundProvider } from '@proj-airi/stage-layouts/components/Backgrounds'
import { useBackgroundThemeColor } from '@proj-airi/stage-layouts/composables/theme-color'
import { useBackgroundStore } from '@proj-airi/stage-layouts/stores/background'
import { HoloCoupon } from '@proj-airi/stage-ui/components'
import { ViewControlSlider, WidgetStage } from '@proj-airi/stage-ui/components/scenes'
import { useVoiceHoldKey } from '@proj-airi/stage-ui/composables/voice-hold'
import { useVoiceListening, useVoicePushToTalk } from '@proj-airi/stage-ui/composables/voice-input-mode'
import { useSettings } from '@proj-airi/stage-ui/stores/settings'
import { useStartupResourcesStore } from '@proj-airi/stage-ui/stores/startup-resources'
import { breakpointsTailwind, useBreakpoints, useMouse } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'

const paused = ref(false)
const modelRenderState = ref<'pending' | 'loading' | 'mounted'>('pending')
const modelRenderError = ref<Error>()
const startup = useStartupResourcesStore()
const { t } = useI18n()

watch([modelRenderState, modelRenderError, () => startup.resources.find(resource => resource.id === 'model')?.status], ([state, error, status]) => {
  if (status !== 'loading')
    return
  if (error)
    startup.fail('model', error)
  else if (state === 'mounted')
    startup.complete('model')
})

function markModelFailed(error: Error) {
  modelRenderError.value = error
}

function handleSettingsOpen(open: boolean) {
  paused.value = open
}

const breakpoints = useBreakpoints(breakpointsTailwind)
const isMobile = breakpoints.smaller('md')
const stageViewport = shallowRef({ height: 0, offsetTop: 0 })
// NOTICE:
// Why: A fixed Stage follows Safari's input pan and moves Live2D with the keyboard.
// Root cause: Safari moves the Visual Viewport before the page receives the new offsetTop value.
// Source: https://bugs.webkit.org/show_bug.cgi?id=265578
// Removal condition: Safari keeps fixed content stable during the input pan.
const stageSurfaceStyle = computed(() => isMobile.value
  ? {
      position: 'fixed' as const,
      inset: '0',
      height: stageViewport.value.height > 0 ? `${stageViewport.value.height}px` : '100dvh',
      transform: `translate3d(0, ${stageViewport.value.offsetTop}px, 0)`,
      willChange: 'transform',
    }
  : undefined)

const backgroundStore = useBackgroundStore()
const { selectedOption, sampledColor } = storeToRefs(backgroundStore)
const backgroundSurface = useTemplateRef<InstanceType<typeof BackgroundProvider>>('backgroundSurface')
const { stageModelRenderer } = storeToRefs(useSettings())

const { syncBackgroundTheme } = useBackgroundThemeColor({ backgroundSurface, selectedOption, sampledColor })
// --- the panel she opens beside herself -------------------------------------
// The dock receives `{type:'panel'}` from the gateway (a Live tool call decided
// it) and re-broadcasts it as a DOM event, so the stage does not have to know
// anything about sockets. `window.__sofiaPanel` is the same entry point for the
// gate, which cannot ask the model to call a tool on cue.
interface SofiaWindow { id: string, kind: 'image' | 'web', url: string, title: string, x: number, y: number, w: number, h: number, z: number }
const windows = ref<SofiaWindow[]>([])
let nextZ = 41
function closeWindow(id: string) {
  windows.value = windows.value.filter(w => w.id !== id)
}
function focusWindow(id: string) {
  windows.value = windows.value.map(w => (w.id === id ? { ...w, z: ++nextZ } : w))
}
function moveWindow(payload: { id: string, x: number, y: number }) {
  windows.value = windows.value.map(w => (w.id === payload.id ? { ...w, x: payload.x, y: payload.y } : w))
}
function showPanel(payload: { kind?: 'image' | 'web' | 'live', url: string, title?: string, sid?: string } | null) {
  if (!payload?.url) { windows.value = []; return }
  const kind = payload.kind === 'live' ? 'live' : payload.kind === 'web' ? 'web' : 'image'
  const existing = windows.value.find(w => w.url === payload.url)
  if (existing) { focusWindow(existing.id); return }
  const n = windows.value.length
  const vw = window.innerWidth
  const vh = window.innerHeight
  // She keeps the left of the stage; what she opens takes the right. A window
  // dropped in the middle covers the avatar, which is the thing he asked not to
  // happen.
  //
  // The shoulder is READ, not assumed: the first version placed windows by
  // "viewport minus width minus 48" and the 620 px default only cleared her at
  // >=1280 px. Measured on the live build 2026-11-10: at 1024 it started 74 px
  // over her (356 vs shoulder 430) and at 768 it started 476 px over her
  // (100 vs 576) — a 768-wide window is a tablet or a landscape phone, where
  // the dock does mount. So: measure her column, and when no real window fits
  // beside her, go low and wide instead of pretending — her head stays clear.
  const col = document.querySelector('.stage-column')?.getBoundingClientRect()
  // Read BEFORE the window exists, so the column is still at full width. What
  // matters is where it ends up AFTER `stage-column--narrow` applies, so take
  // the narrower of the two: 58% (the CSS says 56%; the measured post-open
  // column ran to 57.9% at 1280, and a shoulder 19 px short of hers is a
  // failure) and, below the media query's 768 px, the full width.
  const herW = Math.min(col ? col.width : vw, Math.round(vw * (vw <= 768 ? 1 : 0.58)))
  const shoulder = Math.round(herW * 0.75)
  const besideW = vw - shoulder - 48
  const beside = besideW >= 360
  const preferredW = kind === 'live' ? 680 : kind === 'web' ? 560 : 620
  const w = beside ? Math.min(preferredW, besideW) : vw - 48
  const x = beside ? Math.min(Math.max(shoulder, vw - w - 48 - n * 30), vw - w - 16) : 24
  const y = beside ? 104 + n * 28 : Math.max(96, Math.round(vh * 0.42))
  const h = Math.min(kind === 'live' ? 520 : kind === 'web' ? 320 : 440, Math.max(240, vh - y - 24))
  windows.value = [...windows.value, {
    id: `w${Date.now().toString(36)}${n}`,
    kind,
    url: payload.url,
    sid: payload.sid || '',
    title: payload.title || '',
    x,
    y,
    w,
    h,
    z: ++nextZ,
  }]
}
// The page navigated inside its window: keep the title bar honest.
function onRetitle(payload: { id: string, title: string, url: string }) {
  windows.value = windows.value.map(w => w.id === payload.id
    ? { ...w, title: payload.title || w.title, url: payload.url || w.url }
    : w)
}
const panel = computed(() => windows.value.length > 0)
function onPanelEvent(event: Event) {
  showPanel((event as CustomEvent<{ kind?: 'image' | 'web' | 'live', url: string, title?: string, sid?: string }>).detail)
}
onMounted(() => {
  window.addEventListener('sofia:panel', onPanelEvent)
  ;(window as unknown as { __sofiaPanel: typeof showPanel }).__sofiaPanel = showPanel
})
onBeforeUnmount(() => window.removeEventListener('sofia:panel', onPanelEvent))

onMounted(() => {
  syncBackgroundTheme()

  // Two upstream overlays outlive the stage. The boot splash stays until a
  // readiness signal that can arrive late or never; the startup overlay is
  // worse — `z-index: 10000`, full screen, and it swallows every pointer event
  // until its phase reaches "done". Measured 2026-11-10 with elementFromPoint:
  // a click on a window's title bar landed on `.startup-screen`, which is why
  // "clicking a window raises it" passed on three builds and failed on the next
  // four. The stage is mounted, so both have done their job. An ERROR screen is
  // kept, because it is the only thing that explains why nothing started.
  const clearOverlays = () => {
    document.getElementById('boot-splash')?.remove()
    const el = document.querySelector('.startup-screen')
    if (el && !el.classList.contains('startup-screen-error')) {
      // Hide it, never remove it: it is rendered through a Vue <Teleport>, and
      // deleting the node makes Vue throw "Cannot read properties of null
      // (reading 'insertBefore')" on the next patch (seen in the drag probe).
      el.style.display = 'none'
      el.style.pointerEvents = 'none'
      el.setAttribute('aria-hidden', 'true')
    }
  }
  clearOverlays()
  for (const delay of [800, 2500, 5000])
    setTimeout(clearOverlays, delay)
})

// Small screens offer no control for continuous listening, so only a voice call listens there.
useVoiceListening({ continuous: () => !isMobile.value })
// The page has no global shortcut, so Push to Talk uses Space while the stage page has focus.
useVoiceHoldKey(useVoicePushToTalk({
  onUnconfigured: () => toast(t('stage.chat.voice-composer.configure-title'), { description: t('stage.chat.voice-composer.configure-description') }),
}))

const { x: mouseX, y: mouseY } = useMouse()
const cursorPosition = computed(() => ({
  x: mouseX.value,
  y: mouseY.value,
}))

const router = useRouter()
</script>

<template>
  <BackgroundProvider
    ref="backgroundSurface"
    :class="['widgets top-widgets']"
    :background="selectedOption"
    :style="stageSurfaceStyle"
    :top-color="sampledColor"
  >
    <div
      data-testid="mobile-stage-content"
      :class="[
        'relative z-2 h-full w-100vw overflow-hidden md:h-100dvh',
        'flex flex-col',
      ]"
    >
      <!-- header -->
      <div :class="['w-full gap-2 px-0 py-1 md:px-3 md:py-3']">
        <Header :class="['hidden md:flex']" />
      </div>
      <!-- page -->
      <div :class="['relative flex flex-1 flex-row gap-x-2 gap-y-0 <md:flex-col']">
        <div :class="['relative min-w-1/2 flex-1 stage-column', panel ? 'stage-column--narrow' : '']">
          <div
            v-if="!isMobile || stageModelRenderer !== 'live2d'"
            :class="[
              'absolute left-0 z-15 px-3',
              stageModelRenderer === 'live2d' ? 'top-0 h-full py-[20vh]' : 'top-1/2 -translate-y-1/2',
            ]"
          >
            <ViewControlSlider />
          </div>
          <WidgetStage
            v-model:state="modelRenderState"
            :class="['h-full w-full']"
            :cursor-position="cursorPosition"
            :enable-orbit-controls="!isMobile"
            :paused="paused"
            @error="markModelFailed"
            @select-avatar-model="router.push('/settings/models')"
          />
        </div>
        <!-- A fixed width keeps the chat panel narrow on wide screens. A percentage minimum overrode the maximum there. -->
        <InteractiveArea v-if="!isMobile && !panel" :class="['absolute right-4 h-[85dvh] w-[min(440px,45%)] flex flex-col']" />
        <!-- She moves aside rather than being covered: the column above narrows,
             and what she wants to show takes the space she gave up. Mounted on
             every width: the dock only exists on desktop, so a phone can only
             receive a window through the gate hook — and a dropped event is
             worse than a small window (rule: no fabricated capability). -->
        <SofiaWindows
          :windows="windows"
          @close="closeWindow"
          @focus="focusWindow"
          @move="moveWindow"
          @retitle="onRetitle"
        />
      </div>
      <HoloCoupon />
    </div>
    <Teleport to="body">
      <MobileInteractiveArea
        v-if="isMobile"
        @settings-open="handleSettingsOpen"
        @stage-viewport-change="stageViewport = $event"
      />
    </Teleport>
  </BackgroundProvider>
</template>

<route lang="yaml">
name: IndexScenePage
meta:
  layout: stage
  stageTransition:
    name: bubble-wave-out
</route>

<style scoped>
.stage-column {
  transition: max-width 0.45s cubic-bezier(0.16, 1, 0.3, 1), flex-basis 0.45s cubic-bezier(0.16, 1, 0.3, 1);
  max-width: 100%;
}
.stage-column--narrow {
  max-width: 56%;
}
@media (max-width: 768px) {
  .stage-column--narrow { max-width: 100%; }
}
</style>
