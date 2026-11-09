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
<meta name="theme-color" content="#0a0506">
<title>Sofia</title>
<style>
  :root { color-scheme: dark; --ink:#0a0506; --ink2:#120809; --panel:rgba(24,11,14,.88);
    --edge:rgba(168,50,74,.28); --hot:rgba(197,63,92,.75); --wine:#a8324a; --wine2:#c53f5c;
    --brass:#c8a06a; --text:#f3e8e6; --muted:#a9898d; }
  * { box-sizing:border-box; }
  html,body { height:100%; margin:0; }
  body { display:grid; place-items:center; overflow:hidden; color:var(--text);
    font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
    background:
      radial-gradient(1100px 620px at 50% -12%, rgba(168,50,74,.22), transparent 62%),
      radial-gradient(760px 520px at 88% 108%, rgba(200,160,106,.10), transparent 60%),
      linear-gradient(168deg, var(--ink2) 0%, var(--ink) 58%, #060303 100%); }
  body::after { content:""; position:fixed; inset:0; pointer-events:none; opacity:.05;
    background-image:radial-gradient(rgba(255,255,255,.7) .5px, transparent .5px);
    background-size:3px 3px; }
  .card { position:relative; width:min(372px,90vw); padding:34px 32px 30px; border-radius:18px;
    background:var(--panel); border:1px solid var(--edge); backdrop-filter:blur(14px);
    box-shadow:0 30px 90px rgba(0,0,0,.75), inset 0 1px 0 rgba(255,255,255,.045); }
  .card::before { content:""; position:absolute; inset:-1px; border-radius:18px; pointer-events:none;
    padding:1px; background:linear-gradient(152deg,var(--hot),transparent 38%,transparent 68%,rgba(200,160,106,.22));
    -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
    -webkit-mask-composite:xor; mask-composite:exclude; }
  .mark { width:46px; height:46px; margin-bottom:18px; border-radius:13px; display:grid; place-items:center;
    background:linear-gradient(150deg,var(--wine),#5e1626); border:1px solid rgba(200,160,106,.35);
    box-shadow:0 10px 26px rgba(168,50,74,.32);
    font:600 19px/1 ui-serif,Georgia,"Times New Roman",serif; color:#fdf3ef; }
  h1 { font:500 25px/1.2 ui-serif,Georgia,"Times New Roman",serif; letter-spacing:.055em;
    text-transform:uppercase; margin:0 0 8px; }
  p.sub { margin:0 0 26px; color:var(--muted); font-size:13px; }
  label { display:block; font-size:11px; letter-spacing:.14em; text-transform:uppercase;
    color:var(--muted); margin-bottom:8px; }
  input { width:100%; padding:12px 14px; border-radius:10px; font:inherit; color:var(--text);
    border:1px solid rgba(168,50,74,.24); background:rgba(8,4,5,.72);
    transition:border-color .18s ease, box-shadow .18s ease; }
  input::placeholder { color:#6d545a; }
  input:focus { outline:none; border-color:var(--hot); box-shadow:0 0 0 3px rgba(168,50,74,.16); }
  button { width:100%; margin-top:16px; padding:12px 14px; border-radius:10px; cursor:pointer;
    border:1px solid rgba(200,160,106,.32); color:#fff6f2; font:inherit; font-weight:600;
    letter-spacing:.06em; text-transform:uppercase; font-size:12.5px;
    background:linear-gradient(160deg,var(--wine2),var(--wine) 55%,#78182a);
    box-shadow:0 12px 30px rgba(168,50,74,.30), inset 0 1px 0 rgba(255,255,255,.14);
    transition:transform .12s ease, box-shadow .18s ease, filter .18s ease; }
  button:hover { filter:brightness(1.07); }
  button:active { transform:translateY(1px); }
  .err { color:#ff8f9e; font-size:12.5px; margin-top:14px; min-height:17px; }
  .foot { margin-top:22px; padding-top:16px; border-top:1px solid rgba(168,50,74,.16);
    color:#6d545a; font-size:11px; letter-spacing:.08em; text-transform:uppercase; }
</style></head>
<body>
  <form class="card" method="POST" action="/api/login">
    <div class="mark">S</div>
    <h1>Sofia</h1>
    <p class="sub">Private assistant. Enter the password to continue.</p>
    <label for="pw">Password</label>
    <input id="pw" type="password" name="password" placeholder="\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022" autofocus autocomplete="current-password">
    <button type="submit">Enter</button>
    <div class="err">${error || ''}</div>
    <div class="foot">Sofia \u00b7 private deployment</div>
  </form>
</body></html>`
}
