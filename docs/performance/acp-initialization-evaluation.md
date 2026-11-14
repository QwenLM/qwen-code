# ACP initialization: performance evaluation

[English](acp-initialization-evaluation.md) | [简体中文](acp-initialization-evaluation.zh-CN.md)

The final integrated source reduces the median first complete SDK create from **815.994 ms to 706.277 ms** in eight interleaved pairs against clean main at the same revision. The mean changes from **833.257 ms to 719.861 ms**. The candidate is slower in pair 7, which remains included. **Neither condition has a first SDK result below 500 ms (0/8 each); the goal remains incomplete.**

This report covers local reconstructed private installed workloads after the separately merged watcher optimization in [PR #17177](https://github.com/QwenLM/qwen-code/pull/17177). It is not latency of a deployed preproduction instance. Private contents, installation names, manifests, identifiers, paths and raw logs are not published. The current source-only comparison appears first; every older component, runtime and cache cohort retains its own conditions and observations below.

## Current integrated source scope

The current comparison uses clean main 6f754be6548903e545e6ff0ed43a34927fe3bfb9 and a 42-file local candidate: **25 production files, 11 test files and six bilingual documents**. Both already contain the merged watcher change. The source combination includes initialization-local ripgrep overlap/cancellation, parallel independent per-extension discovery, attach/export and scheduled-source import cuts, bounded repeated YAML parsing, and lazy top-level CLI command registration. The conservative six-file experiment below is an earlier component cohort, not this final candidate.

The YAML cache admits at most 256 successful raw object results with inputs no longer than 16,384 UTF-16 code units. Every return creates a fresh sanitized result; diagnostics, invalid inputs and dynamic debug flags retain the existing parser path. CLI registration preserves the 15 original command grammars/order, auth's early translation snapshot, update's getter and the selected command's original synchronous builder/handler. Conservative raw-name and completion-marker matching can load extra implementations without dispatching them.

No new setting or daemon route is introduced. Existing readiness, authentication, trust, workspace activation and tool decisions remain on their original paths. This source candidate includes no resolver hook, installed AOT cache, launcher/GC policy, minification change or first-tool initialization deferral. The measured result belongs to the combined source; it does not isolate each change's contribution.

The primary clock includes the complete awaited SDK create-or-attach: capabilities GET, session POST, JSON decoding and SDK identity validation. At its start the daemon is ready but has no session or ACP child. The real child starts within that call. Daemon spawn through first SDK completion is a separate clock; waiting for daemon readiness is not channel preheating.

## Final integrated source on the same main: empty per-row cache

This separate eight-pair cohort compares a clean main build (A) with the final integrated source build on that same main (B), using normal published packages. Base: `6f754be6548903e545e6ff0ed43a34927fe3bfb9`; measurement-time snapshot seal: `78afd107a0f4bc1e0c4222918ca97b43dd441e0fdbe4e5553aab87cfc6d7b827`. This evidence is independent of the earlier YAML, resolver, AOT, runtime and GC/cache-sharing cohorts. The seal identifies the 42-file measurement snapshot, including its then-current documents; later report-only revisions are outside that seal.

Both arms use the fixed Node 26.7.0 binary, the same complete TypeScript SDK 0.1.32 build, and 31 complete private installed resources reconstructed locally (14 suites plus 17 standalone resources, 90 standard custom Skill files). The normally prepared full published trees contain 1430 files / 168,758,017 bytes for A and 1456 / 168,902,897 for B; both have the same complete normal 2151-byte package manifest. The embedded API imports the actual prepared trees and launches their CLI directly; it does not execute an installed npm/standalone bin wrapper. Default package-size/security gates pass, but complete npm installation and native-feature behavior are not qualified. Every row starts fresh daemon/ACP processes, HOME, workspace, runtime and temp state, and an absent per-row Node compile-cache directory. Parent flags are the original empty list; the actual child retains its original heap-8192/expose-GC flags. There is no parent-GC alignment, startup/request flush, resolver hook, installed AOT, preheat, runtime substitution or first-tool deferral.

The fixed order is AB/BA/AB/BA/AB/BA/AB/BA. Each row retains the full first SDK create-or-attach call, its capabilities GET and session POST, plus two further new UUID sessions. SDK-driver import and offline resource seeding/verification are outside both measured clocks. Daemon spawn through first SDK completion includes ordinary product startup and the original daemon-ready boundary; product runtime-ready and harness-ready clocks remain separate. The fixed resource-only profile retains Hook definition files, sets disableAllHooks=false and mcp.allowed=[]; it does not prove each definition was loaded or executed. No model prompt or business tool is executed. OS filesystem and binary caches are not reset.

| Clock (ms)                                    |   A mean | A median |   B mean | B median |
| --------------------------------------------- | -------: | -------: | -------: | -------: |
| First full SDK call                           |  833.257 |  815.994 |  719.861 |  706.277 |
| Daemon spawn → first SDK complete             | 1517.299 | 1456.511 | 1384.047 | 1385.197 |
| Daemon spawn → observed product runtime-ready |  683.846 |  648.895 |  663.946 |  661.839 |
| Daemon spawn → harness-ready                  |  683.878 |  648.928 |  663.978 |  661.870 |
| Startup flush                                 |    0.000 |    0.000 |    0.000 |    0.000 |
| Second full SDK call                          |   69.207 |   67.994 |   69.141 |   66.086 |
| Third full SDK call                           |   61.539 |   58.465 |   59.267 |   54.303 |

A first-SDK range is 781.783–928.814 ms; B is 687.656–819.895 ms. Neither arm has any first-SDK sample below 500 ms (0/8 each). Same-pair B−A first-SDK delta: mean -113.396 ms, median -98.120 ms. Same-pair total delta: mean -133.252 ms, median -104.220 ms. Pair 7's B is slower for both SDK and total and remains in the statistics. These eight local pairs do not establish tail latency, an SLA, or a stable sub-500-ms result.

| Pair | Position | Arm | Full first SDK (ms) | Spawn → SDK complete (ms) |
| ---- | -------- | --- | ------------------: | ------------------------: |
| 1    | 1        | A   |          894.458984 |               1626.931641 |
| 1    | 2        | B   |          712.582764 |               1397.311279 |
| 2    | 1        | B   |          696.478760 |               1320.496338 |
| 2    | 2        | A   |          802.532471 |               1443.487305 |
| 3    | 1        | A   |          796.724365 |               1433.256592 |
| 3    | 2        | B   |          699.971191 |               1357.909180 |
| 4    | 1        | B   |          715.573242 |               1376.442871 |
| 4    | 2        | A   |          812.840820 |               1461.891357 |
| 5    | 1        | A   |          928.813965 |               1635.111328 |
| 5    | 2        | B   |          687.656494 |               1331.387207 |
| 6    | 1        | B   |          695.946533 |               1394.960205 |
| 6    | 2        | A   |          781.783447 |               1430.887939 |
| 7    | 1        | A   |          819.147949 |               1451.130615 |
| 7    | 2        | B   |          819.895264 |               1499.917969 |
| 8    | 1        | B   |          730.781982 |               1393.950928 |
| 8    | 2        | A   |          829.755371 |               1655.693848 |

| Pair   | B-A first SDK (ms) | B-A total (ms) |
| ------ | -----------------: | -------------: |
| 1      |        -181.876221 |    -229.620361 |
| 2      |        -106.053711 |    -122.990967 |
| 3      |         -96.753174 |     -75.347412 |
| 4      |         -97.267578 |     -85.448486 |
| 5      |        -241.157471 |    -303.724121 |
| 6      |         -85.836914 |     -35.927734 |
| 7      |           0.747314 |      48.787354 |
| 8      |         -98.973389 |    -261.742920 |
| Mean   |        -113.396393 |    -133.251831 |
| Median |         -98.120483 |    -104.219727 |

All 16 runtime attempts succeeded without retry: 48 distinct newly created UUID sessions, 32 actual daemon/ACP PIDs independently confirmed gone, normal close ACK, clean 0/null exits, drained stdio, and no fallback termination. The independent audit re-read every raw result hash and timestamp, all 159 immutable input files, six full trees, 496 installed resource copies and 16 final mutable cache trees. The original SDK/launch measured block is byte-identical to the inherited harness. Native tracing is off; final namespace/file counts do not prove native cache acceptance.

Mutable settings are separate from immutable source/SDK/resource trees. For all 16 rows the audit independently reconstructed the unchanged helper/adapter initial settings bytes and matched their pre-run SHA. Post-run JSON permits only the existing migration from `usageStatisticsEnabled:false` to `privacy.usageStatisticsEnabled:false` plus `$version:4`; A and B both have exactly that result. Trusted-folder and V2 activation-state bytes are unchanged. This cohort did not timestamp settings-file writes, so it does not establish whether that migration happened before daemon-ready or within the first SDK call.

A metadata-only preparation schema mismatch and two independent-audit assumptions (host Python API compatibility and settings-byte immutability) are retained with their original scripts/logs. They caused no runtime retry or alteration of the 16 raw measurements. Preparation, resource seeding and auditing costs are recorded outside the SDK/launch clocks; no installed compiler artifact was generated or copied. The earlier experimental AOT result is not attributed to the current default source build.

## Final-main installed AOT and resolver: separate eight-pair experiment

This cohort compares a clean normal published main build (A) with the integrated normal published source build on the same main (B), with an experimental installed-bytecode artifact and resolver enabled on both arms. Base is `6f754be6548903e545e6ff0ed43a34927fe3bfb9`; the candidate source seal is `78afd107a0f4bc1e0c4222918ca97b43dd441e0fdbe4e5553aab87cfc6d7b827`. It is separate from the source-only empty-cache experiment and every earlier YAML/runtime/cache cohort; no percentages or samples are pooled. These artifact/resolver harness changes are not delivered by the source PR.

Both arms use fixed Node 26.7.0, the same complete SDK 0.1.32 build and the same 31 actual installed inner-pre resources (14 suites plus 17 standalone resources, 90 standard custom Skill files). Parent flags retain the original application policy plus their own standard resolver import; child heap-8192/expose-GC flags remain unchanged. There is no parent-GC alignment or startup/request flush. Runtime HOME, workspace, activation, daemon, ACP and sessions are fresh, but initial code cache is explicitly installed/nonempty. No ACP process/channel/session is created before the first measured SDK call. Hook definition files remain present, disableAllHooks is false and mcp.allowed is empty; this does not prove every definition was loaded or executed. The fixed resource-only profile filters remote MCP discovery, with no prompt/model or business-tool invocation.

Generation is trace-free selection of every eligible main-build ESM output: 761 targets for each control flag profile and 787 for each candidate profile. It does not use a runtime trace to select compiler inputs. Runtime native validation instead checks each separately observed cold lifecycle subset, independently of that generation policy. Every row uses a complete independent clone of its own two-namespace union: A has 1526 files / 40,530,792 bytes; B has 1578 / 40,693,688. There is no header/namespace renaming or template sharing. This local artifact depends on exact physical source URLs, Node identity/flags, architecture and UID; runtime/path/version changes require regeneration or ordinary fallback, not a portability claim.

The 16 timing rows use AB/BA/AB/BA/AB/BA/AB/BA. The complete first SDK call includes capabilities GET and session POST; two further new UUID sessions also run. SDK-driver import and installation/copy/audit work are outside both measured clocks. Daemon-spawn→SDK-complete includes the ordinary startup, own hook setup/manifest parsing and original daemon-ready boundary. Product runtime-ready and harness-ready are separately recorded. The original measured block and timestamp positions are unchanged. OS filesystem/binary caches are not reset.

| Clock (ms)                                    |   A mean | A median |   B mean | B median |
| --------------------------------------------- | -------: | -------: | -------: | -------: |
| First complete SDK call                       |  641.547 |  642.871 |  575.740 |  559.677 |
| Daemon spawn → first SDK complete             | 1101.337 | 1092.504 | 1028.123 | 1005.987 |
| Daemon spawn → observed product runtime-ready |  459.654 |  465.911 |  452.240 |  450.001 |
| Daemon spawn → harness-ready                  |  459.685 |  465.941 |  452.273 |  450.033 |
| Startup flush                                 |    0.000 |    0.000 |    0.000 |    0.000 |
| Second complete SDK call                      |   79.094 |   74.796 |   63.621 |   62.859 |
| Third complete SDK call                       |   61.848 |   58.493 |   55.966 |   54.143 |

First-SDK ranges: A 620.018–680.419 ms, B 523.529–701.576 ms. Both have 0/8 samples below 500 ms. Same-pair B−A SDK delta: mean -65.807 ms, median -85.218 ms; total delta: mean -73.214 ms, median -85.647 ms. Pair 3 has slower candidate SDK and total results, fully retained. This is eight local pairs, not a tail-latency/SLA or default sub-500-ms result.

| Pair | Position | Arm | First full SDK (ms) | Spawn → SDK complete (ms) |
| ---- | -------- | --- | ------------------: | ------------------------: |
| 1    | 1        | A   |          625.018555 |               1095.624023 |
| 1    | 2        | B   |          537.493164 |                975.199219 |
| 2    | 1        | B   |          523.528564 |                948.666504 |
| 2    | 2        | A   |          645.444092 |               1066.078125 |
| 3    | 1        | A   |          640.297119 |               1112.829590 |
| 3    | 2        | B   |          701.576172 |               1189.983643 |
| 4    | 1        | B   |          584.845215 |               1033.202881 |
| 4    | 2        | A   |          648.923340 |               1104.636475 |
| 5    | 1        | A   |          624.158203 |               1086.879883 |
| 5    | 2        | B   |          527.649658 |                987.020264 |
| 6    | 1        | B   |          554.165771 |               1006.081787 |
| 6    | 2        | A   |          680.418945 |               1177.952881 |
| 7    | 1        | A   |          648.098633 |               1077.313477 |
| 7    | 2        | B   |          565.187988 |               1005.892334 |
| 8    | 1        | B   |          611.476074 |               1078.939453 |
| 8    | 2        | A   |          620.017822 |               1089.384766 |

Two additional native validations are excluded from timing. The independent audit reparses raw native state/read lines, verifies one exact ESM origin per declared runtime source, and joins its original artifact-relative entry to the actual per-row clone path. Every accepted source also has a successful disk read and byte/mode identity in the initial copied artifact. Namespace/count existence alone is not acceptance evidence. These are whole three-session lifecycle observations, not first-await-only attribution.

| Build/role | Generated targets | Declared runtime sources | Accepted + successful read + exact original entry | Other observed sources | Rejected |
| ---------- | ----------------: | -----------------------: | ------------------------------------------------: | ---------------------: | -------: |
| A/parent   |               761 |                      414 |                                               414 |                      8 |        0 |
| A/child    |               761 |                      397 |                                               397 |                      9 |        0 |
| B/parent   |               787 |                      420 |                                               420 |                      8 |        0 |
| B/child    |               787 |                      369 |                                               369 |                      9 |        0 |

A has 302 sources accepted in both roles and 509 in their source union; B has 273 and 516. Per-role accepted counts overlap and cannot be added as unique modules. Each parent has six uncached external CommonJS sources plus the uncached wrapper and resolver ESM; each child has six uncached CommonJS sources plus CLI, locale and resolver ESM. There are no rejections. Native validation demonstrates these two runs; the 16 timing rows have native tracing off and are not assigned inferred per-row hit counts.

Installation and isolation costs are explicit and separate from both runtime clocks:

| Build/role       | Generation targets | Producer wall diagnostic (ms) | Link-failure qualification wall (ms) |
| ---------------- | -----------------: | ----------------------------: | -----------------------------------: |
| control-parent   |                761 |                      1224.271 |                              579.166 |
| control-child    |                761 |                      1131.436 |                              591.273 |
| candidate-parent |                787 |                      1118.262 |                              578.346 |
| candidate-child  |                787 |                      1283.804 |                              641.776 |

The two producer flag profiles sum to 2355.707 ms for control and 2402.066 ms for candidate; qualification consumers sum to 1170.439 and 1220.122 ms. These are instrumented local installation diagnostics, not production installation estimates or part of first SDK latency. The exact link barrier failed before application-body evaluation; the barrier sentinel stayed absent and isolated HOME/temp stayed empty.

| Offline phase (ms)                          |           Control |         Candidate |
| ------------------------------------------- | ----------------: | ----------------: |
| Union pure copy                             |           764.811 |           770.553 |
| Union destination seal                      |           157.585 |           165.449 |
| Timing-row independent copy mean / median   | 640.769 / 547.739 | 637.868 / 551.696 |
| Timing-row seal + inode check mean / median | 197.146 / 196.435 | 204.947 / 201.825 |

Union-wide before/after source sealing took 8542.975 / 4266.359 ms and is separate from the two pure-copy rows above. Full per-row copy/seal costs, including the separate native fixtures, remain in the raw cost table; resource seeding costs are also retained. Copying is isolation setup, not a claimed production cost on every session.

All 18 runtime attempts succeeded without retry: 54 distinct new UUIDs, 36 actual daemon/ACP PIDs independently gone, normal close ACK, 0/null exits and drained stdio, with no fallback termination. Independent post-verification rehashed 217 immutable inputs, 12 full trees, 558 complete resource copies and 18 final mutable cache trees. Initial offline verification also proved 27,936 distinct device/inode pairs across all 18 cache clones and no hardlinks to templates. Mutable settings are separately verified: exact initial helper bytes match the pre-run SHA; only the existing privacy migration and `$version:4` are allowed, identically on both arms; trust and V2 activation bytes remain unchanged. Settings-write phase was not timestamped.

The initial process observer permission failure during artifact setup is retained and launched no compiler; all four actual producers/qualifiers and their independent raw proofs are preserved. One metadata-audit copied-path assertion was corrected with the original failed audit retained; no runtime was retried or data resampled. This experimental local installed-cache profile does not establish a default source improvement below 500 ms and cannot be compared with an older cohort as a regression or as a chained percentage.

## Integrated validation and observed limits

The final integrated source passes build, typecheck and bundle. Focused CLI tests pass **1,110/1,110** (937 ordinary and 173 daemon/serve checks); the final Core run passes **2,090/2,091** across 14 files. Its sole remaining extension network-policy assertion also fails when selected independently on exact clean main. Each baseline/candidate reproduction executes one failing case; the remaining 195/198 cases are skipped, not counted as passes. Initial real-HOME permission failures and an intermediate explicit-QWEN_HOME fixture mismatch are retained as validation setup attempts; source and assertions were not changed to hide them.

Independent integration E2E passes **41 out-of-band checks plus 18 two-workspace lifecycle checks per side: 118 assertions total**. This is separate from the timing cohort. All 24 created UUIDs are new, HTTP200 and unattached; four daemon and six ACP PIDs disappear after normal close ACK, exit0/null signal and no fallback termination. Full published applications, fixed SDK/seed-Core, all 42 source files and the restored resource inventories match their integrity records.

Complete helper snapshots, existing-session menus after helper and new-session menus each match in 8/8 comparisons; lifecycle snapshots match in 11/11. Ordinary workspace envelopes match in 28/32, Skill rows in 30/32 and existing-session commands in 30/32. Each side emits eight SSE events with matching phase/type sequence; seven payloads match. The remaining completion order and natural new-response identity/time differences are retained in the full comparisons, with separately labeled correspondence checks.

Two ordinary Skill catalogs still have the old user-row state at about 1.9 seconds on the candidate: a restored row is missing once and a deleted copy remains once. Both sides mark these snapshots stale/refreshing; all 105/106 common named rows retain equal fields and ownership. Both 3,000 ms ordinary reads, before any explicit helper, return equal complete arrays in original order and correct presence/absence. The unchanged warm-GET contract returns retained snapshots while background revalidation uses a 1,000 ms start throttle. Preceding observations cross its 999/1,000 ms boundary, which is consistent with the differences; this is an explanatory inference, not a causal proof or refresh-latency equivalence claim.

Functional tests use a correct token and trusted product root. They do not exhaust negative authentication/trust paths, every workspace boundary, first-tool behavior, model/business execution or unrestricted external MCP. Hook definition files remain present, disableAllHooks is false and mcp.allowed is empty; this does not prove every definition was loaded or executed. Two clean self-audit passes and an independent source review found no confirmed defect; they do not substitute for normal maintainer review of public Core/config and cross-package changes.

## Historical component and runtime cohorts

The following retained sections describe earlier artifacts and conditions. In the initial conservative-initialization experiment, the first SDK median was 799.173 to 723.808 ms and the mean 807.958 to 799.741 ms, including its 1,310.803 ms first candidate. Its source scope, tests and functional counts are historical evidence, not the final integrated scope or validation above. Subsequent GC/flush, runtime, package-layout, resolver and AOT experiments also keep their original boundaries. None of their percentages may be added or multiplied into the current same-main comparison.

PR #17177 merged on 2026-11-13 UTC with both required approvals and 32 successful checks; squash 98bb7cf9491abd0efeda6a039ab822331716eab4 is in the current base. The older 1,662 ms observation used a different preheat/readiness prelude and is not a valid no-preheat control. Private resources remain local; only their aggregate counts and timings appear here.

### Separate experiments and timing definitions

| Experiment             | Conditions                             | Independent first sessions per condition | Median first complete SDK create | Observed median reduction |
| ---------------------- | -------------------------------------- | ---------------------------------------: | -------------------------------: | ------------------------: |
| Watcher PR             | Main baseline → watcher only           |                                        8 |           1,096.099 → 772.944 ms |       323.155 ms / 29.48% |
| Conservative component | Watcher only → combined initialization |                                        8 |             799.173 → 723.808 ms |         75.365 ms / 9.43% |

These are separate cohorts. The first cohort's 772.944 ms must not be joined to this cohort's 799.173 ms control as one continuous controlled experiment. Their percentage reductions cannot be added or multiplied into a claimed combined improvement. The older **1,662 ms** observation used a different preheat/readiness-prelude procedure and is not a valid baseline for either no-preheat percentage.

The primary clock encloses the complete awaited TypeScript SDK `createOrAttachSession`: capability discovery, session POST, JSON decoding and SDK identity validation. It starts after daemon `runtimeReady`, with zero business sessions and no ACP channel; the real ACP child starts inside the measured call. Daemon readiness is not an ACP-ready wait. The first capabilities GET by itself is not a session-create measurement. Subsequent creates also perform their actual capabilities request and are reported separately.

### Candidate scope

This historical conservative candidate changes six production files. The watcher guard is already present in both conditions.

| Source                                                                        | Change and preserved boundary                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Core Config](../../packages/core/src/config/config.ts)                       | Starts the existing local ACP ripgrep health probe inside initialization, overlaps it with resource reads, and awaits the same result at the original backend decision. The promise is initialization-local. Managed execution, delegated environments, shell sandboxes and bare mode retain their existing paths. |
| [ripgrep helper](../../packages/core/src/utils/ripgrepUtils.ts)               | Adds optional cancellation for that probe. The signal-bearing process settles only after actual close; cancellation and timeout terminate the owned direct child. Ordinary no-signal callers retain their existing helper path.                                                                                    |
| [Extension manager](../../packages/core/src/extension/extensionManager.ts)    | Overlaps commands/context, Skills, agents and workflows within one Qwen extension. All reads settle before releasing an enclosing store read lock or selecting the first error in original resource order. Both complete scans and the existing cross-extension batch remain.                                      |
| [Attach command](../../packages/cli/src/commands/attach.ts)                   | Imports client constructors when attach executes. The original cancellation, exit deadline and error boundary remain; shutdown during import prevents connection.                                                                                                                                                  |
| [Export command](../../packages/cli/src/ui/commands/exportCommand.ts)         | Imports collection, normalization and formatters after selecting a valid session. Synchronous command metadata, the pure filename helper, path checks, file permissions and ACP artifacts remain.                                                                                                                  |
| [Scheduled-task source](../../packages/cli/src/runtime/scheduled-task-run.ts) | Uses the existing session-source leaf export instead of loading the full bridge barrel, with the same constant bindings.                                                                                                                                                                                           |

Resource warnings and filesystem reads from different categories can now interleave. Later categories can run even if an earlier one fails. Result ordering, discovery-error/refusal metadata, original error priority and skip-versus-throw behavior are retained. This is not an atomic filesystem snapshot, and direct load/install callers do not acquire a new lock merely because the local join exists.

The measured bundle includes no syntax minification, chunk coalescing, diagnostic source surgery, request-time cache flush, channel preheat or deferral of health checks to first tool use. The first create still waits for required resources, permissions and tool initialization. No mutable Config is shared across sessions.

### Workload, environment and integrity

The complete installed workload has **31 resources: 14 extension suites and 17 standalone Skills**, containing **90 custom Skills, 3,944 files and 81,931,741 bytes**. Every sample uses the same full inventory on a case-sensitive filesystem. Hook definition files remain present and disableAllHooks is false; an empty MCP allowlist filters external MCP discovery. This does not verify that every definition loaded or executed. No prompt, model request, business tool call or external MCP connection is made.

Native activation is seeded during untimed fixture preparation. This tests an already installed and activated resource set with a fresh process and fresh runtime/session state; it does not claim every resource-derived cache is empty. Copying, activation seeding, building and SDK module import finish before either clock starts. Each sample has a fresh HOME, runtime/session root, temporary directory and initially absent Node compile-cache root. OS file caches are not dropped.

Runtime: macOS 26.6.2 arm64, Node.js v26.7.0, CLI 0.27.2, TypeScript SDK **0.1.32**. Measurement date: 2026-11-13 UTC. These local results do not establish Node 22, Linux, Windows or live-service latency.

Eight paired rounds run serially in alternating control/candidate then candidate/control order. All fixtures are prepared before an exclusive measurement window; no build, copy, test or other benchmark under this task runs concurrently. All 16 formal attempts pass, creating 48 distinct new UUID sessions with matching identity and `attached: false`. No formal attempt or slow timing is excluded.

Every row proves preheat `not_scheduled`, zero sessions/no ACP channel before create, ACP spawn after SDK start and first HTTP, normal close acknowledgement, exit code zero with no signal or forced fallback, and absence of recorded ACP PIDs after teardown. Complete source/build/SDK/activation-seed/harness seals match before and after the cohort.

The historical candidate is a sealed local patch on source HEAD `2aadc4b127ec24074e0e5ddfd402e978a0c43f5d`, not a claimed published release. Its source-proof SHA-256 is `1dac0c9cf083b2fa214a7112dd25b141fd7a0df4f6c9e2cb3a68103a268becb7`; tracked-diff SHA-256 is `6e460d4116033da83f4d41ecbe4e879befc0ee4c840396f3237b85b621b8dfba`.

| Frozen tree                 | Files | SHA-256                                                            |
| --------------------------- | ----: | ------------------------------------------------------------------ |
| Watcher-only control        | 1,412 | `6d3f050064aaa18fad7db4fe3438b9fe118af6645df03f71579e50e5564ed58c` |
| Combined candidate          | 1,418 | `e45c7e1ae8b4e102d559af3aaa8565af94e7c9c19cb115386880295f222a8876` |
| Compiled SDK                |    85 | `ec2900fb95d22b54c491de5633f462cd05e4a2f9dbb9bb4fefa868f6ad812f70` |
| Shared activation-seed Core | 6,415 | `17db74c21de306e775b62fa981347d7c3a0614d5ea9efcc23bb579e6651ad742` |

### All formal first-create observations

All values are milliseconds. Each row is one independent fresh daemon per condition.

| Paired round | Watcher only | Combined candidate |
| ------------ | -----------: | -----------------: |
| 1            |      840.695 |          1,310.803 |
| 2            |      797.918 |            717.610 |
| 3            |      800.428 |            745.532 |
| 4            |      822.208 |            719.563 |
| 5            |      792.411 |            715.387 |
| 6            |      794.082 |            726.802 |
| 7            |      822.191 |            720.814 |
| 8            |      793.728 |            741.419 |
| Mean         |      807.958 |            799.741 |
| Median       |      799.173 |            723.808 |
| Minimum      |      792.411 |            715.387 |
| Maximum      |      840.695 |          1,310.803 |

The observed median reduction is 9.43%; the mean reduction is only **8.217 ms / 1.02%**. The candidate is faster in seven pairs and slower in the first. The 1,310.803 ms row remains in every aggregate; current evidence does not establish its cause. A diagnostic binary's slow health probe from another run is not proof of this row's cause. Every candidate first create exceeds 500 ms. The median remains 223.808 ms above that target, and the slow observation remains unresolved.

### Other clocks

Median (minimum–maximum), milliseconds; eight observations per condition. The second and third creates are subsequent sessions within each daemon, not independent first-session samples.

| Clock                                      |                    Watcher only |              Combined candidate |
| ------------------------------------------ | ------------------------------: | ------------------------------: |
| First complete SDK create                  |       799.173 (792.411–840.695) |     723.808 (715.387–1,310.803) |
| First session POST + JSON                  |       779.171 (773.457–820.852) |     705.205 (696.991–1,291.760) |
| Daemon spawn → observed listener           |       333.427 (326.280–416.058) |       328.861 (322.504–337.589) |
| Daemon spawn → pre-client request boundary |       626.911 (621.268–707.005) |       617.526 (608.825–632.222) |
| Daemon spawn → first SDK result            | 1,427.536 (1,415.253–1,529.310) | 1,349.374 (1,333.181–1,919.715) |
| First capabilities GET + JSON              |          18.468 (18.240–21.422) |          18.350 (17.948–20.941) |
| First HTTP → ACP spawn                     |          14.416 (14.277–16.720) |          14.323 (13.624–16.250) |
| Second complete SDK create                 |          68.096 (63.842–75.962) |          67.522 (63.451–76.325) |
| Third complete SDK create                  |          56.642 (53.897–59.666) |          55.227 (53.691–95.253) |

### What the bundle measurement establishes

The SDK/scheduled import cuts reduce the rebuilt static cold output closure from **15,580,414 to 14,597,940 bytes**, a reduction of **982,474 bytes**. Static outputs change from 324 to 322; SDK inputs from 34 to 17; bridge inputs from 59 to 27. This is emitted-output graph evidence, not the number of files loaded at runtime or a per-file latency attribution. It does not establish that those bytes alone cause the 75.365 ms median change. The formal candidate combines import cuts, probe overlap and resource concurrency; this experiment does not isolate each contribution.

A separate instrumented observation also shows why optimizing only business-session creation is insufficient: bootstrap resource/tool phase span is 410.25 ms, including 214.10 ms of residual health waiting; the first actual Session Config phase span is 51.56 ms. The instrumented complete create is 986.984 ms. Those spans are partial, diagnostic and not a decomposition of the formal cohort's median.

### Functional verification and limits

Full build, sequential typecheck and bundle pass. Focused Core tests pass **1,103/1,103** across three files; focused CLI tests pass **204/204** across four files. The ExtensionManager file passes **198/199**. Its sole failure is an existing update-network-policy test expecting the Git environment mock to run; the same exact test fails at the same assertion on the clean watcher baseline. That failure is retained and has not been presented as a green suite or repaired through unrelated source changes. The three new resource-concurrency cases fail against the old serial source and pass with the change. Changed-file lint and formatting pass for the implementation.

A separate combined-candidate functional comparison, run after the timing window, passes **41/41 external-change assertions and 18/18 two-workspace lifecycle assertions in each condition**. Helper snapshots, existing-session menus after helper and genuinely new-session menus each match in 8/8 comparisons; lifecycle snapshots match in 11/11.

Ordinary reads are not identical: whole workspace-Skill envelopes match in 30/32 observations, Skill rows in 32/32, and existing-session commands in 29/32. Immediate edit/replace/create propagation and cache flags differ at some observation points, then converge. Both sides retain old extension-Skill descriptions through the three-second ordinary observation window and become correct after the normal helper. Original array order and cache flags remain in comparisons.

Each side emits eight public SSE events with matching phase/type sequence; the first seven payloads match after fixture/UUID correspondence. The last reload refreshes the same nine sessions in a different completion order. New-session responses retain natural identity/time differences, with all other fields matching when those fields are separately accounted for. Four functional daemon groups close normally, with six recorded ACP PIDs absent and a final scoped process observation finding no matching process.

Functional runs include helper/health operations before some session checks, so their timings are not cold-first-create measurements. Validation does not cover model execution, actual business tools, prompt-triggered hook execution, external MCP behavior, terminal UI end-to-end behavior or production deployment. Independent source audit found no new confirmed correctness defect; it does not replace maintainer approval of the Core changes.

### Other evaluated approaches

#### Sharing the daemon compile cache

Request-time compile-cache flushing did not show a stable benefit and could add hundreds of milliseconds. A separate six-run diagnostic moved the explicit flush after product `runtimeReady` and before the harness announced readiness, without loading ACP or creating a session. It records the moved startup cost rather than hiding it outside the SDK clock.

| Diagnostic pair | Control: first SDK / total | Flush: first SDK / total |
| --------------- | -------------------------: | -----------------------: |
| 1               |        791.329 / 1,436.874 |      775.578 / 1,440.565 |
| 2               |        711.861 / 1,379.793 |    1,034.069 / 1,681.682 |
| 3               |        738.174 / 1,357.958 |      716.516 / 1,402.732 |

Total means daemon spawn through first complete SDK result. It increases in all three pairs. Median total changes from **1,379.793 to 1,440.565 ms**; median first SDK create changes from 738.174 to 775.578 ms. Median flush cost is 43.951 ms. The second-pair fluctuation is retained. Six fresh state/cache roots, no preheat and normal cleanup pass; no cache-hit tracing proves that the child consumed the persisted cache. This diagnostic does not justify adopting the flush.

##### Correcting the parent/child cache namespace

A later inspection establishes that the preceding diagnostic used different V8 cache tags: the parent started without `--expose-gc`, while the production ACP launcher supplied that flag to its child. The [Node v26.7.0 implementation](https://github.com/nodejs/node/blob/v26.7.0/src/compile_cache.cc) includes the V8 cached-data version tag in the cache namespace. On this runtime, the GC flag changes that tag; the child heap limit alone does not. An isolated native trace confirms a lookup miss with mismatched flags and an accepted cache entry with matching flags. This explains why the preceding configuration did not test successful shared-cache consumption; its negative timings remain valid for that configuration.

A new three-arm diagnostic retains the same frozen combined bundle, complete resources and SDK. A uses the original parent arguments without flushing; B starts the parent with standard `--expose-gc` without flushing; C uses the same parent flag and flushes already-required daemon modules after product `runtimeReady`, before harness readiness. No additional modules are imported to prime ACP, and no channel or session is preloaded. The order rotates A/B/C, B/C/A, C/A/B, with fresh runtime and cache roots for every row.

All observations are milliseconds; total includes daemon startup and flush through the complete first SDK result.

| Round  | A first SDK | B first SDK | C first SDK |   A total |   B total |   C total |
| ------ | ----------: | ----------: | ----------: | --------: | --------: | --------: |
| 1      |     762.770 |     726.204 |     604.972 | 1,414.216 | 1,368.431 | 1,311.656 |
| 2      |     717.387 |     786.980 |     628.174 | 1,336.207 | 1,413.369 | 1,310.426 |
| 3      |     730.443 |     705.669 |     585.951 | 1,344.692 | 1,342.361 | 1,269.458 |
| Median |     730.443 |     726.204 |     604.972 | 1,344.692 | 1,368.431 | 1,310.426 |
| Mean   |     736.866 |     739.618 |     606.366 | 1,365.038 | 1,374.720 | 1,297.180 |

C's flush costs 52.226, 42.348 and 42.064 ms, all included in total. Relative to A, C reduces the first-SDK median by **125.471 ms / 17.18%**, but the total median by only **34.266 ms / 2.55%**. Every paired total improves, by 102.560, 25.782 and 75.234 ms. B alone establishes no stable benefit. C's complete first creates remain **585.951–628.174 ms**, above 500 ms; three samples per arm do not establish a tail-latency guarantee. These statistics must not be combined with either eight-pair cohort.

A separate tenth fresh C trace, excluded from timing, records **304 actual child cache acceptances, zero rejections and 97 uninitialized/missing entries**. All 304 accepted entries have successful disk reads and matching parent/child module type, source path and canonical file identity; 298 are bundle modules and six are external dependencies. This is positive native acceptance evidence, not an inference from cache-directory names. All nine timing rows and the trace pass resource seals, new-session identity, no-preheat, normal close and PID-disappearance checks.

This remains an experimental launch configuration, not the default CLI or embedded API implementation. Product `runtimeReady` resolves before the experiment's flush; shipping this unchanged would expose requests during that extra work. A product change must publish readiness only after any required flush, account for that startup cost, and qualify the supported Node versions and entry points. The parent flag also appears twice in the child's inherited arguments instead of once; effective GC exposure and heap limit match, but the argument arrays are not byte-identical. No production launcher or readiness behavior is changed in this evaluation.

#### JavaScript minification and chunk coalescing

An isolated minification diagnostic keeps function/class names and changes syntax/identifiers in copied bundles. All four SDK observations remain:

| Execution order | First complete SDK create | Residual health wait |
| --------------- | ------------------------: | -------------------: |
| Control A       |                   840.756 |                0.000 |
| Minified A      |                 1,350.249 |              523.040 |
| Minified B      |                   777.447 |                0.000 |
| Control B       |                   882.728 |                0.000 |

Import spans improve in some observations, but these four runs do not establish stable whole-create benefit. The slow candidate is retained. Minification is absent from the formal candidate.

A child-only chunk-coalescing prototype reports a 2.75 ms named import span while moving 308.98 ms before profiler readiness. Its complete session request remains about 920 ms. The small named span is not a removed 300 ms cost. The prototype's module-ordering and export semantics were not qualified for shipping; it is excluded from the candidate.

#### Extension installation dependencies

Making only the manager's installation-related imports lazy removes **zero** inputs/bytes in the audited static graph, because other cold readers retain them. An intentionally unrealistic omission of the complete installation modules bounds attributed output at 130,891 bytes; a real independent ZIP edge accounts for 41,881 bytes. These are graph analyses, not measured latency gains, and do not support a broad installation refactor as the main path to 500 ms.

#### Command payloads: a separate follow-up

Formal daemon logs observe private command-update frames of 1,436,559 bytes for control and 1,436,831 bytes for candidate. A read-only reconstruction, not a raw private wire capture, identifies a 1,432,623-byte notification. Removing Skill bodies from that reconstructed frame removes 1,284,987 bytes, **89.7%**. The reconstruction differs from the observed control size by 3,936 bytes; that difference remains unexplained.

The first large-frame log observation is **21.084–24.574 ms after the complete SDK create returns** in all 16 formal rows, including +23.442 ms for the slow candidate. This is a log observation point, not a measurement of the whole construction/serialization interval. The data therefore do not justify counting the potential body reduction as first-SDK savings or blaming it for the slow row. It remains a menu, IPC/serialization and latest-snapshot-memory lead. JSON bytes are not measured heap usage.

Internal menu consumers do not explicitly read the wire bodies; public SSE already strips details. External raw ACP clients cannot be exhaustively inventoried, so removing the existing field globally would require an explicit compatibility decision. No payload production change is included here.

#### Bun runtime comparison: local Legacy diagnostics

A separate three-pair diagnostic compares Node v26.7.0 with the installed **Bun 1.3.10**. The Node SDK and runner stay fixed; only the daemon and ACP interpreters change. Both conditions use the same frozen combined bundle and complete installed workload, fresh runtime/session state and initially absent Node cache roots. Bun's transpiler cache is explicitly disabled with `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`; there is no cache flush or ACP preload.

All six observations are retained, in their actual control/candidate alternating order:

| Order       | Runtime | First complete SDK create | Daemon spawn → ready | Daemon spawn → first SDK result |
| ----------- | ------- | ------------------------: | -------------------: | ------------------------------: |
| Pair 1 A    | Node    |                   752.281 |              669.902 |                       1,422.463 |
| Pair 1 B    | Bun     |                   995.649 |              754.678 |                       1,750.540 |
| Pair 2 B    | Bun     |                   998.701 |              725.841 |                       1,724.760 |
| Pair 2 A    | Node    |                   717.544 |              630.052 |                       1,347.765 |
| Pair 3 A    | Node    |                   798.380 |              640.666 |                       1,439.215 |
| Pair 3 B    | Bun     |                   992.581 |              770.758 |                       1,763.564 |
| Node median | Node    |                   752.281 |              640.666 |                       1,422.463 |
| Bun median  | Bun     |                   995.649 |              754.678 |                       1,750.540 |

Bun is slower in all three pairs, and no first create is below 500 ms. All six runs pass no-preheat, fresh-session identity, normal close, unchanged source/build/SDK/runtime hashes and recorded-PID disappearance checks. This does not support runtime replacement for the tested configuration. It is not a general conclusion about other Bun releases.

These are local Legacy ACP diagnostics, not the repository's Bun 1.4.4 qualification pin, a Node optimization, a Managed/Sandbox qualification, or a deployed preproduction measurement. The local Managed runtime path rejects Bun. Runtime identity is established from the actual interpreter, not Bun's Node-compatibility version field. Three successful session-creation calls per row do not independently establish full resource/menu/permission/model/tool equivalence. The diagnostic remains separate from both formal Node cohorts above.

#### Supported Node binaries: separate qualification

A new 16-row diagnostic uses four actual binaries: the original Homebrew Node 26.7.0, official Node 24.19.0 matching the repository standalone pin, official Node 22.23.4 matching a local downstream Dockerfile, and an existing Node 26.12.1 installation recommended by the CLI warning. The Dockerfile is source evidence, not a verified deployed version. Downloaded archives were verified against official checksums; no system runtime was replaced. SDK 0.1.32 runs in the fixed Node 26.7.0 driver. Production JS, resources and child memory/GC policy stay fixed; each parent has standard startup GC and the startup flush. Binary provenance/builds vary, so this is not an isolated causal comparison of V8 versions.

The order is 26.7/24.19/22.23/26.12, then rotates left for each of four rounds. All values are milliseconds; each version has four independent first sessions.

| Order | Node    | First complete SDK | Spawn → first SDK result |
| ----- | ------- | -----------------: | -----------------------: |
| 1     | 26.7.0  |            763.202 |                1,550.657 |
| 2     | 24.19.0 |            931.882 |                2,020.060 |
| 3     | 22.23.4 |          1,030.843 |                1,989.538 |
| 4     | 26.12.1 |            983.793 |                2,036.229 |
| 5     | 24.19.0 |            904.906 |                1,949.503 |
| 6     | 22.23.4 |          1,048.382 |                2,112.100 |
| 7     | 26.12.1 |            935.887 |                1,951.784 |
| 8     | 26.7.0  |            595.081 |                1,279.039 |
| 9     | 22.23.4 |          1,122.181 |                2,097.672 |
| 10    | 26.12.1 |            957.962 |                1,972.605 |
| 11    | 26.7.0  |            593.231 |                1,281.457 |
| 12    | 24.19.0 |            935.708 |                2,161.139 |
| 13    | 26.12.1 |            987.268 |                2,144.387 |
| 14    | 26.7.0  |            599.505 |                1,295.674 |
| 15    | 24.19.0 |          1,055.560 |                2,101.940 |
| 16    | 22.23.4 |          1,096.888 |                2,521.125 |

| Node    |     SDK median / mean | Total median | Flush median |
| ------- | --------------------: | -----------: | -----------: |
| 26.7.0  |     597.293 / 637.755 |    1,288.566 |       43.945 |
| 24.19.0 |     933.795 / 957.014 |    2,061.000 |       67.350 |
| 22.23.4 | 1,072.635 / 1,074.573 |    2,104.886 |       70.452 |
| 26.12.1 |     970.878 / 966.228 |    2,004.417 |       72.776 |

All 16 timing rows pass with 48 distinct new UUIDs, normal close and unchanged seals. The first 26.7 observation, 763.202 ms, and the 26.12 flush outlier, 175.839 ms, remain included. No first SDK is below 500 ms; the minimum is 593.231 ms. These tested alternatives do not support a runtime replacement for this workload. Host/binary differences and unisolated variation must not be assigned to one engine feature.

Node 22 has an additional limitation: its production child heap flag changes the cache tag, unlike the other three tested binaries. Parent startup GC alone therefore leaves two namespaces. A separate fresh Node 22 trace, excluded from timing, has zero accepted/rejected entries and 401 lookup errors; a broad original-log rescan confirms this is not a parser missing older log wording. A direct tag-only experiment reproduces the heap-flag difference without starting a daemon. Node 22's result must not be described as a successfully aligned-cache or pure-engine comparison. The other three arms' single namespaces alone do not prove hits in this cohort; the earlier independent Node 26.7 positive native trace remains separate.

The first attempted runtime cohort is retained but excluded as a whole: its Node 26.7 SDK result was 706.342 ms; Node 24.19 completed three creates at a 918.134 ms first SDK, then failed a driver-only post-clock assertion still hardcoded to Node 26's tag and executable. Both processes closed normally. The two original raw records and eight unused fixtures remain. The new cohort fixes those two validation oracles and uses all fresh state; the parent script is byte-identical. A download setup check also initially compared an xz archive with the repository's gzip checksum and stopped before execution. The xz archive then matched its own official checksum; the official gzip entry matched the repository pin. These are disclosed harness/setup issues, not product failures or discarded slow formal samples.

#### Standard package layout: a separate measurement correction

The earlier frozen bundles have no root package.json and inherit the 19,243-byte development manifest. A separate copy now runs the existing default npm package-preparation API, including its normal asset, size and security gates. The generated root manifest is 2,151 bytes with all 12 release fields, complete config and 20 native/runtime pins. Preparation adds exactly seven files: the manifest, real wrapper, README/LICENSE and three missing platform libraries. All original 1,418 files retain their bytes and permissions. This is the existing publication format, not a new code optimization or a hand-written minimal manifest. A chunks-level marker was rejected because it would truncate real package/config lookups. Node's package reader caches fields; the old manifest size does not mean its full JSON was reparsed for every module.

A new nine-row diagnostic uses A = raw copy plus parent GC/flush; B = complete prepared tree plus the same GC/flush; C = B's exact tree with original parent flags and no flush. All use the same Node 26.7 binary, SDK, full resources and fresh state, in A/B/C, B/C/A, C/A/B order. Preparation finishes outside the clocks. The embedded API imports each actual tree; the added bin wrapper is present but not executed in this cohort. Prepared artifacts and dependency links do not establish a complete installed-npm/native-feature qualification; the normal missing audio-prebuild warning is retained.

| Order | Arm | First complete SDK | Spawn → first SDK result |
| ----- | --- | -----------------: | -----------------------: |
| 1     | A   |            944.437 |                1,756.878 |
| 2     | B   |            733.454 |                1,439.948 |
| 3     | C   |            828.557 |                1,413.339 |
| 4     | B   |            572.340 |                1,241.857 |
| 5     | C   |            698.326 |                1,284.475 |
| 6     | A   |            602.042 |                1,272.148 |
| 7     | C   |            699.758 |                1,315.737 |
| 8     | A   |            580.842 |                1,236.168 |
| 9     | B   |            604.623 |                1,269.591 |

A/B SDK medians are **602.042 / 604.623 ms**, with means 709.107 / 636.805 ms; this does not establish an extra layout median benefit. B/C medians are **604.623 / 699.758 ms** and total medians **1,269.591 / 1,315.737 ms**. B's flush median is 42.324 ms, included in total. B/C changes both parent GC and flush, so it is not a flush-only result. First A 944.437, B 733.454 and C 828.557 ms remain; zero of nine creates is below 500 ms, with a minimum of 572.340 ms. These results must not be combined with prior cohorts or presented as additional source-code savings.

All nine timing rows and a separate fresh B trace pass complete SDK/state/session/close/seal gates, yielding 30 distinct new UUIDs. The excluded trace proves 304 actual cache acceptances and successful reads with matching parent/child literal and canonical paths, zero rejections and 97 lookup errors; 298 accepted modules are in the prepared tree and six are external dependencies. Its inherited trace-only label was stale; sealed plan, actual paths and GC/flush flags identify B, and the raw record is preserved. The experiment still flushes after product runtimeReady and before harness-ready; it does not demonstrate a shipped readiness change. No deployment, model call, business-tool execution or external MCP connection is performed.

#### Resolve-only loading: an isolated published-tree prototype

A separate six-row diagnostic compares the same complete prepared tree with and without a standard Node synchronous resolve-only hook. Both arms use Node 26.7.0, SDK 0.1.32, parent startup GC, initially empty independent code-cache roots and the same startup flush. B adds only the experimental `--import` in both the daemon and actual ACP child. Application JS, package metadata, resource/auth/hook/tool/backend readiness, module bodies and dynamic-import boundaries remain unchanged. No load hook or application preload is used.

The manifest admits exactly 756 canonical generated ESM URLs / 105,897 bytes of table data, covering 47,268,541 existing generated source bytes. Every admitted output has matching original/published bytes, permissions and main-metafile size, without a symlink component. The normal 20-byte post-metafile CLI shebang excludes the CLI entry as a shortcut target. Unknown URLs, require, import attributes and unproven parents use normal resolution; query/hash/encoding are retained. Setup reads only the small table and Node builtins. Parent setup is included in launch total and child setup in SDK/total, including builtin imports that precede the narrower setup counter.

All values are milliseconds. The order is AB / BA / AB; all six timing rows remain included.

| Order | Round / arm | Complete first SDK | Spawn → first SDK result | Included startup flush |
| ----- | ----------- | -----------------: | -----------------------: | ---------------------: |
| 1     | 1 / A       |            644.210 |                1,407.924 |                 51.393 |
| 2     | 1 / B       |            554.506 |                1,157.388 |                 46.228 |
| 3     | 2 / B       |            540.176 |                1,201.411 |                 84.886 |
| 4     | 2 / A       |            663.523 |                1,382.610 |                 53.002 |
| 5     | 3 / A       |            625.746 |                1,373.857 |                 96.231 |
| 6     | 3 / B       |            548.625 |                1,250.773 |                 85.289 |

| Clock                             |       A median / mean |       B median / mean |
| --------------------------------- | --------------------: | --------------------: |
| Complete first SDK                |     644.210 / 644.493 |     548.625 / 547.769 |
| Spawn → first SDK result          | 1,382.610 / 1,388.130 | 1,201.411 / 1,203.191 |
| Startup flush                     |       53.002 / 66.875 |       84.886 / 72.134 |
| Spawn → product-ready observation |     665.793 / 676.459 |     576.042 / 582.996 |
| Spawn → harness-ready publication |     747.833 / 743.413 |     661.010 / 655.209 |

Within this cohort, first-SDK median changes by 95.586 ms / 14.84% and total median by 181.199 ms / 13.11%. Every paired SDK and total improves, but the larger B flushes remain charged to total. **No first SDK is below 500 ms**; B spans 540.176–554.506 ms. These three-pair statistics are separate from all earlier cohorts and cannot be compounded into a source-code speedup. Table/fixture preparation was untimed, without a complete installer-cost observation; no installation-time application compilation was used in this comparison.

A seventh independent B native trace is excluded from timing. It proves **305 accepted child entries: 298 manifest-listed ESM, six external CommonJS and the hook ESM**, zero rejected and 97 missing/uninitialized entries; parent accepted count is zero. Each accepted entry has an actual successful read from the same runtime cache, with matching parent source/type and canonical identity. Trace-only first SDK / total / flush are 600.365 / 1,329.842 / 66.365 ms. The native evidence is not inferred from a directory count. All seven rows pass complete SDK request ordering, 21 distinct new UUIDs, no-preheat/no-precreated-channel, normal close/zero exit/null signal, actual ACP disappearance and full binary/source/SDK/resource/harness seals.

Every B parent records 7,827 shortcut calls / 407 distinct hit URLs and every ACP child 6,349 / 393, with 838 / 839 fallbacks. These are resolver invocation/URL counters, not module evaluation counts. Worker isolates do not register the hook, but inherited preload costs are not proven absent. Deleting/replacing/changing permissions on a known file can alter failure codes, and argv guards cannot detect arbitrary programmatic foreign hooks. This manually selected immutable-artifact/controlled-loader harness is not a shipped default, a generic equivalent resolver, a complete npm/native-feature qualification or a deployed-service result. Productization needs its own opt-in, immutable-install, loader/worker/error-compatibility and readiness decisions.

#### Installed AOT cache: a separate same-hook comparison

A new six-row cohort keeps the same complete published tree, Node 26.7.0, SDK 0.1.32, original resolver hook **enabled in both arms**, parent GC and startup flush. Only initial standard Node code-cache state changes: A starts with an absent cache directory; B receives a complete independent installed AOT cache clone during offline preparation. B is explicitly labeled installed-cache, not empty/fresh code cache. Every row still has fresh processes, resources, HOME/runtime/session state, zero pre-SDK sessions/channel and no preheat. Required application body evaluation, resource/auth/hook/tool/backend initialization still runs normally.

| Order | Round / arm | Complete first SDK | Spawn → first SDK result | Included startup flush |
| ----- | ----------- | -----------------: | -----------------------: | ---------------------: |
| 1     | 1 / A       |            592.986 |                1,291.230 |                 47.526 |
| 2     | 1 / B       |            531.417 |                  972.303 |                 15.577 |
| 3     | 2 / B       |            523.926 |                  993.598 |                 21.999 |
| 4     | 2 / A       |            559.607 |                1,182.874 |                 58.100 |
| 5     | 3 / A       |            551.028 |                1,169.166 |                 59.566 |
| 6     | 3 / B       |            577.217 |                1,021.820 |                 12.135 |

| Clock                             |       A median / mean |   B median / mean |
| --------------------------------- | --------------------: | ----------------: |
| Complete first SDK                |     559.607 / 567.873 | 531.417 / 544.186 |
| Spawn → first SDK result          | 1,182.874 / 1,214.423 | 993.598 / 995.907 |
| Startup flush                     |       58.100 / 55.064 |   15.577 / 16.570 |
| Spawn → product-ready observation |     564.893 / 591.210 | 432.251 / 434.906 |
| Spawn → harness-ready publication |     623.064 / 646.347 | 444.429 / 451.524 |

First-SDK median changes by 28.190 ms / 5.04% and total median by 189.275 ms / 16.0% in this cohort. Paired B−A first-SDK differences are −61.569, −35.681 and **+26.189 ms**; the slower third candidate remains included. Paired totals change by −318.927, −189.275 and −147.346 ms. **No first SDK reaches 500 ms**; B spans 523.926–577.217 ms. Three pairs do not establish a tail bound or statistical significance. Neither these values nor their percentages may be joined to the resolver cohort's 548.625 ms result or any previous source/runtime cohort.

The installed artifact contains **395 standard Node cache files / 8,021,868 bytes**: 393 real ESM targets and two installation helpers. Targets were observed across the original entire three-session ACP lifecycle, not proven exclusive to the first SDK await. A standard exact missing-export instantiate failure prevents application module body evaluation during compilation; the producer and independent consumer catch only that expected guard. The barrier sentinel stayed absent and isolated HOME/temp stayed empty. Real application bodies execute later in the real daemon/ACP. No cache header/source transformation is used.

Installation cost is explicit: the single producer Node process takes **649.609 ms wall / 375.116 ms user / 131.097 ms system**, including native debug. Original outer orchestration/hash/seal/copy duration is unknown and is not treated as zero. Per-timing-B offline copies take 85.265, 54.118 and 51.007 ms; first clone seals take 12.687, 24.604 and 16.637 ms. The independent trace copy/seal takes 49.101 / 11.345 ms; a shared initial-template seal takes 51.736 ms. Further integrity checks are untimed too, so these columns are not a complete installer duration. Compilation/copy/sealing are outside SDK and daemon-launch clocks; this comparison does not prove a complete first-install lifecycle improvement.

The seventh, excluded B native trace proves **298 parent acceptances from the installed artifact** and **400 child acceptances: all 393 declared ESM targets from that artifact plus seven parent-runtime-generated entries**. The seven are six external CommonJS files and the hook ESM, each successfully written/renamed by the parent before the child's successful read. Parent and child have zero rejected entries; their missing/uninitialized counts are 117 and two. The child's two misses are the CLI entry and English locale. Both processes really consume the artifact, so the total-clock change includes parent startup rather than only ACP request work.

The both-accepted parent/child intersection is 298 targets; observed-source intersection is 305 including the seven parent misses later accepted by the child. Do not sum 298+400 as independent modules. All 395 original artifact files remain unchanged; the parent adds 117 files and the child two, yielding 514 files / 10,577,184 bytes in that trace. Actual native read/state/write/rename lines, source identity and per-file bytes/modes establish these origins. All six timings plus trace pass 21 distinct new UUIDs, exact capabilities→session request order, normal close/zero exit/null signal, all 14 recorded processes absent, and complete original/published/SDK/resource/template/config/binary seals. A verifier-only flag-order assumption was corrected with retained stderr; no product sample was retried or excluded.

This remains an explicitly selected diagnostic, not current source's default behavior or deployment. Artifacts depend on the exact Node build, OS account, architecture, compatible flags/tag and physical source URLs; portable mode is off, and mismatches may compile normally. Node 22, Managed/Sandbox, distributed portable caches and complete model/tool behavior are not qualified. The immutable resolver and readiness-publication limits above also apply. Requiring opt-in, an installation contract and supported-runtime/readiness validation is a productization decision, not an already-delivered switch. No default 548.625 or 531.417 ms performance promise follows from these separate harness experiments.

## YAML four-arm cohort with unchanged parent policy

The complete first SDK goal remains unmet. The strongest D condition has a 521.601 ms median and 523.855 ms mean; two of four samples are below 500 ms. D total mean is 941.971 ms, slightly above C at 941.672 ms. Four pairs do not establish a tail bound, SLA or a default sub-500-ms result.

This separate cohort uses Node26.7 and SDK0.1.32, a complete 31-resource/90-custom-Skill-file inventory with original activation, `disableAllHooks=false` and `mcp.allowed=[]`. Complete resource and hook definition files are retained; this does not qualify execution of every hook or the unrestricted external-MCP workload. Parent flags remain original; the child retains its original heap/GC flags. There is no preheat, startup flush, first-tool deferral or model/business-tool call. Every row uses fresh process/runtime/session state; filesystem pages may be warm. Timed order is ABDC / BCAD / CDBA / DACB, with three real SDK creates per row. Earlier cohorts are not combined.

| Arm | Published source            | Initial Node code cache | Resolver |
| --- | --------------------------- | ----------------------- | -------- |
| A   | Earlier conservative source | empty                   | off      |
| B   | Same source + YAML cache    | empty                   | off      |
| C   | Earlier conservative source | installed dual-role AOT | own hook |
| D   | Same source + YAML cache    | installed dual-role AOT | own hook |

A/B have no hook; C/D use the same narrow mechanism with their own exact physical-URL table. C/D are installed-cache experiments, not empty-cache results or delivered product defaults. They retain standard parent policy and no flush, unlike earlier GC-alignment cohorts. B−A and D−C are independent YAML comparisons; no percentages are chained.

### All sixteen retained timing rows

All values below are ms, rounded to three decimals. Full precision for every metric is retained in timing-all16-raw.csv and numeric-summary.json. SDK includes capabilities GET and session POST; total starts at daemon spawn and ends when that SDK call completes. Flush is zero in every row.

| Round/position | Arm |    SDK1 |   SDK2 |    SDK3 |    POST | Product ready | Harness ready |    Total | Flush |
| -------------- | --- | ------: | -----: | ------: | ------: | ------------: | ------------: | -------: | ----: |
| 1/1            | A   | 770.073 | 72.599 |  70.605 | 750.137 |       631.188 |       631.221 | 1401.454 | 0.000 |
| 1/2            | B   | 727.945 | 61.239 |  66.490 | 708.666 |       692.770 |       692.802 | 1420.913 | 0.000 |
| 1/3            | D   | 571.044 | 63.952 |  69.970 | 551.123 |       435.986 |       436.017 | 1007.233 | 0.000 |
| 1/4            | C   | 558.477 | 70.029 |  60.337 | 538.605 |       429.048 |       429.078 |  987.725 | 0.000 |
| 2/1            | B   | 708.096 | 62.531 |  53.333 | 687.972 |       647.527 |       647.556 | 1355.837 | 0.000 |
| 2/2            | C   | 596.994 | 66.494 |  57.955 | 577.043 |       367.425 |       367.453 |  964.594 | 0.000 |
| 2/3            | A   | 749.823 | 67.247 |  55.850 | 729.644 |       720.191 |       720.221 | 1470.217 | 0.000 |
| 2/4            | D   | 495.357 | 59.391 |  52.305 | 475.495 |       349.863 |       349.891 |  845.427 | 0.000 |
| 3/1            | C   | 563.156 | 72.478 |  61.394 | 543.825 |       370.540 |       370.572 |  933.870 | 0.000 |
| 3/2            | D   | 481.173 | 63.877 |  49.460 | 461.577 |       344.638 |       344.668 |  826.008 | 0.000 |
| 3/3            | B   | 733.223 | 64.172 |  48.173 | 712.534 |       621.171 |       621.208 | 1354.585 | 0.000 |
| 3/4            | A   | 877.096 | 92.687 |  61.154 | 854.482 |       679.522 |       679.554 | 1556.811 | 0.000 |
| 4/1            | D   | 547.844 | 57.519 | 109.450 | 527.896 |       541.169 |       541.199 | 1089.215 | 0.000 |
| 4/2            | A   | 777.627 | 71.207 |  56.951 | 755.063 |       736.381 |       736.412 | 1514.202 | 0.000 |
| 4/3            | C   | 508.245 | 70.070 |  58.086 | 488.573 |       372.072 |       372.101 |  880.501 | 0.000 |
| 4/4            | B   | 759.494 | 71.611 |  54.894 | 737.608 |       683.762 |       683.794 | 1443.440 | 0.000 |

### Per-arm summaries

| Arm | SDK mean |  Median |     Min |     Max | <500 | Total mean |   Median |      Min |      Max |
| --- | -------: | ------: | ------: | ------: | ---: | ---------: | -------: | -------: | -------: |
| A   |  793.655 | 773.850 | 749.823 | 877.096 |  0/4 |   1485.671 | 1492.209 | 1401.454 | 1556.811 |
| B   |  732.190 | 730.584 | 708.096 | 759.494 |  0/4 |   1393.693 | 1388.375 | 1354.585 | 1443.440 |
| C   |  556.718 | 560.817 | 508.245 | 596.994 |  0/4 |    941.672 |  949.232 |  880.501 |  987.725 |
| D   |  523.855 | 521.601 | 481.173 | 571.044 |  2/4 |    941.971 |  926.330 |  826.008 | 1089.215 |

### Same-round paired differences

Negative is faster. Pairing uses the same round, not sorted or selected samples. The median of paired differences is distinct from subtracting arm medians.

| Round  |  B−A SDK |  D−C SDK | B−A total | D−C total |
| ------ | -------: | -------: | --------: | --------: |
| 1      |  -42.128 |   12.567 |    19.458 |    19.508 |
| 2      |  -41.727 | -101.637 |  -114.380 |  -119.166 |
| 3      | -143.873 |  -81.983 |  -202.226 |  -107.863 |
| 4      |  -18.132 |   39.599 |   -70.762 |   208.714 |
| Mean   |  -61.465 |  -32.864 |   -91.978 |     0.298 |
| Median |  -41.927 |  -34.708 |   -92.571 |   -44.177 |

D is slower than C in rounds 1 and 4. The retained round-4 D startup makes its total mean slightly higher; first-SDK improvement must not be presented as a uniform total-wall improvement. All sixteen slow/fast rows are retained and no runtime retry was used.

### Separate native proof and integrity

Two fresh C/D debug traces are excluded from timing statistics. Each independently proves all 407 declared parent and 393 child generated ESM targets were accepted and successfully read from their own installed original entries. Each trace records parent 407 accepted/8 uninitialized and child 393 accepted/9 uninitialized, zero rejections. Counts are role observations over three sessions, not unique modules or first-await-only work. CJS, hook, CLI and locale misses remain explicit; namespace names or cache counts alone are not acceptance evidence.

Independent post-verification rechecked all 54 distinct new UUIDs, 36 daemon/ACP PIDs gone, 18 normal close ACKs/zero exits/null signals, all SDK/HTTP clock boundaries and no-preheat evidence; 111 immutable inputs per timing row, 13 full trees, all 558 resource copies and 18 final mutable cache trees matched their seals. No model or business tool was called. One offline finalizer schema failure was retained; it occurred before cache/config writes, was corrected in a separate script and did not consume or retry a runtime sample.

### Installation cost and deployment boundary

| Artifact role                       | Producer diagnostic ms | Fresh consumer diagnostic ms |
| ----------------------------------- | ---------------------: | ---------------------------: |
| control parent                      |                548.420 |                      285.492 |
| control child (historical producer) |                649.609 |                      292.334 |
| yaml parent                         |                606.101 |                      293.407 |
| yaml child                          |                503.527 |                      299.700 |

The control child reuses its actual 395-file historical artifact with one new consumer and zero new producers, not the consumer clone with helper additions. Full Python copying plus pre/post sealing of both unions cost 1,498.145 ms; pure assembly alone is unknown. Per-row copy/seal and resource setup costs remain separately retained. These installation/debug/helper costs are outside SDK and daemon-launch clocks, not hidden or called zero. All application bodies still evaluate in the real runtime.

The AOT caches are opt-in experimental artifacts tied to this Node/runtime/architecture/user and exact physical source URLs. Parent default flags and readiness were unchanged. This cohort is not the later integrated-main build, does not qualify another deployment or a Browser MCP startup, and makes no default-production or stable-sub-500-ms claim.

## Final-build cache qualification and delivery boundary

The final build's separate empty-cache native diagnostics observe the following generated ESM targets over three sessions. These are role observations, not unique module totals or work exclusive to the first SDK await:

| Role      | Clean main targets / source bytes | Integrated targets / source bytes |
| --------- | --------------------------------: | --------------------------------: |
| Parent    |                  414 / 21,311,941 |                  420 / 20,929,382 |
| ACP child |                  397 / 18,007,595 |                  369 / 16,073,891 |

A separate trace-free qualification selects all **787** eligible generated main-build ESM outputs from the candidate's build metadata, without selecting from a private runtime trace. One fixed Node26.7/default-flag producer reaches the exact standard-loader missing-export barrier before application body evaluation. All 787 sources have independent cold lookup, write and rename evidence. The resulting 788 files / 20,342,704 bytes include one orchestration helper. Only eligible source files, pinned inputs and the Node binary were rechecked in this qualification; it did not re-audit all six complete application/SDK/seed trees.

That initial single-producer qualification had no consumer, RSS observation, real-runtime cache-consumption test or first-SDK timing result. Its Node process wall time is 1,463.593 ms and link-attempt span 894.719 ms; these are diagnostic spans, not a complete installer or a startup saving. Absence of a sentinel and empty HOME/TMP supplement the standard loader's pre-evaluation link failure; they do not independently prove every body was unexecuted. The later four-role producer/consumer qualification and separate final-main installed-cache timing are reported above; their evidence is not attributed to this initial trial.

The source PR does not implement managed installation or launcher enablement. Actual integration must generate source/runtime-bound caches only after the final installation path is established and must validate real consumption before advertising the optimized mode. Cache generation costs belong outside the session clock but must still be reported. A downstream Dockerfile pins Node22.23.4; that is checkout evidence, not a running-instance version. This local Node26.7/macOS/arm64 result does not establish that image's behavior or a deployed preproduction latency.

The existing cache experiments retain exact Node/architecture/CPU/account/flag/source-URL limits and the narrow immutable-owned resolver contract. A build-metadata inventory is a possible delivery input, not a shipped helper or generic npm/loader guarantee. No-lazy compilation remains unmeasured on the final application; mechanism evidence alone does not justify a default flag.

## Reproduction and remaining acceptance

The public synthetic generator and no-preheat SDK procedure remain documented in [PR #17177](https://github.com/QwenLM/qwen-code/pull/17177). Prepare independent fresh fixtures for each frozen condition before measuring; alternate conditions serially, retain all failed/slow observations, and enforce the complete session/close/integrity gates. Synthetic data can reproduce the method and scaling investigation, but differs from the private inventory's shapes, bytes and activation preparation and cannot reproduce its exact latency.

The current source-only comparison improves first-SDK median by **109.717 ms / 13.45%** and mean by **113.396 ms / 13.61%**. Total median improves by **71.314 ms / 4.90%** and mean by **133.252 ms / 8.78%**. Median differences are distinct from the median of same-pair differences. Neither condition reaches 500 ms, and eight local first sessions per condition do not establish a tail-latency SLA. Further improvements must preserve full readiness and report any work moved to installation, startup, menus or first tool use. Current-source, historical component and manually selected cache results must remain separate.
