#!/usr/bin/env node
// Guards: every check here exists because I actually broke this repo this way.
// Each one is cheap, static, and names the incident it prevents, so a red run
// tells you what went wrong without needing the chat history.
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const failures = []
const passes = []

const read = (p) => readFileSync(join(root, p), 'utf8')
const has = (p) => existsSync(join(root, p))

function check(name, fn) {
  try {
    const detail = fn()
    passes.push(`${name}${detail ? ` — ${detail}` : ''}`)
  }
  catch (error) {
    failures.push(`${name} — ${error.message}`)
  }
}

function sofiaWorkflow(name) {
  return name.startsWith('sofia-')
}

function assert(condition, message) {
  if (!condition)
    throw new Error(message)
}

// G1 — a tool the model is never told about does not exist. `show_panel` shipped
// for hours while the live instruction listed only `ask_hermes` and `local_time`;
// "open github" produced a narrated page and zero tool calls.
check('G1 every tool is named in the live instruction', () => {
  const tools = read('apps/sofia-gateway/tools.mjs')
  const server = read('apps/sofia-gateway/server.mjs')
  const names = [...tools.matchAll(/name: '([a-z_]+)'/g)].map(m => m[1])
  assert(names.length > 0, 'no tool definitions found — did tools.mjs move?')
  // The instruction is composed now: her card carries who she is, and
  // VOICE_RULES carries the tools. Both are named here so a tool cannot become
  // invisible by moving between them.
  const rulesAt = server.indexOf('const VOICE_RULES')
  assert(rulesAt !== -1, 'VOICE_RULES is gone — did the voice instruction move again?')
  const instruction = server.slice(rulesAt, rulesAt + 20000)
  const missing = names.filter(n => !instruction.includes(n))
  assert(missing.length === 0, `missing from the instruction: ${missing.join(', ')}`)
  return names.join(', ')
})

// G2 — the window layer is pointer-events:none so the stage stays clickable.
// The first cut relied on `.sofia-windows > *` in the parent, which does not
// reach a child component's root; every click landed on the page instead.
check('G2 the window itself takes pointer events', () => {
  const win = read('packages/stage-layouts/src/components/Widgets/SofiaWindow.vue')
  const block = win.slice(win.indexOf('.sofia-window {'), win.indexOf('.sofia-window {' + 400))
  assert(/pointer-events:\s*auto/.test(block), '.sofia-window is missing `pointer-events: auto`')
  return 'pointer-events: auto'
})

// G3 — upstream overlays outlive the stage: the boot splash ("Loading" over a
// finished page) and `.startup-screen` (z-index 10000, eats every pointer event,
// and is why raise-on-click passed three times then failed four).
check('G3 the stage clears the upstream overlays on mount', () => {
  const page = read('apps/stage-web/src/pages/index.vue')
  assert(page.includes('boot-splash'), 'index.vue does not remove #boot-splash')
  assert(page.includes('startup-screen'), 'index.vue does not clear .startup-screen')
  assert(page.includes('startup-screen-error'), 'the error screen must be kept, not removed')
  return 'splash + startup overlay, error screen kept'
})

// G4 — `bg-white/25` written as a bare attribute is a template parse error that
// produced two failed deployments. The modifier belongs inside class="".
check('G4 no opacity utilities as bare attributes', () => {
  const offenders = []
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const rel = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (['node_modules', 'dist', '.git'].includes(entry.name))
          continue
        walk(rel)
      }
      else if (entry.name.endsWith('.vue')) {
        const text = read(rel)
        for (const line of text.split('\n')) {
          const bare = line.match(/^\s*(bg|text|border)-[a-z]+(?:\/\d+)?\s*$/m)
          if (bare && line.includes('/'))
            offenders.push(`${rel}: ${line.trim()}`)
        }
      }
    }
  }
  walk('packages/stage-layouts/src')
  walk('apps/stage-web/src')
  assert(offenders.length === 0, offenders.slice(0, 5).join(' | '))
  return 'none'
})

// G5 — a gate nobody runs is a gate that never fails. There are eighteen gate
// files and the verifier runs a few, so the decision of which is automatic is
// written down in apps/sofia-gateway/test/gates.json, with a reason for every
// manual one. A new gate that is not in the manifest fails this check.
check('G5 every gate is declared, and every automatic one is wired', () => {
  const dir = join(root, 'apps/sofia-gateway/test')
  const files = readdirSync(dir).filter(f => f.endsWith('-gate.mjs'))
  const manifest = JSON.parse(readFileSync(join(dir, 'gates.json'), 'utf8')).gates
  const undeclared = files.filter(f => !manifest[f])
  assert(undeclared.length === 0, `not declared in gates.json: ${undeclared.join(', ')}`)
  const verifier = read('scripts/verify-release.sh')
  const unwired = Object.entries(manifest).filter(([f, v]) => v.auto && !verifier.includes(f)).map(([f]) => f)
  assert(unwired.length === 0, `marked automatic but not run by verify-release.sh: ${unwired.join(', ')}`)
  const auto = Object.entries(manifest).filter(([, v]) => v.auto).map(([f]) => f)
  return `${files.length} gates, ${auto.length} automatic`
})

// G6 — a kind the tools can ask for must be a kind the window can render.
check('G6 every window kind is rendered', () => {
  const tools = read('apps/sofia-gateway/tools.mjs')
  const win = read('packages/stage-layouts/src/components/Widgets/SofiaWindow.vue')
  const enumLine = tools.match(/enum: \[([^\]]+)\]/)
  assert(enumLine, 'show_panel enum not found')
  const kinds = [...enumLine[1].matchAll(/'([a-z]+)'/g)].map(m => m[1])
  for (const kind of kinds) {
    if (kind === 'image')
      continue
    assert(win.includes(`kind === '${kind}'`), `SofiaWindow.vue has no branch for "${kind}"`)
  }
  return kinds.join(', ')
})

// G7 — awaiting inside a synchronous request handler is a syntax error that only
// shows up when the file is parsed, not when it is written. Caught once at deploy.
check('G7 the gateway handler is async when it awaits', () => {
  const server = read('apps/sofia-gateway/server.mjs')
  if (!server.includes('await fetch('))
    return 'no awaits in the handler'
  assert(/createServer\(async \(req, res\)/.test(server), 'createServer handler is not async')
  return 'async'
})

// G8 — the verifier once accepted an 11/12 run because it grepped the substring
// "12/12". It must parse the count instead.
check('G8 the verifier parses gate counts', () => {
  const verifier = read('scripts/verify-release.sh')
  assert(!/\$\{?[a-z]*\}?12\/12/.test(verifier) || verifier.includes('%'), 'verifier looks for a hardcoded 12/12')
  assert(/\/\(\\d\+\)\\\/\(\\d\+\)\//.test(verifier) || verifier.includes('pass'), 'verifier does not parse a passed/total count')
  return 'parsed'
})

// G9 — the fork must stay mergeable: package identifiers are never rebranded.
check('G9 the upstream package names are intact', () => {
  const pkg = JSON.parse(read('apps/stage-web/package.json'))
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
  const ours = Object.keys(deps).filter(d => d.startsWith('@proj-airi/'))
  assert(ours.length > 0, 'no @proj-airi/* dependency — the fork may have been renamed')
  return `${ours.length} packages`
})

// G10 — the image Coolify builds must exist and must build the stage.
check('G10 the Dockerfile still builds the stage', () => {
  assert(has('Dockerfile'), 'no Dockerfile')
  const dockerfile = read('Dockerfile')
  assert(/stage-web/.test(dockerfile), 'Dockerfile does not mention stage-web')
  return 'ok'
})

// G11 — upstream ships its own workflows. Adding one is fine; rewriting the
// fork's `ci.yml` is not, and that happened on 2026-11-10 (an 80-line file
// replaced a 387-line pipeline). Ours live under their own name.
check('G11 the upstream CI is untouched and ours is separate', () => {
  const upstream = read('.github/workflows/ci.yml')
  assert(/^name: CI/m.test(upstream), 'upstream ci.yml was replaced — it should still start with "name: CI"')
  const workflows = readdirSync(join(root, '.github/workflows')).filter(f => /ya?ml$/.test(f))
  const ours = workflows.filter(f => sofiaWorkflow(f))
  assert(ours.length > 0, 'no sofia-*.yml workflow runs the guards')
  const runs = ours.filter(f => read(join('.github/workflows', f)).includes('guards.mjs'))
  assert(runs.length > 0, 'a sofia workflow exists but does not run scripts/ci/guards.mjs')
  return `${runs.join(', ')} runs the guards`
})

// G12 — deleting a block took a declaration with it. `stageLastPage` and
// `rememberPage` lost their `let`/`function` when the site matcher moved to
// intent.mjs, and `node --check` passed: it checks syntax, not scope. The
// failure would have been a ReferenceError inside the Live panel handler, so
// every voice-driven window would have thrown before it was sent.
//
// The check is `no-undef`, not a regex of my own: the first attempt counted
// prose in comments and CSS inside template literals as calls, and the second
// fought regex literals. A parser already knows the difference. It runs with a
// throwaway flat config so it cannot be disabled by the repo's own lint rules.
check('G12 no module uses a name it never declares', () => {
  const config = join(root, 'scripts/ci/no-undef.config.mjs')
  assert(has('scripts/ci/no-undef.config.mjs'), 'scripts/ci/no-undef.config.mjs is missing')
  // The `guards` job checks out and runs this file without installing, so a
  // missing eslint has to be a stated skip, not a red check that says nothing
  // about the code. `node_modules/.bin/eslint` is used rather than `npx` so a
  // stray download can never be what passes or fails the guard.
  const eslintBin = join(root, 'node_modules/.bin/eslint')
  if (!existsSync(eslintBin))
    return 'eslint not installed here — scope check runs where dependencies exist (local, CI build job)'
  const result = spawnSync(eslintBin, ['--no-config-lookup', '-c', config,
    'apps/sofia-gateway/*.mjs', 'apps/sofia-gateway/browse-service/*.mjs', '--format', 'json'], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
  })
  if (result.error)
    throw new Error(`could not run eslint: ${result.error.message}`)
  let report = []
  try { report = JSON.parse(result.stdout || '[]') }
  catch { throw new Error(`eslint produced no JSON: ${String(result.stderr).slice(0, 200)}`) }
  const problems = report.flatMap(file => (file.messages || [])
    .filter(m => m.ruleId === 'no-undef')
    .map(m => `${file.filePath.split('/').pop()}:${m.line} ${m.message}`))
  assert(problems.length === 0, `used but never declared: ${problems.slice(0, 6).join('; ')}`)
  return `${report.length} gateway files, no undefined names`
})

// G14 — every locale's default persona is Sofia's, not the fork's VTuber.
//
// `base.yaml`'s `prompt.prefix` is the personality every device gets before its
// owner edits a card, and both lanes read it: the text lane composes it into its
// system prompt, the voice lane sends the same card. Nine of ten locales still
// carried AIRI's "experimental virtual AI VTuber / 15 year old girl / anime or
// Vtuber girl" text after the English one was replaced — and those devices can
// never migrate, because a stored card matching ANY locale variant is classified
// as unedited built-in, so neither the seed nor the sync path rewrites it. The
// default has to be right in every locale, at the source.
check('G14 no locale ships the legacy persona', () => {
  const dir = join(root, 'packages/i18n/src/locales')
  const locales = readdirSync(dir).filter(name => has(`packages/i18n/src/locales/${name}/base.yaml`))
  assert(locales.length > 0, 'no locales found — did the path move?')
  // The fork's stock persona ADVERTISES itself: it names the character as a VTuber
  // and gives her an age. Those two are the identity, and both are unambiguous in
  // every locale. `anime` is deliberately NOT a marker: the replacement text says
  // "you do not speak like a cartoon", so the word legitimately appears in the
  // correct version too.
  const markers = [/VTuber/i, /15\s*(?:years? old|year-old|歳|años|ans|세|лет|ปี|tuổi|岁|歲)/i]
  const offenders = []
  for (const name of locales) {
    const text = read(`packages/i18n/src/locales/${name}/base.yaml`)
    const prefixAt = text.indexOf('prefix: |')
    if (prefixAt === -1)
      continue
    const emotionAt = text.indexOf('emotion: |', prefixAt)
    const prefix = text.slice(prefixAt, emotionAt === -1 ? prefixAt + 4000 : emotionAt)
    for (const marker of markers) {
      if (marker.test(prefix)) {
        offenders.push(`${name}: ${marker}`)
        break
      }
    }
  }
  assert(offenders.length === 0, `legacy persona in: ${offenders.join(', ')}`)

  // The seed's migration has to catch the SAME wording. Changing a locale's
  // default un-filters a stored card that matched it, turning the old text into a
  // "user edit" that is stranded forever and synced as one — so the migration
  // markers must still recognise every legacy locale, and must not match the new
  // text (or it would rewrite her persona on every load).
  // The matcher lives where the locale-correct built-in text is (`airi-card.ts`,
  // next to `migratePreIruCard`), not in the gateway: the seed cannot interpolate
  // module-scope constants into the browser script, and an English persona written
  // over a Japanese card is not a migration.
  const cards = read('packages/stage-ui/src/stores/modules/airi-card.ts')
  const markerAt = cards.indexOf('const legacyPersonaDescription =')
  assert(markerAt !== -1, 'legacyPersonaDescription is gone — the card migration has no matcher')
  const markerLine = cards.slice(markerAt, cards.indexOf('\n', markerAt))
  assert(/VTuber/.test(markerLine) && /15/.test(markerLine),
    'the migration marker no longer names VTuber or an age — it cannot recognise the old cards')
  return `${locales.length} locales, migration marker present`
})

// G13 — a stage event with no tab goes to every tab. `close everything` typed in
// one tab cleared another tab's windows, and no single-tab gate can see it: the
// bug is the *audience* of the event, not its content.
//
// The first version of this check used `[^)]*` to capture a call's arguments,
// which stops at the first `)` — inside a multi-line object literal it never
// reached the closing `, tab)` and reported "all scoped" for calls that had no
// tab at all. It is a balanced-paren scan now, because the thing being checked
// is a function call and regexes do not count brackets.
function callArgs(source, name) {
  const calls = []
  let at = source.indexOf(`${name}(`)
  while (at !== -1) {
    // Skip the definition.
    const before = source.slice(Math.max(0, at - 20), at)
    let depth = 0
    let i = at + name.length
    let start = -1
    for (; i < source.length; i++) {
      const ch = source[i]
      if (ch === '(') {
        depth += 1
        if (depth === 1)
          start = i + 1
      }
      else if (ch === ')') {
        depth -= 1
        if (depth === 0)
          break
      }
    }
    const args = start === -1 ? '' : source.slice(start, i)
    if (!/function\s*$/.test(before))
      calls.push(args)
    at = source.indexOf(`${name}(`, i)
  }
  return calls
}

check('G13 every stage broadcast names its tab', () => {
  const server = read('apps/sofia-gateway/server.mjs')
  const calls = callArgs(server, 'broadcastToStage')
  assert(calls.length > 0, 'no broadcastToStage call sites found — did the name change?')
  // The tab is the second top-level argument. Split on commas at depth 0 so an
  // object literal's commas do not count as separators.
  const topLevel = (args) => {
    const parts = []
    let depth = 0
    let current = ''
    for (const ch of args) {
      if ('([{'.includes(ch))
        depth += 1
      if (')]}'.includes(ch))
        depth -= 1
      if (ch === ',' && depth === 0) {
        parts.push(current)
        current = ''
        continue
      }
      current += ch
    }
    parts.push(current)
    return parts.map(part => part.trim()).filter(Boolean)
  }
  const untagged = calls
    .map(topLevel)
    .filter(parts => parts.length < 2)
    .map(parts => parts[0]?.slice(0, 50))
  assert(untagged.length === 0, `broadcastToStage called without a tab: ${untagged.join(' | ')}`)
  return `${calls.length} broadcast(s), all scoped`
})

for (const line of passes)
  console.log(`PASS  ${line}`)
for (const line of failures)
  console.log(`FAIL  ${line}`)

console.log(`\n${passes.length}/${passes.length + failures.length} guards`)
process.exit(failures.length === 0 ? 0 : 1)
