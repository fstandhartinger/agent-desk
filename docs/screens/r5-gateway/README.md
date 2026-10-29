# r5-gateway live proof (24 Oct 2026)

Local gateway + local bridge (own random secrets, own port), real vendor keys in the gateway process only, real board/ledger data,
real German speech (ElevenLabs `eleven_multilingual_v2`, 24 kHz PCM16) for the audio turns. Script: `gateway/test/manual/canvas-live.mjs`.
`first ready canvas` = ms after the request (typed: when sent; audio: end of speech; chat: request sent).

| run | tools called | first ready canvas | canvases | refusal | errors |
|---|---|---|---|---|---|
| text chat · Erklär mir die Architektur vom Gateway | canvas_render, code_outline, read_file | 3884 ms | architecture:gateway-arch | no | 0 |
| text chat · Wie funktioniert die Video-Sendeblockierung? | canvas_render, read_file, search_facts, search_files | 9844 ms | flow:video-sendeblockierung-in-notify-video | no | 0 |
| text chat · Wofür geben wir das Geld aus? Zeig es mir. | canvas_render, ledger_spend | 1597 ms | bar:ledger-kategorien | no | 0 |
| gemini audio · Erklär mir die Architektur vom Gateway | canvas_draw, code_outline | 7263 ms | architecture:gateway-architektur, architecture:gateway-arch | no | 0 |
| gemini text · Wofür geben wir das Geld aus? Zeig es mir. | canvas_draw, ledger_spend | 13242 ms | pie:ausgaben-uebersicht | no | 0 |
| openai audio · Erklär mir die Architektur vom Gateway | canvas_draw, code_outline, read_file | 10517 ms | architecture:gateway-architektur | no | 0 |
| openai text · Wofür geben wir das Geld aus? Zeig es mir. | canvas_draw, ledger_spend | 13478 ms | bar:kg-ausgaben-oktober | no | 0 |
| xai audio · Erklär mir die Architektur vom Gateway | canvas_draw, code_outline | 6492 ms | architecture:gateway-arch | no | 0 |
| xai text · Wofür geben wir das Geld aus? Zeig es mir. | canvas_draw, ledger_spend | 7193 ms | pie:geld-ausgaben-kategorien | no | 0 |

Not committed here on purpose: the transcripts and the money specs. They contain real ledger lines (named payees, amounts) and this repository
is public. They are in the job folder `workers/r5-gateway/live-proof/` (run-*.json = transcripts, tool calls and event timing; canvas-*.json = specs).
`spec-*architektur*.json` / `spec-*gateway-arch*.json` are the architecture diagrams the agents drew from `code_outline` (code structure only).
