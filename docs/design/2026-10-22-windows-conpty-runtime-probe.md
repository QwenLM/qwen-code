# Windows ConPTY runtime diagnostic

[English](2026-10-22-windows-conpty-runtime-probe.md) | [简体中文](2026-10-22-windows-conpty-runtime-probe.zh-CN.md)

## Status and problem

2026-10-22: author candidate, NOT_RUN on Windows. Existing migration evidence does not prove that the pinned Windows PTY addon works under Bun. This diagnostic compares Node 22.23.2 as a positive control, Bun 1.3.14 as the baseline, and Bun 1.4.3 as a candidate before deciding whether a runtime change merits further investigation. A macOS result cannot establish Windows compatibility.

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

Downloads and extraction each have 30-second limits, identity queries five seconds, worker execution 45 seconds, and each protocol phase eight seconds. The workflow has a ten-minute outer limit and no automatic retries. Each output directory must be new; an existing attempt is never overwritten.

The controller samples Windows process identity using PID plus CreationDate. It follows live captured descendants and commands containing its unique owned scratch path; a recorded worker-before receipt recovers the worker identity after a crash. Cleanup rechecks CreationDate immediately before stopping an owned PID. It never kills by image name or terminates unrelated runner processes. If identity or cleanup cannot be established, preserve the failure and classify it as inconclusive. Process snapshots cannot prove the absence of an unobserved, already reparented helper after a hard native crash; a failed case must receive independent process inspection before any retry.

Always upload `.qwen/e2e-tests/windows-pty-probe/<runtime>` including setup failure receipts, raw worker stdout/stderr, available native identity receipts, terminal output on success or ordinary assertion failure, and the final result. A hard crash may prevent the worker from flushing terminal output; preserve that absence instead of manufacturing a transcript. Downloaded executable hashes survive temporary-directory cleanup. Original failures remain separate from any later attempt.

## Validation and decisions

Independent static review comes first, followed by explicit authorization to execute the workflow on the frozen branch. The first real run must establish the Node positive control before interpreting either Bun result. Node failure points to an invalid or unsupported probe until diagnosed. A Bun-only failure is localized by the last recorded phase and native crash/output evidence; an infrastructure/download or evidence-collection failure is not a product regression.

A candidate improvement requires the same exact package and source identity across all cells, complete behavioral receipts, and clean ownership closure. A Bun 1.4.3 pass with a Bun 1.3.14 failure would justify further targeted Qwen Windows tests, not a production upgrade or reopening the Windows gate. A full application decision still requires fresh integrated build and final installed-product tests.

## Open questions

No Windows result is claimed yet. Whether Bun 1.4.3 materially fixes the observed native interaction, whether the package exposes the same loaded-addon evidence in both runtimes, and whether the full Qwen terminal lifecycle behaves identically remain to be established by real results. Any harness correction must keep the original failed attempt and the unchanged behavioral oracle.
