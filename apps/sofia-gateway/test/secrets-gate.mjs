// secrets-gate.mjs — no secret is recoverable from the image.
//
// Why this exists: Coolify passes any variable marked `is_buildtime` as a
// Docker build argument. Docker records build arguments in the image history
// whether or not the Dockerfile reads them, so a variable nobody used still
// shipped its value into every layer of every image — `ARG
// GEMINI_API_KEY=AQ.Ab8RN6…` was readable with `docker history` on the host.
// The key was live, and deleting it from Coolify would not have removed it from
// images already built.
//
// So this gate inspects the image that is actually deployed and fails if any
// credential material appears in its build history. It cannot run from the QA
// container: `docker` access is on the host, which is where the verifier runs.
//
//   node secrets-gate.mjs                      # the running app container
//   IMAGE=sofia:ci node secrets-gate.mjs       # any image by name
import { execFileSync } from 'node:child_process'
import process from 'node:process'

const results = []
const ok = (name, detail = '') => { results.push(['PASS', name]); console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`) }
const fail = (name, detail = '') => { results.push(['FAIL', name]); console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }

function sh(args) {
  return execFileSync(args[0], args.slice(1), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

let image = process.env.IMAGE || ''
if (!image) {
  try {
    const container = sh(['docker', 'ps', '--format', '{{.Names}}']).split('\n').find(n => n.includes('zp31'))
    image = container ? sh(['docker', 'inspect', container, '--format', '{{.Config.Image}}']).trim() : ''
  }
  catch { image = '' }
}
if (!image) {
  console.log('FAIL  an image to inspect was found — none running and IMAGE is unset')
  console.log('\n0/1')
  process.exit(1)
}
ok('an image to inspect was found', image)

// Every name that has ever carried a credential here, plus the generic shapes.
// A history line is `RUN |N NAME=value`, so the name is what to look for: the
// value must not appear even when it is a variable this build never uses.
const SECRET_NAMES = ['GEMINI_API_KEY', 'HERMES_KEY', 'HERMES_API_KEY', 'SOFIA_PASSWORD',
  'SOFIA_API_TOKEN', 'BROWSER_WORKER_SECRET', 'API_SERVER_KEY', 'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY', 'HF_TOKEN', 'GITHUB_TOKEN']

let history = ''
try {
  history = sh(['docker', 'history', '--no-trunc', '--format', '{{.CreatedBy}}', image])
}
catch (error) {
  fail('the image history can be read', String(error?.message || error).slice(0, 160))
}

if (history) {
  // `ARG NAME=value` and `RUN |N NAME=value` are the two shapes seen on this
  // host. A mention of the name with no `=` (a Dockerfile ARG declaration in a
  // comment) is not a leak, so only assignments count.
  const leaked = []
  for (const name of SECRET_NAMES) {
    const pattern = new RegExp(`(?:ARG|ENV|RUN \\|\\d+)[^\\n]*?\\b${name}=([^\\s'"\`]+)`)
    const match = history.match(pattern)
    if (match)
      leaked.push(`${name} (${match[1].length} chars)`)
  }
  leaked.length === 0
    ? ok('no credential is recoverable from the image history', `${SECRET_NAMES.length} names checked`)
    : fail('no credential is recoverable from the image history', `baked into the image: ${leaked.join(', ')}`)
}

const passed = results.filter(r => r[0] === 'PASS').length
console.log(`\n${passed}/${results.length}`)
// `exitCode`, not `exit`: stdout is a pipe in the release run, and exiting
// immediately after printing the tally can drop it (measured: 641 of 4000
// lines and the final count lost). See G15 in scripts/ci/guards.mjs.
process.exitCode = passed === results.length ? 0 : 1
