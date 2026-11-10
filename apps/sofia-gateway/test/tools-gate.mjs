// The bug he hit: she opened a page, then said she could not see one. The cause
// was a context rebuilt per tool call, so `lastPage` never survived. This gate
// calls the tools the way the gateway does — one shared ctx — and fails if a
// second call cannot see what the first one opened.
//
// It runs inside the deployed gateway container (docker cp + docker exec), which
// is the only place that can reach both /app/tools.mjs and sofia-browser.
import process from 'node:process'

const { executeToolCall } = await import(process.env.TOOLS_MODULE || '/app/tools.mjs')

const results = []
const ok = (name, detail = '') => { results.push(['PASS', name]); console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`) }
const fail = (name, detail = '') => { results.push(['FAIL', name]); console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }

const ctx = { lastPage: null, panels: [], onPanel: p => ctx.panels.push(p) }
const call = (name, args) => executeToolCall({ name, args }, ctx)
const textOf = r => String(r?.response?.result ?? '')

const before = await call('browse', { action: 'read' })
textOf(before).toLowerCase().includes('open')
  ? ok('with nothing open, browse says to open a page first')
  : fail('with nothing open, browse says to open a page first', textOf(before).slice(0, 120))

const opened = await call('show_panel', { kind: 'live', url: 'https://example.com', title: 'Example' })
const openedText = textOf(opened)
openedText.startsWith('That did not work')
  ? fail('show_panel opens a live page', openedText.slice(0, 160))
  : ok('show_panel opens a live page')
ctx.lastPage?.sid ? ok('the page id is remembered on the context', ctx.lastPage.url) : fail('the page id is remembered on the context', JSON.stringify(ctx.lastPage))

const links = await call('browse', { action: 'links' })
const linksText = textOf(links)
// The service lists link *text* ("Links: Learn more"), not hrefs — counting
// http:// made a working call read as a broken one.
linksText.startsWith('That did not work') || !/^Links: .+/.test(linksText)
  ? fail('a second call still sees the page it opened', linksText.slice(0, 160))
  : ok('a second call still sees the page it opened', linksText.slice(0, 80))

const read = await call('browse', { action: 'read' })
textOf(read).length > 40 && !textOf(read).startsWith('That did not work')
  ? ok('she can read the page she opened', `${textOf(read).length} chars`)
  : fail('she can read the page she opened', textOf(read).slice(0, 160))

ctx.panels.length = 0
const avatar = await call('control_avatar', { action: 'set', scale: 0.7 })
const avatarPanel = ctx.panels.find(p => p.kind === 'avatar')
textOf(avatar).startsWith('That did not work') || !avatarPanel
  ? fail('control_avatar reaches the stage', JSON.stringify({ text: textOf(avatar).slice(0, 100), panel: avatarPanel }))
  : ok('control_avatar reaches the stage', `scale ${avatarPanel.scale}`)

ctx.panels.length = 0
const closeAll = await call('control_window', { action: 'close_all' })
const controlPanel = ctx.panels.find(p => p.kind === 'control')
controlPanel && controlPanel.action === 'close_all'
  ? ok('control_window reaches the stage', 'close_all')
  : fail('control_window reaches the stage', JSON.stringify({ text: textOf(closeAll).slice(0, 100), panels: ctx.panels }))

await call('browse', { action: 'close' })
const afterClose = await call('browse', { action: 'read' })
textOf(afterClose).toLowerCase().includes('open')
  ? ok('after closing, browse asks for a page instead of guessing')
  : fail('after closing, browse asks for a page instead of guessing', textOf(afterClose).slice(0, 140))

const passed = results.filter(r => r[0] === 'PASS').length
console.log(`\n${passed}/${results.length}`)
process.exit(passed === results.length ? 0 : 1)
