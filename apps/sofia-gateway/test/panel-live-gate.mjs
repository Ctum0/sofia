// panel-live-gate.mjs — does the MODEL calling show_panel actually put something
// on the screen? panel-gate.mjs proves the browser half by calling
// window.__sofiaPanel directly; this proves the half that starts at Google:
// a real Live session, a typed instruction, a toolCall, a {type:"panel"} frame.
import { chromium } from "playwright"

const BASE = process.env.BASE || "https://sofia.ctum.org"
const PASSWORD = process.env.SOFIA_PASSWORD || ""
const log = (...a) => console.log(...a)

const browser = await chromium.launch({
  args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required",
    "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
})
const ctx = await browser.newContext({ permissions: ["microphone"], viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
page.on("console", m => { const t = m.text(); if (t.includes("[sofia]")) log("  page>", t.slice(0, 160)) })

let ok = false
try {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60000 })
  const f = await page.$("input[type=password]")
  if (f) { await f.fill(PASSWORD); await page.click("button[type=submit], button"); await page.waitForLoadState("domcontentloaded") }
  await page.waitForSelector("[data-testid=sofia-voice-dock]", { timeout: 120000, state: "visible" })

  const started = await page.evaluate(async () => {
    window.__pEvents = []
    const { SofiaVoice } = await import("/public/voice-client.mjs")
    const v = new SofiaVoice({ onEvent: (e) => { window.__pEvents.push({ type: e.type, name: e.name || null, kind: e.kind || null, url: e.url || null }); if (e.type === "panel") window.dispatchEvent(new CustomEvent("sofia:panel", { detail: e })) } })
    window.__pv = v
    await v.connect()
    await v.startMic()
    await new Promise(r => setTimeout(r, 1500))
    return { ready: v.ready, sent: v.sendText("Call the show_panel tool now: kind image, url /og.png, title Sofia. Do not speak, just call the tool.") }
  })
  log(`session ready=${started.ready} textSent=${started.sent}`)

  let hit = null
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(1000)
    const st = await page.evaluate(() => ({
      panel: (() => { const el = document.querySelector("[data-testid=sofia-panel]"); return el ? { kind: el.getAttribute("data-kind"), title: el.querySelector(".sofia-panel__title")?.textContent?.trim() } : null })(),
      events: window.__pEvents.filter(e => /panel|tool/i.test(e.type) || e.name).slice(-6),
      last: window.__pEvents.at(-1)?.type || null,
    }))
    if (st.panel) { hit = st; break }
    if (i % 6 === 0) log(`  t+${i}s last=${st.last} tool/panel events=${JSON.stringify(st.events)}`)
  }
  const tail = await page.evaluate(() => window.__pEvents.filter(e => /panel|tool/i.test(e.type) || e.name).map(e => `${e.type}${e.name ? ":" + e.name : ""}${e.kind ? ":" + e.kind : ""}`))
  log(`tool/panel events: ${JSON.stringify(tail)}`)
  log(`panel on screen: ${hit ? `YES kind=${hit.panel.kind} title="${hit.panel.title}"` : "NO"}`)
  ok = !!hit
  await page.evaluate(() => window.__pv?.stop?.()).catch(() => {})
} catch (e) {
  log(`gate threw: ${String(e).slice(0, 200)}`)
} finally {
  log(ok ? "\nPASS model-driven panel" : "\nFAIL model-driven panel")
  await browser.close()
  process.exit(ok ? 0 : 1)
}
