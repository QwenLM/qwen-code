# Hosted foreground Shell tool turns

[English](2026-09-27-hosted-shell-tool-turn.md) | [简体中文](2026-09-27-hosted-shell-tool-turn.zh-CN.md)

Status: implemented behind an explicit private profile. Builds on #12831 and
merged O1c #12821.

## Problem and scope

Hosted can run Read, Write and Edit through its saved Workspace, but cannot run
Shell. O1c captures foreground process pipes and admits complete output under a
local Session writer. Hosted instead uses the HTTP Session Store: its ordinary
resource publication is staged in memory until a journal transaction, with a
64 KiB inline limit. Injecting that store into O1c would falsely acknowledge
durability and lose unreferenced pages.

Add an explicitly selected `hosted-workspace-shell/1` profile containing the
existing file tools and foreground `run_shell_command`. Default no-tool and
`hosted-workspace-files/1` behavior remain unchanged. This first bridge supports
the existing same-host process provisioner. It does not add public downloads,
object storage, PTY/background jobs, automatic garbage collection, arbitrary
remote provisioners, or restart/replay of uncertain executions.

## Ownership and transport

The Hosted Session owner opens an ephemeral loopback publisher at
`http://127.0.0.1:<port>/internal/hosted-shell-publisher/v1` with a random capability.
After acquisition, a new private Broker publisher registration installs that
descriptor into the original Runtime Session and returns its binding generation.
The worker accepts only a canonical loopback URL, rejects redirects, and stores
the capability in memory; neither journal references nor model arguments contain
it. No SQL writer token crosses into the worker.

The worker prepares each capture through the private owner listener. Its raw pipe sink forwards bounded write/finish/finalize requests to the owner. Writes and finish are serialized per stream, including pipe callbacks
that overlap when Node resumes a paused stream during process exit. The owner reuses `LocalShellResultCapture`, including its 1 MiB
segments, bounded pages, two-stream backpressure and final manifest. A raw write
reply acknowledges bounded capture buffering; only segment publication replies
acknowledge durable bytes. Lost raw-write replies are not retried. Any uncertain
write or finish irreversibly fails capture, drains the physical process with
bounded memory, and prohibits a complete receipt. Finalization preserves the
physical exit/cancellation result. Model-facing text previews have an additional
8 KiB UTF-8 budget so escaped JSON and receipt metadata fit the existing 64 KiB
history resource limit. Longer previews retain up to 2 KiB from the head and
use the remaining budget for a truncation marker and the tail, cutting only at
UTF-8 boundaries. This preserves trailing failure summaries and exit status.
The tail is from the bounded 64 KiB process buffer; retrieving the true tail of
larger output from durable capture remains follow-up work.
Raw capture bypasses the ordinary temporary-file output
truncator: its preview is not a complete local file. Truncated model text explicitly
reports the execution status and points to retained Session output, without
recommending an inaccessible worker path.

| Route                                  | Owner and checks                                                                                                           |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Broker publisher registration          | Original selected Runtime Session, binding, lease and Workspace ownership                                                  |
| Worker publisher registration          | Authenticated selected runtime; immutable registration for the named Runtime Session                                       |
| Publisher prepare                      | Live Session owner; writer and activation rechecked after checkpoint and argument reads, original execution mapping        |
| Publisher write/finish/finalize/accept | Live Session owner; capability, activation, registered original execution, runtime/model call mapping and capture identity |
| Durable output publication             | Persisted Session; tenant, Workspace, writer token, writer generation and unexpired lease                                  |
| Broker start/status/cancel/ACK         | Original execution and saved protocol selection; no v2 fallback                                                            |

## Durable output storage

Add a narrow writer-fenced Session Store resource publication operation, using
the existing SQL resource table. It admits only tool-result content (at most
1 MiB), pages (256 KiB), and manifests (64 KiB). Ordinary inline publication and
journal transaction bounds are not increased. A successful response follows
the SQL transaction commit. Stable resource IDs are immutable and idempotent;
reusing an ID with different bytes or metadata conflicts.

A Session-owned sequential segment adapter stores each capture/stream/ordinal
under a deterministic resource ID, computes lengths and SHA-256 itself, and
persists an immutable seal after verifying the exact accepted prefix. It is a
foreground producer adapter, not an implementation of arbitrary out-of-order
O1a uploads. Only stdout/stderr and contiguous ordinals are admitted. Active
upload cursors are bounded in memory and are not resumed after owner loss.
Pages and manifests are immediately durable too, avoiding the staged-resource
closure problem. A new reader can verify a retained manifest, pages, seals and
segment bytes after all producer processes have stopped. Resources are retained
with the Session; ACK does not delete them. Publication without admission never
permits model continuation, and abandoned bytes await future Session cleanup.

## Identity, admission and model history

Keep two digests: the existing exact `payloadJson` byte digest protects deferred
Broker start, while `managedToolDigest(input)` identifies Tool v3 arguments.
Persist the model call ID, unique worker call ID, execution ID, input digest and
the explicit v3 selection. Shell `tool.intent.argsRef` holds the actual input;
its route resource retains the Broker payload. The owner verifies this mapping
against the covered `await_runtime` checkpoint before the first side effect.
Hosted explicitly binds that checkpoint to the current turn, prompt and
committing activation, including after detach/load or a Harness restart. An
unfinished turn cannot be relabeled. Each runtime binding stores the worker
call ID in `invocationBindingId`, while its tool item keeps the model call ID. Preparation
rechecks the writer and activation after asynchronous checkpoint/argument reads;
writer checks also revalidate activation after their await.

Extract O1c admission into a shared Session implementation. The local wrapper
retains its current lease/root guards and automatic checkpoint advancement.
Hosted uses its existing HTTP writer and activation, and advances only after
committing the model-facing result. Full output is re-read in bounded ranges
and checked against the original identity and stream digests before committing
`tool.receipt`. The receipt event factory checks the original activation inside
the authority commit queue, so replacement during output verification cannot
admit an old owner’s result. Complete output receives `committed`; partial/unavailable output
receives `blocked`, preserves its physical result and stops the turn.

The order is: acquire/register, persist assistant and intent/checkpoint, execute,
durable capture, durable receipt, model result, checkpoint resolution, exact ACK,
next inference, result consumption, release. The worker's remote accept returns
the same durable Session receipt; later ACK only replays it. Lost execute replies
use bounded status reconciliation on the original v3 reference. Never reissue a
Shell side effect after unknown status or missing admission. Lost receipt replies
may replay the identical candidate against the recorded receipt. New activations
continue to refuse unresolved old tool turns.

An admitted Shell result must fit the complete serialized history record. If
this invariant fails, retain recovery-blocked ownership without committing an
omission response or acknowledging the result: changing history while reusing
the admitted outcome reference would make them disagree. File-tool results
continue to use their bounded omission response when oversized.

## Lifecycle and failure handling

Runtime warming still overlaps inference. File-only or text-only turns do not
need Shell publication. Shell parameters reject background execution and use the
saved Workspace directory. Invalid Shell arguments return durable function
errors before acquisition or dispatch. If any Shell call is invalid, the entire
batch is refused and each other call explicitly reports that it did not run;
the model can correct the batch within the same turn. Failure to persist that
refusal blocks recovery. An unavailable publisher is rejected before spawn.
Publisher failure, writer loss, unknown execution, receipt/history/ACK failure,
or unconfirmed cancellation retains recovery-blocked ownership. Cancellation
before start remains `not_started` with null capture; after start it requires the
physical process outcome and capture admission. Stop publisher ingress and drain
pending operations before closing the Session writer. A completed turn closes
its private listener without deleting retained output.

## Implementation and validation

Affected layers: core HTTP resource client and shared Shell admission/segment
adapter; CLI Hosted profile, publisher and worker proxy; Java Session Store,
Broker original-execution routing and Workspace transport. No ordinary daemon
route is added or rerouted.

Focused tests cover immutable publication and stale writers, segment prefix and
seal integrity, cross-Session/activation identity, lost raw replies, admission
before history, exact ACK, cancellation and unchanged file-only/no-tool behavior.
They also pin head/tail UTF-8 previews, refused-batch recovery, publisher bearer
authentication, listener closure after completed and failed turns, and the
admitted-result history bound with worst-case JSON escaping.
A real-process test runs the packaged Harness and worker through production Java
Broker and SQL Store, checks the selected Workspace with a Harness decoy, writes
100 MiB with independent stdout/stderr digests and tails, then re-reads retained
output after producer shutdown. Faults must leave side effects at most once and
must not trigger the next model request. Build, typecheck, bundle and two clean
full-diff audits precede review. The global CLI baseline is recorded separately;
absence of its private Hosted routes is not reported as a passing feature test.

Acceptance requires actual cross-process complete capture and durable admission,
not merely a v3 HTTP response. There are no unresolved product choices; public
artifact access, distributed storage and recovery remain follow-up work.
Per-call/Session storage quotas and reducing writer-lease renewal frequency also
remain follow-ups; this change does not alter durable publication or fencing.

Local validation uses macOS, Node.js 22 and Java 21 with real processes and H2 in
MySQL mode. The six-Workspace fixture verifies complete 100 MiB output, SQL
publication failure, lost raw/start replies, cancellation, and a fresh reader
after producer shutdown. It does not validate a real MySQL deployment, Windows,
Linux, or a real model provider.
