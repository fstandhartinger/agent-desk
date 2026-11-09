# Computer control v2: tool contract (gateway loop <-> Screen Agent app)

Lead-owned spec. Both repos implement exactly this. Applies in UNRESTRICTED mode (client `policy.Unrestricted`, gateway
`unrestricted()`; both are the default since 4 Nov 2026: Florian supervises in real time, no confirmations, no site or app limits).
The guarded mode (`DESK_COMPUTER_GUARDS=on` / `ComputerUnrestricted=false`) keeps the OLD tool set and behaviour byte for byte: its tests must stay green.

Transport is unchanged: gateway sends `{id,run,seq,op:"action",tool,args}` through the commands long-poll, the app answers
`POST .../computer/<id>/result` with `{ok,code,class?,rule?,result?:{text?,target?,domain?,process?,jpeg?},run_state?}`.
Limits raised for v2: result JSON <= 2 MB, `jpeg` (plain base64) <= 1,400,000 chars.

## Why (post-mortem 9 Nov 2026, session a#ba7990)
He said "verwende den Computer, um auf Senden zu klicken" (a Telegram Web card in his Chrome). Both runs failed in 15-18 s:
1. Chrome attach: the allow-dialog matcher (`AllowDialog.Find`) answered `several` on the REAL dialog (window + text both carry the heading) -> `dialog-not-ours`; every `chrome_*` tool refused.
2. `ui_tree` on a browser window: refused `use-cdp`. `screenshot` of a browser window without a CDP-verified URL: "ausgeblendet" (no image).
3. No coordinate click, no free keyboard, no shell. He then said: "du kannst doch auch ganz normal den Computer steuern, über Screenshot und XY-Koordinate und Klick" and the second run failed the same way.

## Coordinate rule (one rule for the model)
Every image the app returns defines the current FRAME. `x`,`y` of click/move/drag/wheel are pixels IN THE LAST IMAGE the app returned
(top-left 0,0). The app keeps the frame (screen origin + scale, or a browser tab + scale) and maps to physical pixels itself
(PerMonitorV2: physical virtual-desktop coordinates, negative origins on left/top monitors must work). Each image result carries the
text line `frame: <kind> <w>x<h> ...` so the model knows what it sees. A click with no frame yet -> `ok:false, rule:"no-frame"` ("erst screenshot").
Frame kinds: `screen` (whole monitor or virtual desktop), `window`, `region` (zoom crop), `tab` (CDP page screenshot; mouse tools then go through CDP to that tab, also when Chrome is not in front).

## Auto-observe
Every acting tool (marked A) waits `settle_ms` (default 350, arg 0..5000) after acting and attaches a fresh image of the same frame kind/area
as the last one (or the monitor under the action when there is none) unless `observe:false`. So one model turn = act + see the result.

## Tools
Desktop (toolset `DesktopTools`, slice client-desktop):
| tool | args | result |
| --- | --- | --- |
| `screenshot` | `window?` ref, `monitor?` int (0 = primary; omitted: monitor of the foreground window), `all?` bool (virtual desktop), `region?` [x,y,w,h] in CURRENT frame px (zoom), `grid?` bool (labelled coordinate grid every 100 px), `max?` int long edge 640..2000 (default 1280) | jpeg + text: frame line, monitors (index, size, scale %, primary), foreground window (process, title), cursor position in frame px |
| `click` A | `x`,`y`, `button?` left/right/middle, `count?` 1..3, `mods?` e.g. "ctrl+shift" | "geklickt" + observe |
| `move` A | `x`,`y` | hover |
| `drag` A | `x`,`y`,`x2`,`y2`, `button?`, `ms?` 100..5000 (default 600; smooth path, >= 12 steps, press-hold 80 ms before moving) | |
| `wheel` A | `dy` notches (positive = down), `dx?`, `x?`,`y?` (default: cursor) | |
| `type` A | `text` (<= 20000 chars, newlines allowed), `enter?` bool, `paste?` bool (clipboard paste, clipboard restored afterwards; default automatic for > 200 chars or text with newlines) | types into whatever has the focus |
| `key` A | `key`: one chord ("ctrl+shift+t", "alt+tab", "win+r", "enter", "f5", "ctrl+a") or several separated by spaces ("ctrl+a delete"); `times?` 1..50 | |
| `wait` | `ms` 0..10000 | + observe |
| `ui_windows` | - | one line per top-level window: ref, process, title, state (min/max/normal), bounds, monitor, foreground mark |
| `window_focus` A | `window` | brings to front (restores a minimised window) |
| `window_state` A | `window`, `state` maximize/minimize/restore/close | |
| `open` A | `target` (path, URL, or program name as for Win+R), `args?` | ShellExecute |
| `ui_tree` | `window?`, `depth?` 1..40, `filter?` substring, `max?` nodes (default 400) | UIA tree with refs; browsers allowed |
| `ui_find` | `name` substring, `role?`, `window?` (default foreground; `all` = every window) | up to 30 matches with refs, role, name, value, enabled, offscreen |
| `ui_click` A | `ref`, `button?`, `double?` | Invoke/Toggle/Select/ExpandCollapse pattern when left single click, else real mouse at the element centre |
| `ui_type` A | `ref`, `text`, `clear?` (default true), `enter?` | ValuePattern when possible, else focus + type |
| `ui_read` | `ref` | name, value, text (TextPattern up to 20000 chars), state |
| `clipboard_read` | - | text (<= 20000) |
| `clipboard_write` | `text` | |
| `run_powershell` | `command`, `timeout_s?` 1..600 (default 60), `cwd?` | `exit=<n>` + stdout/stderr tail (<= 12000 chars each end-weighted) |
| `run_cmd` | same | |
| `run_wsl` | `command` (bash -lc), `distro?`, `timeout_s?` | `wsl.exe` missing or no distro -> ok:false rule `no-wsl` |
| `run_python` | `code`, `timeout_s?`, `where?` windows/wsl (default: Windows `py -3`/`python` if present, else WSL python3) | |
| `file_read` | `path`, `max?` chars (default 20000), `tail?` bool | UTF-8 text; binary -> size + note |
| `file_write` | `path`, `content`, `append?` | creates directories |

Chrome (toolset `ChromeTools`, slice client-chrome), over CDP on his RUNNING signed-in Chrome:
| tool | args | result |
| --- | --- | --- |
| `chrome_tabs` | - | every page tab: tab id, url, title, `own` (opened by this run), `active` |
| `chrome_open` A | `url`, `background?` | opens an OWN tab (never navigates his tabs unless asked) |
| `chrome_navigate` A | `tab`, `url` or `back`/`forward`/`reload` | |
| `chrome_activate` A | `tab` | brings the tab (and window) to front |
| `chrome_close` | `tab` | own tabs only, his tabs -> ok:false rule `not-own` unless `force:true` |
| `chrome_snapshot` | `tab`, `all?` bool (default: what is in the viewport plus a little; `all` = whole page, capped), `filter?` | outline in document order: text lines and interactive elements with refs (`[r12] button "Senden (empfohlen)"`), so a button can be told apart by the text around it |
| `chrome_click` A | `ref`, `double?`, `button?` | scrolls into view, real mouse events via CDP at the element centre |
| `chrome_fill` A | `ref`, `text`, `clear?` (default true), `enter?` | focus + Input.insertText (works for React inputs), verifies the value |
| `chrome_key` A | `tab`, `key` | key chord to the page via CDP |
| `chrome_read` | `tab`, `max?` | page text (innerText) + url + title |
| `chrome_eval` | `tab`, `js` (expression or async function body), `timeout_s?` | JSON result (<= 20000 chars) |
| `chrome_screenshot` | `tab`, `full?` | jpeg, sets a `tab` frame |
| `scroll` A (existing) | `dy` wire px (gateway maps direction/amount), `tab?` or `window?` | kept for compatibility |

When CDP is not available every `chrome_*` answers `ok:false`, `rule` = the reason (`debugging-off`, `no-dialog`, `no-answer`, `chrome-not-running`, ...) and a
German text that says what failed AND "nimm die Desktop-Werkzeuge (screenshot, click, type, key, ui_tree)". The connect result is cached for 20 s, then tried again (the run does not die on a failed attach).

## Result conventions
- `ok:true, code:"done"`: `result.text` short German status, plus `jpeg` when observed. `result.target` = the element/label acted on (for the activity line), `process`, `domain` as today.
- `ok:false, code:"refused"|"unclear"|"stale-ref"`: `rule` = machine reason (`no-frame`, `bad-args`, `not-found`, `timeout`, `no-wsl`, `stale-ref`, ...), `result.text` = one German sentence with the way out.
- Kill (Ctrl+Win+Shift+X), hands-on, pause, caps, beat: unchanged.
- No tool ever blocks longer than its timeout + 5 s. A stop during a running process kills the process tree.
