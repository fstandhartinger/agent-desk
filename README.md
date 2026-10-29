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
