<script setup lang="ts">
// The stage's window layer. Windows live ABOVE the page, never inside the chat
// column: the avatar narrows, the chat steps back, and whatever she opened gets
// the room. Several at once, each with its own focus order and close.
import type { SofiaWindowState } from './SofiaWindow.vue'
import { computed } from 'vue'
import SofiaWindow from './SofiaWindow.vue'

const props = defineProps<{ windows: SofiaWindowState[] }>()
const emit = defineEmits<{
  close: [id: string]
  focus: [id: string]
  move: [payload: { id: string, x: number, y: number }]
}>()

const topZ = computed(() => Math.max(0, ...props.windows.map(w => w.z)))
</script>

<template>
  <div data-testid="sofia-windows" class="sofia-windows">
    <SofiaWindow
      v-for="win in windows"
      :key="win.id"
      :win="win"
      :active="win.z === topZ"
      @close="emit('close', $event)"
      @focus="emit('focus', $event)"
      @move="emit('move', $event)"
    />
  </div>
</template>

<style scoped>
/* The layer itself is a pass-through: only the windows take pointer events. */
.sofia-windows { position: fixed; inset: 0; pointer-events: none; z-index: 40; }
.sofia-windows > * { pointer-events: auto; }
</style>
