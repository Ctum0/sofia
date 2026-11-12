// Her memory, and his — one store, both lanes.
//
// Until now there were two: the stage kept a browser-local memory in IndexedDB
// (`stores/memory.ts`) that voice never read, and Hermes kept a server-side one
// in Honcho that the Live call never saw. So a fact told to her by voice was
// forgotten by evening, and a fact told by text lived in one browser profile.
// JARVIS remembers you, not your tab.
//
// Honcho is already running on this host for Hermes (`workspace: ctum`,
// `peer: ctum`), with a real representation built up over weeks. So this module
// is a thin client over it: `recall()` reads, `remember()` writes, and both the
// voice tool and the typed lane go through here.
import { readFileSync } from 'node:fs'
import process from 'node:process'

const BASE = process.env.HONCHO_BASE || 'https://honcho.ctum.org'
// `/app/data` is the volume Coolify already mounts into this container, so the
// credential lives beside the other state rather than in the image or in an env
// var that `docker inspect` would print.
const TOKEN_FILE = process.env.HONCHO_TOKEN_FILE || '/app/data/honcho-token'
const WORKSPACE = process.env.HONCHO_WORKSPACE || 'ctum'
// The person, and the assistant. Honcho models both: observations about him,
// and what she knows she said.
const USER_PEER = process.env.HONCHO_USER_PEER || 'ctum'
const AI_PEER = process.env.HONCHO_AI_PEER || 'sofia'

let cachedToken

function token() {
  if (cachedToken !== undefined)
    return cachedToken
  if (process.env.HONCHO_TOKEN) {
    cachedToken = process.env.HONCHO_TOKEN.trim()
    return cachedToken
  }
  try {
    // A file, not an env var: the token is a credential and this container's
    // environment is visible to anyone who can run `docker inspect`.
    cachedToken = readFileSync(TOKEN_FILE, 'utf8').trim()
  }
  catch {
    cachedToken = ''
  }
  return cachedToken
}

async function call(path, { method = 'POST', body, timeoutMs = 20_000 } = {}) {
  const key = token()
  if (!key)
    throw new Error('no Honcho token — memory is not configured')
  const res = await fetch(`${BASE.replace(/\/$/, '')}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  let parsed
  try { parsed = text ? JSON.parse(text) : {} }
  catch { parsed = { raw: text.slice(0, 400) } }
  if (!res.ok)
    throw new Error(`Honcho ${res.status}: ${String(parsed.detail || parsed.raw || '').slice(0, 160)}`)
  return parsed
}

/**
 * What she knows about him, as text she can be told.
 *
 * Honcho keeps a *representation* — observations distilled from past turns —
 * and `target` chooses whose. The answer is prose, not JSON, because it goes
 * straight into a model's context.
 */
export async function recall({ about = 'user', query = '', timeoutMs = 25_000 } = {}) {
  const peer = about === 'self' ? AI_PEER : USER_PEER
  if (query) {
    // A directed question gets a synthesised answer rather than the whole
    // representation: this is the "do you remember what I said about X" path.
    const chat = await call(`/v3/workspaces/${WORKSPACE}/peers/${peer}/chat`, {
      body: { query, target: peer },
      timeoutMs,
    })
    const answer = String(chat.content ?? chat.answer ?? '').trim()
    if (answer)
      return answer
  }
  const context = await call(`/v3/workspaces/${WORKSPACE}/peers/${peer}/context`, { method: 'GET', timeoutMs })
  return String(context.representation || '').trim()
}

/**
 * Tell her something worth remembering, outside a conversation.
 *
 * The normal path is that every turn is saved as a message and Honcho derives
 * facts from it, which is why this is not the hot path — it exists for the
 * moment he says "remember this", where the fact should land immediately rather
 * than after the next derivation pass.
 */
export async function remember(text, { about = 'user', timeoutMs = 25_000 } = {}) {
  const peer = about === 'self' ? AI_PEER : USER_PEER
  const sessions = await call(`/v3/workspaces/${WORKSPACE}/sessions/list`, { body: {}, timeoutMs })
  const sessionId = sessions.items?.[0]?.id || 'default'
  await call(`/v3/workspaces/${WORKSPACE}/sessions/${encodeURIComponent(sessionId)}/messages`, {
    body: { messages: [{ peer_id: peer, content: String(text).slice(0, 4000) }] },
    timeoutMs,
  })
  return sessionId
}

/** Save one turn so both lanes contribute to the same history. */
export async function recordTurn({ from, text, sessionId }) {
  await call(`/v3/workspaces/${WORKSPACE}/sessions/${encodeURIComponent(sessionId)}/messages`, {
    body: {
      messages: [{
        peer_id: from === 'assistant' ? AI_PEER : USER_PEER,
        content: String(text).slice(0, 8000),
      }],
    },
  })
}

export async function memoryStatus() {
  const key = token()
  if (!key)
    return { configured: false, reason: 'no token' }
  try {
    const list = await call('/v3/workspaces/list', { body: {}, timeoutMs: 8000 })
    return {
      configured: true,
      base: BASE,
      workspace: WORKSPACE,
      peers: { user: USER_PEER, ai: AI_PEER },
      workspaces: (list.items || []).map(item => item.id),
    }
  }
  catch (error) {
    return { configured: false, reason: String(error?.message || error).slice(0, 120) }
  }
}
