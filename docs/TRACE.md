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
  without one they wait up to 60 s in a per-sid buffer (200 events).
- **Reading.** Tool `session_trace {which}`; route `GET /api/session-lookup?q=<a#id|hex|slug|last>[&full=1]`.

Env: `ARTIFACTS_URL`, `ARTIFACTS_DESK_TOKEN` (as for the device routes), `SOURCE_COMMIT` (recorded as `gateway_commit`;
the Dockerfile exposes the Coolify build arg of that name).
