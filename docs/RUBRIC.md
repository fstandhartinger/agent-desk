# Gauntlet rubric — Agent Desk (critic scores each 0–5; PASS = every item ≥ 4, no security item < 5)

Producer/critic rounds (Matt Shumer's gauntlet loop): producer builds, an independent strong critic scores against this
rubric with evidence (screenshots, curl output, logs), producer fixes, repeat until PASS.

## S — Security (must be 5)
S1 No vendor key, bridge token or access code ever reaches the browser, a log line, the repo or a URL (grep the built
   bundle, network log, `git log -p`, gateway stdout).
S2 Every /api route and WS upgrade is gated by the signed cookie; Origin checked on WS; login rate-limited; gate input
   is not a password field (shared-secret rule).
S3 Bridge read tools cannot escape the allowlist (../, symlinks, absolute paths, deny patterns) and redact secrets.
S4 Claude sessions only start from an authenticated request; audit line for every start/send/stop/tool call; ≤ 3 running.
S5 Spend caps and rate limits enforced server-side; vendor errors never leak headers or keys.

## F — Function (live, on the deployed URL)
F1 Explainer: any published slug loads; audio + stage stay in sync on play, pause, seek, speed 0.75–2×; clicking an
   element selects its point and pauses.
F2 Text chat answers a page question and a workshop question (e.g. "Was ist der Stand von <job>?") with tool use,
   streamed, < 2 s to first token for simple questions.
F3 Dictation: speak German → text in composer.
F4 Voice: at least two providers hold a real two-way German conversation with barge-in and at least one tool call;
   default provider falls back cleanly when unavailable.
F5 Claude Code: start a task from the page, see output live (< 1 s lag from the bridge), follow-up message works,
   stop works, session folder has PROMPT.md with full context and standing rules; reconnect replays.
F6 Visualisation: activity layer reacts instantly to tool/Claude/voice events; Live Canvas updates within ~2 s with
   smooth transitions; looks like the explainer videos.
F7 Telegram explainer captions carry the explainer page link; the explainer page links to the desk.

## Q — Quality
Q1 UI at the level of chutes-frontend chat: typography, spacing, motion, empty/loading/error states, no layout shift.
Q2 Mobile (390×844) fully usable: tabs, voice button, composer, safe areas.
Q3 German UI copy, clear labels, keyboard shortcuts, accessible names.
Q4 Code: small modules, no dead code, tests for auth, path allowlist/redaction, event normalisation; builds reproducibly
   (Dockerfile), health check, restart-safe bridge (systemd --user, reconnect).
Q5 Performance: initial JS ≤ 350 KB gzip, 60 fps animations, no memory growth over a 20-min voice session.

## C — Generative canvas (round 5+, docs/CANVAS.md; PASS needs every C item >= 4)
C1 Never refuses: in no provider (text, xai, openai, gemini) does the agent say it cannot draw; prompts + refusal guard tested.
C2 Draws proactively: the 3 reference questions produce a visual without the user asking for a diagram, in all 4 channels.
C3 Correct content: flow matches the real notify guard, architecture matches the real code (code_outline), pie sums equal
   ledger_spend totals exactly; no invented numbers; every visual has source footnotes that point to real refs.
C4 Speed: visual (pending frame) < 1 s after the tool call, ready < 8 s after the request; voice keeps talking meanwhile.
C5 Rendering quality: ELK layouts without overlaps/crossing labels, donut/bar/line/table/timeline/sankey/sequence/custom_svg
   all look like the explainer videos at 1440x900 and 390x844; animated diff on same-id updates; PNG export works.
C6 Claude panel: a Claude Code session can put a desk-canvas block on the canvas; it is validated and shown with by=Claude.
C7 Login UX: from an explainer page without session the gate explains the Telegram link and can send a fresh one (rate limited).
C8 Voice providers: GPT-Live and Grok Voice verified live after the top-up (real German two-way session with a tool call each).
