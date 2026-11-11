<script setup lang="ts">
/* eslint-disable style/max-statements-per-line -- compact one-liners read better here than six-line guard clauses */
import Header from '@proj-airi/stage-layouts/components/Layouts/Header.vue'
import InteractiveArea from '@proj-airi/stage-layouts/components/Layouts/InteractiveArea.vue'
import MobileInteractiveArea from '@proj-airi/stage-layouts/components/Layouts/MobileInteractiveArea.vue'
import SofiaVoiceDock from '@proj-airi/stage-layouts/components/Widgets/SofiaVoiceDock.vue'
import SofiaWindows from '@proj-airi/stage-layouts/components/Widgets/SofiaWindows.vue'

import { BackgroundProvider } from '@proj-airi/stage-layouts/components/Backgrounds'
import { useBackgroundThemeColor } from '@proj-airi/stage-layouts/composables/theme-color'
import { useBackgroundStore } from '@proj-airi/stage-layouts/stores/background'
import { HoloCoupon } from '@proj-airi/stage-ui/components'
import { ViewControlSlider, WidgetStage } from '@proj-airi/stage-ui/components/scenes'
import { useVoiceHoldKey } from '@proj-airi/stage-ui/composables/voice-hold'
import { useVoiceListening, useVoicePushToTalk } from '@proj-airi/stage-ui/composables/voice-input-mode'
import { useChatStore } from '@proj-airi/stage-ui/stores/chat'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
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

// Her own size and place: JARVIS steps aside, he does not resize himself.
const avatarScale = ref(1)
const avatarX = ref(0)
const avatarY = ref(0)
const avatarVars = computed(() => ({
  '--sofia-avatar-scale': String(avatarScale.value),
  '--sofia-avatar-x': `${avatarX.value}px`,
  '--sofia-avatar-y': `${avatarY.value}px`,
}))

function applyAvatar(payload: { action?: string, scale?: number, step?: number, x?: number, y?: number }) {
  if (String(payload.action || 'set').toLowerCase() === 'reset') {
    avatarScale.value = 1
    avatarX.value = 0
    avatarY.value = 0
    return
  }
  // A size word is a step, not a fixed size: saying "make yourself smaller"
  // twice has to leave her smaller than saying it once. A fixed 0.65 made the
  // second ask a no-op, so a command that worked read as a broken one.
  if (Number.isFinite(payload.step))
    avatarScale.value = Math.max(0.35, Math.min(1.6, avatarScale.value + Number(payload.step)))
  else if (Number.isFinite(payload.scale))
    avatarScale.value = Math.max(0.35, Math.min(1.6, Number(payload.scale)))
  if (Number.isFinite(payload.x))
    avatarX.value = Math.max(-600, Math.min(600, Number(payload.x)))
  if (Number.isFinite(payload.y))
    avatarY.value = Math.max(-400, Math.min(400, Number(payload.y)))
}

// Her size and place were being written into CSS variables that nothing read,
// so "make yourself smaller" logged as applied and changed nothing on screen.
// The shell below consumes them; getBoundingClientRect moves with a transform,
// which is exactly what the gate asserts.
const avatarTransform = computed(() => ({
  transform: `translate3d(${avatarX.value}px, ${avatarY.value}px, 0) scale(${avatarScale.value})`,
  transformOrigin: '50% 100%',
}))

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
// She can arrange her own windows: the tool sends { kind: 'control', action }
// and this applies it to the real window list.
function windowFor(target: string) {
  if (!windows.value.length)
    return null
  if (target === 'first')
    return windows.value[0]
  if (target === 'last')
    return windows.value[windows.value.length - 1]
  return windows.value.find(w => w.id === target) || windows.value[windows.value.length - 1]
}

function clampWindow(win: { x: number, y: number, w: number, h: number }) {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const w = Math.max(260, Math.min(win.w, vw - 32))
  const h = Math.max(60, Math.min(win.h, vh - 48))
  const x = Math.max(0, Math.min(win.x, vw - w))
  const y = Math.max(0, Math.min(win.y, vh - h))
  return { x, y, w, h }
}

function applyControl(payload: { action: string, target?: string, x?: number, y?: number, width?: number, height?: number }) {
  const action = String(payload.action || '').toLowerCase()
  if (action === 'close_all') {
    windows.value = []
    return
  }
  if (action === 'tile') {
    // Right half, stacked: every window keeps its width, the heights divide.
    const vw = window.innerWidth
    const vh = window.innerHeight
    const n = windows.value.length || 1
    const w = Math.max(320, Math.round(vw * 0.45))
    const h = Math.max(180, Math.floor((vh - 140 - (n - 1) * 12) / n))
    const x = vw - w - 32
    windows.value = windows.value.map((win, index) => ({
      ...win,
      ...clampWindow({ x, y: 96 + index * (h + 12), w, h }),
    }))
    return
  }
  const target = windowFor(String(payload.target || 'last'))
  if (!target)
    return
  if (action === 'close') {
    windows.value = windows.value.filter(w => w.id !== target.id)
    return
  }
  if (action === 'focus') {
    focusWindow(target.id)
    return
  }
  const next = { ...target }
  if (action === 'resize') {
    if (payload.width)
      next.w = payload.width
    if (payload.height)
      next.h = payload.height
  }
  else if (action === 'move') {
    // 'left' and 'right' exist because the stage is hers: a window that can only
    // ever sit on the right half is not arrangement, it is a fixed panel.
    const spot = String((payload as { position?: string }).position || '').toLowerCase()
    if (spot === 'left')
      next.x = 24
    else if (spot === 'center')
      next.x = Math.round((window.innerWidth - next.w) / 2)
    else if (spot === 'right')
      next.x = window.innerWidth - next.w - 24
    if (payload.x !== undefined)
      next.x = payload.x
    if (payload.y !== undefined)
      next.y = payload.y
  }
  else if (action === 'maximize') {
    next.w = Math.round(window.innerWidth * 0.5)
    next.h = window.innerHeight - 150
    next.x = window.innerWidth - next.w - 32
    next.y = 96
  }
  else if (action === 'minimize') {
    next.h = 62
  }
  Object.assign(next, clampWindow(next))
  windows.value = windows.value.map(w => (w.id === target.id ? { ...next, z: ++nextZ } : w))
}

function showPanel(payload: { kind?: 'image' | 'web' | 'live', url: string, title?: string, sid?: string } | null) {
  if ((payload as { kind?: string })?.kind === 'control') {
    applyControl(payload as unknown as { action: string })
    return
  }
  const kindOf = (payload as { kind?: string })?.kind
  if (kindOf === 'avatar') {
    applyAvatar(payload as unknown as { action?: string, scale?: number, x?: number, y?: number })
    return
  }
  if (kindOf === 'control') {
    applyControl(payload as unknown as { action: string })
    return
  }
  if (!payload?.url) { windows.value = []; return }
  const kind = payload.kind === 'live' ? 'live' : payload.kind === 'web' ? 'web' : 'image'
  // A live window is identified by its page session, not its address. Matching
  // on URL meant "click Sign in" opened a *second* window for /login while the
  // first still showed github.com — the title bar lied, and the gate read the
  // old address. Same sid updates in place; same URL still just raises.
  const bySid = payload.sid ? windows.value.find(w => w.sid && w.sid === payload.sid) : null
  if (bySid) {
    windows.value = windows.value.map(w => w.id === bySid.id
      ? { ...w, url: payload.url || w.url, title: payload.title || w.title, tick: (payload as { tick?: number }).tick || w.tick }
      : w)
    focusWindow(bySid.id)
    return
  }
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
    tick: (payload as { tick?: number }).tick || 0,
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

// The chat takes a fifth of the width and never yields below 1024 px. With one
// window that is tight; with three it is unusable. A toggle gives the space
// back, and remembers the choice.
const CHAT_KEY = 'sofia-chat-hidden'
const chatHidden = ref(false)
onMounted(() => {
  try { chatHidden.value = localStorage.getItem(CHAT_KEY) === '1' }
  catch {}
})
function toggleChat() {
  chatHidden.value = !chatHidden.value
  try { localStorage.setItem(CHAT_KEY, chatHidden.value ? '1' : '0') }
  catch {}
}

// A refresh used to throw every window away. The shape is saved; a live page is
// reopened by URL on restore because its server-side session id died with the
// page.
const STAGE_KEY = 'sofia-stage-v1'
let restoring = false

function saveStage() {
  if (restoring)
    return
  try {
    const shape = windows.value.map(w => ({ kind: w.kind, url: w.url, title: w.title, x: w.x, y: w.y, w: w.w, h: w.h, z: w.z }))
    localStorage.setItem(STAGE_KEY, JSON.stringify({
      windows: shape,
      chatHidden: chatHidden.value,
      avatar: { scale: avatarScale.value, x: avatarX.value, y: avatarY.value },
    }))
  }
  catch {}
}

async function restoreStage() {
  let saved
  try { saved = JSON.parse(localStorage.getItem(STAGE_KEY) || 'null') }
  catch { return }
  if (!saved)
    return
  restoring = true
  try {
    if (saved.avatar) {
      avatarScale.value = Number(saved.avatar.scale) || 1
      avatarX.value = Number(saved.avatar.x) || 0
      avatarY.value = Number(saved.avatar.y) || 0
    }
    if (typeof saved.chatHidden === 'boolean')
      chatHidden.value = saved.chatHidden
    for (const win of saved.windows || []) {
      let sid = ''
      let url = win.url
      let title = win.title
      if (win.kind === 'live') {
        try {
          const res = await fetch('/api/browse/open', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url: win.url }),
          })
          const page = await res.json()
          if (res.ok) {
            sid = page.sid
            url = page.url || win.url
            title = page.title || title
          }
        }
        catch {}
      }
      windows.value = [...windows.value, { ...win, id: `w${Date.now().toString(36)}${windows.value.length}`, sid, url, title, z: ++nextZ }]
    }
  }
  finally {
    restoring = false
  }
}
function onPanelEvent(event: Event) {
  showPanel((event as CustomEvent<{ kind?: 'image' | 'web' | 'live', url: string, title?: string, sid?: string }>).detail)
}
watch([windows, chatHidden, avatarScale, avatarX, avatarY], () => saveStage(), { deep: true })
onMounted(() => {
  window.addEventListener('sofia:panel', onPanelEvent)
  // Typed turns go to Hermes and have no tools, so the gateway pushes windows
  // out of band on this stream. Without it a typed "open github" opened nothing
  // while she described a page she never had.
  void restoreStage()

  try {
    const events = new EventSource('/api/events')
    events.onmessage = (event) => {
      try { showPanel(JSON.parse(event.data)) }
      catch {}
    }
  }
  catch {}
  ;(window as unknown as { __sofiaPanel: typeof showPanel }).__sofiaPanel = showPanel
})
onBeforeUnmount(() => window.removeEventListener('sofia:panel', onPanelEvent))

// --- she speaks first -------------------------------------------------------
// The stage can ask; something that is always up has to decide a moment has
// arrived, because a tab that was closed at 07:00 can never know it missed it.
// So the gateway holds the clock (apps/sofia-gateway/proactive.mjs) and hands
// back a *slot and the time it fired*, never a finished sentence: the words are
// composed here, from the clock this page actually has. A 07:00 slot collected
// at 07:04 says good morning; one collected at noon is dropped, because "good
// morning" at noon is a lie the product cannot afford.
//
// Delivery reuses the chat pipeline's own notice path — `notifyConversation`
// stores her line as a proactive reply rather than owner speech — so this adds
// no second way to talk to the model.
const chatOrchestrator = useChatStore()
const chatSessions = useChatSessionStore()

type ProactiveKind = 'morning' | 'midday' | 'evening'
const PROACTIVE_TEXTS: Record<ProactiveKind, (clock: string, day: string) => string> = {
  morning: (clock, day) => `It is ${clock} on ${day}. Sithum has just opened the day and has not typed anything yet — you are speaking first, unprompted. In one or two short sentences, in your own voice: name the day and ask what he is starting with. Do not mention a schedule, a timer, or that anything is automated.`,
  midday: (clock, day) => `It is ${clock} on ${day}. Midday, and you are speaking first, unprompted. In one or two sentences, ask what he has actually got done this morning and what the next thing is. Be concrete rather than encouraging.`,
  evening: (clock, day) => `It is ${clock} on ${day}. The day is ending and you are speaking first. In one or two sentences, ask how the day actually went and what he would change tomorrow. No scorekeeping and no list of numbers.`,
}

function proactiveKind(slot: string): ProactiveKind {
  const hour = Number(String(slot).split(':')[0])
  if (!Number.isFinite(hour))
    return 'midday'
  if (hour < 11)
    return 'morning'
  if (hour < 18)
    return 'midday'
  return 'evening'
}

function textOf(message: { content?: unknown } | undefined) {
  const content = message?.content
  if (typeof content === 'string')
    return content
  if (Array.isArray(content))
    return content.map((part: { text?: string }) => part?.text ?? '').join(' ').trim()
  return ''
}

let deliveringProactive = false
const proactiveAttempts = new Map<string, number>()

async function ackProactive(ids: string[]) {
  try {
    await fetch('/api/proactive/ack', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
    })
  }
  catch {}
}

async function deliverProactive() {
  if (deliveringProactive)
    return
  deliveringProactive = true
  try {
    const res = await fetch('/api/proactive/pending', { headers: { accept: 'application/json' } })
    if (!res.ok)
      return
    const data = await res.json() as { items?: Array<{ id: string, slot: string, at: number, expiresAt: number }> }
    const items = data.items ?? []
    if (!items.length)
      return
    const sessionId = chatSessions.activeSessionId || await chatSessions.ensureActiveSessionForCharacter()
    if (!sessionId)
      return
    for (const item of items) {
      const tries = proactiveAttempts.get(item.id) ?? 0
      if (Date.now() > Number(item.expiresAt || 0) || tries >= 2) {
        // Stale is a drop, not a late delivery, and a notice that fails twice is
        // not going to succeed on the third: both are acknowledged so the queue
        // cannot jam behind one message.
        await ackProactive([item.id])
        proactiveAttempts.delete(item.id)
        continue
      }
      const kind = proactiveKind(item.slot)
      const now = new Date()
      const clock = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Colombo' })
      const day = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Colombo' })
      const before = chatSessions.getSessionMessages(sessionId)?.length ?? 0
      console.info(`[sofia] proactive ${item.slot} -> ${kind} at ${clock}`)
      await chatOrchestrator.notifyConversation(sessionId, { source: `proactive:${item.slot}`, text: PROACTIVE_TEXTS[kind](clock, day) })
      const after = chatSessions.getSessionMessages(sessionId) ?? []
      // `notifyConversation` swallows its own failures and logs a warning, so the
      // store growing is the only evidence that she actually spoke.
      if (after.length <= before) {
        proactiveAttempts.set(item.id, tries + 1)
        console.info(`[sofia] proactive ${item.slot} did not land (attempt ${tries + 1})`)
        continue
      }
      const reply = [...after].reverse().find(message => message.role === 'assistant')
      console.info(`[sofia] proactive ${item.slot} delivered: ${textOf(reply).slice(0, 120)}`)
      await ackProactive([item.id])
      proactiveAttempts.delete(item.id)
    }
  }
  catch (error) {
    console.info(`[sofia] proactive failed: ${String((error as Error)?.message || error).slice(0, 120)}`)
  }
  finally {
    deliveringProactive = false
  }
}

onMounted(() => {
  // Not on the first frame: the provider and the card are still loading, and a
  // send before they exist fails silently and burns an attempt.
  const first = setTimeout(() => void deliverProactive(), 8000)
  const timer = setInterval(() => void deliverProactive(), 60000)
  onBeforeUnmount(() => { clearTimeout(first); clearInterval(timer) })
})

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
  // Vite/upstream marks the app inert while the startup phase runs, and an
  // inert subtree is removed from hit testing entirely: elementFromPoint over a
  // window's own title bar returned #app, with the window visible, opaque and
  // pointer-events:auto. Clearing inert is what makes the windows real.
  const clearInert = () => {
    for (const el of document.querySelectorAll('[inert]'))
      el.removeAttribute('inert')
  }
  clearInert()
  clearOverlays()
  for (const delay of [800, 2500, 5000]) {
    setTimeout(clearInert, delay)
    setTimeout(clearOverlays, delay)
  }
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
    :style="[stageSurfaceStyle, avatarVars]"
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
          <div :class="['avatar-shell h-full w-full']" :style="avatarTransform">
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
        </div>
        <!-- A fixed width keeps the chat panel narrow on wide screens. A percentage minimum overrode the maximum there. -->
        <InteractiveArea
          v-if="!isMobile && !panel && !chatHidden"
          :class="['absolute right-4 h-[85dvh] w-[min(440px,45%)] flex flex-col']"
        />
        <!-- One control, always in the same place: give the stage its width
             back, or bring the conversation back. -->
        <button
          v-if="!isMobile"
          type="button"
          data-testid="sofia-chat-toggle"
          class="sofia-chat-toggle"
          :title="panel ? 'Close the window to bring the chat back' : chatHidden ? 'Show chat' : 'Hide chat'"
          :aria-pressed="chatHidden || panel ? 'true' : 'false'"
          :disabled="panel"
          @click="toggleChat"
        >
          {{ chatHidden ? '‹' : '›' }}
        </button>
        <!-- She moves aside rather than being covered: the column above narrows,
             and what she wants to show takes the space she gave up. Mounted on
             every width: the dock only exists on desktop, so a phone can only
             receive a window through the gate hook — and a dropped event is
             worse than a small window (rule: no fabricated capability). -->
        <!-- The Talk button belongs to the stage, not to the chat: it was inside
             the chat column, so opening a window removed it and killed the Live
             session with it. -->
        <div class="sofia-dock-layer">
          <SofiaVoiceDock />
        </div>
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
.sofia-dock-layer {
  position: fixed;
  right: 1.25rem;
  bottom: 1rem;
  z-index: 46;
}
.sofia-dock-layer :deep(.sofia-voice) { width: auto; padding: 0; }

.sofia-chat-toggle {
  position: fixed;
  right: 0;
  top: 50%;
  z-index: 60;
  transform: translateY(-50%);
  width: 1.35rem;
  height: 3.4rem;
  border: 1px solid #3a2226;
  border-right: none;
  border-radius: 9px 0 0 9px;
  background: #171012e6;
  color: #c98b8b;
  font-size: 1rem;
  line-height: 1;
  cursor: pointer;
  backdrop-filter: blur(6px);
}
.sofia-chat-toggle:hover:not(:disabled) { background: #2a1a1e; color: #f5e6d3; }
/* While a window owns the right-hand space the chat is gone by layout, not by
   choice — so the control says why instead of offering an action it cannot take. */
.sofia-chat-toggle:disabled { opacity: 0.4; cursor: default; }

.avatar-shell {
  transition: transform 0.45s cubic-bezier(0.16, 1, 0.3, 1);
}
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
