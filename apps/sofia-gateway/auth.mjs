// Password gate for Sofia.
//
// The app is one origin, so a cookie is enough: no tokens to paste, no Basic
// auth dialog, and the WebSocket upgrade can check the same cookie. The cookie
// is an HMAC of the password, never the password, and it carries its own expiry
// so a stolen value dies on its own.
//
// Fails closed: no SOFIA_PASSWORD in the environment means no access, not open
// access. A misconfigured deploy should be dark, not public.
import { createHmac, timingSafeEqual } from 'node:crypto'

const COOKIE = 'sofia_session'
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60

function secret() {
  return process.env.SOFIA_PASSWORD || ''
}

function hmac(payload) {
  return createHmac('sha256', secret()).update(payload).digest('hex')
}

function safeEqual(a, b) {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/** Cookie value: <expiry-ms>.<hmac(expiry)> */
export function makeSession() {
  const expiry = Date.now() + MAX_AGE_SECONDS * 1000
  return `${expiry}.${hmac(String(expiry))}`
}

export function isValidSession(value) {
  if (!value || !secret()) return false
  const [expiry, signature] = value.split('.')
  if (!expiry || !signature) return false
  if (Number(expiry) < Date.now()) return false
  return safeEqual(signature, hmac(expiry))
}

export function checkPassword(candidate) {
  const expected = secret()
  if (!expected) return false
  if (typeof candidate !== 'string' || candidate.length === 0) return false
  // Compare digests so lengths always match and the timing is data-independent.
  return safeEqual(hmac(candidate), hmac(expected))
}

export function parseCookies(header = '') {
  const out = {}
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim())
  }
  return out
}

export function isAuthed(req) {
  const cookies = parseCookies(req.headers.cookie || '')
  return isValidSession(cookies[COOKIE])
}

export function sessionCookie(value) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE_SECONDS}`
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
}

export function loginPage({ error } = {}) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sofia</title>
<style>
  :root { color-scheme: dark; }
  html,body { height:100%; margin:0; }
  body { display:grid; place-items:center; background:#07080a; color:#e9ecef;
         font:15px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif; }
  form { width:min(340px,88vw); }
  h1 { font-size:20px; font-weight:600; margin:0 0 4px; letter-spacing:-.01em; }
  p { margin:0 0 22px; color:#8b939e; font-size:13px; }
  input { width:100%; box-sizing:border-box; padding:11px 13px; border-radius:9px;
          border:1px solid #242a33; background:#0e1116; color:#e9ecef; font:inherit; }
  input:focus { outline:none; border-color:#3ddc97; }
  button { width:100%; margin-top:12px; padding:11px 13px; border-radius:9px; border:0;
           background:#3ddc97; color:#06251a; font:inherit; font-weight:600; cursor:pointer; }
  button:hover { background:#4ae8a4; }
  .err { color:#ff6b6b; font-size:13px; margin-top:12px; min-height:18px; }
</style></head>
<body>
  <form method="POST" action="/api/login">
    <h1>Sofia</h1>
    <p>Private assistant. Enter the password to continue.</p>
    <input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password">
    <button type="submit">Enter</button>
    <div class="err">${error || ''}</div>
  </form>
</body></html>`
}
