// Hermes as hands — the Live model speaks, Hermes acts.
//
// The Live API gives the voice model a mouth and nothing else: it cannot open a
// file, read a service status, run a command or touch memory. Hermes can do all
// of that, and it is already the brain behind `/v1`. So the voice model gets two
// function declarations and the gateway runs them server-side, holding the key:
//
//   local_time  — cheap, no network, proves the round trip without a run
//   ask_hermes  — submits a real Hermes run (`POST /v1/runs`) and waits for it
//
// Delegation is structured, never prose: a run is a task object with an id, a
// status and an output, so a failure is a failure and not a paragraph the model
// has to interpret. Handing Hermes a sentence in a chat completion and hoping it
// runs a tool is the pattern that turns "she can act" into "she says she acted".
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

export const TOOL_TIMEOUT_MS = Number(process.env.HERMES_TOOL_TIMEOUT_MS || 45_000)
const POLL_MS = Number(process.env.HERMES_TOOL_POLL_MS || 600)
const MAX_RESULT_CHARS = 4000

export const LIVE_TOOLS = [
  {
    functionDeclarations: [
      {
        name: 'local_time',
        description: 'The current date and time in Sri Lanka (Asia/Colombo). Use this whenever the user asks what time it is, what day it is, or how long until something.',
        parameters: { type: 'OBJECT', properties: {} },
      },
      {
        name: 'show_panel',
        description: 'Put something on his screen beside you. Use it when he asks to see a picture, a logo, a screenshot, or a web page, or when showing is clearer than describing. kind "live" opens the site in a real browser window on the stage that he can scroll and click (prefer this for any website); kind "image" renders a picture inline; kind "web" shows a small card with a link.',
        parameters: {
          type: 'OBJECT',
          properties: {
            kind: { type: 'STRING', enum: ['image', 'web', 'live'], description: 'live opens the site in a real browser window he can click and scroll; web shows a small card with a link; image shows a picture.' },
            url: { type: 'STRING', description: 'An absolute https URL, or a path on this site. Only PUBLIC paths work without a session, e.g. /og.png.' },
            title: { type: 'STRING', description: 'A short human title for the panel.' },
          },
          required: ['kind', 'url'],
        },
      },
      {
        name: 'ask_hermes',
        description: 'Hand a real task to Hermes, the operator machine: it has the VPS, a shell, files, memory, web research, skills and scheduled jobs. Use it for anything that has to actually be done or looked up rather than answered from the conversation — check a service or server, run a command, read or write a file, search the web, research a topic, remember or recall a fact. Give it one complete, self-contained instruction, because it does not see this conversation.',
        parameters: {
          type: 'OBJECT',
          properties: {
            task: {
              type: 'STRING',
              description: 'A complete instruction Hermes can execute on its own, including any detail it needs, e.g. "Run `docker ps` on the VPS and list the unhealthy containers" or "Read /home/ctum/projects/sofia/NEXT.md and summarise the next unchecked item".',
            },
          },
          required: ['task'],
        },
      },
    ],
  },
]

/** http.request speaks plaintext whatever the URL says — pick by protocol. */
function requestFor(target) {
  return target.protocol === 'https:' ? httpsRequest : httpRequest
}

function timeText() {
  const now = new Date()
  const date = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Colombo',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(now)
  const clock = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Colombo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now)
  return `${clock} Sri Lanka time, ${date}.`
}

/**
 * One JSON call to Hermes. Resolves with the parsed body plus the status code so
 * the caller can tell "the brain said no" (401, 429) from "the brain is broken".
 */
function hermesJson(method, path, { base, key, body, timeoutMs = 20_000 }) {
  const target = new URL(base.replace(/\/$/, '') + path)
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')

  return new Promise((resolve, reject) => {
    const req = requestFor(target)(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method,
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          'x-sofia-via': 'gateway-tool',
          ...(payload ? { 'content-length': payload.length } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => { chunks.push(c) })
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed = null
          try { parsed = JSON.parse(text) } catch {}
          resolve({ status: res.statusCode || 0, body: parsed, text })
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error(`Hermes ${method} ${path} timed out after ${timeoutMs} ms`)))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'unknown'])

/**
 * Submit a run and wait for it. Returns the run's output text.
 *
 * A run is the task object: `running` is a real state, so this polls instead of
 * pretending a single request is an answer. 429 is Hermes' concurrency cap, not a
 * failure — keep waiting, the run is queued.
 */
export async function runHermesTask(task, { base, key, timeoutMs = TOOL_TIMEOUT_MS, onProgress } = {}) {
  if (!key) throw new Error('gateway has no Hermes key')
  const deadline = Date.now() + timeoutMs

  let submitted = null
  for (let attempt = 0; attempt < 3 && !submitted; attempt += 1) {
    const res = await hermesJson('POST', '/runs', { base, key, body: { input: task } })
    if (res.status === 202 || res.status === 200) { submitted = res.body; break }
    if (res.status === 429 && Date.now() < deadline) { await sleep(1500); continue }
    throw new Error(`run submission answered ${res.status}: ${(res.body?.error?.message || res.text || '').slice(0, 300)}`)
  }
  if (!submitted?.run_id) throw new Error('run submission returned no run_id')

  const runId = submitted.run_id
  onProgress?.({ state: 'submitted', runId })

  while (Date.now() < deadline) {
    await sleep(POLL_MS)
    const res = await hermesJson('GET', `/runs/${encodeURIComponent(runId)}`, { base, key, timeoutMs: 10_000 })
    if (res.status !== 200 || !res.body) continue
    const { status, output } = res.body
    if (!TERMINAL.has(status)) continue

    if (status === 'completed') {
      const text = String(output ?? '').trim()
      return text || 'Hermes finished but returned no text.'
    }
    const detail = String(output ?? '').trim()
    throw new Error(detail ? `run ${status}: ${detail.slice(0, 300)}` : `run ${status}`)
  }

  throw new Error(`run still running after ${Math.round(timeoutMs / 1000)}s (${runId}) — tell the user it is still working`)
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * Run one function call from the Live model.
 * Returns `{ id, name, response }` — the exact shape `toolResponse` expects.
 */
export async function executeToolCall(call, ctx = {}) {
  const name = String(call?.name || '')
  const args = call?.args || {}
  const id = call?.id

  let text
  try {
    if (name === 'show_panel') {
      const url = String(args.url || '').trim()
      const asked = String(args.kind || 'image').toLowerCase()
      const kind = asked === 'live' ? 'live' : asked === 'web' ? 'web' : 'image'
      if (!url) throw new Error('no url was given')
      if (kind !== 'image' && !/^https?:\/\//i.test(url)) throw new Error('a web panel needs an http(s) url')
      if (typeof ctx.onPanel !== 'function') throw new Error('this session cannot open panels')
      if (kind === 'live') {
        const base = process.env.BROWSER_URL || 'http://sofia-browser:8790'
        let opened
        try {
          const res = await fetch(`${base}/open`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url }),
            signal: AbortSignal.timeout(45000),
          })
          opened = await res.json()
          if (!res.ok) throw new Error(opened.error || `status ${res.status}`)
        }
        catch (error) {
          throw new Error(`the browser could not open that page (${String(error.message || error).slice(0, 100)})`)
        }
        ctx.onPanel({ kind: 'live', sid: opened.sid, url: opened.url || url, title: String(opened.title || args.title || '').slice(0, 80) })
        text = `The page is open beside you — ${opened.title || 'it'} — and I can click or scroll it for you.`
      }
      else {
        ctx.onPanel({ kind, url, title: String(args.title || '').slice(0, 80) })
        text = kind === 'image' ? 'The picture is on the screen beside you.' : 'The page card is on the screen beside you.'
      }
    }
    else if (name === 'local_time') text = timeText()
    else if (name === 'ask_hermes') {
      const task = String(args.task || '').trim()
      if (!task) throw new Error('no task was given')
      text = await runHermesTask(task, ctx)
    }
    else text = `There is no tool called ${name}. Say so plainly instead of guessing.`
  }
  catch (err) {
    // The model must hear the failure, not a plausible invention. Hermes' own
    // "do not fabricate" rule applies to her voice lane too.
    text = `That did not work: ${String(err?.message || err).slice(0, 500)}`
  }

  const trimmed = text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}…` : text
  return { id, name, response: { result: trimmed } }
}
