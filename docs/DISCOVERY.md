# Discovery: the map and the full-text index (LeChonk bridge)

A voice or text assistant has to find anything quickly and walk from a table of contents into the details. Until now
`ctx.search` grepped a subset with a 2.3 s deadline. The **map** replaces the guessing:

- a **tree of nodes** (`map.discover`): about 20 sources, each level at most 40 lines, every line ends with the exact tool call that opens it;
- a **full-text index** (`map.search`): SQLite FTS5 over job notes, DECISIONS, the laptop mirror, the board, knowledge, rules, skills,
  explainer pages and code docs, German and English, accents folded, secrets scrubbed;
- `map.status`: size, freshness and the last build error.

Design: `/home/flori/jobs/agent-desk-context-discovery-20261115/DESIGN.md` §1. Code: `bridge/src/map.js` (read side),
`bridge/scripts/map/build.mjs` (builder), `bridge/src/mapIndex.js` (schema, chunker, classes, shared helpers).
The map methods exist on the **LeChonk bridge only** (`buildMethods(…, 'lechonk')`); the Sandy bridge runs Node 20 and has no `node:sqlite`.
The shell sandbox over a scrubbed text copy of the index runs on the Sandy bridge: see "Shell sandbox" below.

## Where it lives

`~/desk-knowledge/map/` (directory 0700, files 0600, never in the repo):

| file | what |
|---|---|
| `index.sqlite` | the index (docs, FTS5 chunks, nodes, meta) |
| `status.json` | result of the last run: counts, per-source freshness, timings, warnings, `lastError` |
| `.refresh.log` | one line per timer run (last 200 lines) |
| `index.sqlite.build` | work file, only while a build runs (or after an interrupted one, which the next run resumes) |

The builder writes **only** there. It copies the live index (or resumes the partial file of an interrupted run), applies the
changes, and replaces `index.sqlite` with a single rename, so readers never see a half-built index. The bridge opens the file
`readOnly: true` and re-opens it when its inode/mtime changes.

## Node tree

`nodes(path PRIMARY KEY, parent, title, summary, size, updated, kind, open, class, sort, owner)`. `path` is slash-separated and
unique; `parent` is explicit (root = `''`); `sort` orders the children (lower first); `open` is the call that opens the node;
`owner` is the doc a node came from (0 = rebuilt every run). Root order (usefulness):

`wissen, entscheidungen, chats/laptop, desk-sitzungen, jobs, board, chats/sandy, chats/lechonk, regeln, artefakte, skills, explainer, code, ledger, server, gpu, mail, discord, datenbanken, web`

| node path | children | `open` |
|---|---|---|
| `wissen` | `wissen/INDEX`, `wissen/<topic>` (from `~/desk-knowledge/topics/*.md`) | `read_file(<file>)` |
| `entscheidungen` | `entscheidungen/<yyyy-mm>` → one leaf per `## ` entry of DECISIONS.md (`entscheidungen/<month>/<slug of the heading>`; title = the heading, summary = first sentence) | `read_file("/home/flori/DECISIONS.md", offset=<line>, limit=<n>)` |
| `regeln` | `regeln/AGENTS.md` (→ one node per `## ` section), `STATE.md`, `CLAUDE.md`, `model-economy-policy.md` | `read_file(…, offset, limit)` for sections |
| `jobs` | `jobs/<yyyy-mm>` → `jobs/<yyyy-mm>/<job>` → `jobs/<yyyy-mm>/<job>/<file>` | `discover(…)`, `job_status("<job>")`, `read_file("/home/flori/jobs/<job>/<file>")` |
| `chats/laptop` | `INDEX`, `memory` (→ notes), `<project>` → `<sid8>` → `<yyyy-mm-dd>` (summary = the first user line of the day) | `read_file(<day file>)` |
| `board` | `board/<thread id>` (title from the board; entries are search hits only, not nodes) | `board_read("<id>")`; hits: `board_entry("<id>")` |
| `skills` | `skills/<name>` (name + description from the front matter) | `read_file(<SKILL.md>)` |
| `explainer` | `explainer/<slug>` (page title from `context.json`) | `read_file(<deepdive.md>)` |
| `code` | `code/<repo>` → top-level dirs (`code_outline(<abs dir>)`; `docs/` → `discover`) and README/docs `*.md` files | as listed |
| `desk-sitzungen`, `chats/sandy`, `chats/lechonk`, `artefakte`, `ledger`, `server`, `mail`, `discord` | static: the live tool is named in the summary | `desk_sessions()`, `chats_search(…)`, `artifact_search(…)`, `ledger_spend()`, `run_readonly("quota_status")`, `mail_search(…)`, `discord_read()` |
| `gpu`, `datenbanken`, `web` | placeholders ("GPU-Ledger, kommt", Phase 2) | `discover("<name>")` |

A **job** node: title = job name, summary = `FINAL DONE` / `PARKED` / `open` (last line of STATE.md, the job protocol's finish line;
`no STATE.md` when there is none) + ` · ` + the first real line of RESULT.md, else the PROMPT.md title, else STATE.md. Months come from the
`-YYYYMMDD[HHMM]` name suffix, else from the oldest file time. Canonical paths only (`/home/flori/jobs/<job>/<file>`), never the notes-mirror path.

**Classes** (`docs.class`, `nodes.class`): `personal` for `chats/*`, `mail`, `discord` and the laptop `memory/`; `finance` for `ledger` and any
doc/node whose path or title matches `tax|steuer|emission|ledger|wallet|kraken|invoice`; else `open`. The gateway decides what may be spoken.

## Index

```
docs(id, path UNIQUE, source, node, title, mtime, size, class, kind, summary, extra)     -- kind: file | board
chunks  FTS5(doc_id UNINDEXED, line UNINDEXED, heading, body, tokenize='unicode61 remove_diacritics 2', prefix='3 4')
nodes(…)    meta(key, value)
```

- Chunks are about 1,200–1,800 characters, cut at headings and paragraph breaks; `line` is the **0-based start line** (the `offset` of `read_file`).
  DECISIONS.md and AGENTS.md force a cut at every `## ` heading, so a chunk never holds two entries. A chunk's rowid is `doc_id * 100000 + n`,
  which makes "delete a doc's chunks" a rowid range delete (an FTS5 `UNINDEXED` column has no index).
- Every chunk, title and summary passes the bridge `redact()` **before** it is stored (chunk by chunk, so line numbers stay true).
  Files that hold a PEM private key block, binaries (NUL bytes), files over 2 MB (DECISIONS.md: 16 MB), `.jsonl` and anything `isDenied()` never enter.
  A text is indexed up to 600,000 characters. Only allowlisted paths are read (`resolveAllowed`; job notes by `isDenied` on the canonical path).
- Board entries: incremental export with `~/bin/sandy-read board-sql "select … where id > N order by id limit 1000"` (body cut at 20,000 characters);
  `meta.board_max_id` is the cursor. Entries are treated as immutable (an edited entry is not re-read). If `sandy-read` fails, the board part is skipped,
  the build still succeeds and says so in `warnings`; the old entries stay.

## Builder

```bash
node scripts/map/build.mjs [--dir ~/desk-knowledge/map] [--full] [--no-board] [--board-cmd ~/bin/sandy-read]
                           [--mirror <notes mirror>] [--laptop <laptop mirror>] [--max-board N] [--shrink-min N] [--quiet]
```

- Incremental by `(size, mtime)` per file and by board entry id; a doc whose node/class changed but not its content only has its nodes redone;
  a different `SCHEMA_VERSION` (src/mapIndex.js) or `--full` rebuilds from scratch. Aggregate nodes (months, jobs, threads, sessions, repos, root) are rebuilt every run.
- Safety: one build at a time (`.build.lock` with a pid check + `flock` in `refresh.sh`); a source that cannot be listed keeps its rows; a source that
  suddenly lists less than half of what the index holds (≥ 50 docs) removes nothing that run (a wiped notes mirror must not empty the index).
- Needs Node ≥ 22.5; it prints a clear error on older Node. `refresh.sh` runs it from the deployed bridge checkout.

### Measured on LeChonk (15 Nov 2026, Node 24.22, the real data)

| | |
|---|---|
| docs / chunks / nodes | 90,851 / 268,204 / 32,181 |
| docs by source | board 62,418 · jobs 27,813 · chats/laptop 224 · explainer 215 · skills 150 · wissen 15 · code 11 · regeln 4 · entscheidungen 1 (DECISIONS.md, 1,183 entries) |
| text indexed | jobs 254 MB, board 45 MB, laptop 15 MB, rest 6 MB |
| database file | 912 MB (the indexed text is about 320 MB; the rest is the FTS index incl. prefix 3/4) |
| full build | **3 min 51 s** (jobs 127 s for 27,824 files, board 91 s for 62,418 entries, laptop 8 s), 477 MB RSS, 3 min CPU |
| incremental build, nothing changed | **5.4 s** (most of it copying the 900 MB file and the board threads query) |
| incremental, a handful of changed notes + new board entries | 6–8 s |
| skipped | 11 files (private-key blocks / binary) |

### Timer

`systemd/desk-map.service` (oneshot, `Nice=10`, idle IO, `TimeoutStartSec=20min`) + `desk-map.timer` (2 min after boot, then 15 min after the
previous run finished). Install on LeChonk (not done by the feature branch; the bridge checkout must be deployed first):

```bash
cp bridge/systemd/desk-map.service bridge/systemd/desk-map.timer ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now desk-map.timer
systemctl --user start desk-map.service            # first full run now (about 4 min); journalctl --user -u desk-map -f
tail -n 3 ~/desk-knowledge/map/.refresh.log        # one summary line per run
```

A build that is killed by the timeout leaves `index.sqlite.build`; the next run resumes from it (docs are committed in batches of 300).
Rebuild from scratch: `node scripts/map/build.mjs --full`. The live bridge picks up a new file within one request (mtime/inode check).

## Methods

All three are read-only; `map.discover` and `map.search` pass the query through the secret-fragment guard (`assertNoSecretFragment`), and every
result still passes `redactDeepAsync` on its way out. Hits whose path is denied are dropped again at query time.

**`map.discover({path, query, offset, limit, since})`** → `{path, title, summary, open?, class?, lines:[{path,title,summary,size,updated,class,open}], total, nextOffset}`.
No `path` = the root. `limit` default 20, max 40; `nextOffset` is `null` at the end. An unknown path answers with the nearest valid paths; a canonical file path
resolves to its node. A node without children (a file) returns `lines: []` and its own `open`.
With `query`: the FTS search restricted to that subtree, one line per document (best chunk), same line format plus `snippet`; `open` then carries the chunk's
line offset. Below a DECISIONS month/entry or an AGENTS.md section the scope is that file's line range (an entry opens with at most 200 lines, so the scope of a longer one ends there).

**`map.search({query, source, path, limit, since, offset})`** → `{query, terms, total, ms, nextOffset, hits:[{path, line, title, heading, snippet, score, updated, class, open, node, source}]}`.
`source` = a root name (`jobs`, `chats/laptop`, `board` …), `path` = a subtree, `since` = ISO date on the document time. `limit` default 10, max 40.
`path` of a hit is what `read_file` takes (board entries: `board/<thread>/<id>`); `line` is the 0-based chunk start; `snippet` ≤ 300 characters around the densest cluster of matches.

**`map.status()`** → `{built, docs, chunks, nodes, bytes, sources:{name:{docs, newest}}, lastError, warnings}`; before the first build `built: null` and `lastError` explains.

### Query and ranking

1. `expandQuery` (src/searchTerms.js: DE↔EN rows, stems, compound rows, `SN92`) plus map-only German→English rows (`stund→hour`, `bewert/wertung→scoring…`, `runde→round`,
   `konten→account`, `krypto→crypto`, …; one direction on purpose, see `EXTRA_SYNONYMS` in src/map.js) and `ä→ae`, `ö→oe`, `ü→ue`, `ß→ss` variants.
2. Every variant becomes a double-quoted FTS5 phrase (single tokens of 4+ characters are prefix-matched: `"stund"*`). Groups are OR-ed inside, AND-ed between.
   Nothing the user types reaches FTS5 unquoted, so `"`, `*`, `NEAR(`, `AND OR`, `:`, `^`, `heading:x`, `-x` are just words (tested).
3. Pass 1 requires every group. Pass 2 (several groups) requires every group **except the most common one** (document frequency, cached): that finds notes that spell one
   word differently ("Wertung" for "Bewertungsphase") without ranking 100,000 matches of an any-word query (200 ms instead of 20 ms).
4. `bm25` with the heading weighted 3× (`bm25(chunks, 0, 0, 3.0, 1.0)`), then `score = -bm25 + 6 × (matched groups / groups) + 3 × 0.5^(age days / 60) + source bonus`
   (wissen 8, entscheidungen 3, regeln 3, chats/laptop 1.5, code 1, skills 0.5), at most 2 chunks per document.

### Latency (p95 target < 300 ms)

41 mixed German/English queries (incl. 1-word, injection and common-word ones; one cold run plus three warm runs each, 123 warm runs) against the full 90,851-doc index on LeChonk:
**p50 39 ms, p95 207 ms, max 273 ms** (the slowest are single very common words such as `review`: one group, 80,000 matching chunks; typical 3-term
questions take 10–100 ms). The first call after a (re)open adds the document-frequency counts (cached afterwards).

## Shell sandbox: the scrubbed corpus (job agent-desk-context-discovery-20261115, slice shell-sandbox)

The research agent's `shell(cmd)` runs on the **Sandy bridge** (`sandbox.exec`, `bridge/src/sandbox.js`): bubblewrap with user namespaces works
there and is blocked on LeChonk (CoS deputy, board #62544). The program list is not the boundary (`python3`, `awk`, `find -exec`,
`sqlite3 .shell` run other programs); the sandbox is, and what it can read is **only the index's scrubbed text**:

```
LeChonk  desk-map.timer (15 min) -> build.mjs -> index.sqlite -> export-corpus.mjs -> ~/desk-knowledge/corpus/<source>/<path>.txt   (0700/0600)
   |  rsync over ssh, hourly (Sandy: desk-corpus-pull.timer, pull-corpus.sh)
Sandy    ~/.local/share/desk-corpus.gen/gen-<ts>/  <- symlink ~/.local/share/desk-corpus  == /data in the sandbox (read-only)
```

- **File names:** `<source>/<canonical path without the leading slash>.txt` (`jobs/home/flori/jobs/<job>/RESULT.md.txt`, `chats/laptop/...`,
  `entscheidungen/home/flori/DECISIONS.md.txt`); board entries `board/<thread>/<id>.txt`. First line `# <canonical path> | updated <ISO>`,
  then the document's chunks in line order, separated by a blank line (the pieces of one very long line are re-joined with a space).
  The file's mtime is the document's mtime. Line numbers in the file are not the original line numbers; the header gives the path to open.
- **Scrubbing:** every chunk was redacted before it entered the index and passes `redact()` once more at export (secrets that became known
  after indexing), and the sandbox output passes the Sandy bridge's `redact` again. A doc with a denied path (`isDenied`), without text or
  with a path that cannot be mapped to a safe file name (`..`, odd source names) gets no file.
- **Export** (`scripts/map/export-corpus.mjs [--db] [--out] [--full] [--no-redact] [--force]`, Node >= 22.5, called by `refresh.sh` after a
  successful build, a failure never fails the refresh): builds `corpus.new/`, swaps it in (old tree renamed away, new one renamed in, old
  one deleted). Unchanged documents (same mtime) are hard links of the old files, so an export with little change takes seconds; everything
  is re-read and re-scrubbed with `--full`, when the number of known secret values changed, and at least daily. Chunks are read from FTS5's
  own content table `chunks_content` (a rowid range on the virtual table scans all 268,000 chunks: 267 ms per document, about 7 hours in all).
  A new tree with less than half of the old files is not swapped in without `--force`.
- **Pull** (`scripts/sandbox/pull-corpus.sh`): rsync into `gen-*.partial` with `--link-dest` of the current generation, checks (meta file,
  file count, not less than half), renames, moves the symlink atomically, keeps the newest 3 generations and anything younger than
  10 minutes. A failed pull leaves everything as it was; `sandbox.exec` binds the symlink's target when a command starts, so a command
  never sees a half copy or a swap.
- **Secret scan:** `desk-knowledge/corpus` and `.local/share/desk-corpus[.gen]` are pruned from the bridge's secret-store discovery (a note
  called `token-notes.md.txt` is text, not a store; the walk would otherwise visit 99,000 files).

### Measured (15 Nov 2026, the real index: 99,213 docs)

| | |
|---|---|
| corpus | 98,991 files (222 documents are empty), 311 MiB of text (628 MiB on disk with 4 KiB blocks), sources: board 62,456, jobs 36,132, chats/laptop 224, skills 150, wissen 15, code 6, regeln 4, daten 3, entscheidungen 1 |
| full export on LeChonk (`--full`) | **114 s**, 103 s CPU, 330 MB RSS; **11 s** with `--no-redact`: the second scrub costs 100 s |
| incremental export, nothing changed | **6.4 s** (98,991 hard links) |
| pull to Sandy, first / nothing changed | 9 s (345 MB over the wire) / 5 s (new generation of hard links, 34 MB of directory entries) |
| `sandbox.exec` per command | 25-40 ms for `cat`/`jq`/`awk`/`python3 -I -c`, 0.3-0.9 s for `rg`/`find` over all 99,000 files, 1.6 s for a case-insensitive `rg` over the board (62,000 files) |

Limits and the exact bubblewrap line are in `bridge/README.md` ("`sandbox.exec`"). Not covered: nested user namespaces inside the sandbox are
possible (`unshare -U` works; bubblewrap 0.6.1 has no `--disable-userns`); a seccomp filter would close that and is the next hardening step.

## Known limits

- Summaries are the sources' own headlines (no model). A job whose RESULT.md starts with boilerplate gets that as its summary.
- Board entries are indexed once; an edited entry keeps its old text. The first build fetches all of the board (about 90 s); later runs only the new entries.
- A `.txt`/`.md` over 600,000 characters is indexed up to that point (`docs.extra.truncated`).
- The index is a copy of what the notes mirror had at the last run (every 5 min) plus the build interval (15 min): a note written a minute ago is found by
  `ctx.search`/`job_status`, not yet by `map.search`.
- Laptop `INDEX.md` is indexed as a doc but its structure is not parsed: the tree is derived from the day file names (`<project>__<sid8>__<day>.md`).

## Gateway side: discover, search, research (job agent-desk-context-discovery-20261115)

Tools (`gateway/src/discover.js`, registered in `tools.js`): `discover(path?, query?, offset?)` → `map.discover`
(static root when the LeChonk bridge does not serve it yet), `search(query, source?, since?)` → `map.search` (falls back to
`ctx.search`), `research(question, focus?)`, `research_result(id?)`. Voice gets compact results (≤ 6 lines for discover,
≤ 5 hits for search); titles and summaries from files are shown quoted, the open call is built from ids and paths.

Research agent (`gateway/src/research/`):
- `agent.js`: one question, up to 8 rounds / 110 s / USD 0.25. A keyword warm start searches the index before the first
  model call (and the laptop mirror when the question is about Florian's own words). Up to 4 tools per round in parallel,
  then a short German answer with sources, open points and a confidence (`answer` tool; forced at the limit).
  Results above 3,000 characters go into a workspace (`@w1` …): the model sees size, outline and a preview and reads with
  `ws_grep` (literal terms), `ws_read` (by line) or `ws_ask` (cheap sub-calls over 30,000-character chunks, depth 1,
  4 at once): the recursive-language-model idea without a free REPL. Tool set: the Desk's read tools only (explicit list;
  no handoff, Claude, canvas, voice action, Discord or screen tool; `search_files`/`board_search` replaced by `search`).
- Taint rule: web tools exist in a run only until it reads our own data. A run that read outsider text (mail, web)
  closes `web_read` for 5 minutes after its answer is told.
- Model calls go through OpenRouter with zero-data-retention routing and no fallback (`completeChat({ zdrOnly: true })`).
  Model: `DESK_RESEARCH_MODEL`, sub-calls `DESK_RESEARCH_SUB_MODEL`; kill switch `DESK_RESEARCH=off`.
- `manager.js`: runs per Desk session (cookie sid), at most 2 at a time, the same question again = the same run.
  Voice waits 2.5 s (text chat up to 115 s); a slower result is told through the computer manager's `say()` hook
  (`withResearchAttach` in `server.js`), only when `idle()` (session.js: nothing spoken, no tool running, no open question,
  3 s quiet; at most 90 s hold). A pending research settles the no-answer watchdog. Results stay 30 min; an untold result
  is told at the next voice start of the same sid. Trace events: `research.start|done|delivered|undelivered`
  (`research.done.answer` feeds `conversation_history`).
- Voice escalation: a quick search in voice that finds nothing starts `research` for Florian's last sentence.

Evaluation: `gateway/eval/research-eval.mjs` runs a private question set (never in the repo; on LeChonk
`~/desk-knowledge/eval/questions.jsonl`) through the agent with an in-process LeChonk hub; the job folder holds the grader
(Claude via the subscription) and the measured tables.

Start briefing fallback: `laptop.recent` (LeChonk bridge, `bridge/src/laptopRecent.js`) returns the last messages of the
laptop main session from the compact mirror; `briefing.js` uses them when the Screen Agent sends no main-session messages.
