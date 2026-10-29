# Generative canvas — contract (v2, 24 Oct 2026)

Florian (24 Oct): the canvas must show **what he is trying to understand right now**, not what the agents are doing:
a flow diagram of how the video send block works, an architecture diagram of a software module, a pie chart of where
the money goes, drawn live while the agent explains. In his test Gemini Live said "Ich kann leider keine Diagramme
direkt auf der Canvas für dich erstellen". **That sentence must never be possible again**: every agent (text, all
three voice providers, Claude Code sessions) can draw, knows it can, and draws on its own whenever it explains
something that has a structure, a sequence or numbers.

This replaces the "Live Canvas" VizSpec generator (docs/SPEC.md "Visualisation" layer 2). The deterministic activity
layer (orb, tool chips, WorkMap, ActivityRail) stays, but moves out of the main canvas area (Activity tab + a slim strip).
`gateway/src/viz.js` is disabled by default (`DESK_ACTIVITY_VIZ=1` re-enables it; no LLM calls for it otherwise).

## CanvasSpec (JSON, `v: 2`)

```jsonc
{
  "v": 2,
  "id": "video-send-block",        // slug ^[a-z0-9-]{2,48}$; same id = update of that canvas (animated diff), new id = new canvas
  "kind": "flow",                  // flow | architecture | sequence | pie | bar | line | table | timeline | sankey | custom_svg
  "title": "Wie der Video-Versand blockiert wird",   // <= 70 chars
  "caption": "notify lässt ein Erklärvideo nur mit Seitenlink durch.",   // optional, one sentence <= 160 chars
  "highlight": "guard",            // optional: node id / item label / event label to emphasise (papaya glow)
  "sources": [                     // REQUIRED, >= 1. Footnotes under the visual. ref = path, board entry, URL or "Gespräch"
    { "label": "STATE.md explainer-live-agent-page", "ref": "/home/flori/jobs/explainer-live-agent-page-20261024/STATE.md" }
  ],

  // flow | architecture
  "direction": "LR",               // LR | TB (default LR for flow, TB for architecture)
  "groups": [{ "id": "sandy", "label": "Sandy PaaS", "tone": "violet" }],          // architecture boxes (one level)
  "nodes": [{ "id": "guard", "label": "Link-Prüfung", "detail": "exit 75 ohne Link", "group": "sandy",
              "tone": "papaya", "shape": "box" }],                                // shape: box | pill | diamond (decision) | cylinder (data) | person
  "edges": [{ "from": "a", "to": "guard", "label": "Video", "style": "solid" }],   // style: solid | dashed | pulse

  // sequence
  "actors": [{ "id": "agent", "label": "Agent", "tone": "violet" }],
  "messages": [{ "from": "agent", "to": "notify", "label": "--video x.mp4", "style": "sync", "note": "optional" }],  // sync | reply | async

  // pie | bar
  "items": [{ "label": "LLM-APIs", "value": 165, "tone": "papaya", "detail": "33 Aufladungen" }],
  "unit": "USD",                   // shown with values (EUR, USD, %, Std, …)

  // line
  "series": [{ "name": "Ausgaben", "tone": "moss", "points": [{ "x": "2026-10-01", "y": 12.5 }] }],

  // table
  "columns": ["Job", "Stand"], "rows": [["sn92-…", "läuft"]],

  // timeline
  "events": [{ "date": "2026-10-24 09:20", "label": "Guard aktiv", "detail": "…", "tone": "moss" }],

  // sankey (uses nodes + links)
  "links": [{ "from": "konto", "to": "llm", "value": 165 }],

  // custom_svg: a complete <svg viewBox="…">…</svg>, <= 20 000 chars. Sanitised in the browser (allowlist: svg, g, path, rect,
  // circle, ellipse, line, polyline, polygon, text, tspan, defs, linearGradient, radialGradient, stop, marker, title;
  // no script, no foreignObject, no on* attributes, no href except "#…", no url() except url(#…)).
  "svg": "<svg …>",

  // upgrades 28 Oct: the top level is the SIMPLE view; "detail" is the full version of the same diagram (see below)
  "detail": { "kind": "flow", "nodes": [ … ], "edges": [ … ], "caption": "optional, only if different" }
}
```
Limits (gateway clamps, never rejects for size): nodes ≤ 24, edges ≤ 40, groups ≤ 8, actors ≤ 8, messages ≤ 24, items ≤ 12,
series ≤ 4 × 60 points, columns ≤ 8, rows ≤ 24, events ≤ 16, links ≤ 40; labels ≤ 40 chars, detail ≤ 90.
tone ∈ moss | papaya | violet | amber | red | neutral (red only for real problems). Unknown fields are dropped.
`normalizeCanvas(spec) -> {ok:true, spec} | {ok:false, error}` in `gateway/src/canvas.js` is THE validator (also used for Claude
blocks); the error text is English and short, so a model can fix its call. Numbers in items/series/links must be finite
numbers ≥ 0 (strings like "165,00 €" are parsed; otherwise error). A spec without sources gets `[{label:"Gespräch", ref:"Gespräch"}]`
plus `"unsourced": true`, which the UI shows as a small amber "ohne Quelle" tag.

## Tools (in `TOOL_DEFS`, offered to the text agent AND all three voice providers)

| tool | args | behaviour |
|---|---|---|
| `canvas_render` | the CanvasSpec fields above (`v` optional) | validate → publish `ready` at once → result `{ok, id, kind, title, shown:true}` or the validation error |
| `canvas_draw` | `{request: string, kind?: <kind>, id?: string}` | publish `pending` at once and return immediately `{ok:true, id, status:"zeichne"}`; the **illustrator** builds the spec in the background (below) and publishes `ready` (or `error`). Preferred by voice agents (no long JSON in a voice turn). |
| `ledger_spend` | `{from?: "YYYY-MM-DD", to?: "YYYY-MM-DD", groupBy?: "counterparty"\|"category"\|"month", kgOnly?: boolean}` | bridge `ledger.entries`: real money movements, aggregated deterministically |
| `desk_status` | `{}` | gateway-local (no bridge): LIVE state of the desk itself from providerHealth + the bridge hub: voice providers (xAI / OpenAI / Gemini) with model and state, text / drawing models, bridges. Beats job notes. |
| `code_outline` | `{path: string}` | bridge `code.outline`: files of a code directory with line counts, first doc comment, local imports → for architecture diagrams |

Tool schemas: nested `type: object/array/number` properties are needed for canvas_render. `validate()` in tools.js must accept
them (canvas_render args go straight to `normalizeCanvas`; do not flatten). Gemini gets them through `toGeminiSchema`
(no additionalProperties, no `oneOf`), OpenAI Live delegation tools and xAI as JSON schema. Every voice adapter must be
proven with a live session that actually calls canvas_draw and canvas_render.

## Illustrator (`gateway/src/illustrator.js`)
- Model `DESK_CANVAS_MODEL`, default `deepseek/deepseek-v4.1-flash-20261017:nitro` via OpenRouter (never Claude via API).
- Input: the request, the last 8 conversation turns (≤ 700 chars each), the results of the tool calls of the current
  conversation (vizFacts-style ledger, ≤ 6000 chars), the page context, the previous spec with the same id (for stable ids).
- May call read tools itself, max 3 rounds: ledger_spend, code_outline, read_file, search_files, read_core_doc, job_status,
  board_read, board_search, decisions_recent. Then answers ONE CanvasSpec JSON (response_format json_object where supported).
- Invalid JSON/spec (incl. the quality gate, see Round 6) → one repair round with the error. Then `error` event ("Zeichnung fehlgeschlagen: …").
- Timeout 25 s total. At most 2 illustrator runs in flight; a new request for the same id cancels the older one.
- Numbers only from tool results/conversation (same rule as vizFacts NUMBERS); sources = the tools/paths actually used.
- Cost is added to the daily spend estimate; each run is one audit line `canvas.draw`.

## Auto-illustration (the agent draws even when it forgot to)
After every finished assistant turn (text `done`, voice assistant transcript `final`) in which NO canvas_* tool ran, the
gateway decides cheaply (no LLM) whether the turn is explanatory: user text matches
/wie|warum|wieso|erklär|zeig|architektur|aufbau|ablauf|funktioniert|wofür|wieviel|wie viel|kosten|geld|ausgaben|vergleich|diagramm|chart|grafik|skizze|übersicht|struktur/i
or the answer has ≥ 3 sentences or ≥ 3 numbers. If so → illustrator with request "Illustriere die letzte Antwort" (id: reuse the
current canvas id when the topic is the same, the illustrator decides; `by:"auto"`). Debounce 1.2 s; never more than one auto
run per turn.

## Round 6 (gauntlet r5 fixes): fast, correct, sourced visuals
**Early illustrator** (`createCanvasSession.userTurn`, kill switch `DESK_CANVAS_EARLY=0`). When a user turn is complete (voice:
the final user transcript or the provider's turn boundary; text: the request) and the user text is explanatory
(`isExplanatory(userText, '')`, ≥ 12 characters), the gateway starts the illustrator AT ONCE in parallel with the agent: request =
the user question (+ page context), `pending` is published immediately (`by:"auto"`, id = slug of the question). Not started when
the user forbids drawing (`wantsNoDrawing`: "nicht zeichnen", "ohne Bild", "keine Grafik" …, see Round 7; the agent's own canvas tools then refuse
too), when the question asks for secrets/key files, or when the daily cost cap is reached. Fallback triggers: the provider's
`turn_done` runs the auto decision (also without a transcript flush), and research tools running longer than
`DESK_CANVAS_RESEARCH_MS` (6 s; question explanatory, or ≥ 2 tools) in a turn without a canvas start it too.
- *Refine, not duplicate*: a later `canvas_draw` / `canvas_render` of the same turn updates the same id unless its kind clearly
  differs (then it is its own canvas). A `canvas_draw` that arrives while the early run is still drawing is deferred and runs
  right after it as an update; a `canvas_render` (finished spec) cancels the unfinished early run and replaces it.
- *Fast path* (`fastPath.js`, early jobs only): money question → `ledger_spend` is called by code (groupBy from the words:
  Gegenpartei → counterparty, pro Monat/Verlauf → month, else category; period from "im Oktober", "diesen/letzten Monat", "heute");
  "Architektur/Aufbau/Struktur" of the desk → `code_outline` of gateway/bridge/web `src`; of anything else → `knowledge_read`.
  The results are in the messages of the first model round (no model round to decide on the tool).
- Latency is measured per provider in the round-6 RESULT (pending at once, ready ≤ 8 s after the end of speech, text ≤ 6 s).

**Quality gate** (`normalizeCanvas(spec, {gate:true})`, used by the illustrator, `canvas_render` and Claude canvases). Rejected with a
short English reason the model repairs against: placeholder title/caption/labels ("Platzhalter", "placeholder", "TODO", "TBD",
"lorem ipsum", "…"); flow/architecture with < 3 nodes or 0 edges; architecture with ≥ 6 nodes and no groups; pie/bar with < 2 items.
When the tool-round budget is used up the illustrator forces one final answer without tools "ausschließlich aus den gesammelten
Fakten"; the one repair round carries the gate's error. On failure the previous spec stays: a NEW id gets an `error` event, an
EXISTING id gets its old spec published again (clears the pending marker; no destructive error).

**Deterministic money visuals** (`ledgerViz.js`). When the turn used `ledger_spend`, pie/bar/sankey values are built in code from
the newest result (`totalsEurApprox`, else single-currency `totals`): labels = the ledger groups, unit `"€ (ca.)"`, the `fxNote` as
a source. Detail of a category = its real top counterparties from the entries (prefixed "u. a." when not all entries were
shown); sankey = Gesamt → categories → top-2 counterparties + "Weitere" (second level only when all entries are shown and add up).
The model only picks kind, title, caption, highlight and (by how it calls the tool) period and groupBy. Items whose label is not in
the ledger are dropped (no invented payees); with < 2 left the chart is rebuilt completely. >12 groups → "Sonstige".

**Automatic sources** (`enrichSpec`, illustrator and `canvas_render`). A spec without a real source (or only "Gespräch") gets the
sources of the tools that ran in the turn: `ledger_spend` → its `source.ref` (Board #22 / export path; a claimed
`GELDBEWEGUNGEN…` file is removed unless `source.kind` is `export`), `knowledge_read` → `~/desk-knowledge/topics/<slug>.md` (slug from the
result), `read_file`/`code_outline` → the path, `board_*` → "Board #n". A spec with no tool and no source stays "ohne Quelle".

**Auto-illustration skips**: the user forbids drawing; refusal / "nichts gefunden" / secret-refusal answers (`isMetaAnswer`);
secret-file requests. The refusal-guard replacement "Ich zeichne es dir auf." is said at most once per turn.

**Tool hallucinations** (`tools.js`): an unknown tool name returns an error listing every valid tool with its arguments
(`read_file(path, offset?, limit?); …`); argument aliases are mapped (`file_path`→`path`, `name`/`slug`→`topic` for knowledge_read,
`topic`→`name` for read_core_doc, `job`→`name`, …); `/home/florian/…` and `~/…` in paths become `/home/flori/…`. The prompts state the real home
(`/home/flori`) and the repo path, and the citing rule (path verbatim from the tool result, no invented source chatter, terms as in the source).

**Voice**: Gemini's transcript glues German compounds ("KryptoEmissionen"); the final transcript is repaired with hyphens
(`voice/transcript.js`, brand names and CamelCase words seen in tool results stay whole). A voice session counts as healthy on
its first audio (`markOk`); `providerHealth` persists successes (file in production, `DESK_HEALTH_FILE`) so a redeploy does not
show `ok=null`; Gemini has a cheap key probe (`GET /models`), so no configured vendor stays unknown.

## Round 7 (gauntlet r6 fixes): the FINAL displayed state is complete, exact and clean
Gateway side only (`ledgerViz.js`, `sources.js`, `canvas.js`, `illustrator.js`, `tools.js`, `fastPath.js`, `prompt.js`).

**Monotonic refinements.** A same-id update never shows less than what is on the canvas.
- *Money charts are complete.* `ledger_spend` now carries a `breakdown` in its header (category → counterparties with EUR sums,
  built from ALL entries, whatever rows fit below; `breakdownComplete:false` when pairs had to be folded or the result was
  truncated). `ledgerViz` regroups from it: a category chart on a counterparty-grouped result (or the other way round) still
  covers EVERY group, and the sum equals the total (checked against the header, ±0.05). The newest result that can carry the wanted
  grouping is used. The grouping comes from the title ("Kategorie" / "Gegenpartei"; both = a sankey with category AND counterparty
  level), else from the labels, else from the ledger. The title follows the data: if only the other grouping can be shown,
  "nach Kategorien" becomes "nach Gegenparteien" and vice versa. Payee labels on a category ledger without a grouping word in the title
  stay a drill-down (known payees kept, invented ones dropped, as in round 6).
- *Captions.* When ledgerViz rebuilds a chart, caption sentences that contradict it are removed: another currency than the unit,
  "getrennt / nicht addiert" on the combined EUR chart, an entry count that is not the ledger's. An emptied caption becomes
  "Summe … € (ca.), n Kategorien."
- *Generic rule.* A `canvas_render` or an illustrator update on a ready id with the same kind and FEWER nodes (flow / architecture /
  sankey), items, rows, events, messages or points is rejected: the better spec stays (the illustrator republishes it, which clears
  pending; `canvas_render` answers `{shown:true, kept:true, note}`), audit line `canvas.refine.rejected`. Exceptions: Florian asked
  to simplify ("vereinfach, kürzer, weniger, grob, kompakt …"), or the spec was rebuilt from the ledger (deterministic, any period).
- The early illustrator's fast-path results (`ledger_spend`, …) are remembered in the session, so a later `canvas_render` of the
  agent is enriched from the same data.

**Quality gate (`qualityError`).** Tables: ≥ 2 rows, ≥ 50 % real cells, no junk header, no row with only its first cell; a cell is junk
when empty, one non-digit character ("x", "y"), "-", "n/a", "TBD" or "vexp: …". Sankey: ≥ 2 flows, real node labels, and a title that
promises two levels ("Kategorie und Gegenpartei") needs a second level.

**A render for another question gets its own canvas** (`kindsFor` / `fitsQuestion`). The question implies kinds: architecture →
`architecture`; money (not tax/emission talk) → pie / bar / sankey / line / table / timeline; "wie funktioniert / Ablauf / was passiert"
→ flow / sequence / timeline; "Tabelle", "Sankey", "Torte", "Balken", "Zeitleiste", "Sequenzdiagramm" name their kind. A
`canvas_render` / `canvas_draw` of another kind than that, on the early id, gets its own id (derived from its title, `-2` on a clash);
the early run keeps running and is not cancelled (Gemini put the previous video-block flow under the architecture question).

**Early trigger.** `isExplanatory` also matches "frage über|zu", "steuer", "rücklage", "umwandeln", "emission", "tranche", "wie läuft",
"was passiert", and EVERY user turn ≥ 60 characters that asks or requests something (a "?" or a request word) and is not chit-chat.
Tax/emission/conversion talk is not a money (ledger) question although it says "Euro": the fast path reads `knowledge_read` +
`search_files` for it. `wie` is matched as a word ("wieder" no longer triggers).

**Explicit ids.** User text that spells out an existing canvas id, or says "aktualisiere / ändere / erweitere … die Canvas /
Zeichnung / Grafik", makes the early run update that canvas (the newest one when no id is named). An explicit id of the agent's
`canvas_render` / `canvas_draw` wins over the early id when it is an existing canvas, the early id itself, or the one Florian named;
an unknown invented id still refines the early canvas.

**Sources (`sources.js`, `enrichSpec`).** A ref must be an absolute path (`~/…` is the same file as `/home/flori/…`), a URL,
`Board #n` / `Board #n · Eintrag m` / `Board: <query>`, a DECISIONS key with its file (`/home/flori/DECISIONS.md · key`), or
"Gespräch". Repaired: `AGENTS` / `STATE` / `CLAUDE` / `MODEL_POLICY` → the real file, `Thread #11` → `Board #11`, text after the
number is cut (`Board #22, 54 Einträge …` → `Board #22`), a repo-relative `gateway/src/x.js` → the absolute path, a job name that
`job_status` looked at → its folder. An entry id used as a thread (`Board #41234`) is mapped to its thread through the `board_read`
results of the turn (`Board #7 · Eintrag 41234`), else it stays an entry (`Board · Eintrag 41234`), never a made-up thread. Everything
else ("Ledger-Aggregation", "ledger_spend, Stand …", "src (Code)") is dropped; with nothing left the tools' sources apply, else
"Gespräch" (ohne Quelle). The desk's own FX-note source is kept.

**Prose.** The shared prompt lines (text + voice) say: "Zahlen und Kategorien nur wörtlich aus dem Werkzeugergebnis; keine
Selbstkorrektur-Floskeln ("Moment, ich prüfe") in der Antwort — prüfe vorher", and that categories with their counterparties and
sums stand in the `breakdown` field of the `ledger_spend` result (assign nothing yourself, compute nothing yourself). A German
conversation (the user's text has German words and no CJK) drops CJK glyphs U+3400–U+9FFF from the agent's answer (text deltas and
final voice transcripts).

**`wantsNoDrawing`** counts only explicit negations of the user's own request ("nicht zeichnen", "ohne Bild / Grafik / Diagramm",
"keine Grafik", "zeichne nichts"). Quoted text (`"…"`, „…“, »…«, `…`), a sentence the agent is asked to repeat ("Ich kann leider keine
Diagramme …") and "keine Werkzeuge" between the words are ignored.

**Tool hallucinations (`tools.js`).** `canvas_render {}` (or only an `id`) → `canvas_draw` of the user's question
(`session.question()`). An argument that starts with `_` (`__unused`) is an error that lists the valid arguments
(`read_file takes: path, offset?, limit?`); a missing required argument names the unknown ones. `*_placeholder` tool names
(`search_chunk_placeholder`) are mapped by intent to a read tool (`search_*` → `search_files`, `read_*` → `read_file`, `ledger*` →
`ledger_spend`, `code*` → `code_outline`, `canvas*` → `canvas_draw`, `claude*` → `claude_status`, never `claude_task`) or rejected with
the list of valid tools.

## Round 8 (gauntlet r7 fixes): honest refinement, deterministic prose, live facts

- **Refinement rule: subset ⇒ reject, different ⇒ the newest well-sourced drawing wins.** `shrinks(prior, next)` is true only when `next`
  has the same kind and fewer entries and every entry of `next` is already on `prior` (`entriesOf`: node label; pie / bar label + value;
  table row = all cells; event date + label; message endpoints + label; line point), or when `next` is different but unsourced while
  `prior` has real sources. A differing, sourced render with fewer entries (the correct 3-row provider table against a stale 4-row one)
  replaces the old drawing, for the illustrator and for the agent's `canvas_render`. "Simplify" requests still win as before.
- **Live desk facts.** `desk_status` (see Tools) is in `ILLUSTRATOR_TOOLS`; `fastCalls` runs it first for questions about the desk's own
  providers / models / credit / bridges (`isDeskStatusQuestion`). Both prompts say: desk_status beats job notes, never claim "kein Guthaben"
  unless it says so.
- **Deterministic money prose.** `ledger_spend` results end with `=== ANTWORT-LISTE (liste genau diese Werte …) ===` and one line per group,
  `Label: 1.234,56 € (ca.), n Einträge`, folded like the chart (11 + "Sonstige") and a `Summe:` line (`answerList` / `answerBlock` in
  `ledgerViz.js`; payees with a "— pro forma …" suffix are merged). In the text chat, once a ledger result exists the round's answer is held
  back and checked by `createMoneyGuard(content)`: a self-correction marker ("Moment,", "stimmt nicht", "ich vermische", "mein erster Satz war
  falsch", "Entschuldige", …), a euro amount that occurs nowhere in the result (rounding to a whole number or a tenth is tolerated) or a name
  before an amount that is not in the result → every sentence with money or a marker is dropped and `Laut Ledger:` + the list is appended
  (audit `chat.money_guard`). A clean answer is streamed unchanged. Spoken answers cannot be replaced; they get the list in the tool result.
- **GPT-Live.** The OpenAI voice instructions add: never ask back on a workshop question, call knowledge_read / search_files / ledger_spend /
  desk_status first. The early illustrator hands its fast-path facts to the session (`onFacts` → `adapter.addContext`, OpenAI only: an extra
  user message item without `response.create`).
- **Late draws.** `focus:false` (bus section). The session counts user turns (`startTurn`); a run that publishes after the next turn began,
  and a `canvas_render` / `canvas_draw` whose kind or title belongs to another domain (architecture vs. money) than the turn's question,
  publish with `focus:false`. Gemini's research loop is capped at 5 non-drawing tools per user turn (the 6th gets "Recherche-Limit erreicht …
  antworte jetzt").
- **Sources.** `Board #22 (TAX-Zeilen)` → `Board #22` (a parenthesis after a board ref is a model comment); the board is cited once; a
  notify / video-send / Telegram drawing never cites the desk's own code (`dropOffTopicSources`); code_outline sources are labelled
  `bridge/src (Code)`. Bridge `ledger.js` strips purpose / receipt text ("— pro forma PF/…") from the counterparty.
- **Test hook for critics.** `POST /api/auth/request-link` with header `x-desk-dry-run: 1` signs the link but sends nothing and uses no
  allowance - only when the gateway runs with `DESK_TEST_DRYRUN=1` (never set in production; otherwise the header is ignored and a REAL
  card goes out). The answer is `{ok:true, dryRun:true}`.

## Round 8 (gauntlet r7 fixes, web): big diagrams viewable as a whole
Web side only (`render/graph.ts`, `view.ts`, `CanvasView.tsx`, `Stage.tsx`, `render/charts.ts`, `render/sketchFit.ts`).

**Whole first on desktop (`bestLayout`).** Ranking per stage: (4) whole and legible (≥ 9 px labels, full detail) > (3) whole and
legible as a *dense overview* > (2) whole with labels ≥ `OVERVIEW_PX` = 8 px (stages ≥ 600 px only) > (1) fitted to the width with
vertical scrolling, legible > (0) illegible. The "groups stacked" scrolling column is therefore only the last resort on desktop (phones
< 600 px keep the r7 rules: 10 px, compact scale, single column). Within the best class (whole / scrolling / illegible) the variant
with the fewest edges around the diagram wins, then the tier, then the label size. `pickScale` uses the same 8 px threshold for
diagrams on desktop stages, so the chosen overview is shown whole; "Groß ansehen" is still offered below 9 px.
- *Dense overview* (big diagrams only: grouped, or ≥ 12 nodes): labels only, tight spacing, group legends capped at 110 px and edge
  labels at 76 px (ellipsis). What it drops stays in tooltips (node rect `<title>` = label — detail; edge label `<title>` = full label).
- *Requested LR is kept on a wide stage*: when any LR variant reaches tier ≥ 2 only LR variants compete; a plain chain (`isChain`) is
  never laid out TB there (folded LR rows at most).
- *"Groß" and the canvas-first big slot* are their own `CanvasView` with their own stage size, so `bestLayout` runs again for the
  bigger stage (full detail, ≥ 11 px for the q2-shaped 17-node architecture at 1390×626).

**Back edges never loop around (`backEdges`).** Edges into an earlier group (block order) and node-level cycle edges (depth-first from
the sources in spec order) are given to ELK reversed and drawn in their own direction again (route reversed, the arrowhead at the real
target). A group cycle (a "loops" group feeding back into the gateway's hub) no longer forces ELK to route around everything.

**Folded routes are completed (`attachEnds`).** ELK's graph wrapping can return a route that stops in the gap between rows (r7 d19:
"ja (mit Flag)" pointed at nothing). Such a route is completed orthogonally along the gap into the target's near side; a label left on
the cut-off stretch moves onto the longest segment of the completed route.

**"Alles zeigen" never below 6 px (`wholeView`).** The whole is shown when every text of the scene (labels, details, edge labels,
legends) stays ≥ `FIT_MIN_PX` = 6 px; otherwise the best overview at that size (from the top-left, centred on an axis that fits),
`clamped`, with the note "zu groß für ganz" in the controls strip; a second press returns to the auto view.

**Phone controls strip.** On stages < 600 px the strip folds away after `CONTROLS_IDLE_MS` = 2 s without interaction (never while
the user has zoomed/panned, since the resize would reset that view); a tap or focus on the canvas brings it back. The drawing gets the
44 px back; nothing sits beside or under the zoom pill. Pie legend mode sizes the donut so donut + legend fit the stage (radius ≥ 64,
below that the scene scrolls); a small donut moves a unit note like "(ca.)" under the total so the total keeps ≥ 11 px.

**Style.** Sequence labels are monospace only for a single code-like token (`codeLabel`: `notify.loginLink`, `/api/canvas`,
`canvas_draw`, `start()`), never for prose with hyphens. Model-drawn sketches: a start-anchored text that runs into a rect painted
after it and starting to its right (a badge) is fitted to end 6 units before it — condensed to ≥ 85 %, else cut with an ellipsis
and the full text in a `<title>` (`fitSketchText`, live view only; the PNG export keeps the model's markup).

## Round 9 (gauntlet r8 fixes, gateway): clean money prose, sourced tax claims, real model facts, one question = one turn
- **Money prose (text agent).** Once `ledger_spend` ran in a turn, the model's text never carries numbers: `ledgerViz.createMoneyGuard(...).compose(text, {max, withList})` keeps only model sentences without amounts (no `€`, decimal/thousand numbers, table rows, list items, "Laut Ledger", self-corrections, lead-ins ending in ":"), at most 2 per turn, and the deterministic `Laut Ledger:` list is appended exactly once, with the final answer (`chat.js`: `ctx.moneyListed`, `ctx.moneySentences`). Drafts written before a further tool call are stripped the same way; they never show a list. A model answer with amounts is therefore replaced, not repaired (r8 F2: wrong table + "Korrekt aus dem Ergebnis:" + third copy).
- **Tax-law claims.** `prompt.TAX_RULE` (text + voice via `groundingLines`, illustrator `SYSTEM_PROMPT`): tax-law statements only with a source (file, board, DECISIONS), otherwise "Dazu habe ich keine Quelle – frag den Steuerberater." Text post-filter `taxFilter.js` (`TaxClaimFilter`, sentence-streaming): a sentence stating a tax rule ("Steuerpflicht entsteht …", "ist steuerfrei", "unterliegt der … Steuer", "wird versteuert", "§ n EStG") without a source reference in the same sentence is replaced by that sentence, once per answer.
- **Illustrator facts.** `deskStatus.deskModelFacts()` (from `config.js` + the voice adapters) is part of the illustrator's system prompt ("Desk-Fakten"). A drawing that names a model (claude/gpt/gemini/grok/deepseek/…) found neither in those facts, nor in the conversation, nor in a non-code tool result is rejected and repaired once ("Claude über Abos" as text model). "Claude Code" (bridge sessions) is not a model name. The early architecture fast path runs `code_outline` (gateway/src first) plus `desk_status`.
- **Voice turns (`voice/session.js`).** Final user fragments are joined into ONE question for the agent side (viz/canvas memory, early illustrator): committed after `DESK_VOICE_MERGE_MS` (1500 ms) of silence, at once after a closed sentence, or when a fresh assistant answer starts (not while an older answer was still in flight, whose transcript interleaves with the fragments). The browser still receives every fragment.
- **Barge-in.** A user turn with content while an answer is in flight calls `adapter.interrupt()`: xAI sends `response.cancel`; OpenAI Live has no cancel event (live-verified: `response.cancel` is rejected) and barge-in leaves the delegation backend running, so the gateway sends `session.instructions.append` (`delegation_id: null`, `content`) and marks the tool calls the overtaken answer still issues (until its `turn_done`) stale, which ends that chain (an "nothing to cancel" error is ignored), Gemini needs nothing (new input interrupts; `toolCallCancellation` voids the pending calls). Tool results that come back after the next question began are stale: OpenAI/xAI get the `function_call_output` without a new `response.create` (`ToolBatch` stale path), Gemini (which waits for every call it made) gets the result wrapped in a "früheren Frage" notice, unless the vendor voided the call (`toolCallCancellation` -> not sent). Audit: `voice.barge_in`, `voice.tool.stale`, `voice.tool.cancelled`.

## Round 10 (gauntlet r9 fixes, gateway): scoped guards, sourced names, follow-up draws, fast GPT-Live, one queue per conversation
- **Money guard scope (`chat.js`).** The deterministic `Laut Ledger:` list replaces the model's money sentences only when the user's
  question is a spending question (`fastPath.isMoneyQuestion`, the illustrator's classifier). When `ledger_spend` was only context
  (Florian's tax-reserve sentences), the explanation stays and is checked sentence by sentence like every answer (next point).
- **Prose guard (`proseGuard.js`, text agent, sentence-streaming after `TaxClaimFilter`).** Checked against everything the model was
  given in this turn (system prompt incl. desk facts, conversation, every tool result): a model name with a version (`gpt-4o-realtime`,
  `deepseek-v4-flash`, `eleven_turbo_v2_5`) that none of it carries is replaced by its close sibling from that text (same family,
  edit distance ≤ 3: `deepseek-v4-flash` → `deepseek-v4.1-flash…`), else its sentence / table row is dropped; a host in a host position
  ("Bridge → X", "Bridge (X)", "läuft auf X") that is neither Sandy / LeChonk / sandy-prod / a connected bridge nor in that text
  becomes the connected bridge host (bridge context) or its sentence is dropped; when a tool ran, a currency amount found in no tool
  result is dropped with its sentence (knowledge_read numbers count); "X? — nein, Y" keeps Y; "Korrektur zum …:", "ich habe mich
  verrannt", "… verwechselt" sentences are dropped. Audit `chat.prose_guard`. The text and voice prompts now carry
  `deskModelFacts()` (incl. dictation models from `transcribe.js`), the host list and the desk-feature rule (login link → `auth.js`).
- **Illustrator names.** The model allow-list matches versions exactly (a family word like "deepseek" no longer whitelists any
  `deepseek-*`); an unknown host in a host position (`unknownHostName`) is a repair error like an unknown model. If the repair answer
  fails too, the first drawing with the name removed (host: replaced by the bridge host) is published (`canvas.repair.fallback`)
  instead of nothing.
- **Deictic follow-ups (`isDeicticDraw`, `createCanvasSession.userTurn`).** "Kannst du mir dazu ein Diagramm zeichnen?", "zeichne das" (a
  draw word + "dazu/das/…", no topic word of its own): the early run uses the newest earlier non-deictic question for its fast path and
  refines the canvas on the stage (this session's last focused id, else the newest on the bus); the request carries a "Bezug" line
  (previous question + canvas title / id / kind) that is also appended to every drawing request of that turn (the agent's own
  `canvas_draw`, deferred or not).
- **One illustrator queue per conversation.** Each canvas session is a lane (`text-n`, `voice-<provider>-n`); at most 2 runs per lane, 8
  for the desk; a lane never cancels another lane's drawing. A run that ends without a drawing for an id without a ready spec
  (evicted, early/auto failure) publishes `{phase:"dropped", id}` and `bus.forget(id)` removes that id's pending / error / dropped
  events from the replay ring; an existing id shows its last spec again. An explicit request's failure is still an `error` event
  live, but it leaves the ring at once (a reload never shows a failed placeholder). Web: treat `dropped` like "remove the
  placeholder" (the current reducer ignores unknown phases).
- **Early runs are short.** When the fast path already read the facts, the illustrator gets one more tool round (not three) before it
  must answer; the audit line carries the per-round times (`rounds=2 (650+1480ms)`).
- **Desk features.** "Login-Link / Zugangscode / einloggen" (not another project) → the fast path reads
  `gateway/src/auth.js`; the illustrator prompt says other projects' briefs describe another system. A timeline whose title or
  caption names a range ("R1 bis R9") must have an event for its end, else repair (`timelineRangeGap`).
- **GPT-Live.** The delegation backend comes from `DESK_OPENAI_DELEGATE_MODEL` / `DESK_OPENAI_DELEGATE_EFFORT` (default
  `gpt-6.1-sol` / `low`, live-measured against gpt-6-astra medium/low and gpt-6-luna low; `high`/`xhigh`/`max` are clamped to
  `medium`, Astra never runs above medium). The early illustrator's facts are no longer a separate user message (sent during a
  running delegation it derailed it: filler, then silence) but ride along with the next tool output of that question. The OpenAI
  lines say: at most two research steps, then speak; no own canvas call (the early illustrator draws every question) unless Florian
  asks for another drawing; no period = everything. Barge-in marks calls stale only while a vendor response is really open
  (`response_started` from `response.created` → `turn_done`): GPT-Live keeps speaking after its backend finished, and the old rule
  made the next question's first tool call stale (no answer at all). A voice session warms the bridge's ledger cache at start
  (`deps.prewarm`).
- **Watchdog (all adapters, `createWatchdog`).** No assistant audio / transcript / tool call `DESK_VOICE_WATCHDOG_MS` (6000) after the
  tool results went out → OpenAI / xAI send `response.create` again (max 2), Gemini gets one German text nudge; audit `voice.watchdog`.
- **Gemini.** Every tool result carries `hinweis` (answer in German, also when the result has English words), the early facts ride
  along with the next tool result, research cap 3 (was 5) with a German "keine weiteren Werkzeuge, antworte jetzt" result, and the
  Gemini lines demand a spoken answer with content for every question.

## Round 11 (gauntlet r10 fixes): conversation-scoped "zeichne das", no invented names on drawings
- **The browser says what it shows.** Every `POST /api/chat` body carries `focusedCanvasId` (the id on the stage, `null` when none;
  `web/src/canvas/bus.ts` `focusedCanvasId()`), and so do the voice WS `start` and `text` messages; while a voice session is open
  every stage change goes out as `{type:"focus", focusedCanvasId}`. A body without the field (an older client, a script) counts as
  "unknown".
- **Each text conversation owns its canvases.** The gateway remembers the ids every conversation produced (`createCanvasRegistry`,
  key = session + `conversationId`, in memory, 500 conversations × 30 ids, LRU); a chat request's canvas session gets them as `owned`
  and records new ready ids. A voice session owns what it drew.
- **Deictic referent ("zeichne das", "dazu", "aktualisiere die Canvas").** The canvas to refine is, in this order: the focused canvas
  if this conversation drew it; this session's last focused canvas; the conversation's newest own canvas still on the bus. Never the
  newest canvas of the desk from another conversation, lane or `by`. With an earlier own question but no own canvas, a new id from
  that question (suffix `-2` if that slug belongs to someone else). Only when the conversation has no topic of its own does a focused
  canvas of another conversation give the topic, drawn under a new id (the other canvas is never overwritten). "Ändere die Zeichnung"
  without an id means the focused canvas; only an "unknown" client still gets the desk's newest. The automatic after-answer
  illustration offers only the own stage canvas as "aktuelle Zeichnung".
- **Entity guard (`entityGuard.js`) on every drawn spec** (illustrator early / auto / `canvas_draw`, and the agent's `canvas_render`).
  Name-like tokens in title, caption, groups, node labels / details, edge labels, items, table cells, events, actors, messages and
  series - letters+digits (QX3, ZQX-…; units like 24h / 3x and short labels like R7 / T6 / v3.4 are exempt), ALL-CAPS words (common
  acronyms exempt), CamelCase, quoted one/two-word names, and capitalised words that are a near miss of a sourced name ("Kapa" for
  "kappa") - must occur in this turn's tool results, the knowledge read, the page context, the conversation or the previous version
  (name-like tokens with their exact spelling, plural allowed; other words of 5+ letters also inflected / in a compound), or as a whole
  word in the knowledge index / desk facts / hosts. The illustrator's own drawing request does NOT count (the agent's request itself
  carried the invented IDs). Unknown → one repair round with the list (audit `canvas.entities`), then the nodes / items / rows / events / actors /
  messages naming them are dropped and details / edge labels / title words lose them; if nothing drawable is left, nothing is
  published. `canvas_render`: the first offending call of a turn returns the list as an error, the second is published without them.
- **Early draws read the topic first.** `fastPath.knowledgeTopicOf` scores the question against the knowledge index sections (topic
  name / title words count twice); a clear winner with score ≥ 2 is read with `knowledge_read {topic: slug}` before the first model
  round (Florian's "Es geht darum, dass unser Subnetz … Emissionen … Steuerlast" → the emissions/tax topic instead of a search for "geht darum dass unser").

## Round 12 (gauntlet r11 fixes, gateway): no invented files / flags / domains, owned ids, no loops, quick Gemini
- **Code tokens are entities too** (`entityGuard.js` `codeTokens` / `createCodeCorpus`). File names (`*.js`, `*.md`, `*.sh`, …;
  "Node.js"-style product names exempt), paths (`/…`, `~/…`, `./…`, `gateway/…`, `src/…`, …; word compounds like "Browser/Telegram"
  are no paths), CLI flags (`--send`) and domains (`x.io`, also the host of a URL) on every drawn spec must occur in the same corpus as
  the names: a file / flag / domain as a whole token (a domain also as its last two labels), a path as a whole token, as the tail of a
  longer path, or as a known directory + a known file name ("voice/session.js" next to an outline that lists `session.js` under
  `…/gateway/src`). The prompts' "never /home/florian, never /app" rules do not make those paths known. Unknown → repair round, then
  dropped (as for names). Repro: the Grok architecture with `voice-relay.js`, `keys.js`, … and the flow with `notify --send`.
- **A failing or worse refinement never replaces the drawing on the canvas** (`illustrator.js` `worseThan`). If the refinement's
  invented names had to be dropped (repair failed, or the second `canvas_render` of a turn) and the drawing already on that id names
  nothing unknown, the old drawing stays (published again with its own `by`, audit `canvas.refine.rejected … invented …`; the
  `canvas_render` result says `kept`). If both name unknown things: the one with fewer unknown names stays; with as many, the one with
  more clean entries. The old drawing is judged against the facts alone (not against itself). A clean refinement replaces as before.
- **Canvas ids belong to the conversation that drew them** (`canvasBus.ownerOf(id)`; owner = text conversation (session +
  `conversationId`), voice session, or Claude session `claude:<id>`; kept in the gateway, never in events). A canvas session that
  would write (pending or ready, `canvas_draw`, `canvas_render`, early / auto draw) to an id another owner wrote first uses its own
  id instead: `<id>-2` (or `-3` …), remembered for the session, so later writes under the same name refine that copy. The one
  exception is the canvas Florian named in this turn (its id spelled out, or "aktualisiere die Zeichnung" = the focused canvas).
  Repro: the text conversation's `gateway-architektur` overwritten by Grok's; the same question asked in text and voice
  (same slug) overwritten by the voice auto drawing.
- **Prose sentences of the text agent** (`proseGuard.js`): a sentence that names a file / path / flag / domain the given text
  (system prompt, conversation, this turn's tool results) does not carry is dropped, and so is a sentence with an unknown CamelCase
  product name once the turn fetched data (a short allowlist of common products is exempt). Self-corrections are dropped as
  sentences: "korrekt:", "… — nein", ", nein,", "ich verheddere mich", "ich korrigiere", "Ich beende das", a later sentence starting
  with "Nein," that does not follow a question, and a sentence (30+ characters) the answer already contained.
- **Loop stop** (`LoopDetector`, `chat.js`): the same 6 words (at least 3 different ones) for the third time in one answer stops
  the stream; the complete sentences already checked are shown, the unfinished one is not, and one more round without tools asks
  for at most three short sentences summarising what the tool results said (audit `chat.loop`). A summary that loops again is cut.
  The aborted round reports no token usage (its cost is not counted).
  Not a loop (critic round 7): 6-grams that occur in this turn's tool results (the same error line for seven URLs), and the
  6-grams of a list item whose whole text is new; a list item repeated word for word still counts. When the turn has tool
  results, the closing summary drops sentences claiming results are missing ("keine Ergebnisse vorliegen").
- **Voice transcripts carry no tool markup** (`voice/transcript.js`): `name:call_x{…}`, `call_x{…}`, `default_api.x(…)`,
  `<ctrlNN>` are removed from assistant deltas (the last unfinished word waits for the next delta) and final texts, all providers.
- **Gemini: one filler per question, facts early.** The first sentence of each Gemini answer turn is held until it is complete;
  a second filler sentence ("Ich schaue …", "Ich prüfe …", "Ich analysiere …", "Ich verfolge …", "Moment …"; not with a digit,
  "dass" / "weil" or a perfect tense - "Ich sehe, dass …" is content) of the same question is never shown and is cut from final
  texts (audit `voice.filler.dropped`). The early illustrator hands its facts over without misses (`found:false`, `files:0`),
  headed by the question; once more after its own extra reads (`final`). Exact facts (the knowledge topic asked for by its own
  slug, the ledger, desk status) go to Gemini at once as desk text input when none of its tool calls is open (the "interrupted"
  right after that input is not counted as Florian speaking); all other facts ride along INSIDE the result text of its next tool
  call ("=== DESK-FAKTEN … ===", like GPT-Live; a separate `desk_fakten` field and fuzzy facts as desk input both made Gemini
  answer "keine Information" live). A Gemini research result waits up to 2.5 s after the question for facts still being read;
  after the facts went out Gemini gets one more research tool, then the cap answer. GPT-Live takes the later (`final`) facts
  only while none went out yet. Every hand-over is audited (`voice.facts sent|held|late`). Live r12: answers correct; the thinking
  model starts speaking 8.6-18 s after money / tax questions (no tool call in between) and 10-22 s after fuzzy ones: the remaining
  lever is the thinking level or the `?variant=fast` model, a product decision.

## Upgrades 28 Oct: simple by default, details on demand (docs/UPGRADES-1028.md §5)

Florian glances at the canvas while he talks: a diagram must be readable at a glance. The top-level spec is the
**simple view**; the optional `detail` is the detailed version of the same diagram.

`detail` (gateway `normalizeCanvas`): an object with the same `kind` (another kind is an error), the body fields of that
kind (nodes/edges/groups, actors/messages, items, series, columns/rows, events, nodes/links, svg) validated with the
normal limits above, plus optional `title` / `caption` / `highlight` (stored only when they differ from the simple view).
`id`, `v` and `sources` belong to the top level and are shared. Node ids are shared: the same id = the same thing, so the
web animates the switch in place. A detail with exactly the simple body is dropped. Structural errors come back as
`detail: …`; with `{gate:true}` the detail also passes the quality gate (`detail: nodes[2].label is a placeholder …`).
`detailSpec(spec)` gives the detail as a complete spec, `attachDetail(top, full)` puts a complete spec back as detail
(sources merged).

Simple limits (`SIMPLE` in canvas.js):

| kind | simple view |
|---|---|
| flow / architecture | ≤ 5 boxes, ≤ 6 arrows, at most one fork and one merge point (a chain, one decision or one hub), labels ≤ 28 chars, edge labels ≤ 2 words, no node `detail` text, groups only with ≥ 2 boxes |
| sequence | ≤ 5 actors, ≤ 6 messages, no notes, labels ≤ 28 |
| timeline | ≤ 5 events, no event details, labels ≤ 28 |
| pie / bar | ≤ 6 items |
| table | ≤ 5 rows |
| line / sankey / custom_svg | no simple limit (a chart of a series stays readable; a sankey cannot be cut without changing its sums) |

`simpleError(spec)` names a STRUCTURAL overflow (too many boxes / arrows / branches / actors / messages / events / items /
rows). Cosmetic overflow (long labels, node details, one-box groups) needs no model and is tidied deterministically.

Deterministic simplifier `simplifySpec(spec)` (pure, keeps ids, the original body becomes `detail` unless there is one):
- flow / architecture: the longest simple path (through `highlight` when it is a node), collapsed to ≤ 5 boxes (first,
  last, highlight, evenly spread; a skipped stretch becomes one dashed arrow), then one branch (the off-path neighbour with
  the most arrows, continued as a chain) while there is room; arrows only between kept boxes and only while the branch
  rule holds; labels cut to 28 characters at a word, edge labels longer than 2 words left off (the detail keeps them),
  groups only with ≥ 2 kept boxes. Always connected, always ≥ 3 boxes when the original had them.
- sequence: the 5 busiest actors, ≤ 6 of their messages spread over the whole exchange (first and last kept), no notes.
- timeline: first, last, highlight and evenly spread events (≤ 5), no details.
- pie: the 5 largest + "Sonstige (n)" with the exact rest sum (shares unchanged); bar: the 6 largest in their own order;
  table: the first 5 rows.
`ensureSimple(spec)` = the shown spec: unchanged when it fits, else `simplifySpec`. Returns `{spec, simplified}`.

Connected graphs (fix 28 Oct): a flow / architecture with ≥ 2 boxes has an arrow at every box, in the simple view and in
`detail`. `isolatedNodes(body)` names loose boxes; the quality gate rejects them (illustrator: the one repair round, its
fallback is the deterministic repair). `connectCanvas(spec)` is that repair, used by canvas_render (no model round),
`ensureSimple` and the fallbacks: when the connected boxes are a mostly linear chain in array order (≥ 75 % forward arrows,
≤ boxes + 1 arrows, no box with > 2 arrows in / out), each run of loose boxes is spliced in at its array position
(prev → loose… → next replaces prev → next; at the start / end it attaches to the chain's first / last box); every run
without such a place is dropped and named in the caption ("Ohne Verbindung weggelassen: …"). A detail that is too thin
after that is left out of a canvas_render (the simple drawing still shows).

Paths:
- **Illustrator**: the prompt asks for both in one JSON when the topic has more than the simple view (example: a 4-box
  simple flow + a 10-node detail). The simple view and its detail each pass every guard (entities, models, hosts,
  ledger rebuild, number grounding). A simple view over the limits goes back to the model ONCE ("move the rest into
  detail", audit `canvas.repair`); if the repair is still over the limits, the deterministic simple view is published
  with the model's version as detail (`canvas.repair.fallback`). Never a third call; a fitting answer costs one call.
  A detail that fails its guards is left out (the simple drawing still shows). A ledger-built money chart is simplified
  without a repair round. `infoCount` / `entriesOf` count the detail, so simple + detail is no "shrink" of a full drawing.
- **canvas_render** (text and voice agents): a spec over the simple limits is shown at once as the deterministic simple
  view with the agent's spec as detail (audit `canvas.simplified`); a broken `detail` is dropped instead of failing the
  call. The tool schema has a nested `detail` object. Deviation from the contract text: no extra "simplify pass" model
  call for canvas_render — the deterministic view is instant and free, so there is no interim "complex with toggle on".
- **Claude Code canvases** (```desk-canvas blocks): `ensureSimple` before publishing.
- Prompts: `canvasLines` (text + voice) say "zuerst einfach, die ausführliche Fassung in detail hinter Details"; the
  canvas_draw / canvas_render descriptions say the same.

Web: `web/src/canvas/detail.ts` (`hasDetail`, `variantSpec` = the detail merged over the simple view with the same id,
memoised, `detailLabel`). The canvas header shows a "Details" pill (aria-label "Details anzeigen", `aria-pressed`, the
text switches to "Einfach" while the details show) whenever the spec has a detail; the same header is used in the
"Groß" overlay. Default simple; the choice is kept per canvas id in the bus state (`details`, `toggleDetail`, shared by
the panel and the overlay, kept when switching through the history; an update without detail falls back to simple, an
id that leaves the history forgets it). The switch reuses the same-id update animation (shared node keys tween, new
parts draw in, removed ones fade). PNG export draws the variant on screen; "JSON kopieren" copies both. A simple graph
(≤ 5 boxes) on a desktop stage is laid out with a bigger type tier (`SIMPLE_T`, node labels ≥ 16 px on screen in the
829 px side column, else the normal tiers). Readability check: `web/scripts/screens-detail.mjs` (desk architecture,
payout flow, deployment pipeline; simple, mid-switch and detail at 1440×900 and 390×844, node label size and arrow
crossings measured).

## Prompts (text agent `prompt.js` AND voice `voice/instructions.js`, German)
Must contain, in substance:
- "Du hast eine Canvas neben dem Gespräch und kannst darauf jederzeit zeichnen: Flussdiagramme, Architekturdiagramme,
  Sequenzdiagramme, Torten-, Balken- und Liniendiagramme, Tabellen, Zeitleisten, Sankey und freie SVG-Skizzen."
- "Sag NIE, dass du nicht zeichnen oder keine Diagramme erstellen kannst."
- "Zeichne von dir aus, sobald du einen Ablauf, eine Architektur, einen Vergleich oder Zahlen erklärst — ohne zu fragen.
  Sprich währenddessen weiter; sag kurz 'Ich zeichne dir das auf'."
- Voice: "Nutze canvas_draw mit einer genauen Beschreibung (was, welche Teile, welche Zahlen aus welchen Tools)";
  text: canvas_render when it has the data in hand, else canvas_draw.
- "Für Geldfragen hole echte Zahlen mit ledger_spend, für Architektur code_outline/read_file — nie schätzen."
- To update the same visual while explaining step by step, reuse the id.
A test asserts these sentences exist in both prompts, and a test feeds the phrase "Ich kann leider keine Diagramme" through the
text pipeline guard: if a final answer contains a refusal to draw (/(kann|könnte).{0,30}(keine|nicht).{0,30}(diagramm|zeichn|canvas|grafik)/i),
the gateway triggers canvas_draw for the user's request itself and replaces the sentence by "Ich zeichne es dir auf." (text);
voice: the refusal in an assistant transcript triggers the illustrator at once (the spoken audio cannot be undone, but the visual appears).

## Canvas bus (`gateway/src/canvasBus.js`)
Single user app: one in-memory bus. Event:
`{type:"canvas", phase:"pending"|"ready"|"error", id, kind?, title?, spec?, by:"text"|"voice"|"claude"|"auto", provider?, at, message?, focus?: false}`
- `focus: false` (round 8): a late draw (finished after the next user turn started, or about another topic than the current question) is
  history only; the web must not switch the stage to it (`web/src/canvas/bus.ts applyEvent`, except when nothing is shown yet). The flag is
  absent on normal events, which follow as before.
- `GET /api/canvas/events` → SSE of bus events (cookie auth; `Last-Event-ID` replay from a ring of the last 50 events).
- `GET /api/canvas` → `{canvases:[latest ready spec per id, newest first, max 20]}` for reload/history.
- Chat SSE and voice WS ALSO carry the same `canvas` events (so a single stream suffices in tests), but the web app takes
  canvas state only from the bus (dedupe by `id` + `at`).
- Claude sessions: when a bridge event `{kind:"canvas", spec}` arrives for any session, the gateway normalises it and
  publishes `by:"claude"`.

## Bridge
- `ledger.entries {from?, to?, groupBy?, kgOnly?}` → `{entries:[{date, amount, currency, eurApprox?, counterparty, purpose, ref, kg:boolean|null, category}],
  totals:[{key, currency, sum, count}], totalsEurApprox:[{key, sumEur, count}], fxNote, source:{kind:"export"|"board", ref, asOf}, unparsed}`.
  Source 1: export file `LEDGER_EXPORT` (default `~/data/ledger/GELDBEWEGUNGEN_2026.md`, read-only copy the laptop CoS syncs) if
  present. Source 2 (fallback/merge for entries newer than the export): every `TAX:` line in board thread #22 (via the read-only
  `agent-board` relay; page through the whole thread, cache 5 min). Parse `TAX: <date> <time?>, <amount> <currency> (EUR ~x on card)?, <counterparty>, <purpose>, <ref>, <KG|private>`
  tolerant to variants; dedupe identical lines; category by keyword table (LLM-APIs, GPU, Hosting/Server, Abos, Domains, Steuer/Gebühren, Sonstiges).
  EUR approx: use the `EUR ~x` in the line when present, else a fixed rate constant with `fxNote`.
- `code.outline {path}` → realpath inside the read roots; walks ≤ 300 files (skip node_modules, dist, .git), returns
  `{root, files:[{path, lines, lang, doc (first comment ≤ 160 chars), imports:[relative paths resolved]}], truncated}`.
- New read roots: `~/work/agent-desk`, `~/Dev/explainer-pages`, `~/work/explainer-pages`, `~/bin` (files only, same deny list + redaction).
- Claude sessions: assistant text may contain fenced blocks ```` ```desk-canvas\n{CanvasSpec JSON}\n``` ````. The bridge cuts them out of the
  text shown in the stream (replaces with "[Skizze auf der Canvas: <title>]") and emits `{kind:"canvas", spec}` (raw JSON object; the gateway validates).
  The desk header in PROMPT.md explains the block format with a 6-line example and says: draw when you explain a structure,
  flow or numbers; Florian sees it live on the canvas.
- `notify.loginLink {url}` → runs `~/bin/notify now --requested "<card>"` once (card text below), returns `{sent:boolean, detail}`.
  Card: `✅ ERLEDIGT\nWorum geht's: Login für den Agent Desk (desk.app.mintapis.com)\n<url>\nGilt 24 h, 3 Aufrufe.`

## Login UX gap (Gate)
Opening the desk from an explainer page without a session: the Gate shows "Öffne zuerst den Login-Link aus Telegram"
explanation plus a button "Neuen Login-Link per Telegram schicken". `POST /api/auth/request-link {next}` (no auth; global limit
1 per 10 min and 4 per day; audit) → gateway signs a link (existing L1 links, 24 h / 3 uses) whose target keeps `next`
(only same-origin paths `^/(\?[^#]*)?$`; **`next: ""` or a missing `next` is valid and means `/`** - it really sends a card), sends it via bridge `notify.loginLink`, answers `{ok:true}` / German error. After login the
desk opens exactly the explainer/time it came from. The code field stays as it is.

## Web (`web/src/canvas/**`)
- Canvas tab = generative canvas (default tab of the Live column; on phone the Live tab opens on it). Header: title, kind
  icon, `by` badge (Text / Grok / GPT-Live / Gemini / Claude / Auto), history strip of the last canvases (thumbnails/titles,
  click to show), buttons PNG export + copy spec JSON. Footnotes = sources (path shortened to the file name + job, full ref in a
  tooltip; board refs "#22 · Eintrag 25697"). `unsourced` → amber tag.
- Pending: the frame appears at once with the title (if known) and a calm drawing animation (no spinner text loop).
- Renderers, all SVG in the explainer visual language (#0e0e12 background, moss #63D297, papaya #FA5D19, violet #8B5CF6,
  amber #F59E0B, red #EF4444 only for problems; large type, shapes over text, rounded, generous spacing):
  flow/architecture via **elkjs** (layered, lazy-loaded chunk; groups as compound nodes; orthogonal edges with rounded bends;
  arrowheads; edge labels on a pill), sequence (own layout: lifelines, arrows top-down, reply dashed), pie (donut with total in
  the centre, labels with leader lines, values + percent), bar (horizontal when labels are long), line (axes, gridlines, points,
  last-value label), table (zebra, numbers right-aligned), timeline (horizontal or vertical by count), sankey (own small layout or
  d3-sankey), custom_svg (sanitised as above, scaled to fit).
- Updates: same id → animated diff (nodes/items matched by id/label: new ones rise in, changed ones morph, removed fade);
  values tween; edges draw in. 60 fps, no layout jump; prefers-reduced-motion respected.
- PNG export: the rendered SVG (with title, caption, footnotes) rasterised at 2× to a PNG download, file name from id.
- Allowed new deps: `elkjs` (lazy), optionally `d3-sankey` + `d3-shape` (small). Nothing else. CSP stays (`worker-src 'self' blob:` exists; elkjs
  without web worker is fine).
- Activity layer: ActivityRail as a slim strip under the canvas (collapsible), WorkMap stays in the Claude tab, full log in Activity.

## Acceptance (gauntlet, see RUBRIC.md section C)
The three reference questions, asked by voice in EACH of xai / openai / gemini AND by text:
1. "Wie funktioniert die Video-Sendeblockierung?" → flow diagram (agent → notify → caption check → exit 75 NOT SENT / Telegram).
2. "Erklär mir die Architektur vom Agent-Desk-Gateway." → architecture diagram from real code (code_outline), groups Browser / Gateway (Sandy) / Bridge (LeChonk) / Vendors.
3. "Wofür geben wir das Geld aus?" → donut chart from ledger_spend with real sums, source footnote board #22 / export.
Each produces a correct, sourced visual within 8 s of the request (voice: of the end of speech), without the agent ever saying it cannot draw.
