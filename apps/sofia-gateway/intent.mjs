// What a turn means, and how a meaning becomes a browser command.
//
// Two lanes drive the same hands: the Live model calls `browse` with arguments,
// and a typed turn is matched by `stageIntent`. They used to build the wire
// payload separately, and that is exactly how they drifted: a typed "type hello"
// sent the words as the *selector*, a typed "scroll down" sent the word "down"
// where the service wanted pixels, and the model's `clickSelector` arrived
// lowercased as `clickselector` and the case-sensitive switch answered
// "unknown action". One contract, one place to be wrong, one thing to gate.
//
// Pure on purpose: nothing here opens a socket except `runBrowse`, nothing here
// knows about windows or SSE, and `hands-gate.mjs` can call every function
// without a server.
import process from 'node:process'

const OPEN_VERB = /\b(?:open|show|pull up|bring up|go to|take me to)\b/i
const SITES = {
  github: 'https://github.com',
  gitlab: 'https://gitlab.com',
  youtube: 'https://youtube.com',
  google: 'https://google.com',
  gmail: 'https://mail.google.com',
  reddit: 'https://reddit.com',
  x: 'https://x.com',
  twitter: 'https://x.com',
  wikipedia: 'https://wikipedia.org',
  notion: 'https://notion.so',
  maps: 'https://maps.google.com',
  hn: 'https://news.ycombinator.com',
  hackernews: 'https://news.ycombinator.com',
  stackoverflow: 'https://stackoverflow.com',
}

/** "open github for me and show" -> https://github.com, or null. */
export function urlFromText(text) {
  // The chat prefixes its own timestamps ("[2026-11-10 21:43] …") and any
  // dotted token used to win the match: that is how "try again and open github"
  // became https://chess.play and failed. Known sites first, strips of digits
  // and times removed, and only real TLDs accepted.
  const said = String(text || '').replace(/\[[^\]]*\]/g, ' ').replace(/\b\d{1,2}:\d{2}\b/g, ' ')
  if (!OPEN_VERB.test(said))
    return null
  const direct = said.match(/https?:\/\/[^\s'"]+/i)
  if (direct)
    return direct[0].replace(/[.,;:!)]+$/, '')
  const lower = said.toLowerCase()
  for (const key of Object.keys(SITES)) {
    if (new RegExp(`\\b${key}\\b`).test(lower))
      return SITES[key]
  }
  const TLD = /^(?:com|org|net|io|dev|ai|app|co|me|sh|gg|tv|xyz|edu|gov|info|site|so)$/
  for (const candidate of lower.match(/[a-z0-9-]+(?:\.[a-z0-9-]+)+/g) || []) {
    const tld = candidate.split('.').pop()
    if (TLD.test(tld))
      return `https://${candidate}`
  }
  for (const key of Object.keys(SITES)) {
    if (new RegExp(`\\b${key}\\b`).test(said.toLowerCase()))
      return SITES[key]
  }
  return null
}

// Her own size and place. These run before the open matcher, because "make
// yourself smaller" contains "make" and would otherwise be read as a request to
// open something.
// Word order is the whole bug: the first version only accepted "get smaller"
// and "smaller yourself", so the phrasing he actually uses — "make yourself
// smaller" — matched nothing, fell through to prose, and she answered that she
// could not resize herself. The rules below read the size word and the subject
// in either order; an explicit number ("scale yourself to 0.6") wins over both.
export const AVATAR_RULES = [
  // A size word is a step, not a fixed number: "make yourself smaller" twice
  // has to leave her smaller than once. The fixed 0.65 made the second ask a
  // no-op, and a command that does nothing on the second try reads as broken.
  [/\b(?:smaller|tinier|littler)\b|\bshrink\b|\bscale (?:yourself )?down\b|\bminimi[sz]e yourself\b/i, { action: 'set', step: -0.2 }],
  [/\bhalf size\b|\bsmall size\b/i, { action: 'set', scale: 0.5 }],
  [/\b(?:bigger|larger|taller)\b|\bgrow\b|\bscale (?:yourself )?up\b|\bmaximi[sz]e yourself\b/i, { action: 'set', step: 0.2 }],
  [/\bfull size\b|\bnormal size\b/i, { action: 'set', scale: 1 }],
  [/\bmove (?:yourself )?(?:to the )?left\b/i, { action: 'set', x: -260 }],
  [/\bmove (?:yourself )?(?:to the )?right\b/i, { action: 'set', x: 260 }],
  [/\bmove aside\b/i, { action: 'set', x: 220, scale: 0.8 }],
  [/\b(?:come back|reset yourself|back to normal|usual place)\b/i, { action: 'reset' }],
]

/**
 * What a typed turn asks the stage to do. Deliberately deterministic: the text
 * lane is Hermes, which has no function calling here, so every capability the
 * voice lane gets from a tool has to be recognised here or it does not exist
 * while typing.
 */
export function stageIntent(rawText) {
  const said = String(rawText || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b\d{1,2}:\d{2}\b/g, ' ')
  const lower = said.toLowerCase().trim()

  // Does this turn talk about HER, or about the furniture? "make yourself
  // smaller" is her; "make the window smaller" is the stage. Getting that
  // backwards is how a size request ends up opening a page.
  const herDirect = /\byourself\b|\byour avatar\b|\bavatar\b|\bshrink\b|\bmove aside\b|\bcome back\b/.test(lower)
  const sizeTalk = /\b(?:smaller|bigger|tinier|littler|larger|taller)\b|\bscale (?:up|down)\b|\bfull size\b|\bhalf size\b|\bnormal size\b|\b(?:scale|size)\b[^0-9%]{0,14}\d/.test(lower)
  const furniture = /\bwindows?\b|\bpanes?\b/.test(lower)

  if (herDirect || (sizeTalk && !furniture)) {
    // "scale yourself to 0.6" / "size 60%" beats a vague word.
    const sized = lower.match(/\b(?:scale|size)\b[^0-9%]{0,14}(\d*\.?\d+)\s*(?:%|percent)?/)
    if (sized) {
      const percent = /%|percent/.test(sized[0])
      let value = Number(sized[1])
      if (percent || value > 1.6)
        value = value / 100
      if (Number.isFinite(value) && value > 0)
        return { events: [{ kind: 'avatar', action: 'set', scale: Math.max(0.35, Math.min(1.6, value)) }] }
    }
    for (const [re, payload] of AVATAR_RULES) {
      if (re.test(lower))
        return { events: [{ kind: 'avatar', ...payload }] }
    }
  }

  // A window move, not a body move: "move it to the left" must not shrink her.
  if (/\b(?:window|page|browser|it)\b/.test(lower) && /\bmove\b/.test(lower)) {
    if (/\bleft\b/.test(lower))
      return { events: [{ kind: 'control', action: 'move', position: 'left' }] }
    if (/\bright\b/.test(lower))
      return { events: [{ kind: 'control', action: 'move', position: 'right' }] }
    if (/\b(?:centre|center|middle)\b/.test(lower))
      return { events: [{ kind: 'control', action: 'move', position: 'center' }] }
  }

  if (/\bclose (?:all|everything|all of them)\b|\bclose the windows\b/.test(lower))
    return { events: [{ kind: 'control', action: 'close_all' }] }
  if (/\bclose (?:it|that|this|the window)\b/.test(lower))
    return { events: [{ kind: 'control', action: 'close', target: 'last' }] }
  if (/\b(?:tile|line (?:them|the windows) up|arrange (?:them|the windows))\b/.test(lower))
    return { events: [{ kind: 'control', action: 'tile' }] }
  if (/\bmaximi[sz]e\b/.test(lower))
    return { events: [{ kind: 'control', action: 'maximize', target: 'last' }] }
  if (/\bminimi[sz]e\b/.test(lower))
    return { events: [{ kind: 'control', action: 'minimize', target: 'last' }] }

  const url = urlFromText(said)
  if (url)
    return { events: [{ kind: 'open', url }] }

  if (/\b(?:search|look up|google)\b/i.test(lower)) {
    const q = said.replace(/^.*?\b(?:search(?: for)?|look up|google)\b/i, '').replace(/^\s*(?:for|about)\s+/i, '').trim()
    if (q)
      return { events: [{ kind: 'open', url: `https://duckduckgo.com/?q=${encodeURIComponent(q.replace(/[?.!]+$/, ''))}` }] }
  }

  // Reading is a capability the voice lane has and the typed lane did not: a
  // typed "read me the page" matched nothing, so she answered from the chat
  // history and sounded like she had looked. `read` and `links` both go to the
  // page and come back with text, which is what makes the answer grounded.
  if (/\b(?:read|tell me what(?:'s| is) on)\b.*\b(?:page|site|screen|it|this|that)\b/i.test(lower)
    || /\bwhat does (?:the |this )?(?:page|site) say\b/i.test(lower)
    || /\bread (?:me )?(?:the |this )?(?:page|site)\b/i.test(lower))
    return { events: [], browse: { action: 'read' } }
  if (/\b(?:what )?links?\b.*\b(?:page|site|on it|there)\b/i.test(lower)
    || /\blist (?:the )?links?\b/i.test(lower)
    || /\bwhat(?:'s| is) clickable\b/i.test(lower))
    return { events: [], browse: { action: 'links' } }

  const click = said.match(/\b(?:click|tap|press) (?:on )?(?:the )?(.+?)(?: link| button)?$/i)
  if (click && !/^enter$/i.test(click[1].trim()))
    return { events: [], browse: { action: 'clickText', text: click[1].trim() } }
  if (/\bpress (?:the )?enter\b|\bhit enter\b/i.test(lower))
    return { events: [], browse: { action: 'press', key: 'Enter' } }
  const type = said.match(/\btype (?:in )?(?:["“])(.+?)["”]/i) || said.match(/\btype (?:in )?(.{2,80})$/i)
  if (type)
    return { events: [], browse: { action: 'fill', text: type[1].trim(), selector: 'input:not([type=hidden]), textarea' } }
  if (/\bscroll (?:down|further)\b/i.test(lower))
    return { events: [], browse: { action: 'scroll', delta: 600 } }
  if (/\bscroll (?:up|back)\b/i.test(lower))
    return { events: [], browse: { action: 'scroll', delta: -600 } }
  if (/\bgo back\b|\bback to the (?:last|previous) page\b/i.test(lower))
    return { events: [], browse: { action: 'back' } }
  if (/\breload\b|\brefresh the page\b/i.test(lower))
    return { events: [], browse: { action: 'reload' } }

  return { events: [] }
}

/** The stage knows `left`, `center` and `right`. Everybody else spells it their own way. */
export function normalizePosition(value) {
  const spot = String(value || '').toLowerCase().trim()
  if (spot === 'left')
    return 'left'
  if (spot === 'right')
    return 'right'
  if (spot === 'centre' || spot === 'center' || spot === 'middle')
    return 'center'
  return undefined
}

// The browser service's verbs are case-sensitive and half of them mean
// something different from the model's word for them. Mapping is explicit:
// forwarding a lowercased string is how `clickSelector` became `clickselector`
// and the service answered "unknown action" while a working action sat there.
const ACTIONS = {
  click: 'clickText',
  clicktext: 'clickText',
  clickselector: 'clickSelector',
  fill: 'fill',
  type: 'type',
  press: 'press',
  key: 'press',
  scroll: 'scroll',
  read: 'read',
  links: 'links',
  value: 'value',
  look: 'look',
  select: 'select',
  check: 'check',
  uncheck: 'check',
  tick: 'check',
  date: 'date',
  back: 'back',
  forward: 'forward',
  reload: 'reload',
}

const SCROLL_STEPS = { down: 600, up: -600, left: -600, right: 600, further: 600, 'further down': 600, 'back up': -600 }

/**
 * One meaning -> one wire payload for `/act`.
 *
 * `selector` is a CSS selector, `key` is a key name, and `text` is words or a
 * page coordinate. They were interchangeable once, which is why a typed
 * "type hello" asked Playwright for `locator("hello")` and timed out.
 */
export function browseCommand(args = {}) {
  const asked = String(args.action || '').toLowerCase().trim()
  const action = ACTIONS[asked]
  if (!action)
    throw new Error(`there is no browse action "${asked}". Use one of: ${[...new Set(Object.values(ACTIONS))].join(', ')}`)

  const out = { action }
  if (args.selector !== undefined && args.selector !== '')
    out.selector = String(args.selector)
  if (args.key !== undefined && args.key !== '')
    out.key = String(args.key)

  if (action === 'scroll') {
    // The service reads pixels. A direction word reached it as `Number("down")`
    // -> NaN -> "mouse.wheel: Invalid parameters", and the page never moved.
    const raw = args.text ?? args.delta
    const asNumber = Number(raw)
    if (Number.isFinite(asNumber) && asNumber !== 0)
      out.text = String(asNumber)
    else if (SCROLL_STEPS[String(raw ?? 'down').toLowerCase()] !== undefined)
      out.text = String(SCROLL_STEPS[String(raw ?? 'down').toLowerCase()])
    else if (args.delta !== undefined && Number.isFinite(Number(args.delta)))
      out.text = String(Number(args.delta))
    else
      out.text = '600'
    return out
  }

  if (args.text !== undefined && args.text !== '')
    out.text = String(args.text)
  // `uncheck` and `untick` map to the same verb as `check`, so the direction has
  // to be carried explicitly: without this the service reads its default ("on")
  // and TICKS a box the caller asked to clear, then reports "Done — check".
  if (action === 'check' && args.text === undefined && /^(uncheck|untick)$/.test(asked))
    out.text = 'off'
  if (action === 'fill' && !out.selector)
    out.selector = 'input:not([type=hidden]), textarea'
  return out
}

/**
 * Where browser actions actually execute.
 *
 * Two implementations exist: the headless service beside the gateway (default),
 * and a local agent on the user's own machine driving a real Chromium. The
 * caller cannot tell them apart — that is the point, because the tool contract,
 * the model's view and every existing gate stay identical whether a page is a
 * screenshot from this host or a window on a second monitor.
 *
 * Injected rather than imported: `server.mjs` imports this module, so reaching
 * back into it would be a cycle.
 */
let transport = null

/** Install the local-agent transport. Called once at startup when an agent is paired. */
export function useTransport(next) {
  transport = next
}

/** Ask the browser service to act on one page. Never throws on a page-level failure. */
export async function runBrowse(step, { base = process.env.BROWSER_URL || 'http://sofia-browser:8790', sid, x = 640, y = 400, timeoutMs = 45_000 } = {}) {
  const payload = { sid, x, y, ...browseCommand(step) }
  if (transport) {
    try {
      const body = await transport(payload, { timeoutMs })
      return { ok: true, status: 200, body, payload }
    }
    catch (error) {
      // Same shape as an HTTP failure, so `body.error` is where callers look.
      return { ok: false, status: 502, body: { error: String(error?.message || error) }, payload }
    }
  }
  const res = await fetch(`${base}/act`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  })
  let body
  try { body = await res.json() }
  catch { body = { error: `the browser service answered ${res.status} with no JSON` } }
  return { ok: res.ok, status: res.status, body, payload }
}

/** Open a page in a fresh browser context. */
export async function openPage(url, { base = process.env.BROWSER_URL || 'http://sofia-browser:8790', timeoutMs = 45_000 } = {}) {
  if (transport) {
    try {
      return await transport({ action: 'open', url }, { timeoutMs })
    }
    catch (error) {
      throw new Error(String(error?.message || error))
    }
  }
  const res = await fetch(`${base}/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const body = await res.json().catch(() => ({ error: `status ${res.status}` }))
  if (!res.ok)
    throw new Error(body.error || `status ${res.status}`)
  return body
}

/** Close one page by its session id. */
export async function closePage(sid, { base = process.env.BROWSER_URL || 'http://sofia-browser:8790', timeoutMs = 15_000 } = {}) {
  if (transport) {
    // Without this branch, "close that window" POSTed to the host service for a
    // page that only exists on the user's machine: it 404'd, the window stayed
    // open, and she reported it closed.
    try {
      await transport({ action: 'close', sid }, { timeoutMs })
    }
    catch {
      // Closing something already gone is not an error worth surfacing.
    }
    return
  }
  const res = await fetch(`${base}/close`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sid }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok)
    throw new Error(`could not close that page (status ${res.status})`)
}
