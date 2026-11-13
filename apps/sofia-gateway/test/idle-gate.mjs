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
import { writeFileSync } from 'node:fs'
import process from 'node:process'

const results = []
const ok = (name, detail = '') => { results.push(['PASS', name]); console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`) }
const fail = (name, detail = '') => { results.push(['FAIL', name]); console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }

const container = process.env.CONTAINER || 'sofia-browser'
const pageUrl = process.env.PAGE || 'https://github.com'
const base = 'http://sofia-browser:8790'

function sh(args) {
  return execFileSync(args[0], args.slice(1), { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
}

// Wait past the service's OWN suspend window, read from its healthz, rather than
// a number guessed here. The first version waited 240 s while SUSPEND_MS was
// 600 s, so `live === 0` was unreachable and the gate reported a failure for
// correct behaviour — the same defect as the short-window experiment, in the
// other direction.
const suspendMs = (() => {
  try {
    const app = sh(['docker', 'ps', '--format', '{{.Names}}']).split('\n').find(n => n.includes('zp31'))
    const h = JSON.parse(sh(['docker', 'exec', app, 'node', '-e',
      `fetch('http://sofia-browser:8790/healthz').then(r=>r.text()).then(t=>process.stdout.write(t))`]))
    return Number(h.suspendMs || 0)
  }
  catch {
    return 0
  }
})()
const waitMs = Number(process.env.IDLE_WAIT_MS || Math.max(240_000, suspendMs + 60_000))

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
  // Assert the CAPABILITY, not a comment or a log line: the previous check
  // grepped a phrase that a later edit renamed, so it reported "stale module" for
  // a container running the right code. What matters is that the module in the
  // container knows about suspending and resuming.
  const design = sh(['docker', 'exec', container, 'sh', '-c',
    'grep -cE "SUSPEND_MS|pageFor|launchPersistentContext" /app/server.mjs || true']).trim()
  if (design === '0') {
    fail('the service is running the current module', '/app/server.mjs has no suspend/resume path')
  }
  else {
    ok('the service is running the current module', `${design} suspend/resume markers`)
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
  idleHealth.live === 0 && idleHealth.browser === false
    ? ok('an unused browser shuts itself down', `live=${idleHealth.live} suspended=${idleHealth.suspended} browser=${idleHealth.browser}; ${busyCpu?.toFixed(1) ?? '?'} % -> ${idleCpu.toFixed(1)} %`)
    : fail('an unused browser shuts itself down', `live=${idleHealth.live} suspended=${idleHealth.suspended} browser=${idleHealth.browser}; ${busyCpu?.toFixed(1) ?? '?'} % -> ${idleCpu.toFixed(1)} %`)
}
catch (error) {
  fail('an unused browser shuts itself down', String(error?.message || error).slice(0, 140))
}

// 4b. the suspend must PRESERVE the page, not kill it: same sid, same URL.
// This is the difference between "throttled" and "silently broken", and it is the
// whole point of remembering the URL. Written as a probe file rather than a
// nested `node -e` string: the earlier inline version lost its quoting and
// reported "Unexpected end of JSON input" for a resume that worked.
const PROBE = '/tmp/sofia-resume-probe.mjs'
try {
  writeFileSync(PROBE, `
const base = ${JSON.stringify(base)}
const open = await (await fetch(base + '/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com' }) })).json()
const sid = open.sid
let sawSuspend = false
for (let i = 0; i < 90; i++) {
  const h = await (await fetch(base + '/healthz')).json()
  if (h.suspended >= 1) { sawSuspend = true; break }
  await new Promise(r => setTimeout(r, 1000))
}
const r = await fetch(base + '/act', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sid, action: 'read' }) })
const body = await r.json()
process.stdout.write(JSON.stringify({ sawSuspend, status: r.status, chars: String(body.text || '').length, url: body.url || '' }))
`)
  const app = sh(['docker', 'ps', '--format', '{{.Names}}']).split('\n').find(n => n.includes('zp31'))
  sh(['docker', 'cp', PROBE, `${app}:/tmp/sofia-resume-probe.mjs`])
  const raw = sh(['docker', 'exec', app, 'node', '/tmp/sofia-resume-probe.mjs']).trim()
  const parsed = JSON.parse(raw)
  parsed.sawSuspend && parsed.status === 200 && parsed.chars > 50 && /example\.com/.test(parsed.url)
    ? ok('a suspended page resumes with the same sid and url', `${parsed.chars} chars from ${parsed.url}`)
    : fail('a suspended page resumes with the same sid and url', raw.slice(0, 160))
}
catch (error) {
  fail('a suspended page resumes with the same sid and url', String(error?.message || error).slice(0, 140))
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
// `exitCode`, not `exit`: stdout is a pipe in the release run, and exiting
// immediately after printing the tally can drop it (measured: 641 of 4000
// lines and the final count lost). See G15 in scripts/ci/guards.mjs.
process.exitCode = passed === results.length ? 0 : 1
