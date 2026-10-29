# Agent Desk — interface spec (v1, 24 Oct 2026)

Florian's private live agent page: watch an explainer (same audio/animation as the Telegram video), pause anywhere,
click any element and talk about it — by text, dictation or realtime voice — with an agent that can read the
agent workshop's state, and hand tasks to a real Claude Code session whose output streams live. Everything has a
realtime visualisation in the explainer visual language.

URL: `https://desk.app.mintapis.com/` (deep link `/?x=<explainer-slug>&t=<seconds>&p=<pointId>`).

## Components

```
browser (web/, React 19 + Vite + Tailwind 4, built into gateway/public)
   │  HTTPS + SSE + WS (cookie auth)
gateway/  Node 24 ESM, one process, Coolify app "agent-desk" on server Sandy (port 8080)
   │  holds ALL vendor keys (env), auth, rate limits, audit, text agent loop, voice relays, viz generation
   │  WSS  /bridge   (the bridge dials IN; Bearer BRIDGE_TOKEN)
bridge/   Node 24 ESM, systemd --user service "agent-desk-bridge" on LeChonk (later also Sandy)
          NO vendor keys. Read-only context tools (redacted) + Claude Code sessions (claude -p stream-json)
```

Dependencies allowed: gateway `ws` only (plus node built-ins; fetch is global). bridge `ws` only. web: react, react-dom,
vite, @vitejs/plugin-react, tailwindcss 4 (+ @tailwindcss/vite), lucide-react, react-markdown, remark-gfm, typescript.
Nothing else without the lead's OK. No CDN at runtime (CSP `default-src 'self'`; connect-src 'self' wss://desk...).

## Environment (gateway)

| var | meaning |
|---|---|
| `DESK_ACCESS_CODE` | Florian's login code (long random). Login link: `/#k=<code>` |
| `DESK_SESSION_SECRET` | HMAC key for the session cookie |
| `BRIDGE_TOKEN` | shared secret the bridge presents |
| `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `XAI_API_KEY` | vendor keys, server-side only |
| `DESK_TEXT_MODEL` | default `deepseek/deepseek-v4.1-flash-20261017:nitro` (OpenRouter) |
| `DESK_VIZ_MODEL` | default same as text model |
| `DESK_DAILY_USD_CAP` | default `15` (estimated spend across voice+text+viz; refuse new paid work above it) |
| `EXPLAINER_ORIGIN` | default `https://explainers.app.mintapis.com` |
| `PORT` | 8080 |

Never send any of these to the browser, never log them. Claude is NEVER called through a paid API (subscriptions only,
via the bridge's `claude` CLI).

## Auth, limits, audit (gateway)

- `POST /api/auth/login {code}` → constant-time compare with `DESK_ACCESS_CODE`; on success `Set-Cookie: desk_s=<b64(payload)>.<hmac>`
  (`HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`), payload `{iat, exp, sid}`. 5 failed tries / 15 min / IP → 429.
  `GET /api/auth/me` → `{ok:true}` or 401. `POST /api/auth/logout` revokes the session: its `sid` goes on a server-side
  denylist (memory + `DESK_REVOKED_FILE`, default `/tmp/agent-desk-revoked-sessions.json`, 0600, entries expire with the
  cookie), so the old cookie value answers 401 everywhere, including new WebSocket upgrades. Restart caveat: the file
  survives a process restart but not a redeploy that replaces the container; after that a copied old cookie works again
  until its 30 days end. Rotating `DESK_SESSION_SECRET` revokes all sessions.
- User-facing error texts are German and shown as they are: `{error}` (+ `retryAfter` seconds on 429), e.g. "Code stimmt nicht",
  "Zu viele Versuche – bitte in 12 Minuten erneut", "Zu viele Nachrichten – bitte in 9 Minuten erneut". Tool diagnostics
  that only the model reads (argument validation, bridge messages) stay English.
- Every `/api/*` route except login/health requires the cookie; WS upgrades check the cookie too (and `Origin` must be
  the desk origin). `GET /healthz` → `{ok, bridges:[...]}` without auth (no secrets, no details).
- Gate UI uses the shared-secret markup rule (type=text + CSS mask, never `type=password`, see sandy-paas-deploy).
- Rate limits (in-memory, per cookie sid): chat 40 / 10 min; voice ≤ 2 concurrent, ≤ 90 min / day; Claude starts
  ≤ 25 / day, ≤ 3 running; transcription 60 / 10 min. Daily USD estimate cap (`DESK_DAILY_USD_CAP`).
- Audit: one JSON line per mutating call / tool call / login / voice session start-stop / Claude start-send-stop:
  `{ts, actor:"florian", ip_hash, action, detail(short, redacted), cost_usd?}` → stdout AND bridge `audit.append`.
- Security headers: CSP, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`.

## Explainer integration (gateway)

- `GET /api/explainer/:slug/:file` → server-side fetch of `${EXPLAINER_ORIGIN}/p/:slug/:file`, cache 10 min.
  slug `^[a-z0-9-]{3,80}$`; file in {index.html, stage.html, explainer-core.js, timeline.js, timeline.json,
  points.json, audio.mp3, words.json} or `^[a-z0-9_-]+\.(png|jpg|svg|webp|woff2|css|js)$`. Range requests pass through for audio.mp3.
- The web app loads `stage.html` in a SAME-ORIGIN iframe from that path, drives time via `iframe.contentWindow.seekTo(t)`
  (contract of explainer-core.js; `window.__ready`), plays `audio.mp3` itself, and reads `points.json` + `timeline.json`.
  Clicking an element with `data-cue`/`data-point` that has a points entry selects that point (pause + context chip).
- Page context sent with every chat/voice/Claude request: `{slug, title, t, sceneId, pointId?, point?:{title, short, more},
  transcriptNear: "<narration words ±20 s around t>"}`; the gateway adds `points.page.context` (≤ 12k chars) itself.

## Text agent (gateway) — `POST /api/chat` → `text/event-stream`

Request `{conversationId, messages:[{role:"user"|"assistant", content}], page?, model?}`.
Loop: system prompt (desk persona, German by default, answer from tools/page context, never invent, cite paths) +
tools below, OpenAI-compatible tool calling via OpenRouter, max 8 tool rounds, streaming. Guards: tool-call markup the
model writes as text (`<｜DSML｜`, `<tool_call>`, `<|tool`, `<function_calls>` …) is cut from the stream and never shown;
on the last allowed round (and after such a leak) the gateway adds the system message "Antworte jetzt mit dem, was du
hast …" and offers no tools; an empty final answer becomes a short German "keine verlässliche Antwort" sentence.
SSE events (each `data: <json>`):
- `{type:"delta", text}` — assistant text tokens
- `{type:"status", text}` — one short German line ("Ich schaue kurz in die Jobs …") sent right before the tools of a round
  start, so the UI has something to show while a slow tool runs; at most one per round. Replace it by the next delta.
- `{type:"tool", id, name, args, status:"start"|"done"|"error", summary, ms}` — summary ≤ 200 chars of the result
- `{type:"viz", spec}` — VizSpec (below), whenever the viz generator produces one
- `{type:"done", usage:{in,out}, costUsd, model}`
- `{type:"error", message}`

## Agent tools (shared by text agent AND voice agents; executed in the gateway, data from the bridge)

| tool | args | bridge method |
|---|---|---|
| `read_core_doc` | `{name: "AGENTS"\|"DECISIONS"\|"STATE"\|"CLAUDE"\|"MODEL_POLICY", maxChars?}` (DECISIONS is newest-first; the result header says so) | `ctx.core` |
| `knowledge_read` | `{topic?}` — desk knowledge (`~/desk-knowledge`, private, built by `bridge/scripts/knowledge`): without topic INDEX.md, with topic the fuzzy-matched `topics/<slug>.md`. The INDEX is also in every system prompt (cached 10 min). | `ctx.knowledge` |
| `search_files` | `{query, scope?: "jobs"\|"docs"\|"skills"\|"all", maxHits?}` — words are OR-ed, DE<->EN expanded, files ranked by matched words; all job folders (local notes mirror) | `ctx.search` |
| `read_file` | `{path, offset?, limit?}` — offset/limit are **lines** (0-based first line, max lines); result header: `totalLines`, `nextOffset` | `ctx.read` |
| `decisions_recent` | `{days?}` (1–7, default 2) — today's and yesterday's DECISIONS.md entries, newest first, all of today's included | `ctx.decisionsToday` |
| `list_jobs` | `{filter?, activeOnly?, limit?}` | `jobs.list` |
| `job_status` | `{name}` | `jobs.get` |
| `board_threads` | `{}` | `board.threads` |
| `board_read` | `{thread, limit?, since?}` | `board.read` |
| `board_search` | `{query}` | `board.search` |
| `chats_search` (old name `search_chats` still accepted) | `{query, agent?: "claude"\|"codex"\|"opencode"\|"all", host?: "sandy"\|"lechonk", limit?}` — fanned out to every connected host (or only `host`), merged: deduped, newest first, each hit tagged `host`, `ref` prefixed `<host>~` | `chats.search` (all hosts) |
| `chat_read` | `{ref, offset?, limit?}` — `ref` from chats_search; the `<host>~` prefix picks the bridge | `chats.read` |
| `explainer_point` | `{pointId}` | (gateway: points.json of the current page) |
| `claude_task` | `{prompt, sessionId?, model?: "opus"\|"sonnet", title?}` — PROPOSES only (critic round 1, P0-1): stores the proposal (id `c…` + session, one-time, 24 h) and sends `{type:"claude_proposal", id, prompt, title, sessionId?, model?}` to the browser (chat SSE / voice WS). Florian's click on "Claude starten" / "An Sitzung senden" → `POST /api/claude/proposal {id}` (session cookie, same-origin `Origin` REQUIRED) → `claude.start` (shared gate + limits) or `claude.send` with the STORED text. | (gateway; `claude.start` / `claude.send` only from the click) |
| `claude_status` | `{sessionId?}` | `claude.list` / `claude.get` (summary: state, last 5 tool uses, last text) |
| `web_read` | `{url, maxChars?}` — `gateway/src/webRead.js`: http(s) on 80/443 only, no URL credentials, every resolved address checked (loopback, private, link-local, CGNAT, 10.89.0.0/24, metadata, ULA, mapped/NAT64/6to4 IPv4), socket pinned to the checked address, redirects re-checked (max 5), GET without cookies, 10 s, ≤ 3 MB, HTML → title + main text + links; PDF refused; 30 calls / 10 min per session | (gateway) |
| `discord_read` | `{channel?: "<guildId>/<channelId>"\|"@me/<channelId>", limit? ≤ 50}` — without channel the DM/channel list | `discord.list` / `discord.read` (Sandy) |
| `mail_search` / `mail_read` | `{account?, query?, folder?, limit?}` / `{account, uid, folder?}` — read-only, mails stay unread | `mail.search` / `mail.read` (Sandy) |
| `skills_list` / `skill_read` | `{query?}` / `{name, file?}` | `skills.list` / `skills.read` |
| `run_readonly` | `{command: "quota_status"\|"asks_open"\|"board_threads"\|"sched_list"\|"disk"\|"jobs_running"}` — fixed ids, the bridge maps each to a fixed argv | `ops.run` (Sandy) |
| `handoff_propose` | `{title, task, why?}` — posts NOTHING: stores the proposal (id + session) and sends `{type:"handoff", id, title, task, why}` to the browser (chat SSE / voice WS). Florian's click → `POST /api/handoff {id}` (session cookie, same-origin `Origin` REQUIRED, one-time, 10/day, 24 h expiry) → bridge `board.handoff {title, task, why?}` → `{ok, entryId}`. Both steps audited. | (gateway; `board.handoff` only from the click) |

No tool sends, posts, pays, deletes or deploys. Unknown tool names are rejected; the near-miss name recovery never maps
onto `handoff_propose`/`claude_task` and never maps write-sounding names (send, post, notify, deploy, pay, delete, …).
Every tool call is audited (`tool.<name>`, detail `{host, ms, ok, args}` with short redacted args). Every tool result
passes `redact()` (`redactPatterns.js`, byte-identical in gateway and bridge, `gateway/test/redact-sync.test.js`):
API keys, Bearer/JWT, private keys, seed phrases with context, env-style `SECRET_KEY=value` lines, `password=`,
Cookie/Set-Cookie, one-time codes/PIN/TAN, login/reset/magic links with tokens, `user:pass@` in URLs.

Bridge routing (`gateway/src/bridgeHub.js` `ROUTE`): a call without explicit host goes to the first connected host of
its route that announced the method in its hello: `discord.*`, `mail.*`, `ops.*` → sandy; `board.*`, `ctx.*`, `jobs.*`,
`chats.*`, `skills.*` → sandy, lechonk; `ctx.knowledge`, `ledger.*`, `code.*` → lechonk, sandy; `claude.*` → lechonk
only; everything else (notify, audit) → lechonk. Bridge hosts are allowlisted `^(lechonk|sandy)$` at upgrade.

Tool results to models are ≤ 6 000 chars (truncate with a marker). Voice tool results ≤ 2 500 chars. Results with a text body
(`ctx.read`, `ctx.core`) are shown as a compact JSON header line, `---`, then the raw text.

**One contract:** the arguments a tool forwards must be parameters of its bridge method with the same JSON type.
`bridge/src/params.js` (`METHOD_PARAMS`) lists the accepted parameters of every bridge method;
`gateway/test/contract.test.js` checks `TOOL_DEFS` / `BRIDGE_TOOLS` against it and runs the real bridge handlers behind
`runTool`; `bridge/test/e2e.test.js` checks that the table lists exactly the served methods. Change both sides together.

## Status — `GET /api/status`

`{ok, bridges:[{host, connected, since, caps, claude:{running, max}}] (always both lechonk and sandy; a missing one as `{host, connected:false}`), providers, models, rates, voice, spendTodayUsd, dailyCapUsd}`.
`bridges[].claude.running` is live (kept from `claude:list` events, seeded by `claude.list` after the hello).
`providers` = `providerHealth.snapshot()`: keys `xai`, `openai`, `gemini`, `openrouter`, `elevenlabs`, each
`{configured, ok: true|false|null, reason?, checkedAt?}`; `ok:null` = not used yet or the last failure is older than 10 min.
Sources: real calls (OpenRouter chat, ElevenLabs/OpenAI transcription, voice sessions via `markFailure`/`markOk`) and probes at
startup and every 10 minutes (`providerProbe.js`): xAI `GET /v1/models` (403 = no credits), OpenAI one-token embedding
(~USD 0.00000002; 429 `insufficient_quota` / `credit_balance_exhausted` = no credits). Gemini, OpenRouter and ElevenLabs
have no probe; they turn red/green with their first real call. A probe never overwrites a fresher failure reported by a real call.

## Bridge protocol (WS JSON text frames, `wss://desk.app.mintapis.com/bridge?host=lechonk`, `Authorization: Bearer BRIDGE_TOKEN`)

- bridge → gw `{t:"hello", host, version, caps:[method...], claude:{running, max}}`
- gw → bridge `{t:"req", id, method, params}`; bridge → gw `{t:"res", id, ok:true, result}` | `{t:"res", id, ok:false, error}`
- bridge → gw `{t:"evt", topic, data}` (topics `claude:<sid>`, `claude:list`)
- either side `{t:"ping"}` / `{t:"pong"}` every 20 s; bridge reconnects with backoff 1→30 s. Request timeout 30 s
  (claude.* start returns immediately).
- Methods: `ctx.core`, `ctx.search`, `ctx.read`, `ctx.list`, `ctx.decisionsToday`, `ctx.knowledge`, `jobs.list`, `jobs.get`, `board.threads`, `board.read`,
  `board.search`, `chats.search`, `chats.recent`, `claude.start`, `claude.send`, `claude.stop`, `claude.list`,
  `claude.get {sid, sinceSeq}`, `audit.append`.
- Read roots (allowlist, realpath-checked, no symlink escape): `/home/flori/{AGENTS,DECISIONS,STATE,CLAUDE}.md`,
  `~/.hermes/model-economy-policy.md`, `/home/flori/jobs/**` (Sandy live view), `~/.agents/skills/**`,
  `~/.claude*/projects/**/*.jsonl` (chat histories), `~/desk-sessions/**`. Deny by path
  segment / file name, never by substring (job `tng-trustedtokens-mining-…` is readable): directories or files named `.ssh`,
  `.gnupg`, `.env*`, `secret(s)`, `credential(s)`, `token(s)`; anything containing `sealed`, `wallet`, `reaxsign`; files `*.env`,
  `*.key`, `*.pem`, `*.p12`, `*.pfx`, `id_rsa|dsa|ecdsa|ed25519`, `auth.json`, `.netrc`, `[…]secret(s)|credential(s)|token(s).<ext>`.
  `resolveAllowed` checks the allowlist and the deny list lexically FIRST, then the realpath; "not allowed" and "not found" are
  one error (`path not allowed or not found`), so the answer is no existence oracle. `ctx.read` offset/limit are LINES
  (result: `totalLines`, `nextOffset`).
  Max 512 KB per read. Every returned string goes through `redact()` (patterns, key prefixes only at a word boundary (`(?<![A-Za-z0-9])`, so `ask-investigate-…` survives): `sk-[A-Za-z0-9_-]{16,}`, `xai-[A-Za-z0-9]{20,}`,
  `AIza[0-9A-Za-z_-]{30,}`, `gh[pousr]_[A-Za-z0-9]{30,}`, `cpk_[A-Za-z0-9.]{20,}`, `Bearer\s+[A-Za-z0-9._-]{20,}`,
  `-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END`, `(?i)(api[_-]?key|token|secret|password)\s*[:=]\s*\S{8,}`) → `[REDACTED]`.
- Board via the existing `~/bin/agent-board` relay, read subcommands only (`threads`, `read`, `search`), with
  `AGENT_BOARD_NAME=desk:bridge`.

## Claude Code sessions (bridge)

- `jobs.list` answers from a 30 s index of the newest 100 jobs (stale index served at once and refreshed in the background;
  kept warm while the desk is in use).
- `claude.start {title, prompt, page?{slug,title,t,sceneId,pointId,point,transcriptNear}, chatContext?(last 12 turns, ≤ 6 KB), model:"opus"|"sonnet", effort:"medium"}` → `{sid}` (sid `d<yyyymmdd>-<6 hex>`).
  Creates `~/desk-sessions/<sid>/` with `PROMPT.md` = desk header (who asked, from where, page context, recent chat
  transcript, rules: this is an interactive desk session for Florian, follow AGENTS.md like every job, use notify/board
  as usual, write STATE.md) + the task. Runs exactly like `~/bin/run-claude.sh` does (same `PRE` text +
  `~/bin/job-preamble.txt` + PROMPT.md, `--dangerously-skip-permissions`, account from `quota-pace account --kind work`
  → `CLAUDE_CONFIG_DIR` A=`~/.claude-A`, B=`~/.claude`, C=`~/.claude-C`), but with
  `--output-format stream-json --verbose --include-partial-messages`, cwd = the session folder (so `/home/flori/CLAUDE.md`
  and `~/.claude/CLAUDE.md` load as in every session), env `AGENT_BOARD_NAME=claude:desk-<sid>`, `AGENT_BOARD_JOBDIR`.
- `claude.send {sid, text}` → next turn with `--resume <claude_session_id> -p <text>` (queued if a turn is running).
- `claude.stop {sid}` → SIGINT then SIGTERM after 5 s of the process group the bridge spawned (by PID, never by pattern).
- Normalised events (`evt claude:<sid>` and stored in `events.jsonl`, monotonically increasing `seq`):
  `{seq, ts, kind:"status", state:"starting"|"running"|"idle"|"stopped"|"error", account?, model?}`,
  `{kind:"user", text}`, `{kind:"text_delta", text}`, `{kind:"text", text}`, `{kind:"thinking", text}`,
  `{kind:"tool_use", id, name, input(short), path?, command?}`, `{kind:"tool_result", id, ok, preview(≤600 chars)}`,
  `{kind:"todo", items:[{content,status}]}` (from TodoWrite), `{kind:"result", durationMs, costUsd?, turns, agentSteps, subscription:true}` (`turns` = desk turns of this session, 1, 2, …;
  `agentSteps` = Claude's own step count; `costUsd` is the API-equivalent value, not money — the session runs on the subscription, so the UI
  labels it "≈ API-Wert (Abo)"),
  `{kind:"error", message}`. All text redacted. A requested stop (`claude.stop`) ends as `status: stopped` without an `error` event
  (the `error_during_execution` the interrupted CLI reports is swallowed); a turn timeout is still an `error`.
- Max 3 concurrent sessions; turn timeout 2 h. Sessions survive gateway disconnects; `claude.get` replays from `sinceSeq`.

## Gateway Claude API (browser)

`POST /api/claude/sessions {title, prompt, model?, host?:"lechonk"}` → `{sid}`; `POST /api/claude/sessions/:sid/messages {text}`;
`POST /api/claude/sessions/:sid/stop`; `GET /api/claude/sessions` → list; `GET /api/claude/sessions/:sid/events`
→ SSE (`id: <seq>`, supports `Last-Event-ID` / `?since=`), events as above.

## Voice (gateway relay) — `WS /api/voice?provider=xai|openai|gemini`

Browser never talks to a vendor. Browser ↔ gateway protocol:
- client → server JSON `{type:"start", page?, lang:"de", voice?}`, then binary frames = mic PCM16 LE mono 24 kHz
  (20–40 ms chunks); `{type:"text", text}` (typed into the live session); `{type:"interrupt"}`; `{type:"stop"}`.
- server → client JSON `{type:"ready", provider, model}`, binary frames = assistant PCM16 LE mono 24 kHz,
  `{type:"transcript", role:"user"|"assistant", delta?, text?, final:boolean}`, `{type:"speech_started"}` (barge-in:
  client flushes playback), `{type:"tool", ...same as chat}`, `{type:"viz", spec}`, `{type:"usage", seconds, costUsd}`,
  `{type:"error", message, fallback?:"gemini"}`, `{type:"closed"}`.
- Providers (verified 24 Oct 2026):
  - **xai** (default): `wss://api.x.ai/v1/realtime?model=grok-voice-3.0`, `Authorization: Bearer XAI_API_KEY`;
    `session.update` {voice:"eve", instructions, turn_detection:{type:"server_vad"}, audio in/out `audio/pcm` 24000,
    input transcription, tools:[{type:"function",name,description,parameters}]}; audio `input_audio_buffer.append`;
    out `response.output_audio.delta`; tool call `response.function_call_arguments.done` → `conversation.item.create`
    `{type:"function_call_output", call_id, output}` → `response.create`. NOTE: xAI team currently out of credits (403);
    on 403/402 send `{type:"error", fallback:"gemini"}`.
  - **openai**: `wss://api.openai.com/v1/live/sessions` (Bearer), first msg `session.start` {session:{model:"gpt-live-1",
    instructions, audio:{format:{type:"audio/pcm",rate:24000}, output:{voice:"marin"}}, delegation:{type:"responses",
    responses:{model:"gpt-6-astra", reasoning:{effort:"medium"}, tools:[function tools], tool_choice:"auto"}}}}; wait
    `session.started`; audio `session.input_audio.append {audio}`; out `session.output_audio.delta {delta}`; transcripts
    `session.input_transcript.delta` / `session.output_transcript.delta`; backend events wrapped in `response.event`
    (function call in nested `response.output_item.done`) → reply `response.item.create {type:"function_call_output",
    call_id, output}` then `response.create`.
  - **gemini**: `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=GOOGLE_API_KEY`;
    `setup` {model:"models/gemini-3.8-live-extended-thinking" (option "models/gemini-3.8-live" = fast),
    generationConfig:{responseModalities:["AUDIO"], thinkingConfig:{thinkingLevel:"medium"}}, systemInstruction,
    tools:[{functionDeclarations:[...]}] (behavior NON_BLOCKING), inputAudioTranscription:{}, outputAudioTranscription:{}};
    input `realtimeInput.audio {data, mimeType:"audio/pcm;rate=16000"}` (gateway resamples 24k→16k), output 24 kHz PCM;
    `toolCall.functionCalls` → `toolResponse.functionResponses`.
  Exact field names MUST be verified against the live APIs by a real session test (record the test in the PR).
- Voice instructions: same persona/tools as the text agent; short spoken answers; German default; announce long tool
  work ("Ich schaue kurz ins Board…"); never read secrets or long paths aloud.

## Dictation — `POST /api/transcribe` (body: audio/webm or audio/wav ≤ 10 MB) → `{text}` via OpenAI transcription
(model verified from `/v1/models`, e.g. `gpt-live-transcribe` or `gpt-realtime-whisper`; language `de` hint).

## Visualisation — VizSpec (gateway generates, web renders)

Two layers:
1. **Deterministic activity layer** (no model, instant): every tool event / Claude event / voice state becomes motion —
   voice orb driven by mic & speaker RMS, tool chips that fly from the agent node to their target (file, job, board
   thread, Claude session), Claude Code "work map" (files touched as tiles that pulse on read / glow papaya on edit,
   command lane, todo progress bar).
2. **Live Canvas** (fast model, ≤ 1.5 s after a turn/tool burst, debounced): the gateway asks `DESK_VIZ_MODEL` for a VizSpec
   summarising what is being discussed/done, rendered in the explainer visual language:
```json
{"v":1,"title":"…","caption":"one sentence","focus":"nodeId",
 "nodes":[{"id":"a","label":"…","kind":"agent|user|claude|tool|file|job|board|idea|number|risk|decision","tone":"moss|papaya|violet|amber|red|neutral","value":"optional short number/text","group":"optional"}],
 "edges":[{"from":"a","to":"b","label":"optional","style":"flow|pulse|dashed"}],
 "steps":[{"label":"…","state":"done|active|todo"}]}
```
   ≤ 12 nodes, ≤ 16 edges, labels ≤ 28 chars, German labels when the conversation is German. Invalid JSON → ignored.
   Transitions: nodes keep ids across specs and animate (rise/pop/draw, 300–600 ms ease), never jump.
Visual language (from the explainer skills): near-black `#0e0e12`, one idea per view, large type, shapes over text, palette
moss `#63D297`, papaya `#FA5D19`, violet `#8B5CF6`, amber `#F59E0B`, red only for real problems.

## UI (web)

Desktop: three columns — left **Explainer** (stage iframe 16:9, play/pause, speed 0.75–2×, scrub timeline with scene
ticks, captions with the current word highlighted, clicked point card), center **Conversation** (one thread: typed,
dictated and voice turns, tool activity inline as compact chips, markdown, code highlighting, copy, stop/regenerate,
composer with dictation button + voice toggle + provider picker), right **Live** (tabs: Live Canvas | Claude Code
sessions with live stream and work map | Activity log). Mobile (Florian opens it from Telegram on his phone): one
column with a bottom tab bar (Explainer / Chat / Live), voice button always reachable, safe-area insets, 44 px targets.
Quality bar: chutes-frontend chat (`~/Dev/chutes/chutes-frontend/src/components/chat`), dark theme, smooth 60 fps,
no layout shift, keyboard shortcuts (space play/pause, / focus composer, V voice), accessible labels, German UI copy.
