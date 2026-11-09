<script setup lang="ts">
import { PartAnimatedWave, PatternCross } from '.'
</script>

<template>
  <PatternCross class="default-background">
    <PartAnimatedWave
      fill-color="var(--default-background-wave)"
      class="h-full w-full"
    >
      <slot />
    </PartAnimatedWave>
  </PatternCross>
</template>

<style scoped>
/*
 * In CSS, so the wave follows the stage palette and dark mode. The band is a deep burgundy over the
 * black page rather than the pale pastel it used to be; the colours are `--sofia-*` (see
 * `apps/stage-web/src/styles/main.css`), with literal fallbacks for the other stages.
 */
.default-background {
  --default-background-wave: color-mix(in srgb, var(--sofia-accent, #7b1f2b) 14%, var(--sofia-panel, #171012));
}

.dark .default-background {
  --default-background-wave: color-mix(in srgb, var(--sofia-accent, #7b1f2b) 42%, var(--sofia-bg, #0b0708));
}
</style>
