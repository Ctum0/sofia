// brand-assets-gate.mjs — the tab icon, the home-screen icon and the manifest
// must be Sofia's burgundy, not upstream's amber. Run against production:
//   node brand-assets-gate.mjs   (SOFIA_PASSWORD or /home/ctum/secrets/sofia-password)
import { chromium } from 'playwright'
import { readFileSync, existsSync } from 'node:fs'

const BASE = process.env.BASE || 'https://sofia.ctum.org'
const PASSWORD = process.env.SOFIA_PASSWORD
  || (existsSync('/home/ctum/secrets/sofia-password') ? readFileSync('/home/ctum/secrets/sofia-password', 'utf8').trim() : '')

const checks = []
const ok = (name, cond, detail = '') => checks.push({ name, pass: !!cond, detail })

const browser = await chromium.launch()
const ctx = await browser.newContext()
const page = await ctx.newPage()
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
// The gate serves the login form at `/` (content negotiation), so detect the
// form, not the URL — a URL check silently skips the login and every asset
// request then reads 401.
if (await page.locator('input[type=password]').count()) {
  await page.fill('input[type=password]', PASSWORD)
  await page.click('button[type=submit]')
  await page.waitForLoadState('networkidle')
}
const authed = await page.evaluate(async () => (await fetch('/v1/models')).status)
ok('session established', authed === 200, `GET /v1/models ${authed}`)
if (authed !== 200) { await browser.close(); for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  (${c.detail})`); process.exit(1) }
const cookies = await ctx.cookies()
const jar = cookies.map(c => `${c.name}=${c.value}`).join('; ')
const get = async path => {
  const r = await fetch(`${BASE}${path}`, { headers: { cookie: jar } })
  return { status: r.status, body: await r.text(), type: r.headers.get('content-type') || '' }
}

// 1. manifest
const man = await get('/manifest.webmanifest')
let m = {}
try { m = JSON.parse(man.body) } catch {}
ok('manifest reachable', man.status === 200, `status ${man.status}`)
ok('manifest theme_color burgundy-black', m.theme_color === '#0b0708', m.theme_color)
ok('manifest background_color burgundy-black', m.background_color === '#0b0708', m.background_color)
ok('manifest name is Sofia', m.name === 'Sofia', m.name)

// 2. favicon source
const fav = await get('/favicon.svg')
ok('/favicon.svg served', fav.status === 200, `status ${fav.status}`)
ok('favicon has no amber', !/#f5c06a|#e0655f|#fbbf24|#f59e0b/i.test(fav.body), 'amber hex found')
ok('favicon uses the dark base', /#0b0708|#3a1620/i.test(fav.body), 'no burgundy base')

// 3. the rendered icon, measured in a canvas — colour, not markup
const px = await page.evaluate(async () => {
  // Same-origin, credentialed — no crossOrigin attribute, or the browser turns
  // the request into an anonymous CORS one and the gate gets 401 + decode error.
  const img = new Image()
  img.src = '/web-app-manifest-192x192.png?v=gate'
  await img.decode()
  const c = document.createElement('canvas')
  c.width = img.width; c.height = img.height
  const g = c.getContext('2d')
  g.drawImage(img, 0, 0)
  const d = g.getImageData(0, 0, c.width, c.height).data
  let r = 0, gg = 0, b = 0, n = 0, amber = 0
  for (let i = 0; i < d.length; i += 4) {
    const R = d[i], G = d[i + 1], B = d[i + 2]
    r += R; gg += G; b += B; n++
    // upstream's amber: bright, warm, low blue. Count pixels, not averages — a
    // dark background hides an amber glyph in any mean.
    if (R > 190 && G > 130 && B < 130 && R - B > 70) amber++
  }
  return { r: Math.round(r / n), g: Math.round(gg / n), b: Math.round(b / n), w: c.width, amber, n }
})
ok('icon decodes at 192', px.w === 192, `${px.w}px`)
ok('icon is dark', px.r + px.g + px.b < 260, `avg rgb ${px.r},${px.g},${px.b}`)
ok('icon has no amber pixels', px.amber / px.n < 0.002, `${px.amber}/${px.n} px, avg rgb ${px.r},${px.g},${px.b}`)
ok('icon leans red', px.r >= px.g && px.g >= px.b - 4, `avg rgb ${px.r},${px.g},${px.b}`)

// 4. the page really links it
const link = await page.evaluate(() => {
  const l = document.querySelector('link[rel~="icon"]')
  return l ? l.getAttribute('href') : null
})
ok('page declares an icon', !!link, String(link))

await browser.close()
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`)
const failed = checks.filter(c => !c.pass).length
console.log(`\n${checks.length - failed}/${checks.length}`)
process.exit(failed ? 1 : 0)
