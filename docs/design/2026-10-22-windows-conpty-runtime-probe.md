# Windows ConPTY runtime diagnostic

[English](2026-10-22-windows-conpty-runtime-probe.md) | [简体中文](2026-10-22-windows-conpty-runtime-probe.zh-CN.md)

## Status and problem

2026-10-22: the first Windows diagnostic completed with three original failures; the bounded observer correction below is a new author candidate, NOT_RUN. Existing migration evidence does not prove that the pinned Windows PTY addon works under Bun. This diagnostic compares Node 22.23.2 as a positive control, Bun 1.3.14 as the baseline, and Bun 1.4.3 as a candidate before deciding whether a runtime change merits further investigation. A macOS result cannot establish Windows compatibility.

## Scope and unchanged behavior

Reuse the registered `verify-landlock-helper.yml` workflow with a default-false boolean `windows_pty_probe`. Only explicit manual dispatch with true selects the new Windows x64 matrix and skips its three existing jobs. Pull requests, main pushes, and default manual dispatch retain their existing jobs. The diagnostic does not change production Bun/OpenTUI versions, dependency manifests, the Windows gate, the default renderer, or any Qwen startup path. It creates no additional migration PR.

The probe is an isolated published-package test, not workspace installation acceptance. It does not test Windows ARM64, full Qwen rendering, authentication, npm/standalone distribution, or an interactive human terminal host. Those remain separate acceptance requirements even if all three cases pass.

## Runtime and package identity

The controller runs Node 22.23.2, provisioned by the existing pinned setup-node action. Each matrix cell downloads only `@lydell/node-pty` and `@lydell/node-pty-win32-x64` version `1.2.0-beta.10`. Both tarballs must match their exact SHA512 integrity in the committed lockfile; extraction is into a uniquely owned temporary directory without invoking a package manager or lifecycle scripts.

Bun archives are official `bun-windows-x64.zip` release assets, downloaded with `gh release download` using the read-only workflow token. GitHub release metadata was read using `gh api` on 2026-10-22:

| Runtime    | Release                                                                | Archive SHA256                                                     |
| ---------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Bun 1.3.14 | [bun-v1.3.14](https://github.com/oven-sh/bun/releases/tag/bun-v1.3.14) | `0a0620930b6675d7ba440e81f4e0e00d3cfbe096c4b140d3fff02205e9e18922` |
| Bun 1.4.3  | [bun-v1.4.3](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.3)   | `0bf84e808552beea67bf1202a287a35c6c825d837b287b3f8e9dd513dba35d3d` |

Record source HEAD/tree, driver and lock hashes, download URLs/digests/sizes, the actual executable path/hash/version, wrapper hash, native binary inventory, and the loaded `conpty.node` path/hash. Native inventory alone is not proof of loading. If a runtime lacks the require-cache evidence, the result is evidence incomplete, not proof of an addon defect.

## Driver and behavioral oracle

`scripts/diagnostics/windows-pty-probe.mjs` has a Node controller and a worker running under the selected runtime. The worker loads the real package and spawns a Node 22 payload through bundled ConPTY with `useConptyDll: true`, matching the Windows backend selected by the actual `ShellExecutionService` at base 7368. The inbox backend is outside this probe: production uses the bundled backend to avoid orphaned console hosts after natural exit. Keeping the payload constant isolates the PTY host runtime; it does not claim that a Bun child also works. The payload uses short nonce-bound array frames to avoid wrapping at 80 columns.

Each case requires all of these observations:

1. The actual PTY child reports stdin, stdout, and stderr as TTY, the expected PID, and an initial window of 80 columns by 24 rows.
2. A nonce sent with `terminal.write` is consumed and acknowledged by the child.
3. `terminal.resize(97, 31)` is reflected by the child's actual window-size query.
4. A quit input produces the final nonce marker and voluntary child exit 0. No forced termination is accepted as success.
5. The worker exits 0 and no observed owned PID/start identity survives. Missing native identity, timeout, cleanup intervention, crash, protocol failure, or missing raw evidence cannot pass.

The original workflow conditions and matrix contract have a focused static test in `scripts/tests/verify-landlock-helper-workflow.test.js`. It is also NOT_RUN at candidate preparation.

## Budgets, ownership, and evidence

Downloads and extraction each have 30-second limits. The single controller-self initialization query before worker spawn has an explicit 15-second limit; every later identity query remains five seconds, worker execution 45 seconds, and each protocol phase eight seconds. The workflow has a ten-minute outer limit and no automatic retries. Each output directory must be new; an existing attempt is never overwritten.

The controller samples Windows process identity using PID plus CreationDate. Each CIM query is filtered to the actual worker/captured PIDs and their direct ParentProcessId matches; newly observed children are queried recursively in the same sample. Scratch-path matching applies only within those returned rows, not to a host-wide process scan. A PID used as a CIM query filter grants no cleanup ownership: seed identities require an exact captured PID/start match or the unique owned scratch path in the command. Before starting the worker, an explicit controller-PID query warms the same CIM path; the worker queries its own PID for its initial receipt. Only that one initialization query uses 15 seconds and records its budget and actual elapsed time, including failure, without swallowing exceptions or retrying. The worker identity query and all subsequent samples keep the original five-second limit and propagate failure. A recorded worker-before receipt recovers the worker identity after a crash. Cleanup rechecks CreationDate immediately before stopping an owned PID. It never kills by image name or terminates unrelated runner processes. If identity or cleanup cannot be established, preserve the failure and classify it as inconclusive. Process snapshots cannot prove the absence of an unobserved, already reparented helper after a hard native crash; a failed case must receive independent process inspection before any retry.

Always upload `.qwen/e2e-tests/windows-pty-probe/<runtime>` including setup failure receipts, raw worker stdout/stderr, available native identity receipts, terminal output on success or ordinary assertion failure, and the final result. A hard crash may prevent the worker from flushing terminal output; preserve that absence instead of manufacturing a transcript. Downloaded executable hashes survive temporary-directory cleanup. Original failures remain separate from any later attempt.

## Validation and decisions

Independent static review comes first, followed by explicit authorization to execute the workflow on the frozen branch. The first real run must establish the Node positive control before interpreting either Bun result. Node failure points to an invalid or unsupported probe until diagnosed. A Bun-only failure is localized by the last recorded phase and native crash/output evidence; an infrastructure/download or evidence-collection failure is not a product regression.

A candidate improvement requires the same exact package and source identity across all cells, complete behavioral receipts, and clean ownership closure. A Bun 1.4.3 pass with a Bun 1.3.14 failure would justify further targeted Qwen Windows tests, not a production upgrade or reopening the Windows gate. A full application decision still requires fresh integrated build and final installed-product tests.

## Open questions

No Windows compatibility pass is claimed. Whether Bun 1.4.3 materially fixes the observed native interaction, whether the package exposes the same loaded-addon evidence in both runtimes, and whether the full Qwen terminal lifecycle behaves identically remain to be established by real results. Any harness correction must keep the original failed attempt and the unchanged behavioral oracle.

## First-run evidence and bounded observer correction

Run [39782916977](https://github.com/QwenLM/qwen-code/actions/runs/39782916977), at `91edf79e1e7c8ef561e391e1368555a0cef524aa`, selected only the three explicit diagnostic cells. All three original FAIL results and their raw artifacts remain preserved. Node22 failed in the five-second cold PowerShell/CIM process observer before establishing the native positive control. Bun1.3.14 loaded the pinned ConPTY addon and produced the correct nonce/PID/three-TTY/80x24 ready frame, then timed out waiting for input acknowledgment. Bun1.4.3 loaded the same addon and acknowledged input, but its first size frame still reported 80x24 immediately after resize. Neither Bun reached natural exit. These mixed diagnostic failures do not establish a Bun-only product defect or justify upgrading production. The independent evidence audit is `69f1a0d1ff943899c81bac350bdd16935ad2de3ffdfd5c13b8f645d43c979c14`.

The first observer correction narrowed and explicitly warmed CIM sampling without increasing query, worker or protocol budgets. It replaces the immediate first-size-frame assertion with a finite observation inside the original eight-second resize phase: request SIZE at most once per 100 ms until the same nonce/PID/three-TTY tuple reports exactly 97x31. Every received size frame and the first size frame are retained, including any initial 80x24 frame; that original observation is never relabeled as a matching first frame. A wrong nonce/PID/TTY tuple still fails immediately. The pinned native producer, initial window, input contract, voluntary exit and cleanup assertions are unchanged.

Recursive PID sampling follows only processes observed while their known ancestry is still visible. A helper that exits before sampling or reparents before its first observation can escape that coverage; a PID-only query cannot prove such a helper absent. Original Node empty capture lists therefore do not establish complete ownership closure. This limitation remains explicit even if a later run passes. The corrected Node positive control and both Bun cells require a fresh reviewed dispatch; no corrected result is claimed here.

## Initialization-only budget correction after the second run

Run [39787064396](https://github.com/QwenLM/qwen-code/actions/runs/39787064396), at `35300c37fe00adfe22c7236013b515ce14da28b8`, preserves another three FAILs. The Node22 controller-self filtered CIM warmup still exceeded five seconds before any worker was spawned. Bun1.3.14 reached ready but not input acknowledgment. Bun1.4.3 acknowledged input, then produced 79 nonce/PID/three-TTY size frames over the unchanged eight-second phase, all still 80x24; the original first frame remains recorded. Neither Bun reached voluntary exit. The independent audit is `6ea713e9a73cacfa544385b9b50c3b5f65d327d58290bf97454f0dd4fdf4d071`. These observations do not justify extending product deadlines or upgrading Bun.

The new author candidate changes only the pre-worker controller-self CIM initialization to a separate finite 15-second budget and records the configured budget and actual elapsed time on success or failure. Default and all other queries remain five seconds; worker 45 seconds, input/resize eight seconds, SIZE spacing 100 ms and zero retries remain unchanged. Failure still propagates. Both earlier five-second failures remain original evidence, and the corrected candidate remains NOT_RUN pending review and a fresh dispatch.

## Fresh native size oracle after the third run

Run [39790195471](https://github.com/QwenLM/qwen-code/actions/runs/39790195471), at `27efffaba0cf071a40f1bf1dcf1a15f73ec25410`, preserves another three FAILs. Node22 initialization took 5008.423 ms within the explicit 15000 ms budget, then established real ConPTY loading, ready and input acknowledgment. It still reported 64 cached 80x24 size frames; Bun1.4.3 acknowledged input but reported 78 such frames, while Bun1.3.14 again timed out at input. No case reached voluntary exit. The independent audit is `5ae3e4fe639208e3d9e2bd749725d4c5e3cb88c0ace37ac9df0222f8d21d23fd`. All nine earlier failures remain immutable.

The exact official Node `v22.23.2` source explains why these size frames cannot establish a native resize defect. [`lib/tty.js:164`](https://github.com/nodejs/node/blob/v22.23.2/lib/tty.js#L164) returns cached columns/rows. [`src/tty_wrap.cc:90–110`](https://github.com/nodejs/node/blob/v22.23.2/src/tty_wrap.cc#L90) requires an array, calls the native window query, fills width/height only on return code zero and returns that numeric code. On Windows, [`deps/uv/src/win/tty.c:440–455`](https://github.com/nodejs/node/blob/v22.23.2/deps/uv/src/win/tty.c#L440) invokes `GetConsoleScreenBufferInfo` for the actual TTY handle, updates the virtual window and returns its dimensions; native failure returns a translated Windows error. The internal API is acceptable only within this fixed Node22 diagnostic payload, not a new production interface.

The new NOT_RUN candidate retains every original cached frame and its nonce/PID/three-TTY checks. The same fixed payload emits a separate short `native-<kind>` frame containing nonce, PID, native return code and fresh dimensions, so the combined observation does not wrap the original 80-column terminal. Initial native ready and input frames must be exact 80x24 with return code zero. Resize requires return code zero and actual 97x31 from the native query, never a cached value or hardcoded target. Keep both `firstResizeFrame`/all cached `resizeFrames` and `firstNativeResizeFrame`/all `nativeFrames`, including failures. A cached size may remain 80x24 when native size is 97x31; both observations stay visible with their distinct meanings.

No runtime, native package/backend, production code or budgets change. Initial CIM15s, subsequent queries5s, worker45s, protocol8s, SIZE100ms and zero retries remain unchanged. Independent review and a fresh Node positive control are required before interpreting runtime differences. Nothing here establishes full Qwen Windows acceptance or approves an upgrade.
