<template>
  <div
    :class="[
      'flex flex-col h-full w-full rounded-xl',
      'bg-primary-50/50 dark:bg-[var(--sofia-panel)] backdrop-blur-md',
      // The elevated surface gets its 1px warm border, so the panel reads as glass on black.
      'dark:border dark:border-[var(--sofia-panel-border)]',
      'border border-transparent',
    ]"
  >
    <slot />
  </div>
</template>
