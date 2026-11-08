# Conversations Ownership Cutover Plan

Date: 2026-09-06

Design: [Relaxed Standalone Daemon Ownership](../design/2026-09-02-relaxed-standalone-daemon-ownership.md)

Tracking: [#10810](https://github.com/QwenLM/qwen-code/issues/10810)

Inspected checkout: `a6549509c63a779e911fd5c846684f2140aed3bb`.
The mandatory writer fences are already merged as
`cf44c778c0775d640560143828d851fa30dbd893` (#10924).

## Outcome

Two updated daemons sharing one user's Conversations root can list sessions,
create chats, and use different sessions concurrently. The same session stays
exclusive for its loaded lifetime, with a structured writer conflict on a
second daemon. Live activation remains exclusive to the stable locator's exact
publisher. A failure affecting one session or Live does not disable unrelated
standalone sessions.

The backend and Web Shell cutover are implemented locally in this change.
This is not a release-completion claim. Recheck integration points after
updating the implementation branch to its eventual base.

The global CLI dry-run reached a healthy isolated daemon, but version `0.22.2`
does not advertise standalone support and both standalone GET routes return 404. This is not an ownership reproduction. The pre-cutover source containing
#10924 was therefore built before implementation: A returned 200, B returned
503 `conversation_runtime_in_use`, and B recovered after A stopped without
restarting B. Both parent and ACP child used the worktree's 0.23.0 bundle.

## Delivery order

1. Implement explicit Live-start admission while the outer Conversations owner
   still exists, with focused tests for later stop/new/toggle intents.
2. In the same backend cutover change, replace the long-lived owner with the
   legacy compatibility check, move journal bootstrap and Live publication
   handoff to their consumers, and handle journal lease contention as a skip.
3. Deliver session-local Web Shell errors and operator recovery guidance.
   This can be a companion PR and can land before the backend cutover.
4. Verify the combined release with real daemon processes, then document the
   coordinated upgrade and rollback procedure. Backend and client changes
   must ship together.

Steps 1 and 2 are one backend delivery unit: removing the owner before its
implicit responsibilities have replacements is not a releasable intermediate
state. Avoid unrelated owner-code cleanup or a new ownership mode.

## Backend implementation map

| Area                                                                     | Current responsibility                                                                     | Required change                                                                                                                                                               |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/serve/conversations/conversation-runtime-manager.ts`   | `ensureOnce()` acquires the long-lived owner before runtime access                         | Run a legacy compatibility check before first publication; retain exact-root, generation, trust, mandatory-lease attestation, and quarantine checks                           |
| `packages/cli/src/serve/conversations/conversation-runtime-ownership.ts` | Owner creation, validation, liveness, retirement, directory bootstrap, stable Live handoff | Reuse the strict parser, checked directory lock, exact stale retirement, durability, and grace for inspect-and-retire; never create a new owner record on the updated path    |
| `packages/cli/src/serve/server.ts` and `serve-app-lifecycle.ts`          | Construct and drain/release the Conversations owner                                        | Wire the compatibility check; remove lifetime owner registration/release while preserving listener, host, runtime, and child drains                                           |
| `packages/cli/src/serve/conversations/standalone-deletion-journal.ts`    | Relies on state-parent bootstrap previously performed by ownership acquisition             | Own its minimal directory creation and identity validation; revalidate the parent on every read/recover/clear/write path                                                      |
| `packages/cli/src/serve/conversations/standalone-session-service.ts`     | Lifecycle leases and daemon-local journal reconciliation                                   | Retain leases and the existing per-entry sweep catch; prove ordinary contention is skipped without failing the trigger, while direct mutations keep their structured conflict |
| `packages/cli/src/serve/live/discovery.ts` and `run-qwen-serve.ts`       | Live publication and custom-base handoff                                                   | Run validated handoff for the stable base too, preserving post-lock grace and the final publication lock; publication failure remains Live-local                              |
| `packages/cli/src/serve/routes/live.ts` and Live host coordination       | HTTP and Host actions can activate Live                                                    | Require current protocol plus exact local PID/instance nonce at one admission seam; recheck pending action generation before activation                                       |
| Conversations task rehydration and keepalive                             | Restore bound tasks and transactionally bind unbound tasks                                 | Keep #10924's fences; verify losing restores do not fire tasks or create task-run results                                                                                     |

The journal's private `conversations/` leaf and subtree remain `0700` on POSIX.
An existing same-owner, non-symlink stable root such as a `0755` home `.qwen`
directory stays valid. Moving bootstrap must not chmod ancestors or require
Live publication to have happened. Parent validation must also cover the
`pendingClears` fast paths in journal read and clear operations. The existing
reconciliation sweep already catches per-entry failures; add contention
evidence before deciding it needs code changes.

The legacy check honors a live valid owner, retires only an exactly revalidated
stale record under its directory lock, and preserves malformed/unsafe/unknown
failures. It runs before publication and retries after a previous failed
initialization; it does not poll after the runtime has been published. Keep
the legacy owner implementation/tests needed by compatibility and avoid a
cleanup sweep in this change.

Live admission covers `/live/start`, `/live/new`, Host toggle, and Host new.
Later start/new/stop/toggle intents from either entry family supersede pending
admission. Capture the action generation before any await, including the
HTTP route's current `ensureRuntimeReady()` await. Deactivation and disposal
also invalidate pending admission. Preserve the originating generation through
the delayed new-call continuation. A superseded request must not create a
session, start microphone or Appshot capture, or schedule a later call. Missing
or unsafe locator state fails Live closed without quarantining Conversations.

## Client and recovery

The client work has three existing integration points:

- `packages/web-shell/client/components/sidebar/StandaloneRecents.tsx`:
  active/archived/pagination reads and `openSession()` currently call global
  `onError`; replace those paths with local state and existing load generations.
- `packages/web-shell/client/daemon/session/DaemonSessionProvider.tsx`:
  preserve the structured standalone error code and stop automatic restore
  retries for `session_writer_conflict` and `session_writer_unavailable` on
  standalone attach/restore, waiting for explicit retry. Ordinary network/SSE
  reconnection for an established session remains unchanged.
- `packages/web-shell/client/App.tsx`: its connection-error effect must not
  notify the host again for an error already presented in the standalone UI.
  Direct links and initial page restore may bypass Recents' click handler;
  present their connection session ID/error code with a section-level retry
  before suppressing the host notification. Keep the original error propagated
  by `loadSidebarSession()`.

Use existing session error codes and the existing retry actions:

- Recents list failures, including transitional `conversation_runtime_in_use`,
  render once in that section. Navigation-triggered refetches do not toast.
- `session_writer_conflict` and `session_writer_unavailable` on open render on
  the affected session or section. Do not silently create a replacement chat.
- `409 session_writer_conflict` means the writer fence prevents access; it does
  not always prove a second process is currently alive. Copy must account for
  unresolved locks, and must not classify unrelated 409 errors as writer locks.
- Keep batch archive/delete transport status 200 and inspect each error item;
  do not treat a successful envelope as a successful operation on every item.

For the first release, keep the existing identity-qualified reclaim policy and
add local diagnostic/recovery guidance. Preserve the fixed, path-free public
HTTP/ACP error contract. Exact lock paths belong in local operator diagnostics,
never alongside owner tokens. Diagnostics must resolve the affected runtime's
storage, not the primary workspace or a guessed default directory.

The recovery guide distinguishes normal close, certified sealed takeover,
same-domain dead active writers, foreign/missing identity, and malformed or
residual claim state. It requires stopping or otherwise fencing every possible
writer, including ACP children, before handling an exact residual lock, and
retaining evidence/backups before any manual cleanup. It must not prescribe a
recursive lock-directory deletion or imply an absent foreign-namespace PID is
proof of death. Cross-boot automatic reclaim, TTLs, a new persisted machine ID,
and force-unlock API/UI are separate work.

## Acceptance evidence

Run real daemons sharing one isolated home, Conversations root, and runtime
base. Use distinct workspaces and ephemeral loopback ports. Record daemon and
ACP child binaries/PIDs to prevent an installed child from invalidating a
local-build test. Use a deterministic local provider if prompting is needed.

| Scenario                       | Required observation                                                                                                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two updated daemons            | Both list and retrieve session options with 200; neither writes `runtime-owner.json`                                                                                                   |
| A holds S, B uses T            | B lists, creates T, and prompts a different session while A retains S                                                                                                                  |
| B competes for S               | Load/resume and direct mutations return writer conflict; archive/delete return a per-item conflict inside 200                                                                          |
| A closes S                     | B restores and appends after A's last authoritative record; verify parent UUID continuity                                                                                              |
| Graceful shutdown or idle reap | Certified handoff and ordinary release each permit subsequent restore                                                                                                                  |
| Non-cooperative death          | Same-domain dead ACP writer is recoverable; killing only the daemon while its writer survives does not allow takeover                                                                  |
| Ambiguous locks                | Live/stalled/foreign/missing-identity writers stay fenced; malformed/claim states preserve their error classification and receive accurate guidance                                    |
| Legacy owner                   | Live owner yields transitional 503; after its exit the next request succeeds without restarting the new daemon                                                                         |
| Journal concurrency            | One daemon reconciles an entry; the loser's unrelated triggering operation succeeds                                                                                                    |
| Scheduled tasks                | One bound session becomes resident; one unbound task binding wins, losing orphans close, and no task fires before binding                                                              |
| Live admission                 | Only the exact stable publisher can activate through HTTP or Host actions; a pending start superseded by stop stays stopped                                                            |
| Filesystem isolation           | Missing journal parent bootstraps safely; replacements/unsafe leaves fail closed without primary fallback                                                                              |
| Web Shell                      | Recents clicks and direct-link/initial restores show local errors and explicit retry without restore loops or duplicate host notification; stale errors do not leak to another session |
| Upgrade and rollback           | All old writers drain before new startup; rollback handles active, sealed, claim, and extended-schema records explicitly                                                               |

The detailed baseline and release verification plan lives at
`.qwen/e2e-tests/2026-09-06-conversations-ownership-cutover.md`.

For implementation, run root `npm run build`, `npm run typecheck`, and
`npm run bundle`, focused Vitest suites from each changed package, and
`npm run check:serve-fast-path-bundle`. Follow with the real two-process and
client scenarios. Linux-specific boot/namespace cases require Linux evidence;
a macOS run cannot satisfy them. Review the complete diff and new files using
the repository's two-clean-pass self-audit rule before code review.

## Local verification and release gates

On macOS with Node 22, real isolated daemons and ACP children verified:
both daemons can serve standalone without a new global owner; different
session prompts overlap; same-session operations retain writer conflicts;
closing the owner allows another daemon to append with the original transcript
prefix and parent UUID continuity intact. A stalled surviving ACP writer
remains fenced after its daemon is killed, and confirmed writer death permits
recovery. Journal contention does not fail unrelated creates. Competing task
watchers converge on one binding/resident, including after restart. A foreign
Live publisher rejects HTTP start/new while standalone prompting still works.
A strict V1 owner fixture with a real holder process verifies transitional
503 and retry after exit; this is not mixed-binary upgrade coverage.

Browser integration against a mock daemon verified local 409/503 presentation,
no automatic restore loop before or after refresh, explicit same-session
retry, list-row preservation on refetch failure, accessible rename retry, and
discarding late errors after navigation. These browser tests and the real
backend tests are separate evidence, not a combined native Host/audio test.
Focused unit tests cover directory replacement, legacy failures, publisher
identity, canceled Host/HTTP admission, batch error codes, and client retry
behavior. The full server suite passed 1,226 tests after one archive test's
initial intermittent failure passed both focused and full-suite reruns.
One workspace-extension activation test also returned an unexpected 404 in
a concurrent verification run; its complete 51-test file passed on rerun.
Neither intermittent failure was attributed to or fixed by this change.

The final local build, workspace/integration typecheck, production bundle,
serve fast-path bundle closure check, and changed-file ESLint passed. The
final Web Shell run passed 1,063 tests and the core writer-lease run passed
99 tests with 10 platform skips. Two clean source/test self-audit passes and
an independent read-only review found no confirmed new defect. This is not
maintainer gate approval for a cross-package architecture change.

Release still needs Linux boot/PID-namespace evidence, native Live Host/audio
validation with credentials, and coordinated upgrade/rollback validation.
The real task test did not pause inside the binding transaction or directly
inspect losing orphan cleanup; existing lease/task tests remain important.
Rapid shutdown during ACP preheat produced an exit 1 in both baseline and
cutover fixtures, so these runs do not certify universally clean shutdown.
No fixture daemon or ACP process was left running.

Detailed backend/browser evidence and retained fixture paths are recorded in
`.qwen/e2e-tests/2026-09-06-conversations-ownership-cutover.md`.
This ignored report is a working artifact; this section preserves its
scope and limitations for the implementation review.

## Boundaries

Preserve #10924's mandatory lease, provenance, directory-generation pin, and
unbound-task eligibility behavior. Keep ordinary workspace lease settings
unchanged. Do not add cross-daemon forwarding, an owner index, active-elsewhere
catalog hints, a shared cache invalidation system, a global lifecycle lock, or
an ownership feature flag. Different sessions can be concurrent; the same
session cannot be concurrently edited, and scheduled delivery remains subject
to its existing at-least-once window.
