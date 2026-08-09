# Transactional WebUI session switching

## Context

Issue #8678 showed two separate large-session problems. The restore request could exceed the former shared ten-second timeout, and the WebUI detached the visible session before the target restore had completed. The timeout and daemon-side resource-safety work is handled by #8691. This design addresses the client-side ownership gap: a failed, timed-out, or superseded restore must not erase a healthy session that the user was already viewing.

The core invariant is that the currently committed session owns the transcript, event stream, workspace metadata, active prompt waiters, and session-scoped actions until a target restore has completed remote work, local replay staging, and a final generation/deadline check. A target failure leaves the committed session visibly unchanged.

## Compatibility contract

Transactional switching requires a successful daemon capability snapshot that advertises `client_identity`, plus concrete non-empty client ids for both the committed source and every restored candidate. A daemon that explicitly omits the feature uses the existing detach-first path. An unavailable capability snapshot, or a modern response that omits an advertised client identity, fails closed while preserving the source.

`DaemonConnectionState.sessionTransition` exposes `queued`, `preparing`, and `failed` phases. Only queued and preparing block new session mutations. Failed is diagnostic and recoverable; the source remains usable and controlled WebShell hosts are asked to restore their committed target.

## Desired and committed ownership

The provider keeps desired props separate from committed refs. Changes to session id, workspace, restore mode, or requested client identity enter a coordinator instead of restarting the current runner. Initial mount without a committed session retains the existing bootstrap path.

The main WebShell workspace wrapper no longer keys the provider by session or workspace. While a desired workspace is resolving or being registered, the committed App remains mounted and its mutation UI is gated. A terminal target-resolution or restore failure is latched for that desired generation, so unrelated rerenders cannot create a retry loop; the host callback receives the still-committed tuple. Split-view panes keep their existing independent providers and keys.

## Coordinator and terminal arbitration

Each provider runs at most one ordinary load, resume, reload, resync, or repair RPC. Identical requests coalesce. A newer request rejects the older public intent with `AbortError`, replaces the single queued target, and waits for the non-cancellable raw request to settle before starting. The queued target inherits an absolute deadline from its original invocation, so an expired request is never sent later.

SDK settlement, watchdog, caller abort, supersede, and commit use explicit state rather than `Promise.race` ordering. A final check covers intent identity, provider generation, owner generation, target identity, abort state, and the absolute deadline after staging and immediately before commit. User and controlled requests take precedence over automatic full resync, which in turn takes precedence over memory repair.

## Pure staging and commit

The candidate replay is materialized in a temporary transcript store. Transcript state, pagination anchors, connection metadata, notices, workspace signals, follow-up and mid-turn side channels, pending permissions, prompt terminal events, and live-journal repair state remain local until commit. A malformed event may produce a staged warning, but neither that warning nor any other side effect is published if staging fails or the intent is superseded.

Commit is a synchronous linearization point:

1. claim public success and remove the watchdog and abort listener;
2. flush the source's already-valid transcript batch, increment the owner generation, and stop the source runner;
3. install the candidate transcript, history, session ref, workspace, client id, and synchronous connection ref;
4. publish staged notices and side channels;
5. settle or rebind prompt waiters;
6. resolve the public load promise;
7. start candidate metadata and SSE work;
8. issue one non-blocking best-effort detach for the source.

The public promise therefore observes a consistent candidate owner and transcript but does not wait for React rendering, metadata, SSE connection, or source detach. Detach uses the frozen endpoint, token, session id, and client id, is attempted at most once, and never blocks a later restore. Failures are consumed and logged.

## Events, resync, and prompts

Ordinary target preparation leaves the source SSE and existing prompt/control work active. Every runner cleanup is scoped to the session and generation captured by that runner; it cannot read a later global session ref and accidentally clear the new owner. Session-scoped asynchronous completions likewise verify captured owner identity before modifying shared UI state.

`state_resync_required` is the exception to continued streaming. Events before the sentinel are synchronously flushed, the stream generation advances at the sentinel, and already-yielded or buffered suffix events are discarded. The stale stream stops immediately, but the source attachment and legal transcript prefix remain frozen. A failed reload leaves that prefix visible with a recoverable warning; a successful reload atomically replaces it.

On a cross-session commit, the candidate is installed before source prompt waiters are locally rejected, and no daemon prompt cancellation is sent. On same-session reload, a staged terminal settles a matching waiter; otherwise an active daemon prompt is rebound, while an authoritative inactive snapshot deterministically ends an already-bound waiter.

## WebShell integration

Sidebar, overview, open-session events, `/resume`, the resume dialog, and bound scheduled runs share the same transactional open helper and an invocation token. Completion code checks the committed owner tuple together with the invocation token, preventing an older same-session request from clearing a newer spinner or firing work against its target.

The main composer and split-view `ChatPane` both inspect the public transition state before running slash handlers or optimistic input side effects. New prompts, shell/model/mode mutations, and conflicting session operations are gated while cancel, permission responses, existing prompt completion, and read-only controls remain available on the committed source.

Worktree, branch, git-mode intent, and recap generation are not cleared before restore. Session-scoped metadata is keyed to its committed owner so the first candidate render cannot display source metadata. Bound scheduled runs rely on the restore promise for the restore phase; the existing 30-second timer begins only after commit and limits catch-up.

## Deliberate limits

This change does not optimize JSONL reading, replay size, checkpoints, or selective restore. Staging briefly holds the source transcript and candidate replay together. A CPU-heavy restore in a shared ACP child may still delay source event delivery even though ownership remains correct.

There is no global attachment scheduler, cleanup registry, or daemon-wide A+1 live-session guarantee. Fresh create/attach, SDK self-heal, branch creation/adoption, and cross-provider resource accounting remain outside this PR. Best-effort detach failure can retain an invisible client reference until the existing server reaper runs. These resource guarantees would require a wider daemon/wire design and are intentionally not implied by the visible-state transaction implemented here.

## Verification

Unit tests cover capability gating, target coalescing, latest-only serialization, deadlines, late candidates, atomic transcript commit, source prompt and control continuity, stale async completions, controlled workspace resolution, metadata ownership, and post-commit scheduled-run catch-up. A focused JSDOM/real-daemon scenario delays the target response while exercising the source, then checks atomic handoff and failure preservation. An approximately 80 MiB transcript remains manual memory and tracing evidence rather than a timing assertion.
