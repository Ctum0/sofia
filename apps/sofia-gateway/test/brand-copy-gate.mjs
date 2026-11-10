// The copy layer, crawled instead of assumed.
//
// Every other gate asserts behaviour. This one asserts a brand property across
// the WHOLE served bundle: no user-visible "AIRI" left anywhere. It exists
// because the previous sweep (6f75cced6) replaced 602 strings and still left
// ~285 in nine non-English locales -- and those live in lazily imported chunks
// (`src-*.js`, `auxiliary-*.js`) that never appear in index.html, so a gate that
// only fetched the entry bundle would have reported green while the defect was
// on screen for anyone who switched language.
//
// So: log in, read index.html, then breadth-first crawl every `assets/*.js`
// reference found inside the chunks themselves, and scan each one. Hits are
// matched against an allowlist of internal identifiers, shader tokens, package
// metadata and unreachable integration prompts -- each with its reason -- and
// anything else is a violation.
//
// Dependency-free (node:http/https only) so it runs in the QA container with no
// install. Env: BASE, SOFIA_PASSWORD (or PASSWORD).
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

const BASE = process.env.BASE || 'https://sofia.ctum.org'
const PASSWORD = process.env.SOFIA_PASSWORD || process.env.PASSWORD || ''
const MAX_CHUNKS = 1200

const results = []
const step = (n, ok, d = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`)
}

// Every hit must match one of these to be excused. Kept narrow and reasoned:
// these are identifiers, shader tokens, package metadata, or prompts for
// integrations this stage never loads.
const ALLOW = [
  [/AIRI_[A-Z_]+/, 'internal constant / shader token (AIRI_DIFFUSE_*, AIRI_OUTLINE_*, AIRI_ALL_OUTLINE)'],
  [/AIRI_[a-z]/, 'GLSL function name inside the shader (AIRI_evalIrradianceSH)'],
  [/group ?[:=]{1,3} ?`AIRI`/, 'Live2D motion group name bound to the model\'s own group fields; renaming breaks motion selection'],
  [/AIRIStream/, 'internal type name'],
  [/Moeru AI Project AIRI Team/, 'package.json author metadata, not rendered'],
  [/airi@moeru\.ai/, 'package.json author email, not rendered'],
  [/AIRI System:/, 'spark-notify agent tool result; that agent is not mounted on the stage'],
  [/AIRI system, the life pod/, 'spark-notify agent system prompt; that agent is not mounted on the stage'],
  [/Minecraft/, 'Minecraft integration copy; no Minecraft service is connected'],
  [/Cinematic Director for AIRI/, 'LLM prompt for the camera director, never displayed'],
]

function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const lib = u.protocol === 'https:' ? httpsRequest : httpRequest
    const req = lib(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers,
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
      },
    )
    req.setTimeout(30_000, () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    if (body)
      req.write(body)
    req.end()
  })
}

function cookiesFrom(res) {
  const raw = res.headers['set-cookie'] || []
  return raw.map(c => c.split(';')[0]).join('; ')
}

async function login() {
  const body = new URLSearchParams({ password: PASSWORD }).toString()
  const res = await request(`${BASE}/api/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': String(Buffer.byteLength(body)),
    },
    body,
  })
  const cookie = cookiesFrom(res)
  return { status: res.status, cookie }
}

function excuse(window) {
  for (const [re, why] of ALLOW) {
    if (re.test(window))
      return why
  }
  return null
}

const main = async () => {
  if (!PASSWORD) {
    console.log('FAIL  no SOFIA_PASSWORD in env')
    process.exit(1)
  }

  const login_ = await login()
  step('login accepted', login_.status === 302 && login_.cookie.length > 0, `status ${login_.status}`)
  if (login_.status !== 302) {
    console.log('cannot continue without a session')
    process.exit(1)
  }

  const shell = await request(`${BASE}/`, { headers: { cookie: login_.cookie } })
  const html = shell.body.toString('utf8')
  step('app shell served', shell.status === 200 && html.length > 5000, `${html.length} B`)
  step('shell carries no AIRI', !html.includes('AIRI'))
  step('shell title is Sofia', /<title>Sofia<\/title>/.test(html))

  const manifest = await request(`${BASE}/manifest.webmanifest`)
  step('manifest is Sofia', /"short_name":"Sofia"/.test(manifest.body.toString('utf8')))

  // Seed the crawl from the shell, then follow `assets/*.js` references found
  // inside chunks -- that is how the lazy locale bundles get reached.
  const seen = new Set()
  const queue = []
  for (const m of html.matchAll(/(?:src|href)="([^"]+\.js)"/g)) {
    if (m[1].startsWith('/assets/'))
      queue.push(m[1])
  }
  step('shell references entry chunks', queue.length > 0, `${queue.length} entry chunk(s)`)

  const violations = []
  let hits = 0
  let excused = 0
  // A second brand property, asserted the same way: no page belonging to another
  // product may be presented as this app's terms or privacy policy. It is not an
  // "AIRI" string (the URL says `airi.moeru.ai`, lower-case, inside an href), so
  // the AIRI scan above never sees it -- that is exactly how three upstream legal
  // links survived every earlier gate.
  let foreignLegal = (html.match(/airi\.moeru\.ai\/docs\/en\/about\/(?:terms|privacy)/g) || []).length

  while (queue.length && seen.size < MAX_CHUNKS) {
    const path = queue.shift()
    if (seen.has(path))
      continue
    seen.add(path)
    const res = await request(`${BASE}${path}`, { headers: { cookie: login_.cookie } })
    if (res.status !== 200)
      continue
    const js = res.body.toString('utf8')
    foreignLegal += (js.match(/airi\.moeru\.ai\/docs\/en\/about\/(?:terms|privacy)/g) || []).length
    for (const m of js.matchAll(/(?:\.\/|\/)?(assets\/[A-Za-z0-9_.-]+\.js)/g)) {
      const next = `/${m[1]}`
      if (!seen.has(next))
        queue.push(next)
    }
    let idx = js.indexOf('AIRI')
    while (idx !== -1) {
      hits++
      const window = js.slice(Math.max(0, idx - 70), idx + 70)
      const why = excuse(window)
      if (why) {
        excused++
      }
      else {
        violations.push({ path, window: window.replace(/\s+/g, ' ') })
      }
      idx = js.indexOf('AIRI', idx + 4)
    }
  }

  console.log(`crawled ${seen.size} chunk(s); AIRI hits ${hits}, excused ${excused}, violations ${violations.length}`)
  for (const v of violations.slice(0, 12))
    console.log(`  ${v.path} … ${v.window}`)
  step('no user-visible AIRI left in the served bundle', violations.length === 0, `${hits} hits, ${excused} allowlisted`)
  step('crawl actually reached the lazy chunks', seen.size > 20, `${seen.size} chunks`)
  step('links no foreign product\'s legal pages', foreignLegal === 0, `${foreignLegal} airi.moeru.ai/docs/en/about/{terms,privacy} reference(s)`)

  const passed = results.filter(Boolean).length
  console.log(`\n${passed}/${results.length}`)
  process.exit(violations.length === 0 && passed === results.length ? 0 : 1)
}

main().catch((e) => {
  console.log(`FAIL  ${e.message}`)
  process.exit(1)
})
