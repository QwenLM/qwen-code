# Complete the ACP control-plane / harness boundary

[English](2026-09-15-acp-bridge-completion.md) | [简体中文](2026-09-15-acp-bridge-completion.zh-CN.md)

Status: local implementation and planned verification complete; full-suite
acceptance remains open, 2026-09-15.
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
The watcher, process-query and EOF shutdown fixes have separate evidence.

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

This section records the candidate committed as `88a5eb2bce`, based on
`9efdd898e7`, before integration with updated main. Its counts and test results
are retained as historical evidence for that candidate.

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
cwd, shell and shutdown. The total await count remains 270; the per-body and
wiring checks establish ordering, rather than the count alone. A mutation that
removes the required exit order is rejected by the added regression test.

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

## Integration with updated main

The submitted candidate integrates main at
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
