// idle-gate.mjs — an unused browser must stop costing CPU.
//
// Why: a single open page left a Chromium software-GPU helper spinning at
// 490-595 % CPU on this host, indefinitely, because a page keeps rendering
// whether or not anyone is looking. Freezing the page's lifecycle was tried and
// measured — still 585 % after a successful freeze — so the shipped design is
// "idle means gone": the page is reaped, then the browser is closed, and the
// next request pays a ~2 s cold start.
//
// The pass condition is the service's own report, `pages:0` and `browser:false`,
// because that is the state that cannot burn CPU. A CPU percentage is recorded
// as supporting detail and is NOT the assertion: example.com renders at ~0 %
// even while open, so a CPU threshold would pass whether or not the shutdown
// ever happened. github.com is used because it is the page that actually costs
// five cores, so the same gate measures the thing the fix exists for.
//
// Needs docker access, so it runs on the host beside secrets-gate.mjs.
//
//   node idle-gate.mjs
//   PAGE=https://github.com IDLE_WAIT_MS=200000 node idle-gate.mjs
import { execFileSync } from 'node:child_process'
import process from 'node:process'

const results = []
const ok = (name, detail = '') => { results.push(['PASS', name]); console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`) }
const fail = (name, detail = '') => { results.push(['FAIL', name]); console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }

const container = process.env.CONTAINER || 'sofia-browser'
const pageUrl = process.env.PAGE || 'https://github.com'
const base = 'http://sofia-browser:8790'
// The service reaps a page after IDLE_MS (180 s default) and closes the browser
// BROWSER_IDLE_MS (30 s) after the last page is gone. The gate waits past both.
const waitMs = Number(process.env.IDLE_WAIT_MS || 240_000)

function sh(args) {
  return execFileSync(args[0], args.slice(1), { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
}

function appNode(script) {
  const app = sh(['docker', 'ps', '--format', '{{.Names}}']).split('\n').find(n => n.includes('zp31'))
  if (!app)
    throw new Error('no sofia app container')
  return sh(['docker', 'exec', app, 'node', '-e', script])
}

function health() {
  return JSON.parse(appNode(`fetch('${base}/healthz').then(r=>r.text()).then(t=>process.stdout.write(t))`))
}

function cpuPercent() {
  return Number(sh(['docker', 'stats', '--no-stream', '--format', '{{.CPUPerc}}', container]).trim().replace('%', ''))
}

// 0. The harness has burned three runs measuring a container that had not
// loaded the edit it was testing: the module on disk was new, the process in
// memory was old, and every conclusion drawn from those runs was about the
// previous code. So the gate restarts the service itself and asserts the loaded
// file is the one on disk before it measures anything.
try {
  const runningHasDesign = sh(['docker', 'exec', container, 'sh', '-c',
    'grep -c "with no page" /app/server.mjs || true']).trim()
  if (runningHasDesign === '0') {
    fail('the service is running the current module', '/app/server.mjs does not contain the idle-shutdown branch')
  }
  else {
    ok('the service is running the current module', 'shutdown branch present')
  }
  sh(['docker', 'restart', container])
  await new Promise(resolve => setTimeout(resolve, 6000))
}
catch (error) {
  fail('the service is running the current module', String(error?.message || error).slice(0, 140))
}

// 1. a page opens, so there is something to go idle.
let opened = ''
try {
  opened = appNode(`fetch('${base}/open',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:'${pageUrl}'})}).then(r=>r.json()).then(j=>process.stdout.write(String(j.sid||'none')))`).trim()
}
catch (error) {
  fail('the browser opens a page', String(error?.message || error).slice(0, 120))
}
if (opened && opened !== 'none')
  ok('the browser opens a page', `${pageUrl} -> ${opened}`)

// 2. it is genuinely serving that page right now.
let busyHealth = null
try {
  busyHealth = health()
  busyHealth.pages >= 1 && busyHealth.browser === true
    ? ok('the page is served while it is in use', `pages=${busyHealth.pages} browser=${busyHealth.browser}`)
    : fail('the page is served while it is in use', JSON.stringify(busyHealth))
}
catch (error) {
  fail('the page is served while it is in use', String(error?.message || error).slice(0, 120))
}

// 3. its cost while open, recorded for the report — never the pass condition.
let busyCpu = null
try { busyCpu = cpuPercent() }
catch {}

// 4. after the idle window, the browser is gone. This is the assertion.
await new Promise(resolve => setTimeout(resolve, waitMs))
let idleHealth = null
let idleCpu = null
try {
  idleHealth = health()
  idleCpu = cpuPercent()
  idleHealth.pages === 0 && idleHealth.browser === false
    ? ok('an unused browser shuts itself down', `pages=${idleHealth.pages} browser=${idleHealth.browser}; ${busyCpu?.toFixed(1) ?? '?'} % -> ${idleCpu.toFixed(1)} %`)
    : fail('an unused browser shuts itself down', `pages=${idleHealth.pages} browser=${idleHealth.browser}; ${busyCpu?.toFixed(1) ?? '?'} % -> ${idleCpu.toFixed(1)} %`)
}
catch (error) {
  fail('an unused browser shuts itself down', String(error?.message || error).slice(0, 140))
}

// 5. and it serves again afterwards: sleeping, not dying.
try {
  const again = appNode(`fetch('${base}/open',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:'https://example.com'})}).then(r=>r.json()).then(j=>process.stdout.write(String(j.title||'')+'|'+(j.png?j.png.length:0)))`).trim()
  const [title, pngLen] = again.split('|')
  title && Number(pngLen) > 1000
    ? ok('a page opens again after the shutdown', `${title}, ${pngLen} bytes of PNG`)
    : fail('a page opens again after the shutdown', again.slice(0, 120))
}
catch (error) {
  fail('a page opens again after the shutdown', String(error?.message || error).slice(0, 140))
}

const passed = results.filter(r => r[0] === 'PASS').length
console.log(`\n${passed}/${results.length}`)
process.exit(passed === results.length ? 0 : 1)
