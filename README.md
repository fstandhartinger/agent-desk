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
