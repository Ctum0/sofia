// --- she speaks first -------------------------------------------------------
// The stage can ask. Something outside the browser has to decide that a moment
// has arrived, and a tab that was closed at 07:00 can never know it missed it.
// So the clock lives here, in the process that is always up.
//
// What this module hands over is the *slot and the time it fired*, never the
// finished sentence. A line written at 07:00 and read at 14:00 says "good
// morning"; the page composes the words from the clock it actually has when it
// delivers, and drops a slot that has gone stale instead of pretending.
//
// State is one small JSON file on the mounted volume, because a deploy must not
// re-fire the morning. In memory would lose that on every release.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const TZ = process.env.PROACTIVE_TZ || 'Asia/Colombo'
const SLOTS = String(process.env.PROACTIVE_SLOTS || '07:00,13:00,22:00')
  .split(',')
  .map(part => part.trim())
  .filter(part => /^\d{1,2}:\d{2}$/.test(part))
// A slot that fired more than this ago is a missed moment, not a late one: she
// does not deliver a 07:00 line at 11:00, she marks it missed and waits for the
// next one.
const GRACE_MS = Number(process.env.PROACTIVE_GRACE_MS || 90 * 60 * 1000)
// How long an unclaimed slot stays claimable before the page refuses it. Slightly
// longer than the grace so a page that was open at the slot still collects it.
const STALE_MS = Number(process.env.PROACTIVE_STALE_MS || 3 * 60 * 60 * 1000)
const KEEP_PENDING = 5
const TICK_MS = Number(process.env.PROACTIVE_TICK_MS || 30_000)

// /app/data is the mounted volume in production; a local run has no such path.
let statePath = process.env.PROACTIVE_STATE || '/app/data/proactive.json'

function localNow(now = Date.now()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .formatToParts(new Date(now))
      .map(part => [part.type, part.value]),
  )
  const hour = Number(parts.hour) % 24
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: hour * 60 + Number(parts.minute),
    clock: `${String(hour).padStart(2, '0')}:${parts.minute}`,
  }
}

function slotMinutes(slot) {
  const [h, m] = slot.split(':').map(Number)
  return h * 60 + m
}

let state = { fired: {}, pending: [] }
let stateError = ''

function loadState() {
  for (const candidate of [statePath, '/tmp/sofia-proactive.json']) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8'))
      if (parsed && typeof parsed === 'object') {
        state = {
          fired: parsed.fired && typeof parsed.fired === 'object' ? parsed.fired : {},
          pending: Array.isArray(parsed.pending) ? parsed.pending : [],
        }
        statePath = candidate
        return
      }
    }
    catch {}
  }
}

function saveState() {
  // Write-then-rename, so a container killed mid-write leaves the previous file
  // intact rather than a truncated one that loses today's fired list.
  for (const candidate of [statePath, '/tmp/sofia-proactive.json']) {
    try {
      mkdirSync(dirname(candidate), { recursive: true })
      const tmp = `${candidate}.tmp`
      writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
      renameSync(tmp, candidate)
      statePath = candidate
      stateError = ''
      return true
    }
    catch (error) {
      stateError = String(error?.message || error).slice(0, 120)
    }
  }
  return false
}

function prune() {
  const cutoff = Date.now() - STALE_MS
  state.pending = state.pending.filter(item => Number(item.at) > cutoff).slice(-KEEP_PENDING)
  const today = localNow().date
  for (const day of Object.keys(state.fired)) {
    if (day < today)
      delete state.fired[day]
  }
}

function markFired(date, slot) {
  if (!Array.isArray(state.fired[date]))
    state.fired[date] = []
  if (!state.fired[date].includes(slot))
    state.fired[date].push(slot)
}

function fire(slot, at = Date.now()) {
  const { date } = localNow(at)
  markFired(date, slot)
  const item = {
    id: `p${at.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    slot,
    at,
    date,
  }
  // Newest last, and a duplicate slot in the same window replaces the older
  // claim instead of stacking two of her lines on one page load.
  state.pending = [...state.pending.filter(existing => existing.slot !== slot), item].slice(-KEEP_PENDING)
  saveState()
  return item
}

/**
 * One clock tick. Returns what it did, so a test can read the decision rather
 * than infer it from the side effects.
 */
export function tick(now = Date.now()) {
  const local = localNow(now)
  const actions = []
  for (const slot of SLOTS) {
    const minutes = slotMinutes(slot)
    const after = local.minutes - minutes
    const already = (state.fired[local.date] || []).includes(slot)
    if (already || after < 0)
      continue
    if (after * 60_000 > GRACE_MS) {
      // The moment passed while she was not running. Marked, never replayed.
      markFired(local.date, slot)
      actions.push({ slot, action: 'missed' })
      continue
    }
    fire(slot, now)
    actions.push({ slot, action: 'fired' })
  }
  if (actions.length)
    saveState()
  return actions
}

export function pending() {
  const cutoff = Date.now() - STALE_MS
  return state.pending
    .filter(item => Number(item.at) > cutoff)
    .map(item => ({
      id: item.id,
      slot: item.slot,
      at: item.at,
      // Milliseconds until the page must stop offering it. A page that cannot
      // deliver in time drops it rather than opening with last night's verdict.
      expiresAt: Number(item.at) + STALE_MS,
    }))
}

export function ack(ids) {
  const wanted = new Set((Array.isArray(ids) ? ids : [ids]).filter(Boolean).map(String))
  const before = state.pending.length
  state.pending = state.pending.filter(item => !wanted.has(item.id))
  if (state.pending.length !== before)
    saveState()
  return before - state.pending.length
}

export function fireNow(slot = 'manual') {
  return fire(slot)
}

export function status() {
  const local = localNow()
  return {
    slots: SLOTS,
    timezone: TZ,
    now: local.clock,
    today: local.date,
    firedToday: state.fired[local.date] || [],
    pending: pending().length,
    statePath,
    error: stateError || undefined,
  }
}

export function start() {
  loadState()
  prune()
  // The first tick on boot is a decision, not a catch-up: a slot older than the
  // grace is recorded as missed, so a restart at noon does not replay breakfast.
  const actions = tick()
  if (actions.length)
    console.log(`[sofia-gateway] proactive: ${actions.map(a => `${a.slot}:${a.action}`).join(' ')}`)
  const timer = setInterval(() => {
    try {
      const done = tick()
      if (done.length)
        console.log(`[sofia-gateway] proactive: ${done.map(a => `${a.slot}:${a.action}`).join(' ')}`)
    }
    catch (error) {
      console.log(`[sofia-gateway] proactive tick failed: ${String(error?.message || error).slice(0, 120)}`)
    }
  }, TICK_MS)
  timer.unref?.()
  return timer
}
