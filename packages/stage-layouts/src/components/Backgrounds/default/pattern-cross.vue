<template>
  <div class="cross-background-container">
    <slot />
  </div>
</template>

<style lang="css" scoped>
/*
CSS Background Patterns by MagicPattern
https://www.magicpattern.design/tools/css-backgrounds

Sofia's stage paints this dark by default: the page is black with a faint burgundy cross. A person
who explicitly chose light still gets the cream/white pattern. The colours come from `--sofia-*`
(`apps/stage-web/src/styles/main.css`) with literal fallbacks, so the pattern follows the palette
instead of hardcoded hexes.
*/
.cross-background-container {
  background-color: var(--sofia-bg, #0b0708);
  --cross-color: color-mix(in srgb, var(--sofia-accent, #7b1f2b) 32%, transparent);
  background:
    radial-gradient(circle, transparent 20%, var(--sofia-bg, #0b0708) 20%, var(--sofia-bg, #0b0708) 80%, transparent 80%, transparent),
    radial-gradient(circle, transparent 20%, var(--sofia-bg, #0b0708) 20%, var(--sofia-bg, #0b0708) 80%, transparent 80%, transparent) 25px 25px,
    linear-gradient(var(--cross-color) 2px, transparent 2px) 0 -1px,
    linear-gradient(90deg, var(--cross-color) 2px, var(--sofia-bg, #0b0708) 2px) -1px 0;
  background-size:
    50px 50px,
    50px 50px,
    25px 25px,
    25px 25px;
  /* After `background:`: the shorthand resets `background-color`. */
  background-color: var(--sofia-bg, #0b0708);
}

html:not(.dark) .cross-background-container {
  background-color: #fdf7f4;
  --cross-color: color-mix(in srgb, var(--sofia-accent, #7b1f2b) 12%, transparent);
  background:
    radial-gradient(circle, transparent 20%, #fdf7f4 20%, #fdf7f4 80%, transparent 80%, transparent),
    radial-gradient(circle, transparent 20%, #fdf7f4 20%, #fdf7f4 80%, transparent 80%, transparent) 25px 25px,
    linear-gradient(var(--cross-color) 2px, transparent 2px) 0 -1px,
    linear-gradient(90deg, var(--cross-color) 2px, #fdf7f4 2px) -1px 0;
  background-size:
    50px 50px,
    50px 50px,
    25px 25px,
    25px 25px;
  background-color: #fdf7f4;
}
</style>
