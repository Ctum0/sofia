# Decision Log

Append-only. Each entry: the choice, the alternatives, the evidence, what would
make us revisit it.

## D1 — One same-origin gateway, not CORS
Hermes returns no `access-control-*` headers at all (measured: 403 with zero CORS
headers), so a browser can never call it. The gateway serves the stage and proxies
`/v1/*` with the key injected server-side. Alternative rejected: patching CORS
into Hermes — more surface, key would reach the browser.

## D2 — The gateway holds the Gemini Live socket
Ephemeral tokens are the documented path, but minting succeeds and the socket
closes with `1008 Permission denied`; `liveConnectConstraints` is rejected by
`v1alpha`. Cost measured at ~60 ms (0.38 s direct vs 0.44 s proxied). Benefit: no
Google credential reaches the client.

## D3 — Rebrand at the edge, keep upstream identifiers
367 files contain `AIRI`; `@proj-airi/*` identifiers are untouchable or upstream
merges die. Rebrand user-visible strings and assets only.

## D4 — Dark theme as tokens, not per-component colours
`uno.config.ts` primary scale + `--sofia-*` variables; components consume them.
A hue change upstream then cannot drag the stage back to blue.

## D5 — Empty state lives in `ChatHistory`
`ChatHistory` already owns the filter (`renderMessages`); duplicating the
emptiness test in the parent produced three wrong answers.

## D6 — Voice: Leda, native audio, Hermes as hands
The mouth is Gemini Live; the brain and tools are Hermes. Revisit if Live latency
degrades or if tool latency inside a live turn exceeds ~1.5 s.
