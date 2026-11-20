# Extension watcher reuse: design supplement

[简体中文](2026-11-15-opentui-extension-watcher-reuse.zh-CN.md)

Composition checkpoint: these reviewed changes are now carried by a separate Source candidate on actual main checkpoint `dab5253c`, excluding the unmerged SkillReview PR increment. The `b6ec` / `7220` results below belong to the earlier two-worktree candidate; at preparation time, this composition had not been built or run and did not inherit those passes.

Historical checkpoint: this document began as a proposed ignored draft without implementation or product qualification. An implementation candidate now exists; the contracts and limits below remain applicable, with current observations recorded in the next section.

## Evidence and scope

The batch-refresh product `2a86` passed the complete Node+Ink Source case; both Bun variants failed. The later watcher-diagnostic artifact `d52c` passed 124 unit tests but its Native Source run still failed at the B-consent boundary. These are separate candidates and outcomes.

The saved diagnostic contains 25 records. Within PID 46144, generation 5, `main-close-call-before` at 19529493875 and `main-close-call-returned` at 25896133584 are separated by 6.366639709 seconds across the before/returned close-boundary records. The before timestamp is taken before log serialization/append, so this interval includes that diagnostic work plus the close call/catch registration; diagnostic overhead has not been independently separated. They do not establish promise settlement, a unique underlying lock holder, or the sole cause of the complete Source failure. Generation 9 has no matching return in the saved interval and cannot be assigned to business work or cleanup from adjacency alone.

The implementation candidate changes CLI watcher lifecycle handling. It must preserve Core store policy, install/consent ordering, linked-extension behavior and refresh classification. No polling flag, timeout increase, retry, Core API or diagnostic logger is part of the shipping design.

## Current verification checkpoint

Current observed checkpoint: the production candidate remains artifact `b6ec1bb9…` (12-file tree `4dd28184…`). Its normal verification recorded 148 passing tests. The separate acceptance harness tree `7220217e…` passed 14 helper-contract tests plus build, typecheck, targeted zero-warning lint and formatting; these are separate scopes, not 162 application tests. The stronger Sources-list admission predicate and lifecycle observations changed the harness, not this production artifact, inputs or budgets.

| Current observed profile | Complete public Source case | Public natural exits | Model HTTP |
| ------------------------ | --------------------------- | -------------------- | ---------- |
| Strict Bun/OpenTUI       | 1 PASS                      | 2 exit 0 / signal 0  | 0          |
| Bun/Ink                  | 1 PASS                      | 2 exit 0 / signal 0  | 0          |
| Node/Ink                 | 1 PASS                      | 2 exit 0 / signal 0  | 0          |

These three executions reached A approval/B denial, partial status and selection clearing, explicit B-only re-selection/fresh consent, exact persisted metadata/commands and hot/cold completion, with publisher guards retained. Git/catalog traffic is separate from model HTTP and is nonzero. Coverage is limited to the command-only HTTP catalog→Git fixture, excluding local-directory publisher and hook-sensitive Source routes. Earlier `2a86` failures and the earlier same-`b6ec` Native cold-start timeout and Bun/Ink Sources-detail admission failure remain recorded; the newer passes do not establish that those failures are fixed or explain their causes. The installed global Ink cold-exit failure also remains open.

The Bun/Ink cold observer spawn-marker→ready interval was 27.177843 seconds, close to the unchanged local 30-second ready window. The clock belongs to the harness observer process, and the spawn marker occurs after PTY creation, so this is not full process initialization time or exact deadline headroom. Synchronous raw-output/lifecycle file writes may perturb scheduling. A single pass per profile does not establish startup frequency, stability, performance improvement or an uninstrumented outcome. Config changes still require Tier 2 maintainer review; cross-platform/native-event stability, final-main acceptance and overall migration completion remain unqualified.

## Existing ownership and callers

One watcher instance captures the selected Config and refresh state. `llm.tsx` creates/starts it, registers extension-state notifications that restart it, and stops it during cleanup. Mutation suppression completion calls `restartAfterMutation`; missing-extension-directory bootstrap also requests restart. These paths must share the same lifecycle authority. Other settings/LSP watchers are outside this change.

## Candidate contract

- The main chokidar watcher monitors extension/link roots only. Chokidar 4 still creates child handles when given the state parent and can rebind them on atomic replacement; changing its root string to the parent alone does not remove that lifecycle cost.
- A separate public `fs.watch` monitors the stable state parent. Filter the state basename exactly; treat a null filename conservatively by rereading the current state generation. Atomic `state.json` replacement does not change parent identity and must not rebuild healthy extension/link watchers. Ignore unrelated siblings.
- If the state parent is missing, monitor the nearest existing ancestor and rearm toward the intended parent as directories appear. Parent replacement, watcher error or stop invalidates the old callback; no fallback to another Config/store is allowed. Preserve the existing missing-extension-directory bootstrap independently.
- Reuse the main watcher only after ready, while healthy, with matching manager and matching real directory identities (device, inode and type) for every extension/link root. Equal strings alone are insufficient. Recompute metadata and stale-file references on reuse without incrementing the live callback generation.
- Real root/link/parent identity changes, unhealthy watcher or manager replacement require the appropriate rebuild. Preserve `followSymlinks: false` and the existing configured link-source interpretation; do not broaden filesystem ownership.
- A rebuild under the same manager must retain active mutation suppression IDs and their completion authority. Releasing them merely to rebuild can suppress or reorder the eventual notification. Explicit stop or manager replacement releases the old manager's listener/suppressions and prevents later old callbacks from reviving it.
- `stopWatching` invalidates main/state/bootstrap callbacks, disposes listeners/pollers and closes every owned watcher once. No new flag, polling override, Core API or generic handoff framework is required. The implementation gates reuse on literal-directory lstat/realpath/device/inode/mode plus ready/health; symlink or unknown identities still attach monitoring but do not reuse the old handle.

The first readable numeric state snapshot establishes the baseline without a refresh, whether its generation is 0 or 1 (or another valid number). Capture whether a baseline existed before rearming: do not force a second notification immediately after the restart poll establishes that first snapshot. If a baseline already existed, parent replacement must still force the existing state-event classification; deleted or unreadable snapshots must retain their conservative notification path. Existing suppression and refresh-state deduplication remain unchanged.

## Verification before acceptance

Retain the existing classification, suppression, bootstrap and cleanup tests. Replace any test that prescribes unconditional restart with a behavioral test proving healthy same-root reuse plus metadata refresh; do not delete its underlying notification assertion. Add focused cases for state atomic replacement with no main restart, ignored siblings/null filenames, missing-parent ancestor rearming, physical root/parent replacement, linked-root add/remove or retargeting, pre-ready/error fallback, same-manager active-suppression preservation, manager replacement, stop/restart and stale callbacks. Tests that mock chokidar prove lifecycle calls, not native FSEvents performance.

Acceptance requires normal build/type/whole affected tests/lint/format/bundle, then the complete Source case across Native, Bun+Ink and Node+Ink on one artifact with unchanged business assertions and budgets; executed checkpoints appear above. Preserve the previous failures. The saved 6.3666-second interval supports investigating avoidable lifecycle cost; it is not a throughput benchmark or a replacement for the complete product case.

## Remaining decisions

The implementation now includes literal-directory identity, ready/health, ancestor rearming, same-manager suppression retention and first-baseline protection; its platform behavior and complexity still require independent review and maintainer judgment. If preserving semantics requires disproportionate lifecycle machinery, reject that design and choose a smaller verified approach. Overall migration, platform approval and default renderer changes remain outside this increment.
