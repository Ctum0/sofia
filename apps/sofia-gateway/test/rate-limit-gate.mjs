// The login limiter, measured from outside the box it protects.
//
// auth-surface-gate asks what a stranger is allowed to *see*. This one asks the
// question the limiter exists for: if a stranger starts guessing, does the server
// actually stop him? It was written because the answer was no — twenty
// consecutive wrong passwords through https://sofia.ctum.org, zero 429s, while
// the identical code locked at the sixth attempt when the same requests were made
// from inside the container. The limiter keyed on the *leftmost* X-Forwarded-For
// element; on the public path (Cloudflare -> Caddy) that element is not stable
// between requests, so every guess opened a fresh bucket and the five-per-window
// cap never engaged. A defence that only exists in a unit test is not a defence.
//
// This gate therefore runs against the public origin with no headers of its own,
// and it LOCKS THE RUNNER'S OWN ADDRESS for five minutes by design: that lock is
// the pass. Run it last in a gate sequence.
//
// Dependency-free on purpose (node fetch only): it has to run anywhere, including
// the QA container, with no install.
const BASE = process.env.BASE || 'https://sofia.ctum.org'
const PASSWORD = process.env.SOFIA_PASSWORD || process.env.PASSWORD || ''
const MAX_ATTEMPTS = 10

const results = []
const step = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function attempt(password) {
  const res = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password }).toString(),
  })
  const body = await res.text()
  return { status: res.status, retryAfter: res.headers.get('retry-after'), body }
}

console.log(`base ${BASE}`)

// --- the grind -------------------------------------------------------------
const codes = []
let firstLock = null
let lockResponse = null
for (let i = 1; i <= MAX_ATTEMPTS; i += 1) {
  const res = await attempt(`not-the-password-${i}`)
  codes.push(res.status)
  if (res.status === 429 && firstLock === null) {
    firstLock = i
    lockResponse = res
  }
  // Once the lock is in force, three more attempts are enough to show it holds.
  if (firstLock !== null && i >= firstLock + 3)
    break
}
console.log(`  attempts: ${codes.join(' ')}`)

if (codes[0] === 429) {
  step('a lock from an earlier run is already in force', true, 'first attempt refused')
}
else {
  step('a wrong password is refused', codes[0] === 401, `first attempt ${codes[0]}`)
}

step(
  `the limiter engages within ${MAX_ATTEMPTS} guesses`,
  firstLock !== null,
  firstLock === null ? `${MAX_ATTEMPTS} attempts, zero 429s — unlimited guessing` : `locked at attempt ${firstLock}`,
)

step(
  'the lock holds for the attempts that follow it',
  firstLock === null || codes.slice(firstLock - 1).every(code => code === 429),
  `${codes.slice(firstLock === null ? 0 : firstLock - 1).join(' ')}`,
)

step(
  'the 429 carries a retry-after in seconds',
  lockResponse !== null && Number(lockResponse.retryAfter) > 0,
  lockResponse === null ? 'no 429 to read' : `retry-after ${lockResponse.retryAfter}`,
)

step(
  'the locked page says so instead of a blank refusal',
  lockResponse !== null && /too many attempts/i.test(lockResponse.body),
  lockResponse === null ? 'no 429 body to read' : `${lockResponse.body.length} bytes`,
)

// --- the lock is not a form-level decoration -------------------------------
// The right password must also be refused while the lock is in force: a limiter
// that lets the correct credential through is a UI animation, not a gate.
if (PASSWORD) {
  const res = await attempt(PASSWORD)
  const locked = firstLock !== null
  step(
    'the lock gates the credential check, not just the form',
    locked ? res.status === 429 : res.status === 302,
    locked ? `correct password while locked -> ${res.status}` : `correct password -> ${res.status}`,
  )
}
else {
  step('the lock gates the credential check, not just the form', false, 'no SOFIA_PASSWORD in env — pass it, do not skip')
}

const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} checks passed`)
if (passed !== results.length)
  console.log('note: this gate deliberately leaves the runner address locked for ~5 minutes when it passes.')
// `exitCode`, not `exit`: stdout is a pipe in the release run, and exiting
// immediately after printing the tally can drop it (measured: 641 of 4000
// lines and the final count lost). See G15 in scripts/ci/guards.mjs.
process.exitCode = passed === results.length ? 0 : 1
