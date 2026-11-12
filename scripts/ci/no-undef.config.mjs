// Scope checking for the gateway, and nothing else.
//
// The gateway is plain Node with no upstream conventions to obey — running the
// repo's own ESLint over it fails on style rules that are not safety. This
// config turns off everything except `no-undef`, so a name that a refactor left
// behind (a declaration deleted with a block, an import dropped) fails the
// guards instead of reaching production as a ReferenceError.
//
// It is deliberately a separate file: `--no-config-lookup -c <this>` cannot be
// weakened by an inline disable comment in the checked file, and it will not
// drift when someone edits the repo's main config.
export default [
  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        Buffer: 'readonly',
        EventSource: 'readonly',
        FormData: 'readonly',
        Headers: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        WebSocket: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        clearInterval: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
        crypto: 'readonly',
        document: 'readonly',
        // Browser globals used inside `page.evaluate` callbacks. The evaluator
        // ships these functions to the page, so `scrollY` is real there even
        // though it does not exist in Node.
        scrollX: 'readonly',
        scrollY: 'readonly',
        getComputedStyle: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        window: 'readonly',
        navigator: 'readonly',
        localStorage: 'readonly',
        location: 'readonly',
        caches: 'readonly',
        fetch: 'readonly',
        globalThis: 'readonly',
        performance: 'readonly',
        process: 'readonly',
        queueMicrotask: 'readonly',
        setInterval: 'readonly',
        setTimeout: 'readonly',
        structuredClone: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': 'off',
    },
  },
]
