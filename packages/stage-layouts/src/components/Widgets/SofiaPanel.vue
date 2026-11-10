<script setup lang="ts">
// What she puts on the screen beside herself.
//
// Two kinds, and the difference matters: an image is rendered inline because it
// is ours and it is safe; a web page is NOT iframed, because almost every real
// site sends X-Frame-Options/CSP frame-ancestors and a blank frame looks like a
// bug. A site gets a card with its host and an explicit Open action instead.
export interface SofiaPanelPayload {
  kind?: 'image' | 'web'
  url: string
  title?: string
}

const props = defineProps<{ panel: SofiaPanelPayload }>()
const emit = defineEmits<{ close: [] }>()

const host = computed(() => {
  try { return new URL(props.panel.url).host }
  catch { return props.panel.url }
})
const isImage = computed(() => (props.panel.kind || 'image') === 'image')

import { computed } from 'vue'

function open() {
  window.open(props.panel.url, '_blank', 'noopener,noreferrer')
}
</script>

<template>
  <aside
    data-testid="sofia-panel"
    :data-kind="isImage ? 'image' : 'web'"
    class="sofia-panel"
  >
    <header class="sofia-panel__bar">
      <span class="sofia-panel__title">{{ panel.title || host }}</span>
      <button type="button" class="sofia-panel__close" aria-label="Close panel" @click="emit('close')">
        ✕
      </button>
    </header>

    <div v-if="isImage" class="sofia-panel__body">
      <img :src="panel.url" :alt="panel.title || 'image'" data-testid="sofia-panel-image">
      <p v-if="panel.title" class="sofia-panel__caption">{{ panel.title }}</p>
    </div>

    <div v-else class="sofia-panel__body sofia-panel__body--web">
      <p class="sofia-panel__host">{{ host }}</p>
      <p class="sofia-panel__note">
        Sites usually refuse to be embedded, so this opens in its own tab.
      </p>
      <button type="button" class="sofia-panel__open" data-testid="sofia-panel-open" @click="open">
        Open {{ host }}
      </button>
    </div>
  </aside>
</template>

<style scoped>
.sofia-panel {
  position: absolute;
  right: 1rem;
  top: 0;
  height: 85dvh;
  width: min(520px, 46%);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid #2a1a1e;
  border-radius: 14px;
  background: #171012;
  box-shadow: 0 24px 60px -20px rgb(0 0 0 / 0.7);
  z-index: 20;
  animation: sofia-panel-in 0.32s cubic-bezier(0.16, 1, 0.3, 1);
}
.sofia-panel__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.7rem 0.9rem;
  border-bottom: 1px solid #2a1a1e;
  background: #1d1215;
}
.sofia-panel__title {
  font-size: 0.82rem;
  letter-spacing: 0.02em;
  color: #f5e6d3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sofia-panel__close {
  border: 1px solid #3a2226;
  background: transparent;
  color: #c98b8b;
  border-radius: 8px;
  width: 1.8rem;
  height: 1.8rem;
  cursor: pointer;
}
.sofia-panel__close:hover { background: #2a1a1e; color: #f5e6d3; }
.sofia-panel__body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.6rem;
  padding: 0.9rem;
}
.sofia-panel__body img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: 10px;
}
.sofia-panel__caption { font-size: 0.78rem; color: #b9a99c; }
.sofia-panel__body--web { justify-content: center; text-align: center; }
.sofia-panel__host { font-size: 1rem; color: #f5e6d3; }
.sofia-panel__note { font-size: 0.78rem; color: #8f7a72; max-width: 22rem; }
.sofia-panel__open {
  margin-top: 0.4rem;
  border: 1px solid #7b1f2b;
  background: #7b1f2b;
  color: #f5e6d3;
  border-radius: 999px;
  padding: 0.45rem 1rem;
  font-size: 0.8rem;
  cursor: pointer;
}
.sofia-panel__open:hover { background: #a3283a; }
@keyframes sofia-panel-in {
  from { opacity: 0; transform: translateX(18px) scale(0.98); }
  to { opacity: 1; transform: translateX(0) scale(1); }
}
</style>
