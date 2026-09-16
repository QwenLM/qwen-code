# Complete the ACP control-plane / harness boundary

[English](2026-09-15-acp-bridge-completion.md) | [简体中文](2026-09-15-acp-bridge-completion.zh-CN.md)

Status: local implementation complete; verification is recorded per integration.
Historical full-suite acceptance remains open, 2026-09-16.
Implements the remaining boundary extraction for
[#11866](https://github.com/QwenLM/qwen-code/issues/11866) after the four
[earlier slices](2026-09-14-acp-bridge-control-plane-harness-boundary.md).

## Problem and scope

After the first four slices, the bridge still owned session policy and physical channel supervision
in one closure. The existing lifecycle, handshake, transport and startup modules
are useful building blocks, but startup's channel type still includes session
state, while physical exit and idle scheduling still mutate it directly.

Finish with two main owners. Keep session registry, admission/FIFO, mid-turn
promotion, terminal deduplication and artifact forwarding together in
`session-control-plane.ts`. Put physical channel ownership and execution in
`channel-harness.ts`, reusing the existing four modules. Keep `bridge.ts` as the
synchronous public composition point and compatibility exports. A cohesive
control-plane module can remain large; line count is not the acceptance test.

This is a behavior-preserving TypeScript extraction. `deriveConfig` stays in
core. No new public options, package exports, daemon routes, wire fields, JVM
implementation, event store or stateless harness API are part of this work.
The watcher, process-query and EOF shutdown fixes have separate evidence and
include intentional behavior changes. In particular, failed EOF draining now
reports exit 1 where the measured baseline exited 0 despite truncation or EPIPE.
The drain covers frames forwarded to the inner stdout writer, not calls still
queued upstream; those can be omitted with an SDK error log and exit 0. See the
[EOF design](2026-09-15-acp-eof-output.md) for the exact boundary and measurements.

## State and construction boundary

`HarnessChannel` holds the physical channel, connection, identity, transport
failure/liveness facts, handshake state, active-work negotiation and resource
samples. A control-plane-private `ChannelInfo` holds its `BridgeClient`, session
ids, pending operations, settlement timers, quarantine and workspace policy.
It references its physical handle. Immutable identity/channel/connection aliases
may be retained; mutable physical fields are accessed through that handle.

A private `WeakMap<HarnessChannel, ChannelInfo>` associates each pair once during
synchronous construction. It is not a second live registry and is never iterated
or synchronized on teardown. The harness alone owns current/alive/starting
membership. An old session or exit callback keeps its original association even
after a replacement becomes current. No getter proxy or mutable registry escape.

The control plane supplies one synchronous construction action: create the ACP
client and guarded connection, create both associated objects, bind callbacks
and return the physical handle. Startup immediately registers it before its
existing initialize await. No extra asynchronous wrapper is introduced around
construction, registration, capability publication or existing ensure calls.
The harness imports ACP client contracts, never `BridgeClient` or session state.

## Lifecycle and execution ownership

| Responsibility                                                | Owner and boundary                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Physical current/alive/starting state and runtime epoch       | Harness; preserve raw slot and old/new overlap semantics                        |
| Idle timer, keep-alive and runtime reservations               | Harness; synchronously read current control-plane busy/reap facts               |
| Session reaper, close grace, queues and terminal events       | Control plane; keep their atomic transitions together                           |
| Quarantine and abandoned-request settlement policy            | Control plane; refuse fresh sessions without disabling existing siblings        |
| ACP client routing and session-owned cleanup                  | Control plane callbacks at their original synchronous positions                 |
| Guarded connection, process kill and physical shell execution | Harness; preserve errors and direct promise/callback ordering                   |
| Worktree metadata and transfer/reset barriers                 | Control plane; pass the selected session cwd and request attribution explicitly |

Idle eligibility includes outer restores, channel-local pending creates/restores,
workspace work and runtime reservations. Preserve the exception that condemned
channels can retire after session work drains. Timer callbacks read current facts.
Reservation acquisition remains synchronous and release retains its original
reap/idle awaits. Do not add a generic RPC dispatch facade over the existing SDK.

One workspace can contain multiple session worktrees on one child. Never rebind
the channel cwd to a worktree. Move the existing worktree defer metadata, session
cwd request and physical shell execution into harness operations; preserve request
spread precedence, trace injection, actual owning channel, and the existing cwd
queue. The control plane retains authorization, reset barriers, result validation,
metadata updates and user-facing event/history publication. Shell cancellation and
deadlines also remain with the session control plane; the harness synchronously
returns the physical execution promise so the original two awaits stay in place.

## Exit, shutdown and composition order

On physical exit, stop liveness, clear transport refreshes, cancel the current
channel's idle timer, run control-plane timer/release cleanup, remove the physical
handle, then run control-plane session cleanup. Preserve this exact order and the
existing per-session terminal-before-bus-close sequence. A late old exit must not
clear the replacement. No asynchronous event emitter is introduced.

The control plane keeps shutdown admission and shared shutdown-promise identity.
Harness snapshot/mark, terminate and killSync operations run at their existing
positions. Keep the single combined wait over physical teardown, startup, session
spawns, restores and abandoned settlements. Do not start killing before session
terminals are published or remove handles before actual exit.

Bridge construction supplies a synchronous harness factory to the control plane
at the existing initialization site. Preserve option-validation order, journal
registration, session-reaper startup and prompt-handler binding. Keep public
error helpers and `createHttpAcpBridge` alias available through the same module.
The internal seam is concrete TypeScript; it does not freeze a future Java ABI.

## Implementation and verification

1. Separate physical and control-plane channel types and their one-time binding.
2. Transfer complete idle/reservation/exit/shutdown ownership and execution helpers
   into the harness, preserving existing function bodies and await positions.
3. Move the remaining cohesive control plane and make bridge the composition point.
4. Verify source movement and exported/wire expressions mechanically, then run
   build, typecheck, bundle, affected tests, public E2E and the full configured
   repository unit suite plus script tests. Follow with two clean audits and
   independent review.

Retain all existing workspace-isolation, spawn-coalescing, startup-failure,
old/new-channel overlap, same-session FIFO, cross-session concurrency, exit fan-out,
idle/preheat, restore, terminal, artifact and worktree/reset tests. Add deterministic
coverage for boundary gaps, including synchronous binding and exit release ordering.
The E2E plan is `.qwen/e2e-tests/issue-11866-completion.md`; it reuses established
global public baselines and checks actual process exit and independent cleanup.

Acceptance requires explicit separate owners, no session registry/queues/events in
harness, no physical lifecycle state in bridge, preserved public/wire behavior,
passing verification and resolved review findings. Historical failures remain in
their reports until evidence establishes their outcome.

## Pre-rebase boundary and evidence

This section records the pre-rebase local commit
`88a5eb2bce7fc1dd3e932176dfd8d08ff82afe97`, based on `9efdd898e7`.
As checked on 2026-09-16, that object still exists in the author's local Git
object database, but is not an ancestor of published `b8124075c6` and GitHub's
commit API returns 422 for it. Its counts and test results are retained as
historical author evidence, not a publicly resolvable candidate or current
verification. In particular, the 14,267-line, 2,092-test and 44-file counts below
belong only to that pre-rebase candidate.

Before integration with updated main, the public bridge was 23 lines of synchronous composition and compatibility
exports. The 14,267-line control plane keeps the cohesive session policy closure;
the 444-line harness owns physical lifecycle and execution, reusing the extracted
lifecycle, startup, handshake, transport and connection helpers. Public package
exports are unchanged, strict TypeScript export types match the baseline, and
`createHttpAcpBridge` remains the same function object as the public factory.

Mechanical comparison verifies the complete final control-plane move against
the prior stage, 13 lifecycle bodies, the connection declarations, preservation
of the original 27 channel initializers across both new objects, and
declaration-resolved physical property accesses. A separate
comparison matches 306 surviving name-keyed control-plane bodies; this is not a
claim about every function because duplicate local names exist. Eight changed
wiring bodies were reviewed directly, including synchronous construction, exit,
cwd, shell and shutdown. The historical moved-body inventory contains 270 awaits; it is not a count of
all await tokens across the final modules. Per-body and wiring checks, rather
than the count alone, establish ordering. The added regression test rejects
moving physical-handle removal after the session lifecycle callback; this
historical mutation did not test all six exit steps.

Build, workspace typecheck, lint, formatting, core subpath exports and the serve
bundle boundary passed. The complete ACP bridge suite passed 2,092 tests. Two
clean self-audits and an independent review of the frozen 44-file candidate found
no outstanding source defect. Their evidence is retained under
`.qwen/investigations/issue-11866-completion/`.

Eight serial final-bundle E2E samples passed their acceptance conditions: public
lifecycle, native 32-skill watching, two active writer sessions, two direct EOF
cases, stalled-reader and EPIPE negative cases, and real process-query timeout/
nonzero-exit negatives. The first two public flows match the installed-CLI public
baselines; active-writer shutdown matches the earlier local baseline. Both
positive direct EOF cases measure complete stdout and actual ACP exit 0; the
two output negative cases measure nonzero exit with timeout or EPIPE. Daemon
child cleanup is independently checked without inferring a child exit code.
The same 1,079-file bundle manifest was present before and after E2E.
Multi-second DELETE stalls remain measured observations; no latency equivalence
is claimed. The separate watcher, query-output and EOF designs retain historical
failures and the limits of each repair.

## Pre-rebase repository-wide results and limits

The full workspace command completed all 22 configured workspaces: 75,691 tests
passed, 25 failed and 117 were skipped. The failures were CLI 19, core 5 and Web
Shell 1. A missing installed Ink patch was restored from the lockfile-verified
package and the unchanged repository patch; its three loop-guard tests then
passed. Some original tests also read actual user settings, usage and memories.
The same 25 assertions in isolated child environments and one worker produced
16 passes and 9 failures. This does not replace the failed full-suite result or
identify one cause for every failure.

The three cron assertions also failed with the exact HEAD scheduler loaded at
its original module ID. The logger deadline assertion failed with the observed
changed source/dist dependencies replaced by HEAD equivalents. The metrics race
passed in both later paired arms. These are bounded module comparisons, not a
whole-tree HEAD run. Separate diagnostics recorded an unchanged AuthDialog state
race, a Git-version-dependent assertion and a passing AddMenu focus observation;
the original failures and unobserved native-watch/shim causes remain recorded.
The source assertions and deadlines were not changed to obtain green results.

| Additional verification | Result                                           |
| ----------------------- | ------------------------------------------------ |
| Complete script suite   | 87 files; 2,412 passed, 75 skipped; exit 0       |
| 27 CI helper files      | 528 passed, 42 failed, 4 skipped; exit 1         |
| Python SDK              | 173 passed with isolated Python 3.12 environment |
| Mobile unit tests       | 43 passed with the matching Playwright runner    |
| Channel plugin example  | 4 passed                                         |

All 42 CI helper failures are in the unchanged Linux triage wrapper tests (39
gate and 3 staging cases). One unchanged all-pass assertion was observed directly:
on macOS the GNU stat/proc inode guard refuses before any sampling round, with
zero runner invocations and no gate log yet created. The staging log also records
the unavailable `/usr/bin/rm` path. No Docker command was available on the current
PATH, and this run did not validate Linux CI. The failed results remain visible;
they are not described as passing CI.

The restored Ink dependency changed only its box-metrics hook. A fresh complete
build, typecheck, bundle, serve bundle boundary and core export checks all passed.
The new 1,079-file bundle is frozen in `post-install-bundle-manifest.json`. All
eight public E2E scenarios also met their original acceptance conditions against
this rebuilt artifact, whose complete manifest matched before and after. Both
positive EOF cases delivered 1,062,289 stdout bytes and actual ACP exit 0;
the negative cases retained actual exit 1 with the original timeout and EPIPE.
All owned processes and listeners were gone. The normalized positive output
matches the earlier final bundle; prior failures are preserved separately.
Full-suite acceptance remains open because the repository-wide command is not
green. Detailed evidence and separate
follow-ups are retained in `.qwen/investigations/issue-11866-completion/` and
`.qwen/issues/issue-11866-unrelated-unit-followups.md`.

## First published candidate: main integration

The first published candidate, `768e1b194f`, integrates main at
`d47a8fdbae49d6acd4b7b4fb2eb650200e2ae9c8`, 16 commits after the original
baseline. Five non-document candidate files change relative to the pre-rebase
candidate.
The bridge remains 23 lines, the control plane is now 14,465 lines, and the
harness remains 444 lines. Updated-main background-turn admission, terminal
waiting, cancellation epochs, active-work snapshots, restore metadata and busy
guards remain in the control plane. Upstream workspace hooks and extension
workflow watching are retained.

The three conflict regions were resolved at the extraction boundary: imports,
physical active-work storage and synchronous client construction. Independent
open-ended and presume-wrong source audits rechecked the complete integration
delta and its downstream consumers. All 25 client-construction arguments match
updated main after the declared physical-access correspondence. A separate
comparison matches 305 surviving name-keyed bodies; another retains duplicate
name occurrences and checks all 20 upstream-changed named bodies. Neither is a
whole-program proof. Non-mechanical construction, exit, shutdown, cwd and shell
wiring were read directly. The new await inventory is 271, not the old 270;
ordering evidence comes from the actual statements and callbacks.

Fresh build, workspace typecheck, lint, bundle, core subpath exports and the
serve bundle boundary passed. Rebased unit results are recorded separately:

| Verification                             | Result                                                              |
| ---------------------------------------- | ------------------------------------------------------------------- |
| Complete ACP bridge suite                | 42 files; 2,130 passed                                              |
| 11 affected CLI files                    | 1,905 passed, 2 failed in the isolation wrapper                     |
| Two CLI directory assertions, diagnostic | Both passed after removing the wrapper's runtime-directory override |
| Three affected core files                | 228 passed, 9 failed in the isolation wrapper                       |
| Six core skill assertions, diagnostic    | All passed after removing the wrapper's Qwen-home override          |
| Serve bundle guard tests                 | 40 passed                                                           |

The two CLI failures received the wrapper's `QWEN_RUNTIME_DIR` instead of the
directory installed by each test. The unchanged main implementation explicitly
prioritizes that environment variable. Reusing the same isolated home/settings
and removing only the conflicting override makes the two original assertions
pass. This is a bounded diagnostic, not a replacement all-green 1,907-test run.

Six core failures similarly used the wrapper's `QWEN_HOME` instead of the
mocked home directory where those tests provide their user-skill fixtures.
Removing only that override, while retaining the same isolated home, runtime
and system settings, makes all six original assertions pass. The original
228-pass/9-failure run remains recorded separately from this diagnostic.

Three core failures remain recorded in durable cron watching: no observed
watcher read after 600 ms, an afterEach cleanup hook exceeding 10 seconds, and
an external task not observed within 3 seconds. The current hook timeout is
not relabeled as the historical assertion failure. Prior baseline comparisons
remain historical evidence; they do not establish the cause of every current
failure. No product code, assertion or deadline was changed to make these
results green. Full-suite acceptance therefore remains open.

All eight serial E2E scenarios met their positive or negative acceptance
conditions on the rebuilt candidate. Public lifecycle, native watching with
32 skills and active-writer shutdown measured daemon exit 0 and independent
cleanup. Both writer seals match their actual 3,609/3,604-byte transcripts and
hashes. Both positive EOF cases delivered 1,072,333 stdout bytes, including the
complete 524,288-byte fixture, and measured actual ACP exit 0. Stalled-reader
and closed-pipe cases retain harness FAIL/exit 1 and actual ACP exit 1 with the
original 2,000 ms drain error or EPIPE. The query-negative fallback measured
SIGTERM at 2,002 ms with both pipes undestroyed; timeout and separate exit 7
both report snapshot failure despite the owned processes exiting cleanly.

The two new positive EOF outputs match after normalizing only exact temporary
roots and session UUIDs. The historical comparison remains MISMATCH: the CLI
version and two bundled skill bodies differ. Those bodies match the updated
upstream content byte-for-byte and account for the 10,044 additional bytes.
The lifecycle sample also captured an existing command-catalog notification
present in the installed-CLI sample but absent from the previous local sample.
Public subset equality is not complete wire equality, and these ordinary-prompt
fixtures do not exhaustively test tool-driven background turns.

The complete 1,079-file artifact manifest matches before and after E2E, as does
the separately imported process-registry build. CLI SHA-256 is
`5e3d6af2d543ffed89610eec76248be54badd740a9b5d106d56ad68a116adef5`;
the full dist tree digest is
`8e9ce5cfc6a2575c6679566a3675726e0d58f57accaf80ac10aafb01ce13fd2d`.
All owned processes and listeners were independently checked. Actual direct
ACP exit measurements remain separate from daemon-child absence. Rebase
evidence is indexed by `rebase-e2e-manifest.json` in the completion investigation
directory; source audits and the rebuilt artifact manifest are under
`.qwen/pr-reviews/`. Historical failures and their limits remain above.

## Follow-up integration with channel output modes

The evidence in this section was gathered for `f0153063d2`.

After the first publication, main advanced to
`473ef4b3e474ddc16d7bd6db32fcc86185a9cac6`. Its bridge change conflicted with
the extraction. The six added lines are preserved at the same synchronous
control-plane request-building point: capture the supplied output mode, always
strip it, then restore only `per_task` for trusted channel-prompt context.
The ACP agent retains its independent trusted-parent check. No mode policy or
session capture state moves into the physical harness.

The merge also retains upstream's session-owned permission queue and complete
channel-task capture, queue, cancellation, disposal and result handling. Related
task notifications remain part of their waiting RPC instead of waiting on that
same RPC through independent background admission. The bridge remains 23 lines,
the control plane becomes 14,471 lines, and the harness remains 444 lines.

Two independent open-ended and reverse source audits found no introduced
defect. Only three non-document candidate files differ from `768e1b194f`;
their additions match upstream's six bridge lines, six ACP lines and 42 test
lines. All other non-candidate files match the new main exactly. Complete
request construction and ACP prompt handling were checked, not only line counts.
Fresh build, workspace typecheck, lint, bundle, core exports and serve bundle
boundary checks passed, followed by all 2,130 ACP bridge tests.

All 2,170 tests in 15 affected CLI files also passed, including the complete
Session suite, trusted/forged channel-mode filtering and channel configuration.
These commands retain isolated HOME and system settings while explicitly
unsetting the wrapper's `QWEN_RUNTIME_DIR` and `QWEN_HOME`, allowing each test
to supply its own runtime and mocked-home fixtures. Original assertions and
deadlines are unchanged; the earlier failed wrapper runs remain above.

The eight related channel-base files passed all 1,150 tests, including both
channel bridges, session routing, output modes, output turns and background
output coordination. Together with the CLI tests, these checks cover trusted
`per_task` and permission behavior that the eight ordinary-prompt process
scenarios do not exercise.

All eight fresh serial E2E scenarios met their acceptance conditions. Public
lifecycle, native watching with 32 skills and active-writer shutdown measured
daemon exit 0. Both writer seals match their actual 3,609/3,604-byte transcripts
and hashes. Both positive EOF cases measured actual ACP exit 0 and delivered
1,072,333 stdout bytes with the complete 524,288-byte fixture. Their complete
outputs match each other and both first-published-candidate samples after
normalizing only exact temporary roots and session UUIDs.

The stalled reader measured actual ACP exit 1 after 2,028 ms with the original
2,000 ms drain error. The closed reader measured actual ACP exit 1 with EPIPE
after 24 ms. Both retain their original harness FAIL/script exit 1; acceptance
means the expected failure occurred, not that either output was complete. The
process-query test measured SIGTERM at 2,002.45 ms with both pipes undestroyed.
The timeout and separate exit-7 query both reject incomplete cleanup proof,
even though known owned processes exit 0 and the registry becomes empty.

The full 1,079-file artifact and the separately imported process-registry build
match before and after E2E; all 34 non-document candidate files also match.
The CLI SHA-256 measured for `f0153063d2` is
`0d7c5f8757f584b321322da34d1926666b61e6b1b23b57b6a9630c03cda43a69`;
the full dist tree digest is
`d6ec947a9fdf9c00e97f086d9c4e0cb6ab4dbeea7949768bdc4ec1ec5639e261`.
Owned PIDs/process groups and listeners were independently checked after each
scenario. Public subset comparisons match their original baselines; raw normal
prompt responses contain no new task-output/task-result/output-mode or
background-turn metadata. These ordinary fixtures do not exercise authenticated
per-task background capture or permissions. Evidence for this integration is indexed by
`latest-main-e2e-manifest.json`; earlier samples and failures remain unchanged.

## Lint-gate integration at `cc0f7c6949`

This merge added main `a98711330c43ba6f434cc9641abda10079bb8b75`, including
Session Stop-hook changes and the filename allowlist required by the lint
freshness gate. The preceding `f0153063d2` bundle hashes and eight process E2E
samples do not describe this integration.

Fresh build, workspace typecheck, bundle, full lint/static checks, core exports,
serve bundle boundary and runtime critical-dependency checks passed. Focused
verification passed 1,557 tests: 1,052 CLI, 459 core, 37 Web Shell and nine
lint-freshness helper tests. The full ACP suite and eight process scenarios
were not rerun locally for this lint-gate merge. The live GitHub comparison
reproduced the original freshness failure and passed with this merge.

At the 2026-09-16 review follow-up, this commit's GitHub checks had completed:
Linux tests, lint/static, no-AK integration, Serve A/B, daemon E2E, desktop
shells, Web Shell smoke and TUI checks succeeded. The optional macOS/Windows
Node test lanes and CLI integration lane were skipped; they are not passes.
These results do not erase the historical full-suite failures recorded above.

## Review follow-up and main integration on 2026-09-16

Published candidate `b8124075c63276d09987b9994005435c95739314` merged main
`888528dfae9b1dd0ea55ef2bab2e94bfcbaa911d` into `cc0f7c6949` and addressed the
six review suggestions. The results in this section belong to that candidate.
The frozen 36-file non-document candidate manifest has SHA-256
`90f2d468919cf77b2016868781994e0ea30b3cc1061ab8d0a4752e8c64e8fc53`.
Its digest uses sorted repository-relative paths and file SHA-256 values,
joined as `path + " " + hash` with newlines and no trailing newline.

All 17 upstream bridge patch blocks, containing 78 added and five removed
lines, were reapplied to the control plane. The entire resulting file matches
the candidate after only the shared exclusion-type declaration change. Summary
projection, synchronous validation, queued and mid-turn mode identity,
dispatch/reset ordering and child-request filtering remain session policy.
The new process-budget admission retains upstream's shared physical registry,
typed errors and rollback. The six other overlapping files match independent
three-way merges. Public package exports are unchanged relative to this main.

The teardown annotation now names the post-split owners and retains the
physical-membership/attach-availability distinction. A shared type removes the
duplicated work-exclusion declaration through a type-only import; it does not
force future implementations to read every new field. Both EOF documents name
all three mocked suites and distinguish the two suites' historical four-test
repair from that three-suite inventory.

Fresh build, workspace typecheck, bundle, all 112 consumed core subpath exports
and the serve bundle boundary passed. The complete ACP bridge suite passed
2,158 tests in 44 files; 22 affected CLI files passed 2,523 tests; two core files
passed 97 tests, for 4,778 in these runs. Earlier concurrent verification was
interrupted by cleaned build outputs and regenerated coverage; those failed
runs remain separate. The isolated lint environment also needed its installed
YAML tool on PATH. After document formatting, the complete lint pipeline passed,
including ESLint, workflow/shell/YAML checks and Prettier.

Three independently observed mutation baselines passed 143 tests. All eight
single mutations were rejected by the added named assertions: direct settings
close, direct skill close, each of the five adjacent exit-step swaps, and
unconditional cancellation of the replacement's idle timer on an old exit.
They were assertion failures, not collection errors or timeouts. In the recorded
final-step swap, the original replacement-flow test also failed with
`BridgeChannelClosedError`; it does not directly assert the exit-step order.
The dedicated six-step array assertion is the direct ordering evidence. Two
limited historical witnesses load only the exact `cc0f7c6949` test files over
current production dependencies: the old settings test survives
direct close (46 passed), and the old harness test survives swapping the first
two exit steps (two passed). These are not whole-commit historical runs.

All 13 valid mutation arms retained identical source, test, real-helper and
index hashes. The first observer configuration accidentally concatenated the
package-wide include patterns; it was stopped with exit 130, its original log
and cleanup of observed ports/processes were retained, and it is excluded from
the valid baseline/mutation counts. Exact-file filtering and load receipts
verified each subsequent observation. Evidence is indexed by
`.qwen/investigations/issue-11866-comments/mutation-summary.json`.

All eight serial process scenarios met their positive or expected-negative
acceptance conditions on the frozen artifact. Public multi-session lifecycle,
native watching with 32 skills and active-writer shutdown each measured daemon
exit 0. Both writer seals match their actual 3,604/3,609-byte transcripts and
hashes. Both positive EOF cases measured actual ACP exit 0, complete
524,288-byte fixture content, 1,074,030 stdout bytes and a final newline.
The complete outputs match after normalizing only exact temporary roots and
session UUIDs. Against the previous `f0153063d2` samples, the sole changed leaf
is the bundled workflow-authoring body: 1,668 more UTF-8 bytes, or 1,697 bytes
in the JSON frame. Its source and copied artifact match incoming main exactly;
this cross-version mismatch is retained, not normalized away.

The stalled reader measured actual ACP exit 1 after 2,023 ms with the original
2,000 ms drain error. The closed reader retained EPIPE and actual ACP exit 1.
Both original harness FAIL/script exit 1 results remain expected negatives,
with no forced cleanup signal. The process-query timeout sent SIGTERM at
2,001.07 ms while both pipes remained undestroyed. Timeout and exit-7 queries
both rejected incomplete cleanup proof even though the known owned processes
exited 0 and the registry count reached zero. Independent checks found no owned
PID, process-group or listener residue after any scenario.

All 1,082 artifact files, the separately imported process-registry build and
all 36 non-document candidate files match before and after process testing.
The CLI SHA-256 is
`dc7442c643cc03d8c939bf514d1e4075e70c90f02b9dac401497a1ea133f6074`;
the full dist tree digest is
`317c38b5bda31f45b0a924952a78d3516778f4160d1fee64816726d533562ec5`.
This is evidence for this integration, not a relabeling of earlier artifacts.
The ordinary-prompt fixtures retain the background/permission and latency
coverage limits above; historical full-workspace acceptance remains open.

## Current conflict follow-up: idle-child reclamation integration

Integration with main `9071c4eb705cf92ba517e007eb03b6178d7b8352` ports #11940
idle-child reclamation to the extracted boundary, including candidate recency,
busy guards and startup admission context. Before the port, all six unchanged
upstream idle-reclamation tests failed on missing provider methods. After the
port, the complete ACP bridge suite passed 2,173 tests in 45 files.

Fresh dependency installation, build, workspace typecheck, DEV bundle, all 113
consumed core subpath exports, serve bundle boundary and lockfile checks passed.
ESLint passed for the four changed production files. The first nine-file CLI
run had 2,062 passes and one failure: the invalid `entryIndex=abc` request
expected 400 but received 401. Rerunning the complete server suite in the same
isolated fixture, without changing source or assertions, passed all 1,296
tests. Together with the other eight files' 767 passes, this supplies passing
evidence for 2,063 related assertions, not an all-green original nine-file run.
The original failure remains recorded and unattributed.

The new two-workspace, capacity-one daemon scenario passed on the frozen local
bundle (`FU1SmT`), with an explicit 30,000 ms initialization timeout, 60,000 ms
channel idle timeout and disabled session reaper. Physical children changed from A epoch 1/PID 18795 to B
epoch 1/PID 18878, then A epoch 2/PID 18884. A loaded idle session protected that
last child: B received 503 `acp_child_capacity_exhausted`, A retained its PID and
epoch, and both prompts around the refusal received their own reply and exactly
one correlated terminal event. After session deletion, B started at epoch 2/PID 18951. All five checkpoints reported one committed child; retired child absence
was checked separately. Workspace registration responses and saved registration
bytes remained unchanged.

One SIGTERM produced actual daemon exit 0 and stream close 0, without forced
kill. Independent checks found no owned PID/process group or either listening
port remaining. This is one two-workspace capacity scenario, not exhaustive LRU
ordering, concurrency or latency evidence. Direct ACP exit codes were not
inferred from child absence, and the earlier eight EOF/query/public scenarios
were not rerun for this integration.

The global 0.23.3 baseline rejected `--child-heap-mode admit` and exited 1 before
listening, so no global-versus-local reclamation match is claimed. The first
local observer (`SSviMm`) also failed: it treated listener readiness as runtime
readiness, read `childHeap=null` from `runtime.loading=true` and threw. Its
cleanup SIGTERM interrupted runtime mounting; actual daemon exit 1 is retained.
The corrected observer only polls the existing public readiness field within
its original 45-second observation bound before the same capacity assertions;
the fixture's product configuration, deadlines and assertions did not change.

All 1,083 dist files, four changed production modules and the separately
imported registry build matched before and after the samples. CLI SHA-256 is
`326c87c1a454f0ff42d03066bf66f005877a5ff84c2de632475e677328b3c853`;
the recorded dist manifest digest is
`2dfcc70b196ea01e036301649484eb611a3b9130b733af12e84b866db65c2d12`.
None of the historical totals or artifacts above are relabeled as these
results. Current logs are the `conflict2-*` records in the completion
investigation directory; process evidence is under
`.qwen/investigations/issue-11866-conflict2/`. See the corresponding PR follow-up
for final lint and audit outcomes.

The review also identified a Linux two-file core run with 91 passes and six
skill-manager failures at `b8124075c6`. Its base comparison was blocked by missing
build prerequisites, so the failures remain unattributed. The earlier local
97-pass run does not resolve that Linux observation. A new macOS diagnostic
uses the same isolated fixture and six original assertions: supplying
`QWEN_HOME` produces six failures; removing only that override produces six
passes. The complete two-file run without the override then passed all 97
tests, with unchanged source/test identity. This verifies an override-induced
failure mechanism locally; it does not establish the environment or cause of
the earlier Linux run. The three observations remain separate from the
historical full-workspace failures. Evidence is under
`.qwen/investigations/issue-11866-conflict2/skills-*`.
