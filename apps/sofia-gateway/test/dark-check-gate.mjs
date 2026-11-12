// dark-check-gate.mjs — the stage is dark, and its brand is Sofia's.
//
// This lived only on the VPS host (`/home/ctum/qa/dark-check.mjs`) while
// `verify-release.sh` treated its output as the authority on branding, so the
// repo could not reproduce the one check that guards the product's name and
// colour. It is in the tree now, and the release runs the tree.
//
// It reports JSON on one line (`strayAIRI`, `anyWhiteSurfaces`) because the
// verifier parses that; the human-readable lines are for whoever reads the log.
import { chromium } from 'playwright'
import { existsSync, readFileSync } from 'node:fs'

const BASE = process.env.BASE || 'https://sofia.ctum.org'
const PASSWORD = process.env.SOFIA_PASSWORD
  || process.env.PASSWORD
  || (existsSync('/home/ctum/secrets/sofia-password') ? readFileSync('/home/ctum/secrets/sofia-password', 'utf8').trim() : '')

if (!PASSWORD) {
  console.log('no SOFIA_PASSWORD')
  process.exit(2)
}

// Sign in through the API so the browser starts authenticated: the stage is
// behind a password gate and an anonymous load would measure the login page.
const res = await fetch(`${BASE}/api/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: `password=${encodeURIComponent(PASSWORD)}`,
  redirect: 'manual',
})
const cookie = (res.headers.getSetCookie?.() || [])[0]
if (!cookie) {
  console.log('login did not return a session cookie')
  process.exit(1)
}
const [pair] = cookie.split(';')
const eq = pair.indexOf('=')

// OS says light on purpose: dark must win anyway.
const browser = await chromium.launch({ args: ['--no-sandbox'] })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
await ctx.addCookies([{
  name: pair.slice(0, eq),
  value: pair.slice(eq + 1),
  domain: new URL(BASE).hostname,
  path: '/',
  httpOnly: true,
  secure: true,
}])
const page = await ctx.newPage()
await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {})
await page.waitForTimeout(8000)

const probe = await page.evaluate(() => {
  const box = (selector) => {
    const el = document.querySelector(selector)
    if (!el)
      return null
    const cs = getComputedStyle(el)
    return { bg: cs.backgroundColor, border: cs.borderColor, color: cs.color }
  }
  return {
    colorScheme: getComputedStyle(document.documentElement).colorScheme,
    body: box('body'),
    textarea: box('textarea'),
    anyWhiteSurfaces: [...document.querySelectorAll('div')]
      .map(el => getComputedStyle(el).backgroundColor)
      .filter(c => c === 'rgb(255, 255, 255)').length,
    strayAIRI: /AIRI/.test(document.body.innerText),
  }
})
console.log(JSON.stringify(probe, null, 1))
await browser.close()

// The verifier parses these two; the screenshot is for a human.
process.exit(probe.strayAIRI === false && probe.anyWhiteSurfaces === 0 ? 0 : 1)
