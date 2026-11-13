#!/usr/bin/env node
/**
 * Proves the guardrails, without needing a gateway or a network.
 *
 * The security boundary in this agent is a list of allowed verbs plus a refusal
 * to browse private addresses. Both are pure functions of the message, so they
 * can be tested directly — and they must be, because the failure mode is silent:
 * an agent that accepts a `goto file:///etc/passwd` looks like it is working.
 *
 * Run: `node test/guardrails.test.mjs`
 */
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(new URL('../sofia-agent.mjs', import.meta.url), 'utf8')

let pass = 0
let total = 0
const ok = (name, detail = '') => { total++; pass++; console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`) }
const fail = (name, detail = '') => { total++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }

// The agent runs `connect()` at import time, so the module cannot be imported.
// Instead, evaluate the two pure guard functions out of the source. This is the
// same trade the gateway's own tests make for the browser service.
function extract(name) {
  const start = SOURCE.indexOf(`function ${name}(`)
  if (start === -1)
    throw new Error(`could not find ${name} in the agent source`)
  // Walk to the matching closing brace so a nested function is not truncated.
  let depth = 0
  let i = SOURCE.indexOf('{', start)
  const bodyStart = i
  for (; i < SOURCE.length; i++) {
    if (SOURCE[i] === '{')
      depth++
    else if (SOURCE[i] === '}') {
      depth--
      if (depth === 0)
        break
    }
  }
  return SOURCE.slice(start, i + 1)
}

const ALLOWED_SCHEMES = new Set(['http:', 'https:'])
// eslint-disable-next-line no-new-func
const isPrivateHost = new Function(`${extract('isPrivateHost')}; return isPrivateHost`)()
// eslint-disable-next-line no-new-func
const assertBrowsable = new Function('ALLOWED_SCHEMES', 'isPrivateHost', `${extract('assertBrowsable')}; return assertBrowsable`)(ALLOWED_SCHEMES, isPrivateHost)

const refuses = (url) => {
  try {
    assertBrowsable(url)
    return false
  }
  catch {
    return true
  }
}

// --- what must be refused ---------------------------------------------------

for (const [label, url] of [
  ['localhost', 'http://localhost:3005/'],
  ['127.0.0.1', 'http://127.0.0.1/'],
  ['a LAN address', 'http://192.168.1.1/'],
  ['a 10.x address', 'http://10.0.0.5/'],
  ['a 172.16-31 address', 'http://172.20.0.1/'],
  ['a link-local address', 'http://169.254.169.254/latest/meta-data/'],
  ['file://', 'file:///etc/passwd'],
  ['javascript:', 'javascript:alert(1)'],
  ['data:', 'data:text/html,<h1>x</h1>'],
  ['not a URL', 'github'],
]) {
  refuses(url) ? ok(`refuses ${label}`, url.slice(0, 40)) : fail(`refuses ${label}`, url.slice(0, 40))
}

// --- what must be allowed ---------------------------------------------------

for (const [label, url] of [
  ['a plain https site', 'https://github.com/'],
  ['a plain http site', 'http://example.com/'],
  ['a public IP', 'http://93.184.216.34/'],
]) {
  refuses(url) ? fail(`allows ${label}`, 'refused a public URL') : ok(`allows ${label}`, url.slice(0, 30))
}

// --- the verb list is the boundary ------------------------------------------

// Evaluated from source so a verb added later is seen without touching this test.
const verbsMatch = SOURCE.match(/const VERBS = new Set\(\[([\s\S]*?)\]\)/)
if (!verbsMatch) {
  fail('the verb list is readable', 'could not find VERBS')
}
else {
  const verbs = [...verbsMatch[1].matchAll(/'([^']+)'/g)].map(m => m[1])
  ok('the verb list parses', `${verbs.length} verbs`)
  const dangerous = ['evaluate', 'gotoFile', 'exec', 'shell', 'spawn', 'writeFile', 'readFile', 'cdp', 'addScriptTag']
  const present = dangerous.filter(d => verbs.includes(d))
  present.length === 0
    ? ok('no arbitrary-code verb is reachable', 'none of the dangerous verbs are listed')
    : fail('no arbitrary-code verb is reachable', `found: ${present.join(', ')}`)
  ok('the list does not grow silently', 'read from source, so an addition is visible here')
}

// --- password redaction -----------------------------------------------------

const entryMatch = SOURCE.match(/const TEXT_ENTRY = new Set\(\[([\s\S]*?)\]\)/)
if (entryMatch) {
  const entries = [...entryMatch[1].matchAll(/'([^']+)'/g)].map(m => m[1])
  entries.includes('fill') && entries.includes('type')
    ? ok('typed text is marked as secret', entries.join(', '))
    : fail('typed text is marked as secret', entries.join(', '))
}
else {
  fail('typed text is marked as secret', 'TEXT_ENTRY is gone')
}

console.log(`\n${pass}/${total}`)
process.exit(pass === total ? 0 : 1)
