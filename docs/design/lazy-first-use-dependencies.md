# Lazy First-Use Loading for Encoding, Terminal, and Git Dependencies

## Context

Issue #7264 tracks dependencies that are present in the ACP child process's eager static import closure even though most sessions never use them. Candidate 5 groups three packages with distinct first-use boundaries:

| Package                  | Baseline ACP closure | First use                                                         |
| ------------------------ | -------------------: | ----------------------------------------------------------------- |
| `iconv-lite`             |        551,713 bytes | Reading or writing non-UTF-8 text without a BOM                   |
| `@xterm/headless`        |        213,071 bytes | Starting a shell through the PTY path                             |
| `simple-git`             |        146,526 bytes | Performing a worktree, cleanup, or GitHub extension Git operation |
| **Direct package total** |    **911,310 bytes** |                                                                   |

The direct total is approximately 890 KiB. The complete ACP static closure also contains modules that become unreachable when these packages move off the eager path, so the measured bundle-level reduction can be larger.

## Goals

- Remove all three packages from the ACP child's static import closure.
- Preserve the current synchronous public encoding helpers.
- Load each package once, at its first real use, with no new configuration.
- Preserve shell fallback behavior, Git behavior, file encoding metadata, BOM handling, and atomic writes.
- Add a bundle guard so future imports cannot silently restore these packages to the eager closure.
- Validate the change using the same 2-vCPU, 4-GiB acceptance discipline as the other candidates in #7264.

## Non-goals

- Changing the public encoding APIs from synchronous to asynchronous.
- Replacing `iconv-lite`, `@xterm/headless`, or `simple-git`.
- Changing PTY selection, worktree semantics, encoding detection, or error policy.
- Optimizing code that runs after these dependencies have already been loaded.

## Import-Closure Findings

The baseline bundle built from `febb43bc9266cc7a3363539df87d90d752ad782c` has an ACP static closure of 13,405,027 bytes across 144 outputs. An esbuild metafile traversal attributes 551,713 bytes to `iconv-lite`, 213,071 bytes to `@xterm/headless`, and 146,526 bytes to `simple-git`.

The initial package-level lazy imports were not sufficient. The CLI contained production namespace dynamic imports of the Core package root. In an esbuild code-splitting build, requesting the entire namespace keeps every root export reachable, including the synchronous encoding compatibility export. The design therefore requires both dependency-local loaders and narrow CLI runtime entry modules that re-export only the symbols each deferred path consumes.

## Design

### Shared loader properties

Each package has a package-local loader backed by a module-scoped promise. Concurrent first users share the same import, and later users reuse the resolved module. The loaders normalize the CommonJS interop shapes emitted by Node and esbuild and expose only the runtime members their consumers need.

The loaders deliberately use `import()` rather than `createRequire()`. The production bundle is standalone and must not depend on a separately installed `node_modules` tree. Dynamic imports let esbuild emit self-contained chunks while keeping those chunks outside the ACP static closure.

### `@xterm/headless`

`ShellExecutionService.execute()` is already asynchronous. The service first obtains the PTY implementation, then loads `@xterm/headless` immediately before entering the PTY execution path. It rechecks the abort signal after the asynchronous import and passes the resolved `Terminal` constructor into the existing synchronous PTY and replay helpers.

If the terminal chunk fails to load, the error remains inside the existing PTY failure boundary and execution falls back to `child_process`, matching the current fallback policy. No package load occurs when PTY support is unavailable or the child-process path is selected.

### `simple-git`

All real Git operations in the audited consumers are asynchronous. `GitWorktreeService` keeps construction side-effect-free and resolves a per-instance `SimpleGit` promise only when its first Git method is called. Other Core consumers use the same package-local loader directly.

Startup cleanup first uses the existing lightweight repository-root discovery. It loads `simple-git` only when a real repository is present and stale worktree inspection is necessary. A failed import rejects the operation at the same asynchronous boundary where a Git initialization failure was already reported.

### `iconv-lite`

This package has the main compatibility constraint: `decodeBufferWithEncodingInfo()` and `encodeTextFileContent()` are public synchronous APIs. JavaScript dynamic import is asynchronous, so making these functions directly lazy would be an API break.

The synchronous APIs remain available through a compatibility module that statically imports `iconv-lite`. Only the Core root re-export edge is marked side-effect-free for the bundle, allowing esbuild to discard the compatibility module when a particular entry does not use those exports. Other imports of the module retain normal side-effect treatment.

Internal asynchronous file-service paths use lazy variants:

- Empty, BOM-tagged, valid UTF-8, ASCII, and UTF-8 writes complete without loading `iconv-lite`.
- A detected non-UTF-8 read loads the codec before decoding.
- A write that preserves non-UTF-8 metadata loads the codec before encoding.
- A read-side load or decode failure retains the current warning and UTF-8 replacement fallback.
- A write-side load or encode failure rejects the write instead of corrupting bytes.

The CLI's deferred Core namespace imports are replaced by narrow local runtime entry modules. This avoids retaining every Core root export while preserving the same bundled Core instance and class identity.

## Bundle Guard

The ACP fast-path guard treats `iconv-lite`, `@xterm/headless`, and `simple-git` as forbidden static packages. A static path from the ACP entry fails the check; dynamic-only paths are allowed. Tests cover both rejection and allowed dynamic boundaries.

This guard evaluates the metafile import graph rather than bundle text, so a renamed chunk or minified symbol cannot bypass it.

## Compatibility and Failure Audit

| Area                            | Preserved behavior                                             | New boundary                                                            |
| ------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Shell execution                 | PTY output handling, replay, abort, child-process fallback     | Terminal chunk is loaded after PTY selection                            |
| Worktrees and GitHub extensions | Existing `simple-git` options and error propagation            | Git module is loaded on the first asynchronous Git operation            |
| Text reads                      | BOM and UTF-8 fast paths, encoding metadata, fallback decoding | Codec is loaded only for a detected non-UTF-8 fallback                  |
| Text writes                     | BOM preservation, non-UTF-8 encoding, atomic write behavior    | Codec is loaded only when non-UTF-8 metadata requires it                |
| Public Core API                 | Synchronous encoding helper signatures and behavior            | Compatibility export can be tree-shaken from entries that do not use it |

The design does not introduce process-global mutable configuration. Loader promises are process-local and idempotent. Rejected imports remain rejected, which is appropriate because a missing or corrupt bundled chunk cannot recover during the same process lifetime.

## Alternatives Considered

### Convert the synchronous encoding APIs to promises

Rejected because it breaks public callers and widens an otherwise internal startup optimization.

### Use `createRequire()` at first use

Rejected because it would make the bundled CLI depend on a runtime `node_modules` installation and would not produce a self-contained release artifact.

### Reimplement the encoding tables or terminal behavior

Rejected as substantially riskier than deferring the existing packages.

### Land only `@xterm/headless` and `simple-git`

This would be simpler, but it would leave the largest package in the group on the eager path and would not satisfy candidate 5. The compatibility facade and narrow runtime entry modules remove `iconv-lite` without changing its public API.

## Verification Plan

1. Build the CLI-only production artifacts and bundle them with esbuild code splitting.
2. Traverse the ACP entry's static metafile closure and require zero attributed bytes for all three packages.
3. Run focused unit tests for encoding reads and writes, shell execution and fallback, Git worktree behavior, cleanup, GitHub extension operations, each loader, and the bundle guard.
4. Run the affected CLI tests, build, and full typecheck.
5. On the 2-vCPU, 4-GiB reference host, run one paired smoke test followed by 30 alternating serial cold pairs and 30 preheated pairs. Report `channel.initialize`, process-to-first-session latency, peak process-tree RSS, concurrency, telemetry-disabled behavior, legacy single-session behavior, and residual processes.

## Measured Static Result

| Variant   | ACP outputs |   ACP static closure |   `iconv-lite` | `@xterm/headless` |   `simple-git` |
| --------- | ----------: | -------------------: | -------------: | ----------------: | -------------: |
| Baseline  |         144 |     13,405,027 bytes |  551,713 bytes |     213,071 bytes |  146,526 bytes |
| Candidate |         142 |     12,314,617 bytes |        0 bytes |           0 bytes |        0 bytes |
| Delta     |          −2 | **−1,090,410 bytes** | −551,713 bytes |    −213,071 bytes | −146,526 bytes |

The remote performance result must be evaluated separately because bundle bytes do not imply a latency improvement.

## Measured 2C4G Result

The remote host had 2 vCPUs, 3.5 GiB total RAM, no swap, and Node.js 22.23.1. A separate one-pair smoke run and its functional scenarios passed before the formal run. The formal run then completed 30 alternating serial cold pairs and 30 alternating preheated pairs, followed by another set of functional scenarios, with no failed sessions or residual processes.

The formal candidate was the copied prototype artifact with SHA-256 `f0ac7edc7665752efac7b7bfbb4fb055ce2d8ef1a8ae5dd1af630305a2c84d28`, labeled `febb43bc9266cc7a3363539df87d90d752ad782c+candidate5` by the harness. The result applies to that exact artifact, not to a future commit SHA; a PR should retain the artifact hash or rerun the gate if its production code changes.

| Scenario  | Metric                  | Baseline P50 / P95 | Candidate P50 / P95 |     P50 delta | Paired median | Candidate wins |
| --------- | ----------------------- | -----------------: | ------------------: | ------------: | ------------: | -------------: |
| Cold      | `channel.initialize`    |   896.2 / 915.5 ms |    831.5 / 848.5 ms |  **−64.7 ms** |      −60.1 ms |          30/30 |
| Cold      | `POST /session`         | 1273.8 / 1305.3 ms |  1156.5 / 1181.1 ms | **−117.4 ms** |     −105.1 ms |          30/30 |
| Cold      | process → first session | 1877.7 / 1921.0 ms |  1733.3 / 1763.8 ms | **−144.4 ms** |     −136.2 ms |          30/30 |
| Cold      | peak process-tree RSS   |   417.0 / 451.4 MB |    408.1 / 419.2 MB |   **−8.9 MB** |       −8.5 MB |          18/30 |
| Preheated | `channel.initialize`    |   895.3 / 926.3 ms |    837.2 / 861.6 ms |  **−58.1 ms** |      −49.2 ms |          30/30 |
| Preheated | `POST /session`         |     90.0 / 94.2 ms |      83.3 / 86.7 ms |   **−6.7 ms** |       −6.5 ms |          28/30 |
| Preheated | process → first session | 3697.3 / 3723.0 ms |  3666.0 / 3676.6 ms |  **−31.3 ms** |      −29.6 ms |          30/30 |
| Preheated | peak process-tree RSS   |   430.5 / 433.1 MB |    403.0 / 419.3 MB |  **−27.5 MB** |      −13.9 MB |          19/30 |

The candidate also passed concurrent first sessions, telemetry-disabled startup, and legacy single-session startup. A production-configured first-use probe passed GBK encode/decode, headless terminal construction and write, loader single-flight identity, and a real local `simple-git` repository initialization. The remote host has no `git` executable, so the remote `simple-git` probe verified module loading and factory construction but could not execute a real Git command; the full local Git service suites cover those operations.

The acceptance gate is satisfied: the cold-path wins are consistent across all 30 latency pairs, remain visible in the preheated channel initialization metric, and do not trade latency for higher memory.

## Risks and Rollout

The main risk is a first-use-only failure that eager imports previously exposed at startup. Focused tests exercise the first-use paths, and the production bundle guard verifies that the imports remain dynamic. Remote smoke and acceptance runs exercise real bundled ACP sessions and check for residual processes.

This candidate should remain a separate PR, as required by #7264, so its regression surface and performance effect stay attributable. If the 2C4G gate shows no repeatable startup benefit or a meaningful first-use regression, the implementation should not land solely for bundle-size reduction.

## References

- [esbuild code splitting](https://esbuild.github.io/api/#splitting)
- [esbuild metafile analysis](https://esbuild.github.io/api/#metafile)
- [Node.js dynamic import expressions](https://nodejs.org/api/esm.html#import-expressions)
- [Node.js CommonJS interoperability](https://nodejs.org/api/esm.html#interoperability-with-commonjs)
