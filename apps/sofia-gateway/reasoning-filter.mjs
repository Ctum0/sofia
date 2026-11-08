// Strips model reasoning from OpenAI-shaped completions.
//
// WHY: Hermes returns `reasoning_content` next to `content` when the model
// thinks before answering. The AIRI stage concatenates whatever it finds in the
// message, so a whole chain-of-thought renders in the chat bubble before the
// answer. The reasoning is useful to the brain and useless to the body, and the
// body is a mouth — so it is removed at the boundary instead of being patched
// per-client.
//
// Covers both shapes: `message.reasoning_content` in a JSON body and
// `delta.reasoning_content` in an SSE stream.
import { Transform } from 'node:stream'

const REASONING_KEYS = ['reasoning_content', 'reasoning', 'reasoning_details']

function stripFromChoice(choice) {
  let changed = false
  for (const holder of ['delta', 'message']) {
    const obj = choice?.[holder]
    if (!obj || typeof obj !== 'object')
      continue
    for (const key of REASONING_KEYS) {
      if (key in obj) {
        delete obj[key]
        changed = true
      }
    }
  }
  return changed
}

/** Mutates a parsed completion body in place. Returns true if anything changed. */
export function stripReasoningFromBody(body) {
  if (!body || typeof body !== 'object')
    return false
  let changed = false
  for (const choice of body.choices || [])
    changed = stripFromChoice(choice) || changed
  return changed
}

/** Line-based SSE filter. Passes everything through except reasoning fields. */
export class SseReasoningFilter extends Transform {
  constructor() {
    super()
    this.pending = ''
  }

  _transform(chunk, _enc, cb) {
    this.pending += chunk.toString('utf8')
    let nl
    while ((nl = this.pending.indexOf('\n')) !== -1) {
      const line = this.pending.slice(0, nl)
      this.pending = this.pending.slice(nl + 1)
      this.push(`${this.filterLine(line)}\n`)
    }
    cb()
  }

  _flush(cb) {
    if (this.pending)
      this.push(this.filterLine(this.pending))
    cb()
  }

  filterLine(line) {
    if (!line.startsWith('data:'))
      return line
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]')
      return line
    try {
      const obj = JSON.parse(payload)
      if (!stripReasoningFromBody(obj))
        return line
      return `data: ${JSON.stringify(obj)}`
    }
    catch {
      return line
    }
  }
}
