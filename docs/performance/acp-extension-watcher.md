# ACP extension watcher: first-session measurement

[简体中文](acp-extension-watcher.zh-CN.md)

This change skips the interactive extension file watcher in ACP processes. The daemon already owns its resource refresh lifecycle. Interactive terminal sessions continue to construct the watcher. This is the first stage of first-session optimization; it does **not** establish a first new session below 500 ms.

## Change and provenance

The baseline is main commit `2985fef4e9b9393601141c16031b2ba039181158`; the measured candidate is watcher-only commit `2aadc4b127ec24074e0e5ddfd402e978a0c43f5d`. The production change is one additional ACP-mode guard. Both `--acp` and `--experimental-acp` are covered, along with a control that constructs the watcher for interactive mode. No Core initialization, resource selection, prompt, authentication, MCP policy, or preheat implementation changes are included.

Both bundles use CLI version 0.27.2. The calling TypeScript package is `@qwen-code/sdk` **0.1.32**. Package version and SDK entry hashes were recorded before and after each run. Complete baseline, candidate, and compiled SDK file-tree digests were also frozen and checked around the measurement cohort. The candidate was built in an independent worktree with the pinned pnpm 11.24.0 lockfile install, full build, typecheck, and bundle.

## Workload and timing boundary

The private installed workload contains 31 resources: 14 extension suites and 17 standalone Skills, with 90 custom Skills, 3,944 files, and 81,931,741 bytes. Every sample materializes the complete same resource inventory on a case-sensitive local filesystem. Resource names, source files, business content, manifests, local paths, identifiers, and raw logs remain private. Only aggregate counts and timings are published here.

The profile preserves hooks and sets the MCP allowlist to an empty list. It sends no prompt, model request, or business tool call and does not connect to configured external MCP servers. Installed native activation state is seeded during untimed fixture preparation. This represents an **already installed and activated** resource set, with a fresh process and fresh session state; it does not claim that all resource-derived caches are empty. Fixture creation, file copying, native activation seeding, bundle building, and SDK module import finish before either clock starts.

Each sample has a fresh HOME, runtime directory, TMPDIR, persisted-session root, and initially empty Node compile-cache directory. The daemon is launched through its real embedded HTTP-bridge entry point with `preheatBridge: false`. The driver waits for `runtimeReady`, then verifies zero business sessions and no live ACP channel before its first SDK call. There is no HTTP readiness or capabilities request before that call. A fresh UUID requests a new thread; the result must echo it with `attached: false`. Two further fresh UUID calls validate subsequent-session behavior.

The ready request boundary is observed before SDK client construction and caller UUID generation; both are outside the primary create clock.

The primary clock encloses the complete `await client.createOrAttachSession(...)`: capability discovery, the session POST, response JSON parsing, and SDK identity validation. The first HTTP request is `GET /capabilities`; its duration alone is **not** a new-session measurement. Request records retain the actual sequence for all three calls; later calls must not be assumed to omit capability checks.

The report also exposes the session POST, daemon process spawn to the daemon-ready request boundary, and daemon spawn through the first completed SDK result. Waiting for the daemon does not create an ACP process: every recorded ACP spawn must occur after both the SDK call starts and the first HTTP request. Daemon status must report preheat `not_scheduled`. No CPU profiler, explicit compile-cache flush, disabled child compile cache, artificial sleep, or startup probe appears in formal samples.

## Formal results

**The first complete SDK create falls from 1096.1 ms to 772.9 ms at the median: 323.2 ms / 29.48% lower. The candidate remains above 500 ms in every sample.**

All values below are milliseconds, shown as median (minimum–maximum), with eight independent first sessions per condition. Both conditions complete 8/8 attempts, creating 24/24 new sessions. No formal sample is excluded.

| Clock                                 |               Baseline |           Watcher only |
| ------------------------------------- | ---------------------: | ---------------------: |
| First complete SDK create (primary)   | 1096.1 (1078.3–1129.3) |    772.9 (758.4–824.1) |
| First session POST + JSON             | 1075.7 (1058.8–1109.2) |    754.1 (739.3–798.5) |
| Daemon spawn → observed listener      |    336.7 (322.5–341.5) |    329.2 (323.1–358.5) |
| Daemon spawn → ready request boundary |    630.6 (618.7–644.5) |    605.3 (591.8–621.0) |
| Daemon spawn → first SDK result       | 1731.0 (1709.6–1748.0) | 1384.5 (1355.5–1427.0) |
| First capabilities GET + JSON         |       18.7 (17.7–28.1) |       18.3 (18.1–25.1) |
| First HTTP → ACP spawn                |       14.2 (13.9–22.3) |       14.2 (14.1–24.6) |
| Second complete SDK create            |       71.1 (65.1–79.6) |       74.0 (65.2–80.0) |
| Third complete SDK create             |       56.9 (53.7–63.7) |       54.4 (53.4–56.6) |

First-create samples by paired round:

| Round | Baseline | Watcher only |
| ----- | -------: | -----------: |
| 1     |   1098.5 |        758.4 |
| 2     |   1078.3 |        771.1 |
| 3     |   1129.3 |        807.8 |
| 4     |   1110.2 |        760.1 |
| 5     |   1082.6 |        767.9 |
| 6     |   1089.2 |        774.8 |
| 7     |   1093.7 |        789.0 |
| 8     |   1110.5 |        824.1 |

The [public numeric summary](acp-extension-watcher-results.json) includes every formal sample, means, medians, ranges, compile/build tree digests, and pass/fail counts. It is constructed from an explicit allowlist; it contains no private resource inventory, source contents, local paths, UUIDs, tokens, or raw logs.

An earlier six-attempt cohort was aborted when its temporary fixture volume ran out of space (five completed samples and one session-initialization failure). The failure logs contain `ENOSPC` on runtime-directory creation. All six processes closed normally; the entire cohort, including its completed timings, is excluded. A larger independent case-sensitive volume and sixteen completely fresh fixtures were prepared before restarting the formal cohort. The failed evidence is retained locally; it is not silently retried into the results.

Eight paired rounds ran serially, alternating A/B then B/A order. All fixtures were prepared before the exclusive measurement window. No build, fixture copying, other benchmark, or test ran concurrently under this task. The OS file cache was not dropped; these are fresh-process, fresh-session measurements on one host, not cold-disk measurements. Eight samples per condition are too few to establish a production tail-latency guarantee.

Host: macOS 26.6.2, arm64; Node.js v26.7.0. This local isolated reconstruction uses the private preproduction installation inventory; it is not a production or live-preproduction latency measurement. The 500 ms objective applies to the first complete SDK create, and remains follow-up work beyond this PR.

## Functional verification and limits

Separate functional runs compare frozen baseline and watcher-only bundles with the same complete installed inventory. They are not members of the formal timing cohort: health and helper calls precede some functional checks.

- Both conditions pass 41/41 external-change assertions and 18/18 activation/lifecycle assertions.
- All eight helper snapshots, eight existing-session menus after the helper, eight newly created-session menus, and eleven lifecycle snapshots match after fixture-path and UUID correspondence.
- Ordinary reads preserve observed propagation differences: complete workspace-Skill envelopes match in 29/32 samples, Skill content in 31/32, and existing-session command lists in 31/32. An atomic replacement appears earlier in the candidate at one observation; file recreation briefly appears earlier in the baseline. Later samples or the normal helper converge. Extension Skill edits/restores remain old in both conditions during the three-second observation window and become correct after the helper.
- Both sides emit eight public SSE events with the same type/phase sequence. The first seven corresponding payloads match; the last reload payload refreshes the same nine sessions with a different completion order. Original array order is retained when checking equality.
- New-session responses differ naturally in UUID, creation time, and client identity. Other response fields match; actual creation is independently asserted by UUID echo and `attached: false`.

Only fixture and bundle roots, workspace identifiers derived from those roots, and UUID correspondence are normalized. For the separately reported workspace-Skill business comparison, observation timestamp and age are excluded; raw envelopes remain intact. Cache staleness, refresh flags, activation state, generation, all Skill/command fields, and original array order are not erased to manufacture equality. These observations do not prove identical propagation latency or byte-identical ordinary reads.

Every functional group receives a normal close acknowledgement and exits with code zero, no signal, and no forced fallback. A final scoped OS observation finds no matching benchmark process. Formal timing samples separately enforce their own normal close acknowledgement, zero exit status, no forced fallback, and disappearance of every recorded ACP child PID.

The focused CLI unit suite passes **129/129**, with full build, typecheck, bundle, changed-file ESLint, and Prettier checks passing. Interactive watcher construction is verified by a unit control; an interactive terminal UI end-to-end run, Windows, Linux, model execution, hooks executing on prompts, and external MCP behavior are outside this validation.

## Reproduce with public synthetic resources

The public generator authors generic resources without reading or exporting the private installation. It uses 14 suites, 17 standalone Skills, and 90 Skill manifests, but its bytes, directory shapes, standalone-skill placement, hook definitions, and activation preparation differ. Its timings can reproduce the procedure and expose scaling behavior; they cannot reproduce or replace the private-workload numbers above.

Build a frozen baseline and a frozen candidate from their respective commits using `corepack pnpm install --frozen-lockfile`, `npm run build`, and `npm run bundle`. The public reproduction was checked with Node.js v26.7.0. Keep the SDK build fixed, stop builds and resource copying before measuring, and alternate the two bundles serially. From this checkout, run one sample per fresh output directory:

```sh
node scripts/benchmarks/acp-first-session/fixture.mjs /tmp/acp-synthetic-a /absolute/frozen-baseline/dist
node scripts/benchmarks/acp-first-session/fixture.mjs /tmp/acp-synthetic-b /absolute/frozen-candidate/dist

node scripts/benchmarks/acp-first-session/run.mjs /tmp/acp-synthetic-a/fixture.json
node scripts/benchmarks/acp-first-session/run.mjs /tmp/acp-synthetic-b/fixture.json
```

Prepare all fresh fixtures before the measurement cohort. A fresh synthetic smoke completes all three creates and the no-preheat, identity, close, child-exit, and recorded-input-hash checks. It validates the procedure and contributes no sample to the private results. Each run prints a path-free numeric/boolean summary and keeps detailed local evidence at the requested output location. The synthetic resources contain no SessionStart hook; no prompt is sent, so the authored UserPromptSubmit hooks do not execute. Use at least eight interleaved pairs, retain failures, inspect every preheat/session/spawn/close assertion, and report all clocks. Do not commit locally generated fixture trees or raw results.

If a recorded ACP PID still exists after shutdown, the public runner marks the result failed and records a cleanup error for manual inspection. PID reuse prevents it from proving process identity, so automatic termination is limited to its own wrapper process handle.

The remaining sub-500 ms work must reduce initialization performed after the first SDK call, with the same no-preheat boundary and functional checks. It is deliberately separate from this one-line watcher change.
