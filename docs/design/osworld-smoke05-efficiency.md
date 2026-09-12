# OSWorld task05: local Codex integration and CUA efficiency

[English](osworld-smoke05-efficiency.md) | [简体中文](osworld-smoke05-efficiency.zh-CN.md)

## Scope and status

This document records the initial smoke stage on 2026-09-11, when the local Node
REPL, JavaScript SDK and Rust native library were connected with the fixes below. Evaluation concerns execution efficiency only,
not task05 data, formatting or scores. Setup, locked-screen and screenshot-permission
failures are excluded from the timing comparison.

The third full smoke used application-refresh build `28ffa1bb` and reached its
1200.242 s limit: 77 MCP calls, nine errors, and no saved workbook. PDF discovery and
reading progressed, but full-task speedup is unproven. The subsequent line-break
build `d8ddc9ea` passed independent Excel LF, CRLF and double-LF fixtures; it was
not used in that 20-minute trial, and their evidence must remain separate.

## Local integration and provenance

The chain is Codex CLI app-server over stdio → local Node REPL MCP → staged
local SDK JavaScript → local N-API bridge and Rust library. No standalone driver
daemon is required.

1. Build `packages/node-repl` with `npm run build`; point MCP at `dist/index.js`.
2. Build `packages/cua-driver/typescript` with `npm run build`; copy `dist`,
   `computer-use` and `package.json` into a registered isolated module root.
3. In `packages/cua-driver/rust`, run
   `DEVELOPER_DIR=/Library/Developer/CommandLineTools SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk cargo build --release -p cua-driver-sdk --locked`.
   This host's default Xcode SDK 14.5 cannot compile the Metal dependency; installed
   Command Line Tools provide SDK 26.5/Swift6.3.3. Select them for the build process
   without changing system configuration.
4. Build the bridge using `packages/cua-driver/scripts/build-node-runtime.mjs --output`.
   Put it and `libcua_driver_sdk.dylib` in an explicit `QWEN_CUA_SDK_NATIVE_DIR`.
5. The benchmark's `scripts/stage_local_cua_runtime.py` stages JavaScript and
   records source hashes. SDK entrypoints must remain inside the registered root;
   Node REPL's rejection of external package symlinks is preserved.

Use separate trial directories and record model, CLI/Node versions, original task
and Skill, inputs, actual load paths and hashes. The source is
`20ecdaf6b2fbbfbd276bf05294e7b672632087e4` plus the fixes recorded for each trial;
a package version alone does not identify it. Archive the previous native file
and build record before atomic replacement, avoiding modification of mapped
libraries. Never relaunch an already-used trial directory.

Before fixes, the all-local connection probe returned a real 1568×743 Finder
screenshot in 47.732 s and four MCP calls. This is not task completion time.

## Fixes and evidence

Ordered by observed workflow impact; recovery intervals are not attributed wholly
to a single defect.

| Hotspot                                                           | Implementation and evidence                                                                                                                                                                                                                   | Boundary                                                                                                                                            |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Persistent MCP misses launched/exited apps and foreground changes | Live Process Manager PID/foreground queries replace time-varying AppKit sources. Launch, focus switch and exit work in one long-lived MCP without pumping the main loop.                                                                      | AppKit name/bundle/classification metadata remains; dynamic activationPolicy retains its existing cache limitation.                                 |
| Foreground shortcuts fail to select or lose Command               | Window-only hotkey uses the existing exact-window HID guard; ordinary modified pressKey uses explicit flags plus physical modifier transitions. Eight real selection/replacement cases passed, with two additional checks on the final build. | Preserve Screen Sharing bare forwarding, standalone-key flags, web coordinate-focus fallback and background refusals.                               |
| Multiline Unicode synthesis lacks Return semantics                | LF/CR become real Return, CRLF coalesces, and read-back across Return never manufactures a single-field partial retry offset.                                                                                                                 | Default pacing, other Unicode/Tab, atomic AX insertion and Screen Sharing physical input remain unchanged; GUI verification is recorded separately. |
| Facade omits incomplete capture and native context                | Prefer nested `observation_revision.capture_complete`, with legacy root compatibility; preserve eight geometry, background-route and degradation context fields.                                                                              | Retry incomplete capture at most once; never expose usable tokens from it or hide native AX errors.                                                 |
| App catalog repeatedly forks plutil                               | In-process CoreFoundation plist parsing supports XML/binary, Unicode and name fallbacks without adding an explicit cache.                                                                                                                     | Static catalog equality does not establish dynamic freshness; test these independently.                                                             |
| Key and AX-action names disagree                                  | Map meta/super to Command, accept Arrow\* names, require exactly one base key, and resolve advertised tree-action aliases.                                                                                                                    | Reject ambiguity, unadvertised actions and malformed chords; no speculative fallback.                                                               |
| Valid compact await fails transformation                          | Preserve whitespace around the injected cancellation guard; the real kernel executes compact nested SDK imports.                                                                                                                              | Discovered during preparation, not relabeled as a historical task error.                                                                            |

A same-state catalog comparison measured npm median 5839.898 ms against first local
17.738 ms, with all 118 static entries identical. Six samples on the final refresh
build took 24.6–48.5 ms in a different dynamic scene. The earlier 329× figure is not
a controlled ratio for the final build, and neither measures full-task speedup.

Explicit AX selection followed by `typeText('X')` replaces correctly; path appending
did not prove that typeText cleared selection. Keyboard acceptance relies on real
AXSelectedTextRange and final field values, not a committed response.

## Persistent application-state cause

In the second trial, Preview launched during an open action around 85 s and owned
grf19.pdf, but four subsequent old-MCP listings still showed only Excel. A fresh
MCP immediately found Preview. The host's Apple NSRunningApplication.h specifies
main-run-loop common-mode updates for running lists and time-varying properties;
an embedded Node host does not guarantee that loop. A separate Calculator test
observed stale raw AppKit values alongside live PID queries. Pumping the loop
repaired the old implementation; the fix does not need that intervention.

The Process Manager APIs are deprecated but available on this host and avoid
taking over the host main thread. This change claims fresh process membership
and foreground state, not every AppKit property. Prior “PDF not opened” statements
must be qualified as “not discovered or confirmed by the model”: the tested SDK's
own list is not an independent failure oracle.

## Smoke trials and multiline input

| Trial                                     |   Duration | MCP calls / errors | Status                                                           |
| ----------------------------------------- | ---------: | -----------------: | ---------------------------------------------------------------- |
| Permission-ready npm comparison           |  684.225 s |             49 / 9 | User stopped; model did not confirm first PDF text               |
| First local fixes                         |  289.250 s |             27 / 4 | Diagnostic stop for keyboard/path appending                      |
| Keyboard correction                       |  615.033 s |             49 / 5 | Diagnostic stop for stale application state                      |
| Application refresh correction (28ffa1bb) | 1200.242 s |             77 / 9 | Budget timeout; five PDFs read, Excel re-entry and Save recovery |

The third trial discovered Preview at 143 s, read first PDF text at 157 s, and obtained
all five years by 246 s. Its 1150-character TSV cell ran 283.248–334.356 s. Default
8+30 ms sleeps per character explain 43.7 s; the 51.108 s interval also contains
observation and REPL scheduling and is not exact typeText latency.

Unchanged 28ffa reproduced `11\t12\n21\t22` in a separate blank Excel workbook:
A1=11, B1 contains 12 and 21 separated by LF, C1=22, and the second row is empty.
Changing only the row boundary to explicit Enter while retaining Unicode Tab
produces adjacent rows in a 2×2 grid. Actual screenshots and per-cell AX readings
isolate LF. The correction emits keycode 36; one AXValue after Return cannot prove
complete delivery and must not recommend replay of a purported missing prefix.

New-build LF, CRLF and double-LF cases passed six per-cell AX assertions and
screenshot checks each. LF payload took 1758.872 ms in one API call versus
4351.404 ms across three calls for the working row-plus-Enter control. Both
exclude their common final-cell Enter, initial positioning and verification.
This demonstrates fewer calls for that fixture, not full-task speedup. Finder
single-line ASCII and Unicode selection/replacement/caret assertions and
screenshots also passed. All five fixtures and their MCP processes were cleaned up.

## Remaining hotspots and attribution limits

- **Save-panel targeting and capture content.** The independent AXSheet maps to
  requested CGWindowID 34138, but target observation considers only top-level
  AXWindows. CG/AX/SCK/filter geometry is 880×448; native 1760×896 output contains
  parent Book1 and padding while still being declared geometrically valid.
  System screencapture also includes the parent and returns 2804×1684. This is
  not SCK-specific, and ResizeRegistry arithmetic has not been shown wrong.
  This was unresolved at the initial smoke stage. The subsequent
  [attached-panel fix](osworld-attached-panels.md) adds exact sheet identity,
  ancestry/focus proofs and a selected-window display crop at validated bounds;
  it does not reuse parent tokens, crop a parent-only image or relax focus guards.
- **Per-character waiting.** Existing pacing remains; the public ComputerUse
  facade has no bulk-paste method. Correcting line breaks does not remove the
  43.7 s character-delay cost.
- **Incomplete AX capture.** Finder Help's `_SC_SEARCH_FIELD` advertises AXChildren,
  but three independent reads return -25200; restart temporarily restored capture.
  Do not silently treat the error as an empty subtree or assume Excel's empty
  tree and 20 s walk timeout have the same cause.
- **Action responses and target selection.** UI can change despite AXPress/AXOpen
  errors. Foreground actions restore the previous app; inactive Finder alone
  does not establish failure. Old windows, tokens and coordinate use require
  individual evidence, with exact-target checks preserved.

Baseline also has path, spreadsheet-character, clipboard and Save-dialog recovery;
mark these as suspected environment issues without assuming identical causes.
Historical hosts and native binaries are not fully matched. Early stops are not
completion times, and a few seconds between two timeouts do not demonstrate speedup.

## Validation and records

At the initial smoke stage, Node REPL build, typecheck and 63 tests, and SDK build,
typecheck and 46 facade tests passed. The line-break patch passed the native release build and 352 library tests.
Latest code review reported no findings; the complete diff is audited in two
passes. Real application/input verification and whole-task trials are recorded
separately; mock results do not substitute for GUI postconditions.

Reproduction report: `.qwen/issues/osworld-smoke05.md`; test plan:
`.qwen/e2e-tests/osworld-smoke05.md`; investigation journal and raw JSON/PNG:
`.qwen/investigations/`. The benchmark's `OSWORLD_QWEN_SMOKE05_PATTERNS.md` records
full trials by build, patterns, historical environment labels and efficiency metrics.
