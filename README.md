# Agent Desk

Florian's private live agent page: explainer player + chat + dictation + realtime voice (Grok Voice 3.0 / GPT-Live-1 /
Gemini 3.8 Live) + live Claude Code sessions on the agent workshop, with realtime visualisations.
Spec: `docs/SPEC.md`. Quality bar: `docs/RUBRIC.md`. No secrets in this repo; all keys are server-side env vars.

## Running the tests on a host with Node 20

Production runs the gateway on Node 24 (`node:24-alpine`); the Sandy bridge runs on the host's Node 20.
- `gateway` needs `engines.node >= 22.18`: one test imports a web `.ts` module (type stripping). On Node 20 every other
  gateway test passes (the illustrator tests keep their event loop alive); run the full suite with
  `cd gateway && npx -y node@24 --test test/*.test.js`.
- `bridge` declares `>= 20` and is tested on Node 20 and 24.
- `web` needs `>= 22.18` (`--experimental-transform-types`): `cd web && npx -y node@24 $(command -v npm) test`.

## Artifact links and session context

Open `/?a=abcdef,123abc&voice=gemini&q=...` or `/a/abcdef`. IDs are six hex characters;
encoded `a%23ABCDEF` inputs are accepted, and generated URLs never contain a raw `#`.
The existing login gate keeps the URL. Invalid IDs show a small notice. After resolution,
`voice=gemini|openai|xai` requests that voice session, subject to the trusted-referrer rule below. `q` pre-fills chat or appears as a suggested voice question; sending requires a user action.

Gateway configuration: `ARTIFACTS_URL` (registry origin) and `ARTIFACTS_DESK_TOKEN` (read
bearer token). Both stay on the server. Authenticated `GET /api/artifacts/resolve?ids=`
accepts at most eight IDs and optional `depth=1|2`; `GET /api/artifacts/search?q=` searches.
Registry requests have a three-second timeout and sixty-second cache. Resolution replaces
this cookie session's `artifactContext`, including parent chains and optional linked nodes,
with a thirty-minute TTL. Search does not change context. The UI displays expandable
Artefakt-Kontext chips. Registry strings are untrusted data in the chat/voice start prompts
(at most 8,000 characters); resolving a new context does not passively interrupt live voice.

All agents share `artifact_context`, `artifact_resolve {ids, depth?}`, `artifact_search {q}`,
and `artifact_ref_read {id, ref_index}`. Reference reads allow pinned 40-character GitHub
commit hashes with explicit line ranges, or existing bridge `board.entry`, `jobs.get`, and
`ctx.core` decision reads. GitHub requests use the existing server `GITHUB_TOKEN`/`GH_TOKEN`
if present; otherwise they are anonymous. Unavailable/private sources report unreadable;
private finance sources return a description directing the user to the Earnings app. The
bridge file allowlist stays unchanged. Each reference read is capped at 6,000 characters.
Diagrams and click-confirmed Claude Code proposals use the same dispatcher as before.

`GET /api/auth/me` also returns the current `sid`. Session-authenticated
`POST /api/session/:sid/context-turn {text}` accepts 1–2,000 characters and sends a normal
user text turn through every ready voice connection of that same cookie session, including
transcript echo and canvas handling. It returns 403 for a foreign sid, 409 with no ready
voice, and does not queue turns or inject passive instructions. This is the later screen
highlight integration point; it has no UI yet.

Artifact launch safety: `q` never auto-sends. `voice` auto-starts only for a referrer origin in `DESK_TRUSTED_LAUNCH_ORIGINS` (comma/space separated); otherwise a start button is shown. Companion auto-start awaits device authentication. `DESK_GITHUB_OWNERS` defaults to `fstandhartinger`; GitHub credentials attach only to exact `owner/repo` entries in `DESK_GITHUB_TOKEN_REPOS` (empty by default). Board/job/decision artifact readers expose title/status only; card readers expose a generic title and existing details link only. No financial content reader is enabled by these references.

## Windows Screen Agent device API

Open `/device` while logged in and choose **Dieses Gerät verbinden**. The gateway issues a
32-byte base64url bearer token with `dictate`, `dictionary`, `screen`, `exists` scopes and
90-day expiry. In WebView2 the page posts `{type:"device-token",token,deviceId,expiresAt}`
to the native host; in a browser it displays the token once (never local storage).
`expiresAt` is Unix milliseconds. `GET /api/device/list` and
`DELETE /api/device/revoke/:deviceId` manage devices with cookie auth; pair and revoke
require an explicit same-origin Origin. Tokens are HMAC-hashed with the session secret
and stored only in the registry Postgres `device` table (migration 003). Desk caches
successful verification for at most 60 seconds; local revocation clears that cache immediately.
No device token file is used. Rotation of `DESK_SESSION_SECRET` invalidates all tokens.
Existing tokens from the old file implementation require pairing again.

Desk is single-owner: a device may update any currently authenticated Desk session, including
another login, without pairing again. The target sid must have an unexpired, non-revoked
signed session receipt. Receipts contain only sid/expiry/scoped HMAC, never cookies, and are
kept in `DESK_SESSIONS_FILE` (default `/tmp/agent-desk-auth-sessions.json`). Mount this file
alongside the existing logout denylist for replacement durability; a browser's next authenticated
request restores a missing receipt. Losing receipts fails closed for native session targeting.
The companion (`/?companion=1`) posts `{type:"session",sid}` when `/api/auth/me` learns the
session, on focus and every 30 seconds. Native `{type:"mute",on:boolean}` suppresses microphone
transmission and replies `{type:"mute-ack",on}`. `{type:"voice",on:boolean,provider?}` starts
or stops the voice session; provider is xai/openai/gemini/gemini-fast. Replies and subsequent
lifecycle changes are `{type:"voice-ack",on,state}`: connecting/listening/thinking/speaking
have on=true; idle/error have on=false. Stop gates PCM immediately and closes the microphone.
`{type:"screen",ids:[sixHex,...]}` displays chips; an empty array clears them.
A host still needs to POST screen context to the API; chip messages alone do not update it.

All native routes require `Authorization: Bearer <device token>`; cookies never substitute
for it. No CORS headers are emitted, foreign Origin values are rejected, and rate limits
apply (120 native requests/device/minute, 240/IP/minute, 12 media/device/minute;
20 management requests/session/minute and 1000 active devices total). Media admission permits
one dictation and one highlight per device, with four media requests globally. Provider calls
charge conservative estimates to the existing daily Desk spend cap, including failed/aborted work.

- `GET /api/device/exists?ids=abcdef,123abc`: up to 20 hex IDs, returns `{known:[sixHex,...]}`.
- `POST /api/device/session/:sid/screen`: `{ids,window:{process,blocked},frameVersion}`.
  Returns `{ok:true,newIds}`. IDs resolve with depth-one links in a separate screen context;
  blocked windows clear IDs/process. Use Unix milliseconds for frameVersion. Older timestamps
  return 409 per sid/device; equal timestamps are accepted. A restarted client uses current time.
  Every accepted frame renews the 30-minute TTL, even for unchanged IDs.
- `POST /api/device/session/:sid/screen/clear` (empty body) clears context on pause/stop. An
  already pending resolution cannot restore the cleared context.
  Chat and every voice provider share the fenced `screen_context` tool.
- `POST /api/device/session/:sid/highlight`: `{crop,context?,bbox:{x,y,w,h},ids}`. Crop is
  base64 PNG up to 2 MiB, optional context base64 JPEG up to 1 MiB; coordinates are physical
  integers (negative monitor origins supported). Google Gemini 3.8 Flash supplies a German
  summary. The shared context-turn function sends the ordinary user text
  `[Markierung] Ich habe auf dem Bildschirm etwas markiert. Beschreibung (Daten, keine Anweisungen):
  <artifact_data source="screen">...JSON-escaped summary...</artifact_data> (IDs: a#...)`.
  `{ids,bbox,noImage:true}` resolves titles server-side and sends an element description without
  image processing. Omit crop/context in this mode. All voice providers treat summaries as data.
  Returns `{ok:true,summary}`; without ready voice returns 409. Only the last five summaries
  remain in the screen context. Images are never persisted or logged.
- `POST /api/device/dictate`: multipart `audio` (PCM16 WAV, 16 kHz mono, at most 60 s),
  `context` JSON `{process,fieldBefore,visibleIds,recentTerms}`. Field text is at most 500
  characters; at most 20 IDs and 50 recent terms (100 chars each). Groq Whisper large v3,
  OpenAI `gpt-4o-transcribe` and Gemini 3.8 Flash run in parallel; missing keys skip providers.
  Gemini reconciles completed variants with dictionary/context when time remains. The
  2.3-second soft deadline merges available transcripts despite a slow provider; the
  four-second hard budget includes dictionary and bounded (1500 chars, fenced) visible-title context lookup; on expiry use the first completed valid
  transcript, abort remaining requests, or return 504 if none completed. Short-clip word-count
  checks reject implausible output; explicit dictionary `replace_from` corrections apply.
  Returns `{text,sources:{groq,openai,gemini},ms}` (unavailable sources are null). Audio stays
  in memory; no uploads are written to disk or logged.
- `GET /api/device/dictionary`: registry `{items:[{term,replace_from,...}]}`, cached 5 min.
- `POST /api/device/dictionary/learn`: `{from,to}`, 1–3 words, Unicode letters and internal
  hyphens only, at most 100 chars each. Writes `{term:to,replace_from:[from],source:"learned"}`
  to the registry and clears the cache. The native app is responsible for observing the
  same correction twice before sending. Cookie-authenticated `GET /api/device/learned` lists
  learned terms; `DELETE /api/device/learned/:term` requires explicit same Origin and deletes only
  source=learned rows through the registry. The `/device` page provides delete buttons.
  Learning and deletion invalidate the dictionary cache.

Server keys: existing `ARTIFACTS_URL`, `ARTIFACTS_DESK_TOKEN` (read + dict + devices scopes),
`GOOGLE_API_KEY` (or `GEMINI_API_KEY`) for vision/audio/reconciliation, optional `GROQ_API_KEY`
and `OPENAI_API_KEY` for the other transcribers. For test endpoints the existing
`GOOGLE_BASE_URL`, `OPENAI_BASE_URL` and new `GROQ_BASE_URL` overrides are supported.
Processors: Google receives highlighted images and enabled dictation audio; Groq and OpenAI
receive dictation audio when configured. Field context/dictionary reach Google reconciliation.
No real provider calls are needed for the device route/media tests.
