import { useColorMode, useToggle } from '@vueuse/core'
import { computed, watchEffect } from 'vue'

import { LocalStorageShim } from '../utils'

// The classes are the ones of `useDark`: `dark` on the root element, and none for light.
const colorMode = useColorMode({
  modes: { dark: 'dark', light: '' },
  // Dark is the house style, so a browser with no stored preference boots dark instead of
  // following whatever its OS reports.
  initialValue: 'dark',
  disableTransition: true,
  // NOTICE: for histoire, used in packages/stage-ui, localStorage global variable exists but `storage.getItem is not a function` wil
  // thrown, here we added LocalStorageShim to avoid this issue, and it will fallback to real localStorage when it's available.
  storage: 'localStorage' in globalThis && localStorage != null && 'getItem' in localStorage && typeof localStorage.getItem === 'function' ? localStorage : new LocalStorageShim(),
})

/**
 * Whether the dark theme shows now. A two-state toggle writes it, and selects
 * the light or the dark theme. Only a three-state control selects `auto`.
 */
const isDark = computed({
  // Only an explicit `light` choice lightens the stage. `auto` means "the house style", not the
  // system scheme, so a light OS keeps the burgundy dark stage and nobody has to toggle anything.
  get: () => colorMode.store.value !== 'light',
  set: (dark) => {
    colorMode.store.value = dark ? 'dark' : 'light'
  },
})

// `useColorMode` maps `auto` to the resolved system scheme and applies the class itself. With
// `flush: 'post'` this runs after that watcher, so it has the last word on the root class.
// Guarded: this module is also imported where there is no DOM (unit tests, Histoire setup).
if (typeof document !== 'undefined') {
  watchEffect(() => {
    document.documentElement.classList.toggle('dark', isDark.value)
  }, { flush: 'post' })
}

const toggleDark = useToggle(isDark)

/** Selects the next theme: light, dark, then the system scheme. */
function switchToNextTheme() {
  colorMode.store.value = ({ light: 'dark', dark: 'auto', auto: 'light' } as const)[colorMode.store.value]
}

export function useTheme() {
  return {
    isDark,
    toggleDark,
    /** The chosen theme, which a three-state control reads and writes. */
    themeMode: colorMode.store,
    switchToNextTheme,
  }
}
