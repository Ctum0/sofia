// hands-gate.mjs — the six ways she claimed work she did not do.
//
// Every check here is a bug that shipped, each named after the mistake. They
// share one cause: the two lanes that drive the browser built their own wire
// payload, so a meaning could be right in the voice lane and wrong in the typed
// lane, and nothing compared them.
//
//  1. `show_panel` read `base` from a sibling branch -> ReferenceError, and the
//     window never opened.  2. `scroll` forwarded the word "down" where the
//     service wanted pixels -> NaN -> a Playwright protocol error.  3. the tool
//     lowercased `clickSelector` into `clickselector` -> "unknown action".
//  4. a typed "type hello" sent the words as the *selector* -> locator("hello").
//  5. a failed click returned no `sid`, so the window kept its old picture.
//  6. the tool said "centre" and the stage accepted only "center".
//
// Pure module checks need no server. The three that touch a page run against
// the real browser service, because a payload that looks right and types into
// the wrong field is exactly the class of bug that reads as fixed.
//
//   inside the gateway container:  node hands-gate.mjs
//   from a laptop against prod:    BASE=https://sofia.ctum.org SOFIA_PASSWORD=… node hands-gate.mjs
import process from 'node:process'

const results = []
const ok = (name, detail = '') => { results.push(['PASS', name]); console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`) }
const fail = (name, detail = '') => { results.push(['FAIL', name]); console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }

const { browseCommand, closePage, normalizePosition, openPage, runBrowse } = await import(process.env.INTENT_MODULE || '../intent.mjs')
const { executeToolCall } = await import(process.env.TOOLS_MODULE || '../tools.mjs')

const textOf = r => String(r?.response?.result ?? '')
const says = (text, pattern) => new RegExp(pattern, 'i').test(String(text))
const saysFailure = text => says(text, 'That did not work')

// --- 1. show_panel opened a page for a URL the model called an image ----------
// The label is wrong on purpose: a website tagged "image" must still open as a
// live page, and the branch that did that was the one reading an unbound name.
{
  const panels = []
  const ctx = { lastPage: null, onPanel: p => panels.push(p) }
  const result = await executeToolCall({ name: 'show_panel', args: { kind: 'image', url: 'https://example.com/' } }, ctx)
  const text = textOf(result)
  const opened = panels.find(p => p.kind === 'live')
  if (text.includes('base is not defined'))
    fail('show_panel opens a page the model mislabelled as an image', text.slice(0, 120))
  else if (/something went wrong|That did not work/i.test(text) && !opened)
    fail('show_panel opens a page the model mislabelled as an image', text.slice(0, 160))
  else if (!opened)
    fail('show_panel opens a page the model mislabelled as an image', `panels=${JSON.stringify(panels).slice(0, 120)}`)
  else
    ok('show_panel opens a page the model mislabelled as an image', opened.sid)
  // Both sides undefined compares equal, so "remembered" has to require that a
  // page actually exists: with nothing opened this used to print PASS.
  const remembered = ctx.lastPage?.sid
  if (!remembered || remembered !== opened?.sid)
    fail('the mislabelled page is remembered for the next call', String(remembered))
  else
    ok('the mislabelled page is remembered for the next call', ctx.lastPage.url)
  if (remembered)
    await closePage(remembered).catch(() => {})
}

// --- 2. a direction word is not a pixel count --------------------------------
{
  let command
  try {
    command = browseCommand({ action: 'scroll', text: 'down' })
  }
  catch (error) {
    command = { error: String(error.message) }
  }
  const pixels = Number(command.text)
  Number.isFinite(pixels) && pixels !== 0
    ? ok('a scroll direction becomes pixels', `"down" -> ${command.text}`)
    : fail('a scroll direction becomes pixels', JSON.stringify(command))
  const up = browseCommand({ action: 'scroll', text: 'up' })
  Number(up.text) < 0
    ? ok('scroll up is negative', up.text)
    : fail('scroll up is negative', JSON.stringify(up))
}

// --- 3. clickSelector survives the trip to the service ----------------------
{
  const command = browseCommand({ action: 'clickSelector', selector: 'a[href]' })
  command.action === 'clickSelector'
    ? ok('clickSelector keeps its capitals', command.action)
    : fail('clickSelector keeps its capitals', JSON.stringify(command))
  if (command.selector !== 'a[href]')
    fail('clickSelector carries its selector', JSON.stringify(command))
  else
    ok('clickSelector carries its selector', command.selector)
  // and the service must accept it
  const page = await openPage('https://example.com/').catch(error => ({ error: String(error.message) }))
  if (page.sid) {
    const result = await runBrowse({ action: 'clickSelector', selector: 'a' }, { sid: page.sid })
    result.ok
      ? ok('the browser service accepts clickSelector', `status ${result.status}`)
      : fail('the browser service accepts clickSelector', String(result.body?.error).slice(0, 120))
    await closePage(page.sid).catch(() => {})
  }
  else {
    fail('the browser service accepts clickSelector', String(page.error).slice(0, 120))
  }
}

// --- 4. a typed "type hello" must target the named field --------------------
{
  const command = browseCommand({ action: 'fill', text: 'hello', selector: 'input[name=q]' })
  command.selector === 'input[name=q]' && command.text === 'hello'
    ? ok('fill keeps the selector and the words apart', `${command.selector} <- "${command.text}"`)
    : fail('fill keeps the selector and the words apart', JSON.stringify(command))
  // The real proof: the text lands in the field that was named, not in the
  // first input on the page. `key` used to carry the words, so this typed into
  // nothing and timed out — and a click on the field succeeds whether or not it
  // holds anything, so the assertion has to read the field's own value.
  const page = await openPage('https://github.com/login').catch(error => ({ error: String(error.message) }))
  if (page.sid) {
    const probe = `sofia-${Date.now().toString(36)}`
    const result = await runBrowse({ action: 'fill', text: probe, selector: '#login_field' }, { sid: page.sid })
    const landed = result.body?.landed
    !result.ok
      ? fail('a named field receives the text', String(result.body?.error).slice(0, 140))
      : landed === probe
        ? ok('a named field receives the text', `#login_field reads "${landed}"`)
        : fail('a named field receives the text', `#login_field reads ${JSON.stringify(landed)} after filling "${probe}"`)
    // and the wrong field must stay empty: this is what "typed into the first
    // input on the page" looked like.
    const password = await runBrowse({ action: 'value', selector: '#password' }, { sid: page.sid })
    password.body?.landed === ''
      ? ok('the text went to the named field only', '#password still empty')
      : fail('the text went to the named field only', JSON.stringify(password.body?.landed))
    // A miss must still say what the page offers, and must still name the page
    // so the caller can redraw it (#5).
    const miss = await runBrowse({ action: 'clickText', text: 'No Such Label Anywhere' }, { sid: page.sid })
    !miss.ok && miss.body?.sid === page.sid
      ? ok('a failed click still names its page', `status ${miss.status}`)
      : fail('a failed click still names its page', JSON.stringify(miss.body).slice(0, 120))
    await closePage(page.sid).catch(() => {})
  }
  else {
    fail('a named field receives the text', String(page.error).slice(0, 120))
  }
}

// --- 5. a failed action still broadcasts a redraw ---------------------------
{
  const panels = []
  const ctx = { lastPage: null, onPanel: p => panels.push(p) }
  const opened = textOf(await executeToolCall({ name: 'show_panel', args: { kind: 'live', url: 'https://example.com/' } }, ctx))
  if (!ctx.lastPage?.sid) {
    fail('a failed click still redraws the window', `could not open a page: ${opened.slice(0, 100)}`)
  }
  else {
    panels.length = 0
    const missed = textOf(await executeToolCall({ name: 'browse', args: { action: 'click', text: 'No Such Label Anywhere' } }, ctx))
    const tick = panels.find(p => p.kind === 'live' && p.tick)
    const lied = !/That did not work/i.test(missed)
    lied
      ? fail('a failed click is reported as a failure', missed.slice(0, 120))
      : ok('a failed click is reported as a failure', missed.slice(0, 70))
    tick
      ? ok('a failed click still redraws the window', `tick ${tick.tick}`)
      : fail('a failed click still redraws the window', JSON.stringify(panels).slice(0, 140))
    await closePage(ctx.lastPage.sid).catch(() => {})
  }
}

// --- 6. the word the tool promises is the word the stage honours ------------
{
  const cases = [['centre', 'center'], ['center', 'center'], ['middle', 'center'], ['left', 'left'], ['RIGHT', 'right']]
  const wrong = cases.filter(([input, want]) => normalizePosition(input) !== want)
  wrong.length === 0
    ? ok('every spelling of a side becomes one side', cases.map(c => `${c[0]}->${c[1]}`).join(' '))
    : fail('every spelling of a side becomes one side', wrong.map(c => `${c[0]} gave ${normalizePosition(c[0])}`).join(', '))
  const panels = []
  const ctx = { lastPage: null, onPanel: p => panels.push(p) }
  const said = textOf(await executeToolCall({ name: 'control_window', args: { action: 'move', position: 'centre' } }, ctx))
  const emitted = panels.find(p => p.kind === 'control')
  emitted?.position === 'center' && !/That did not work/i.test(said)
    ? ok('control_window sends a side the stage can place', `centre -> ${emitted.position}`)
    : fail('control_window sends a side the stage can place', `${JSON.stringify(emitted)} / ${said.slice(0, 80)}`)
  panels.length = 0
  const nonsense = textOf(await executeToolCall({ name: 'control_window', args: { action: 'move', position: 'sideways' } }, ctx))
  ;/That did not work/i.test(nonsense)
    ? ok('an unplaceable side is refused, not narrated as done', nonsense.slice(0, 70))
    : fail('an unplaceable side is refused, not narrated as done', nonsense.slice(0, 90))
}

// A gate that dies leaves no count, and the verifier reads "did not report a
// count" — the same sentence whether the product is broken or the gate is. Say
// which check threw, so a crash is never mistaken for a red product.
process.on('unhandledRejection', (error) => {
  fail('the gate ran without throwing', String(error?.message || error).slice(0, 200))
  report()
})
process.on('uncaughtException', (error) => {
  fail('the gate ran without throwing', String(error?.message || error).slice(0, 200))
  report()
})

function report() {
  const passed = results.filter(r => r[0] === 'PASS').length
  console.log(`\n${passed}/${results.length}`)
  process.exit(passed === results.length ? 0 : 1)
}

// --- 6b. several pages: a call must land on the one that was named ---------
// One remembered `lastPage` was a coin toss the moment two windows were open:
// "click the link" hit whichever page happened to be last. The context keeps
// every page now, and a call names one by title, url, sid, "first" or "last".
{
  const panels = []
  const ctx = { lastPage: null, pages: [], onPanel: p => panels.push(p) }
  const openOne = async (url) => {
    const text = textOf(await executeToolCall({ name: 'show_panel', args: { kind: 'live', url } }, ctx))
    if (/That did not work/i.test(text))
      fail('two pages can be open at once', text.slice(0, 120))
    return text
  }
  await openOne('https://example.com/')
  await openOne('https://github.com/')
  ctx.pages?.length === 2
    ? ok('two pages can be open at once', ctx.pages.map(p => p.sid).join(','))
    : fail('two pages can be open at once', JSON.stringify(ctx.pages))

  // The decisive assertion: the same action, two different targets, two
  // different answers. A registry that always resolved "last" would pass one of
  // these and fail the other.
  const exampleLinks = textOf(await executeToolCall({ name: 'browse', args: { action: 'links', target: 'example' } }, ctx))
  const githubLinks = textOf(await executeToolCall({ name: 'browse', args: { action: 'links', target: 'github' } }, ctx))
  const exampleOk = /^Links: .+/.test(exampleLinks) && !/That did not work/i.test(exampleLinks)
  const githubOk = /^Links: .+/.test(githubLinks) && !/That did not work/i.test(githubLinks)
  if (exampleOk && githubOk && exampleLinks !== githubLinks)
    ok('a target picks the page that was named', `example and github returned different pages`)
  else
    fail('a target picks the page that was named', `example=${exampleLinks.slice(0, 50)} github=${githubLinks.slice(0, 50)}`)

  const unknown = textOf(await executeToolCall({ name: 'browse', args: { action: 'read', target: 'no-such-window' } }, ctx))
  says(unknown, 'nothing open is called') && says(unknown, 'github|example')
    ? ok('an unknown target says what is open instead of guessing', unknown.slice(0, 70))
    : fail('an unknown target says what is open instead of guessing', unknown.slice(0, 100))

  // `last` and `first` are the words the model is told to use.
  const first = textOf(await executeToolCall({ name: 'browse', args: { action: 'links', target: 'first' } }, ctx))
  first === exampleLinks
    ? ok('"first" means the page opened first', `${first.slice(0, 40)}`)
    : fail('"first" means the page opened first', first.slice(0, 80))

  for (const page of [...(ctx.pages || [])])
    await executeToolCall({ name: 'browse', args: { action: 'close', sid: page.sid } }, ctx).catch(() => {})
}

// --- 6c. a chart is a picture, not a paragraph ------------------------------
// "Show me a chart" used to be a sentence about a chart. The tool renders one
// from the numbers, as a URL the window can display, save and reopen.
{
  const panels = []
  const ctx = { lastPage: null, pages: [], onPanel: p => panels.push(p) }
  const text = textOf(await executeToolCall({ name: 'show_chart', args: { type: 'bar', title: 'Sales', labels: ['Q1', 'Q2', 'Q3'], values: [12, 30, 22] } }, ctx))
  const panel = panels.find(p => p.kind === 'image' && /quickchart\.io/.test(String(p.url)))
  panel
    ? ok('a chart is drawn on the stage', `image from ${new URL(panel.url).host}`)
    : fail('a chart is drawn on the stage', JSON.stringify(panels).slice(0, 140))
  // Assert the claim, not a particular sentence: what matters is that she
  // tells him it is on screen, so the words she is allowed to use are broad.
  says(text, 'chart') && says(text, 'screen|beside you')
    ? ok('she says she showed it, and did', text.slice(0, 70))
    : fail('she says she showed it, and did', text.slice(0, 90))
  const bad = textOf(await executeToolCall({ name: 'show_chart', args: { type: 'bar', labels: ['a'], values: ['lots'] } }, ctx))
  says(bad, 'That did not work')
    ? ok('a chart with words for numbers is refused', bad.slice(0, 60))
    : fail('a chart with words for numbers is refused', bad.slice(0, 80))
  const mismatch = textOf(await executeToolCall({ name: 'show_chart', args: { type: 'line', labels: ['a', 'b'], values: [1] } }, ctx))
  says(mismatch, 'one label for every value')
    ? ok('a chart with a mismatched label count is refused', mismatch.slice(0, 60))
    : fail('a chart with a mismatched label count is refused', mismatch.slice(0, 80))
}

// --- 6d. memory reaches a fact told in another lane ------------------------
// The defect this replaces: text memory lived in IndexedDB (one browser profile)
// and voice never read it at all, so anything he said was forgotten by the next
// device. Both lanes now read and write one server-side store.
{
  const { memoryStatus, recall, remember } = await import(process.env.MEMORY_MODULE || '../memory.mjs')
  const status = await memoryStatus().catch(error => ({ configured: false, reason: String(error?.message || error) }))
  if (!status.configured) {
    fail('memory is configured', String(status.reason || '').slice(0, 120))
  }
  else {
    ok('memory is configured', `${status.base} workspace=${status.workspace}`)
    // Write through the tool, then read it back through the tool: a store that
    // accepts writes and cannot answer questions about them is not memory.
    const fact = `Sofia memory gate ${Date.now().toString(36)}: his test colour is ultramarine.`
    const wrote = textOf(await executeToolCall({ name: 'remember', args: { text: fact } }, { lastPage: null, pages: [], onPanel: () => {} }))
    if (saysFailure(wrote)) {
      fail('a fact can be kept', wrote.slice(0, 120))
    }
    else {
      ok('a fact can be kept', wrote.slice(0, 60))
      // Honcho derives observations asynchronously; poll rather than assume.
      let answer = ''
      const deadline = Date.now() + 90_000
      while (Date.now() < deadline) {
        answer = await recall({ query: 'what is his test colour' }).catch(() => '')
        if (/ultramarine/i.test(answer))
          break
        await new Promise(res => setTimeout(res, 5000))
      }
      says(answer, 'ultramarine')
        ? ok('a fact told to her is what she recalls', answer.slice(0, 80).replace(/\n/g, ' '))
        : fail('a fact told to her is what she recalls', `recall said: ${answer.slice(0, 120)}`)
    }
    const empty = await recall({ query: 'the colour of a square circle' }).catch(() => '')
    empty.length > 0
      ? ok('recall answers, even when it knows nothing', `${empty.length} chars`)
      : fail('recall answers, even when it knows nothing', 'empty response')
  }
}

// --- 7. a typed read reaches the model, not just the browser ---------------
// The first version of this fix ran the read out of band and then proxied the
// ORIGINAL body, so Hermes answered from chat history while the page had
// already been read. Asserting the browser call alone would have called that
// fixed. So this calls the gateway's OWN `intentFromText` with a chat body and
// asserts the Buffer it returns: if the function changes, this changes with it.
{
  process.env.SOFIA_NO_LISTEN = '1'
  const { intentFromText, rememberPage } = await import(process.env.SERVER_MODULE || '../server.mjs')
  // A read needs a page, and the gateway's own state is what it reads. Open one
  // and tell the gateway about it through the exported setter, so this exercises
  // the real `stageLastPage` rather than a copy of it.
  const page = await openPage('https://github.com/login').catch(error => ({ error: String(error.message) }))
  if (page.sid)
    rememberPage({ sid: page.sid, url: page.url || 'https://github.com/login' })
  const chat = Buffer.from(JSON.stringify({
    model: 'hermes',
    stream: false,
    messages: [{ role: 'user', content: 'read me the page' }],
  }), 'utf8')
  const prepared = await intentFromText(chat)
  const forwarded = JSON.parse(prepared.body.toString('utf8'))
  const content = String(forwarded?.messages?.[0]?.content || '')
  const carries = /\[stage: the gateway already read/.test(content) && content.length > 200
  carries
    ? ok('a typed read hands the page text to the model', `${content.length} chars in the forwarded turn`)
    : fail('a typed read hands the page text to the model', `${content.length} chars: ${content.slice(0, 100)}`)
  // ...and an ordinary turn must be forwarded untouched.
  if (page.sid)
    await closePage(page.sid).catch(() => {})
  const plain = Buffer.from(JSON.stringify({ model: 'hermes', messages: [{ role: 'user', content: 'hello there' }] }), 'utf8')
  const untouched = await intentFromText(plain)
  untouched.body.equals(plain)
    ? ok('a turn with no intent is forwarded byte-for-byte')
    : fail('a turn with no intent is forwarded byte-for-byte', untouched.body.toString().slice(0, 100))
}

report()
