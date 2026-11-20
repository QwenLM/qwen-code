# OpenTUI extension batch refresh

[English](2026-11-15-opentui-extension-batch-refresh.md) | [简体中文](2026-11-15-opentui-extension-batch-refresh.zh-CN.md)

Composition checkpoint: these reviewed changes are now carried by a separate Source candidate on actual main checkpoint `dab5253c`, excluding the unmerged SkillReview PR increment. The `b6ec` / `7220` results below belong to the earlier two-worktree candidate; at preparation time, this composition had not been built or run and did not inherit those passes.

## Status and problem

Implementation candidate on `fix/opentui-source-batch-refresh-20261115`, based on3165314. Before the fix, a focused mounted regression failed once with18 other tests filtered: the first plugin's runtime reload ran before the next plugin's installer. The original red result is retained. A separate temporary diagnostic measured4.773s between the install call returning its promise and the caller resuming (including initial consent); a subsequent additional Native reload took7.820s before B began. These are one execution's boundary timings, not a performance distribution or proof of a unique OS/lock cause.

The matching earlier public Source matrix passed Node/Ink and Bun/Ink but failed strict Native before B consent. The installed global Ink control reached the business flow but retained a cold natural-exit failure. At that historical checkpoint neither result qualified the new fix, and normal checks and three-profile acceptance were pending; the current checkpoint appears below.

## Behavior and scope

Ink processes selected plugins sequentially without a full CLI runtime reload between items. Core installation already attempts runtime-tools refresh. Native additionally refreshed extension cache, tools and host commands after each item; a batch therefore delayed the next consent with duplicate runtime work.

The correction changes only three CLI production files. Acquisition keeps parsing, consent/settings prompts, abort handling, selected manager arguments, scope preference and committed-warning classification. Its fourth local argument `reloadAfterInstall = true` preserves the existing single-install default. Discover explicitly passes false; Sources keeps the default true. Refresh policy is independent of `rememberScope`, and there is no new environment flag, Core API or permission override.

Discover receives the existing guarded catalog reload as a required `reloadRuntime` callback. Capture it with the installer at batch start. After all target decisions have finished, if at least one install committed—including committed-with-warning—await this callback once before catalog/status completion and unlock. All-failed batches do not reload. One-item detail and B-only retry still finalize once. A successful A and denied B remain partial1/failed1 with cleared selection; there is no automatic B retry or extra consent input.

## Ownership and failures

The selected Config/manager/session/cwd owner remains authoritative. Check captured liveness before and after finalization; the existing mount callback also checks its owner around runtime and command reload. Replacement/unmount cannot dispatch another old target or publish status into its successor. Already dispatched refresh cannot be atomically cancelled by these APIs.

Refresh failure adds a warning detail without changing committed counts or overriding a partial error. Scope-preference and committed-warning behavior stay intact. Keep the batch locked through finalization, and update hot command availability before presenting the final batch status. Parent catalog-change notifications remain UI refresh, not the async runtime finalizer. No watcher implementation or shared reload helper is changed.

## Consumers and validation

The acquisition hook's only production consumers are the extensions dialog's Discover wrapper(fourth false) and Sources wrapper(default true). Discover list, detail and retry all use its one batch loop. The mount still supplies the same owner-guarded reload callback, including its existing reload-state notifications. Sources preserves its single-install refresh and catalog load.

Retain the mounted red test and add meaningful order/ownership tests: both installers before one batch refresh; A commit/B denial; committed warnings; all failed; refresh failure preserving counts; real fourth-false wiring; Sources default; one-item detail/retry; and stale/unmounted owners. Root verifies affected whole files, build/typecheck, zero-warning lint, formatting and bundle before application acceptance.

The initial acceptance plan used the a8be fixture and0cae public case on the new candidate under Node/Ink, Bun/Ink and strict Native. Preserve120s case/local15s/CI45s/zero retries and the recorded180s outer cap. Require A approval/B denial, exact partial result and selection clear, explicit B-only re-selection/fresh consent, exact IDs/metadata/commit/policy/commands, hot/cold completion, modelHTTP0, publisher/read-only guards and two natural exits. This paragraph records the initial pending plan. Later harness changes strengthened Sources-list admission and added data observation without changing business assertions, inputs or budgets; current observations appear below.

## Current verification checkpoint

Current observed checkpoint: the production candidate remains artifact `b6ec1bb9…` (12-file tree `4dd28184…`). Its normal verification recorded 148 passing tests. The separate acceptance harness tree `7220217e…` passed 14 helper-contract tests plus build, typecheck, targeted zero-warning lint and formatting; these are separate scopes, not 162 application tests. The stronger Sources-list admission predicate and lifecycle observations changed the harness, not this production artifact, inputs or budgets.

| Current observed profile | Complete public Source case | Public natural exits | Model HTTP |
| ------------------------ | --------------------------- | -------------------- | ---------- |
| Strict Bun/OpenTUI       | 1 PASS                      | 2 exit 0 / signal 0  | 0          |
| Bun/Ink                  | 1 PASS                      | 2 exit 0 / signal 0  | 0          |
| Node/Ink                 | 1 PASS                      | 2 exit 0 / signal 0  | 0          |

These three executions reached A approval/B denial, partial status and selection clearing, explicit B-only re-selection/fresh consent, exact persisted metadata/commands and hot/cold completion, with publisher guards retained. Git/catalog traffic is separate from model HTTP and is nonzero. Coverage is limited to the command-only HTTP catalog→Git fixture, excluding local-directory publisher and hook-sensitive Source routes. Earlier `2a86` failures and the earlier same-`b6ec` Native cold-start timeout and Bun/Ink Sources-detail admission failure remain recorded; the newer passes do not establish that those failures are fixed or explain their causes. The installed global Ink cold-exit failure also remains open.

The Bun/Ink cold observer spawn-marker→ready interval was 27.177843 seconds, close to the unchanged local 30-second ready window. The clock belongs to the harness observer process, and the spawn marker occurs after PTY creation, so this is not full process initialization time or exact deadline headroom. Synchronous raw-output/lifecycle file writes may perturb scheduling. A single pass per profile does not establish startup frequency, stability, performance improvement or an uninstrumented outcome. Config changes still require Tier 2 maintainer review; cross-platform/native-event stability, final-main acceptance and overall migration completion remain unqualified.

## Boundaries

This is a narrow refresh-order correction, not a Core, watcher, lock, policy or platform fix. Old Source failures and the global cold-exit failure remain recorded. No latest/final-main, installed-package, Windows/Linux, GUI/device, default-renderer change, Ink removal, release or overall migration acceptance is claimed.
