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

import { recall, remember } from './memory.mjs'
import { closePage, normalizePosition, openPage, runBrowse } from './intent.mjs'

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
        name: 'browse',
        description: 'Do things inside a page on his screen. action: click (by visible text), clickSelector, fill (selector + text), select (a dropdown option), check (tick or untick a box; text "off" unticks), date (YYYY-MM-DD into a date field), press (Enter, Tab…), scroll, read (returns the visible text so you can answer from it), links (what is clickable), look (what is on screen right now, including dialogs), back, forward, reload, goto (url), close. Fields inside an iframe are found too. Use it whenever he says "search for", "click", "type", "open the second result", "what does it say". Several pages can be open at once: say which one with `target` (a title fragment, a url fragment, or "last"/"first"), because "click the link" is ambiguous when two windows are up. [stage: …] lists what is open.',
        parameters: {
          type: 'OBJECT',
          properties: {
            action: { type: 'STRING', enum: ['click', 'clickSelector', 'fill', 'select', 'check', 'date', 'press', 'scroll', 'read', 'links', 'look', 'back', 'forward', 'reload', 'goto', 'close'] },
            text: { type: 'STRING', description: 'Visible text to click or type, or a URL for goto' },
            selector: { type: 'STRING', description: 'CSS selector, for clickSelector or fill' },
            key: { type: 'STRING', description: 'Key to press, or the selector to fill' },
            target: { type: 'STRING', description: 'Which page: a title fragment, a url fragment, "last" (default) or "first"' },
            sid: { type: 'STRING', description: 'An exact page id, when you have one from [stage: …]' },
          },
          required: ['action'],
        },
      },
      {
        name: 'remember',
        description: 'Keep something he told you, so it survives this conversation and every window — his preferences, a fact about his work, a decision. Use it when he says "remember that", "keep in mind", "note that", or tells you something he will expect you to know later. Not for passing details of the current page.',
        parameters: {
          type: 'OBJECT',
          properties: {
            text: { type: 'STRING', description: 'The fact, in one clear sentence, as he would want it recalled.' },
          },
          required: ['text'],
        },
      },
      {
        name: 'recall',
        description: 'What you already know about him, from every past conversation on any device. Use it before asking him something he may have told you, and when he asks "do you remember", "what did I say about", "what do you know about me". Give a query for a pointed question; omit it for a general summary.',
        parameters: {
          type: 'OBJECT',
          properties: {
            query: { type: 'STRING', description: 'What you are trying to remember, in his words or yours. Omit for a general picture.' },
          },
        },
      },
      {
        name: 'show_chart',
        description: 'Draw a chart on his screen when a picture explains numbers better than a sentence — a comparison, a trend, a distribution. Give the data, not an image: you describe the chart and the gateway renders it. Use it when he says "show me", "graph that", "chart it", "how does it compare".',
        parameters: {
          type: 'OBJECT',
          properties: {
            type: { type: 'STRING', enum: ['bar', 'line', 'pie', 'doughnut', 'radar'], description: 'Chart shape.' },
            title: { type: 'STRING', description: 'A short human title shown above the chart.' },
            labels: { type: 'ARRAY', items: { type: 'STRING' }, description: 'One label per data point, in order.' },
            values: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'One number per label, same order.' },
          },
          required: ['type', 'labels', 'values'],
        },
      },
      {
        name: 'control_avatar',
        description: 'Change your own size and place on the stage. Use it when he says "get smaller", "move aside", "come back", "bigger" — or before you open something wide. action set or reset; scale 0.35-1.6; x and y are pixel offsets.',
        parameters: {
          type: 'OBJECT',
          properties: {
            action: { type: 'STRING', enum: ['set', 'reset'] },
            scale: { type: 'NUMBER' },
            x: { type: 'NUMBER' },
            y: { type: 'NUMBER' },
          },
          required: ['action'],
        },
      },
      {
        name: 'control_window',
        description: 'Arrange what is already on screen. Use it when he asks to resize, move, maximise, close, or line up the windows, or when a new window would cover the old one. action is one of: resize, move, maximize, minimize, close, focus, tile, close_all. target picks the window: "last" (default), "first", or a window id.',
        parameters: {
          type: 'OBJECT',
          properties: {
            action: { type: 'STRING', enum: ['resize', 'move', 'maximize', 'minimize', 'close', 'focus', 'tile', 'close_all'] },
            target: { type: 'STRING', description: 'last, first, or a window id' },
            x: { type: 'NUMBER', description: 'left edge in pixels, for move' },
            position: { type: 'STRING', description: 'for move: left, centre or right — put the window on that side of the stage' },
            y: { type: 'NUMBER', description: 'top edge in pixels, for move' },
            width: { type: 'NUMBER', description: 'width in pixels, for resize' },
            height: { type: 'NUMBER', description: 'height in pixels, for resize' },
          },
          required: ['action'],
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
/**
 * Which page a call is about.
 *
 * One remembered `lastPage` was fine until several windows were open, and then
 * "click the link" was a coin toss between them — the failure the roadmap calls
 * out. The context now keeps every page it opened, and a call can name one by a
 * title fragment, a url fragment, an exact sid, "first" or "last". A window the
 * user opened by hand (a panel the stage restored) is in the list too, because
 * the stage reports what it has.
 */
function resolveTarget(ctx, args = {}) {
  const asked = String(args.sid || args.target || '').trim()
  const pages = Array.isArray(ctx.pages) ? ctx.pages : []
  if (!asked)
    return String(ctx.lastPage?.sid || pages[pages.length - 1]?.sid || '')
  const lower = asked.toLowerCase()
  if (lower === 'last')
    return String(pages[pages.length - 1]?.sid || ctx.lastPage?.sid || '')
  if (lower === 'first')
    return String(pages[0]?.sid || ctx.lastPage?.sid || '')
  // An exact id wins over a search, so a sid echoed back from [stage: …] always
  // resolves even if it also looks like a word.
  const exact = pages.find(page => page.sid === asked)
  if (exact)
    return exact.sid
  if (ctx.lastPage?.sid === asked)
    return asked
  const named = pages.find(page => String(page.title || '').toLowerCase().includes(lower))
    || pages.find(page => String(page.url || '').toLowerCase().includes(lower))
  if (named)
    return named.sid
  // Nothing matched: say what IS open rather than silently acting on the wrong
  // page, which is how "she clicked the wrong window" would look from outside.
  const open = pages.map(page => page.title || page.url || page.sid).filter(Boolean).slice(0, 8)
  throw new Error(`nothing open is called "${asked}". Open now: ${open.join(' | ') || 'nothing'}`)
}

/** Remember a page, replacing an entry with the same sid. */
export function trackPage(ctx, page) {
  if (!page?.sid)
    return
  const pages = Array.isArray(ctx.pages) ? ctx.pages : (ctx.pages = [])
  const next = { sid: page.sid, url: page.url || '', title: page.title || '' }
  const at = pages.findIndex(existing => existing.sid === next.sid)
  if (at === -1)
    pages.push(next)
  else
    pages[at] = { ...pages[at], ...next }
  ctx.lastPage = next
}

/** Forget a page and keep `lastPage` honest. */
export function untrackPage(ctx, sid) {
  if (!Array.isArray(ctx.pages))
    return
  ctx.pages = ctx.pages.filter(page => page.sid !== sid)
  if (ctx.lastPage?.sid === sid)
    ctx.lastPage = ctx.pages[ctx.pages.length - 1] || null
}

export async function executeToolCall(call, ctx = {}) {
  const name = String(call?.name || '')
  const args = call?.args || {}
  const id = call?.id

  let text
  try {
    if (name === 'browse') {
      const action = String(args.action || '').toLowerCase()
      // `base` used to be declared inside this branch and read from a sibling
      // branch of `show_panel`: a ReferenceError that the tool swallowed into
      // "the browser could not open that page (base is not defined)". It lives
      // at module scope now, so no branch can be the only one that declares it.
      const target = resolveTarget(ctx, args)
      if (action === 'goto') {
        const url = String(args.text || '')
        if (!/^https?:\/\//i.test(url)) throw new Error('goto needs an absolute http(s) url')
        const page = await openPage(url)
        trackPage(ctx, page)
        if (typeof ctx.onPanel === 'function')
          ctx.onPanel({ kind: 'live', sid: page.sid, url: page.url || url, title: page.title || '' })
        text = `Opened ${page.url || url}.`
      }
      else {
        if (!target) throw new Error('nothing is open to work on — open a page first')
        // `close` is its own endpoint on the service, not an /act verb. Treating
        // it as one made the call 400, the page stayed open, and she believed a
        // window she had closed was still there.
        if (action === 'close') {
          await closePage(target)
          untrackPage(ctx, target)
          if (typeof ctx.onPanel === 'function') ctx.onPanel({ kind: 'control', action: 'close' })
          text = 'Closed that page.'
        }
        else {
          const result = await runBrowse(args, { sid: target })
          const body = result.body
          // A tick per action: the window keeps the picture it took when the
          // page opened, so her clicks were invisible without this. It goes out
          // before the error check — a click that missed still has to show him
          // what is really on the page, and the service's error reply carries no
          // `sid`, so gating the tick on `body.sid` muted exactly the failures
          // that most needed a picture.
          if (typeof ctx.onPanel === 'function') {
            // The page's own address, falling back to what this sid was last
            // known as — never an empty url, which the stage must not read as
            // "no window here".
            const known = (Array.isArray(ctx.pages) ? ctx.pages : []).find(page => page.sid === (body.sid || target))
            ctx.onPanel({
              kind: 'live',
              sid: body.sid || target,
              url: body.url || known?.url || ctx.lastPage?.url || '',
              title: body.title || known?.title || '',
              tick: Date.now(),
            })
          }
          if (!result.ok) throw new Error(body.error || `status ${result.status}`)
          if (action === 'read')
            text = `The page says: ${String(body.text || '').slice(0, 1500)}`
          else if (action === 'look') {
            // A description she can reason about: what is in the way, where the
            // cursor is, what is clickable. This is the "am I looking at the
            // right thing" verb, and it exists because innerText cannot see a
            // modal, a CAPTCHA or an error banner.
            const c = body.caption || {}
            const bits = [`Looking at ${c.title || 'the page'} (${c.url || ''}).`]
            if (c.dialogs?.length)
              bits.push(`A dialog is open: ${c.dialogs.join(' / ')}`)
            if (c.alerts?.length)
              bits.push(`Visible message: ${c.alerts.join(' / ')}`)
            if (c.focusedField)
              bits.push(`The cursor is in the "${c.focusedField}" field.`)
            if (c.buttons?.length)
              bits.push(`Buttons on screen: ${c.buttons.join(' · ')}`)
            if (c.scroll)
              bits.push(`Scrolled ${c.scroll.y}px down a ${c.scroll.height}px page.`)
            text = bits.join(' ')
          }
          else if (action === 'links')
            text = `Links: ${(body.links || []).slice(0, 12).map(l => l.text).join(' · ')}`
          else
            text = `Done — ${action}${args.text ? ` "${String(args.text).slice(0, 40)}"` : ''}. The page is ${body.title || body.url || 'updated'}.`
        }
      }
    }
    else if (name === 'remember') {
      const said = String(args.text || '').trim()
      if (!said)
        throw new Error('there was nothing to remember')
      await remember(said)
      text = 'I will remember that.'
    }
    else if (name === 'recall') {
      const answer = await recall({ query: String(args.query || '').trim() })
      // The model must not paraphrase a memory into a guess: an empty recall has
      // to sound like an empty recall.
      text = answer
        ? `What I know: ${answer.slice(0, 2500)}`
        : 'I do not have anything on that yet.'
    }
    else if (name === 'show_chart') {
      // A chart is rendered by a URL, not by her describing one: the window then
      // shows a real PNG that can be saved, zoomed and reopened, and the model
      // only has to produce the numbers. quickchart renders Chart.js config
      // server-side, so no new dependency ships for this.
      const type = String(args.type || 'bar').toLowerCase()
      const labels = Array.isArray(args.labels) ? args.labels.map(String).slice(0, 40) : []
      const values = Array.isArray(args.values) ? args.values.map(Number).slice(0, 40) : []
      if (!labels.length || labels.length !== values.length)
        throw new Error('show_chart needs one label for every value')
      if (values.some(value => !Number.isFinite(value)))
        throw new Error('show_chart needs numbers, not words')
      if (typeof ctx.onPanel !== 'function')
        throw new Error('this session cannot show a chart')
      const config = {
        type: ['bar', 'line', 'pie', 'doughnut', 'radar'].includes(type) ? type : 'bar',
        data: { labels, datasets: [{ label: String(args.title || '').slice(0, 60), data: values }] },
        options: { plugins: { title: { display: !!args.title, text: String(args.title || '').slice(0, 60) } } },
      }
      const url = `https://quickchart.io/chart?w=640&h=360&bkg=white&c=${encodeURIComponent(JSON.stringify(config))}`
      ctx.onPanel({ kind: 'image', url, title: String(args.title || 'Chart').slice(0, 80) })
      text = labels.length === 2
        ? `${labels[0]} ${values[0]} against ${labels[1]} ${values[1]} — the chart is on the screen beside you.`
        : `The ${type} chart with ${labels.length} points is on the screen beside you.`
    }
    else if (name === 'control_avatar') {
      if (typeof ctx.onPanel !== 'function') throw new Error('this session cannot move the avatar')
      ctx.onPanel({
        kind: 'avatar',
        action: String(args.action || 'set'),
        scale: Number.isFinite(Number(args.scale)) ? Number(args.scale) : undefined,
        x: Number.isFinite(Number(args.x)) ? Number(args.x) : undefined,
        y: Number.isFinite(Number(args.y)) ? Number(args.y) : undefined,
      })
      text = String(args.action || 'set') === 'reset' ? 'Back to my usual place.' : 'Moved.'
    }
    else if (name === 'control_window') {
      const action = String(args.action || '').toLowerCase()
      if (!action) throw new Error('no action was given')
      if (typeof ctx.onPanel !== 'function') throw new Error('this session cannot arrange windows')
      // The tool description tells the model "left, centre or right" and the
      // stage only knows "center". A British spelling silently did nothing and
      // the reply still said "Done", so the fix is at the boundary: translate
      // once, and say so if the word means nothing at all.
      let position
      if (args.position !== undefined && args.position !== '') {
        position = normalizePosition(args.position)
        if (!position)
          throw new Error(`"${String(args.position)}" is not a side of the stage — use left, centre or right`)
      }
      ctx.onPanel({
        kind: 'control',
        action,
        target: String(args.target || 'last'),
        x: Number.isFinite(Number(args.x)) ? Number(args.x) : undefined,
        y: Number.isFinite(Number(args.y)) ? Number(args.y) : undefined,
        width: Number.isFinite(Number(args.width)) ? Number(args.width) : undefined,
        height: Number.isFinite(Number(args.height)) ? Number(args.height) : undefined,
        position,
      })
      text = `Done — ${action}${position ? ` ${position}` : ''} applied to the ${String(args.target || 'last')} window.`
    }
    else if (name === 'show_panel') {
      const url = String(args.url || '').trim()
      const asked = String(args.kind || 'image').toLowerCase()
      const kind = asked === 'live' ? 'live' : asked === 'web' ? 'web' : 'image'
      if (!url) throw new Error('no url was given')
      if (kind !== 'image' && !/^https?:\/\//i.test(url)) throw new Error('a web panel needs an http(s) url')
      if (typeof ctx.onPanel !== 'function') throw new Error('this session cannot open panels')
      // A website shown as an <img> is a broken picture: the model sometimes
      // answers "open this page" with kind:"image" and the window renders an
      // empty box, which reads as "she ignored me". Decide from the URL, not
      // from the model's label: only real image files and site assets are
      // images, everything else is a live page.
      //
      // The decision used to live in an `else` branch that re-opened the page
      // itself, and that copy read `base` from the sibling `if` — an unbound
      // name. One decision, one open, so a third copy cannot appear.
      const imageUrl = /(\.(png|jpe?g|gif|webp|avif|svg|bmp|ico))(\?|#|$)/i.test(url) || /^\/(?!\/)/.test(url)
      const kind2 = kind === 'web' ? 'web' : imageUrl ? 'image' : 'live'
      if (kind2 === 'live') {
        let opened
        try {
          opened = await openPage(url)
        }
        catch (error) {
          throw new Error(`the browser could not open that page (${String(error.message || error).slice(0, 100)})`)
        }
        trackPage(ctx, { sid: opened.sid, url: opened.url || url, title: opened.title || '' })
        ctx.onPanel({ kind: 'live', sid: opened.sid, url: opened.url || url, title: String(opened.title || args.title || '').slice(0, 80) })
        text = `The page is open beside you — ${opened.title || 'it'} — and I can click or scroll it for you.`
      }
      else {
        ctx.onPanel({ kind: kind2, url, title: String(args.title || '').slice(0, 80) })
        text = kind2 === 'image' ? 'The picture is on the screen beside you.' : 'The page card is on the screen beside you.'
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
