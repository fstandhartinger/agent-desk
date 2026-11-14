# Session trace (gateway side)

Every voice session (`/api/voice`) and every text conversation (`/api/chat`) writes a durable trace to the registry
(`POST /v1/sessions`, then `POST /v1/sessions/<id>/events`). Code: `gateway/src/trace.js`.

- **Never in the session path.** `trace.event()` is synchronous and cannot throw; shipping happens in the background
  (first flush ~1 s after `session.start`, then every 2 s or 50 events, 100 events per request, exponential back-off on
  failure). The buffer keeps at most 5000 events per session (oldest dropped, a `trace.dropped {count}` event follows).
  If the registry stays away, the session ends with one stdout line `trace-fallback {...}`.
- **What is stored.** Strings pass `redact()`; event data at most 8 KB; transcripts up to 4 KB, other strings 1 KB, tool
  args 2 KB; tool results only as size (`chars`); no audio, images or base64 (keys like `audio`, `image`, `base64` and
  data URIs are replaced by a marker). `seq` is monotonic per source (`gateway`, `client`, `screen-agent`).
- **Redeploy.** `SIGTERM` marks every open trace `session.interrupted` and flushes them (5 s budget) before exit.
- **Chat.** One trace per conversation (`conversationId`), idle 15 min. The SSE stream carries `{type:"session",aid}`;
  the web client shows it in the message footer. Events: `session.start`, `transcript.user.final`, `response.created`,
  `tool.call/done/error`, `transcript.assistant.final`, `response.done`, `provider.error`.
- **Screen Agent.** `POST /api/device/session/<sid>/trace` (device scope `screen`, 60 requests/min, ≤ 100 events of
  type `screen.*|hotkey.*|client.*`, body ≤ 256 KB). Events attach to the newest voice (else chat) trace of that sid;
  without one they wait up to 60 s in a per-sid buffer (200 events), then they move to the device log (below).
  Events whose client timestamp is 5 min to 24 h old (the app's retry queue) skip the session and go to the device log with `data.late: true`
  and their own timestamp; foreign or future clocks are clamped to the receive time. `POST /api/device/log` takes events with no session at all.
- **Device log (kind `device`).** Events with no session (dictation, captions, the retry queue, parked events that found no session) go to one trace per
  UTC day and device, created on the first event ("Geräteprotokoll 3 Nov", device id in `client.device`; the registry has to know `kind device`).
  If the registry refuses the kind the events are dropped after one stdout line `trace-fallback {... "reason":"kind-refused-<status>"}`; the next try is the next day.
  Up to 20000 client events per log. Gateway events written there: `dictation.result {ms,bytes,seconds,chars,providers,degraded,merged,dictationId?,index?,final?}`,
  `dictation.failed {status,code,ms,bytes,seconds,providers}`, `caption.stats {calls,failures,lastStatus,medianMs,costUsd,windowS}`, `caption.log {d,items}` (the caption words for refinement rounds since 14 Nov 2026; off with `DESK_CAPTION_TEXT_LOG=off`; README, captions),
  `device.error`. A numeric `bytes` is kept (a size carries no payload); a string under `bytes`, `audio`, `image` and the like is still replaced.
- **Error log.** Every HTTP answer >= 400 outside `/api/device/` writes the audit line `http.error {path,method,status,message?,ms,bytes}` (server.js); a failing device route
  `device.error {path,method,status,code?,message,ms,bytes,reason?,upstream?,providers?,repeats?}` (path with session/command ids folded; the same failure at most once per 10 s,
  with `repeats`). Refused WebSocket upgrades write `ws.reject`. Other failure paths: `screen.vision {ok:false,error,ms,bytes,status?,reason,frameVersion}`, `screen.error {what,status?,message}`,
  `page.load_failed`, `session.refused`, `session.hard_cap`, `client.bad_message`, audit lines `artifact.registry.error`, `artifact.card.unreadable`, `artifact.ref.unreadable`.
- **Browser errors.** What the web UI shows as an error (error toasts, red activity lines, the voice dock) is sent over the voice socket as `client.error {what,reason}`
  (`reason` is the text shown, at most 300 characters); errors with no open socket wait (20 at most) for the next voice session.
- **Handoff card clicks.** Florian's click on "An Agenten übergeben" is an HTTP call outside the session socket; its outcome is written into the trace of the session that made the proposal
  (the proposal stores the trace handle): `handoff.click {id,title}`, `handoff.posted {id,entry,thread,fallback,threadId?,intendedThreadId?,reopened?,ms}`, `handoff.failed {id,kind,reason,retry,detail,ms}`
  (`retry:true` = nothing reached the board, the same card can be clicked again), `handoff.refused {id,code,reason,retry}` (unknown / already used / limit / running). In a voice session a failure or refusal is also
  told to the live model as a passive note (`handoff.note {how,chars}`, briefing channel, no reply asked). `session_trace` prints them and the diagnosis counts failed clicks. A trace that has already closed
  (voice session over, chat idle 15 min) takes no more events; the audit lines `handoff.posted|failed|refused` are written regardless.
- **Test.** `gateway/test/errors-logged.test.js` and `web/test/errors-logged.test.ts` scan the source for user-visible error strings and fail when one has no path to a log event.
- **Reading.** Tool `session_trace {which}`; route `GET /api/session-lookup?q=<a#id|hex|slug|last>[&full=1]`.

Env: `ARTIFACTS_URL`, `ARTIFACTS_DESK_TOKEN` (as for the device routes), `SOURCE_COMMIT` (recorded as `gateway_commit`;
the Dockerfile exposes the Coolify build arg of that name).
