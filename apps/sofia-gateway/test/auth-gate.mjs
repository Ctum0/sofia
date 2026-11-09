// The journey a person actually has: password -> app -> chat, with no onboarding.
import { chromium } from 'playwright'

const BASE = process.env.BASE || 'https://sofia.ctum.org'
const PASSWORD = process.env.PASSWORD
const results = []
const step = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`) }

if (!PASSWORD) { console.log('no PASSWORD'); process.exit(2) }

const browser = await chromium.launch({ args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })

try {
  // 1. anonymous visitor sees the gate, not the app
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  const locked = await page.getByText('Private assistant').isVisible().catch(() => false)
  step('anonymous visitor gets the password gate', locked)
  step('branding is Sofia', (await page.title()) === 'Sofia', await page.title())

  // 2. wrong password is refused
  await page.fill('input[name=password]', 'definitely-wrong')
  await page.click('button[type=submit]')
  await page.waitForTimeout(1500)
  const rejected = await page.getByText('Wrong password').isVisible().catch(() => false)
  step('wrong password refused', rejected)

  // 3. right password opens the app
  await page.fill('input[name=password]', PASSWORD)
  await page.click('button[type=submit]')
  await page.waitForFunction(() => !document.body.innerText.includes('Private assistant'), null, { timeout: 45000 })
  step('correct password opens the app', true)

  // 4. no onboarding wizard for a configured install
  await page.waitForTimeout(8000)
  const body = await page.evaluate(() => document.body.innerText)
  step('no onboarding wizard', !/Setup with your provider/i.test(body))
  step('no AIRI in the visible page', !/AIRI/.test(body), /AIRI/.test(body) ? 'AIRI still visible' : 'clean')

  // 4b. the brand is Sofia at the file level too — the built bundle still ships
  // upstream's logo, icon set and manifest, so the gateway has to be the one
  // serving these URLs or a tab shows the old mark no matter what the HTML says.
  const svg = await page.request.get(`${BASE}/favicon.svg`)
  const svgText = svg.ok() ? await svg.text() : ''
  step(
    'favicon is the Sofia mark',
    svg.ok() && svgText.includes('#f5c06a') && !/AIRI/i.test(svgText),
    `${svg.status()} ${svgText.length}B`,
  )
  const manifest = await page.request.get(`${BASE}/manifest.webmanifest`)
  const mf = manifest.ok() ? await manifest.json() : {}
  step('PWA manifest is Sofia', mf.name === 'Sofia' && mf.short_name === 'Sofia', `name=${mf.name}`)
  const ico = await page.request.get(`${BASE}/favicon.ico`)
  step('favicon.ico served', ico.ok() && Number(ico.headers()['content-length'] || 0) > 1000, ico.status())

  // 5. the brain answers without any setup step
  const composer = page.locator('textarea[placeholder="Say something..."]')
  await composer.waitFor({ timeout: 30000 })
  await composer.fill('Say only: LIVE-SOFIA')
  await composer.press('Enter')
  await page.waitForFunction(
    () => document.body.innerText.split('\n').map(s => s.trim()).includes('LIVE-SOFIA'),
    null,
    { timeout: 180000 },
  )
  step('chat answers on a fresh browser', true)

  await page.screenshot({ path: '/qa/auth-gate.png' })
  console.log('\nVISIBLE TEXT:\n' + (await page.evaluate(() => document.body.innerText)).slice(0, 400))
}
catch (err) {
  step('journey completed', false, String(err).slice(0, 220))
}
finally {
  await browser.close()
  const passed = results.filter(Boolean).length
  console.log(`\n${passed}/${results.length} checks passed`)
  process.exit(passed === results.length ? 0 : 1)
}
