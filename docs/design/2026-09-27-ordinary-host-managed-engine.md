# Ordinary-host Managed engine

[English](./2026-09-27-ordinary-host-managed-engine.md) | [简体中文](./2026-09-27-ordinary-host-managed-engine.zh-CN.md)

## Status

Design for the Managed execution engine of ordinary `qwen serve` hosts, the
part of #12737 that [paired engine host wiring](./2026-09-26-paired-engine-host-wiring.md)
(B2d, #12828) left out of scope, for #12380. Based on upstream `302e7d88ef`.
It implements the "Managed engine seam" and the "Configuration compatibility
contract" of the B2d design and splits the work into slices M1 to M6. Slice M1,
the preconditions the B2d design requires before any Managed session exists
(Legacy refusal and purpose marking), is implemented with this document. M2 to
M6 are proposals; each lands with its own design update.

The reference implementation is the branch
`doudouOUC/qwen-code:feature/managed-agents-p0-p8` at `032392a673`. This
document records what is brought upstream, in which order, and where the
upstream port deliberately differs.

## Problem and current behavior

B2d pairs the daemon's ordinary workspace runtimes behind
`--experimental-paired-engines`, but registers no Managed engine: every new
session of a paired runtime runs on Legacy, and a Managed owner is refused with
409 `session_execution_engine_unavailable`. Upstream has none of the parts such
an engine needs:

- The only production ACP agent is `QwenAgent`, built inside `runAcpAgent`. It
  is bound to the process's stdin and stdout, deletes environment variables
  and redirects the console. `createInMemoryChannel` exists but has no
  production caller.
- On ordinary hosts, every tool runs in the process that hosts the session.
  The Managed Runtime worker (`qwen managed-runtime-worker`) runs Read, Write,
  Edit and foreground Shell over the tool v2 routes, but only the Java Broker
  launches it; the Hosted Harness reaches it through that Broker for its gated
  Read, Write and Edit turns (#12831). `LocalManagedRuntimeProvider` depends on
  Bridge methods that nothing implements, and `LocalProcessRuntimeActivator`
  speaks a boot protocol the worker does not; neither has a production caller.
- The Managed Session authority (#12693) writes logs only for the Hosted
  Harness, through HTTP stores; nothing in production writes a Managed Session
  log through its local JSONL journal and resource stores. The Hosted Harness
  runs its own model loop, served over HTTP and SSE rather than ACP, and its
  tool turns need the Java Runtime Broker.
- Reading configuration has side effects or loses evidence. `loadSettings`
  migrates, backs up and rewrites settings files; the extension store locks,
  recovers and writes when read; a `.mcp.json` read error counts as an absent
  file and its parse errors are only printed. No read-only snapshot can prove a
  configuration compatible.

Two preconditions that the B2d design places before the first Managed session
were also open:

- An unpaired Legacy host refuses to execute, record, rename or fork a
  transcript that carries the Managed Session header, but not one whose only
  Managed evidence is a `session_execution_engine` owner record naming
  `managed`. Switching the opt-in off could then let a Managed session run on
  Legacy.
- The replacement session of a worktree reset is created without `worktree`
  and moved into the checkout afterwards, so the purpose rules treat it as an
  ordinary creation. Whether a thread that a Live conversation starts in a
  project is a Live purpose was undecided.

## Scope

In scope:

- The definition of the ordinary-host Managed engine and the decisions the B2d
  design left to it: the owner record and the Managed Session header, the
  workspace-control case with only Managed live, the bounded evaluation, the
  revalidation inputs and the purpose marking.
- The slice plan M1 to M6 with their exit checks.
- The implementation of M1.

Out of scope: default enablement; Hosted sessions on a paired Bridge; Managed
branching, which stays rejected; Stage G takeover; Stage H extensions (MCP,
Hooks, background Shell, child agents) on Managed sessions; the Java-backed
Managed WebShell product path; any daemon route or REST shape change.

## Proposed design

### What the engine is

Per paired workspace runtime, the engine is one Managed `ChannelFactory` and
one compatibility evaluation, registered through the seam B2d defined.

- **In-process host.** A channel is an in-memory ACP stream pair whose agent
  side is the ordinary `QwenAgent`, hosted in the daemon process instead of a
  child. Sessions keep Legacy's session behavior: prompts, permissions,
  approvals, compaction, model changes and the model loop.
- **Tools in the Runtime.** The Managed host registers only Runtime-backed
  tools. A tool call is prepared and permission-checked in the host, then
  executed by a local Runtime worker that the daemon launches for the session
  and binds to its workspace directory. The host never performs a tool's side
  effect itself. The first phase supports the worker's existing tool set:
  Read, Write, Edit and foreground Shell. Other tools are not registered for
  Managed sessions, and a configuration that needs them evaluates as
  `deferred`. Unlike the Hosted tool turns of #12831, which drive the Java
  Runtime Broker from the Hosted loop with a preapproved configuration, the
  ordinary host keeps `QwenAgent`'s permission and approval flow and needs no
  Java service.
- **Managed Session log.** A Managed session is recorded as a Managed Session
  log in the session's transcript file, through the #12693 authority with its
  local JSONL journal and resource stores. The authority writes the `managed`
  owner record and then the Managed Session header in its first transaction,
  and the host's recorder writes through the authority's record sink.
- **Owner and receipt.** The host follows the B2a contract with `managed`:
  before any initialization side effect it creates or opens the log, which
  persists or verifies the owner, and only then returns
  `_meta['qwen.session.executionEngine'] = 'managed'`.
- **Registration last.** A paired runtime registers the engine only when it
  can run the first-phase tool set in the Runtime. Until then B2d's
  placeholder factory stays, and no session selects Managed.

### Decisions

1. **The owner record and the Managed Session header.** A Managed session is a
   Managed Session log, not an ordinary transcript with a `managed` owner
   record. Legacy entries already refuse the header when they execute, record,
   rename or fork; the log is the format the Hosted Harness writes and Stage G
   externalizes; recovering Runtime tool work needs the authority's journal
   and checkpoints; and the paired selector already reads owners from such
   logs, whose record types are known. The owner record stays the engine's
   identity and the header identifies the format. M1 makes a `managed` owner
   record alone enough for Legacy to refuse, so the refusal does not depend on
   the header being present.
2. **An in-process host.** The Runtime, not the host, owns tool side effects,
   so the host process only runs model loops, and #12380 places that loop in
   `qwen serve`, with several sessions able to share it. The Bridge channel
   contract already allows an in-process channel: `killSync` tears it down in
   process and `exited` may resolve without an exit code. The host therefore
   has to keep process-global effects with the process owner (stdin and
   stdout, environment deletion, console redirection, the event-loop monitor)
   and take its runtime environment explicitly.
3. **Workspace control with only Managed live.** Workspace control stays
   Legacy-scoped (#12737 Q4). Today, when Legacy is not live, a permission-rule
   change fails before anything is applied, because Legacy workspace control
   is what persists it, so it never reaches live Managed sessions; the other
   session-affecting changes reach Managed but report the missing control
   channel as a failure. The engine starts the Legacy workspace-control channel
   for a session-affecting change when it is not live, as some
   workspace-control commands already do, applies the change there and then
   delivers it to Managed through B2b's `qwen/control/workspace/change`. A
   change is never refused only because Legacy is idle.
4. **A bounded evaluation.** The evaluation reads local files only (settings
   layers, `.mcp.json`, extension directories and store metadata), never the
   network, and starts no process. It settles well within the Bridge's
   selection budget, the initialize timeout of 10 seconds by default. A thrown
   or rejected evaluation counts as `unknown`; the engine logs the source
   category and the reason, never configuration values or credentials.
5. **Revalidation inputs.** The host does not receive the selector's snapshot.
   Before Hooks, MCP, tools or the model start, it reads the same strict
   snapshot again from the configuration it will actually use and applies the
   same evaluation. A result other than `compatible` fails the creation or
   restore with `SessionExecutionEngineError`, answered as 409, and never
   falls back to Legacy. Channel startup separates selection from
   initialization, so a change in between must fail rather than reach Managed
   with a deferred capability.
6. **Purpose marking.** The worktree reset replacement carries its worktree
   metadata from the spawn (M1). A thread that a Live conversation starts in a
   project is an ordinary creation: the Live task tools list and drive every
   thread of every runtime, whoever created it, so marking the threads Live
   created would isolate nothing. The Live conversation itself runs on the
   Conversations runtime, which is never paired. The other internal creators
   already mark their sessions (see M1).
7. **Positive evidence only.** Legacy refuses a transcript only on positive
   Managed evidence. The owner reader reports `unavailable` for a transcript
   with a line that does not parse whole or an unknown record type; gating
   unpaired hosts on it would refuse crash-truncated Legacy sessions, the
   stricter restore that B2d accepted only behind the opt-in. The reference
   implementation asserted a verified `legacy` owner instead; the upstream
   port does not.

### Invariants

The B2d invariants hold. In addition:

1. A Managed session never runs a tool's side effect in the host process.
2. A Legacy entry never executes, records or forks a transcript that positively
   identifies as Managed, paired or not.
3. A paired runtime registers the engine only when it can run the first-phase
   tool set in the Runtime.

### Slice plan

| Slice                                  | Deliverable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Exit check                                                                                                                                                                                                                                                                                                                                                                           | Reference                                             |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| **M1 — preconditions** (this change)   | Legacy refusal of a `managed` owner record; worktree reset purpose marking; the Live task decision; this design.                                                                                                                                                                                                                                                                                                                                                                                          | See the M1 acceptance criteria.                                                                                                                                                                                                                                                                                                                                                      | `2f00ac26e3` (refusal, reworked to positive evidence) |
| **M2 — in-process ACP host**           | Split `runAcpAgent` into the process owner (stdio, environment deletion, console redirection, event-loop monitor, exit) and a host that serves `QwenAgent` on any ACP stream and releases everything it owns on disposal without exiting the process. `runAcpAgent` uses the host.                                                                                                                                                                                                                        | ACP suites unchanged; a host on `createInMemoryChannel` creates, prompts and closes a session, then disposes with no leaked handles, timers, MCP clients or environment changes.                                                                                                                                                                                                     | `bf06117511`, `d63eec71a1`                            |
| **M3 — strict configuration snapshot** | A read-only snapshot of every configuration input in the compatibility contract: settings layers read without migration writes, backups or resets (in-memory migration only; missing, unreadable, corrupt and unknown-version layers kept distinct), `.mcp.json` with its errors, Hooks from every source, a lock-free proof that the extension store is empty, forwarded argv, trust and cwd, and request options; plus the evaluation that returns `compatible`, `deferred` or `unknown` with a reason. | Reading leaves every byte and every metadata file unchanged; each input source alone makes a configuration `deferred` or `unknown`; an evaluation of an empty trusted workspace is `compatible`.                                                                                                                                                                                     | `a836081466`, `306cf17546`, `d48161bc4a`              |
| **M4 — Managed Session log recording** | The host's recorder writes through the authority's record sink under the certified writer lease; restore reads the log's projection; the log is sealed on close.                                                                                                                                                                                                                                                                                                                                          | A session recorded this way restores with the same history; Legacy entries refuse it by its header; a crash before the first commit leaves no Managed session that Legacy can run.                                                                                                                                                                                                   | `e98cda5c95`, `1ed806ca85`, `f501d9694d`              |
| **M5 — Runtime-backed tools**          | A session-exclusive local Runtime worker launched lazily at the first tool call and bound to the session's directory; Read, Write, Edit and foreground Shell declared without waiting for the worker, prepared and permission-checked in the host, executed in the worker; cancellation that reaches the worker's processes; results durable in the log before the model continues; an unknown outcome blocks instead of replaying.                                                                       | The host performs no file write or process spawn for a tool call; cancellation has physical-stop evidence; a lost result blocks the session.                                                                                                                                                                                                                                         | `7786edd123`, `5dde5c8dd7`, `174e072ac4`              |
| **M6 — the engine**                    | The Managed channel factory (M2 host, M4 recording, M5 tools, M3 revalidation, owner and receipt), the extension methods the Bridge calls on a Managed channel (session close, workspace-change acknowledgement, user language, resource snapshot), the workspace-control decision, registration at the three daemon sites and the embedded default behind `--experimental-paired-engines`, and lifecycle (shutdown, drain, revoke, generation and environment reload).                                   | On a paired daemon, an ordinary new session in a trusted workspace with an empty configuration runs on Managed through the real routes: create, prompt, tool call, cancel, close, and a cold restore after a daemon restart. A deferred configuration stays on Legacy, a new deny rule reaches the live Managed session, and with the opt-in off Legacy refuses the Managed session. | `824e92d84f`, `306cf17546`                            |

M2 and M3 are independent of each other. M4 and M5 need M2. M6 needs all of
them and is the only slice that can make a session select Managed.

### M1: preconditions

#### Legacy refusal

Positive Managed evidence is the Managed Session header, as before, or a
complete transcript line whose record is `type: "system"` with `subtype:
"session_execution_engine"` and `systemPayload.engine: "managed"`. Text inside
a message does not count. A Managed owner is written before anything else, so
the check reads the same 64 KiB head window as the header check. It fails
open on a read error, like the header check: an unreadable transcript fails
later on its own.

The three existing refusal points take the new check. Every Legacy entry that
executes, records or forks a transcript reaches one of them:

| Entry                                                                                                                          | Refusal point                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| CLI `--resume` and `--continue`                                                                                                | `loadCliConfig` → `SessionService.assertLegacySessionExecution`                                                     |
| CLI `--fork-session`                                                                                                           | the same, then `SessionService.forkSession`                                                                         |
| ACP cold `session/load` and `session/resume` on an unpaired host, including IDE clients, channels and unpaired daemon runtimes | `loadCliConfig` → `assertLegacySessionExecution`, answered as -32024 and 409 `session_execution_engine_unavailable` |
| ACP session source copy                                                                                                        | its temporary resume Config through `loadCliConfig`                                                                 |
| TUI `/resume` (Ink and OpenTUI)                                                                                                | `assertLegacySessionExecution`                                                                                      |
| TUI `/branch`, ACP branch and side task                                                                                        | `SessionService.forkSession`                                                                                        |
| A recorder writing without the writer lease                                                                                    | the conversation file check in `ChatRecordingService`                                                               |

A hot attach or live load reuses a live session, which a Legacy child only
holds for Legacy sessions. Read-only transcript reads, replay and listing stay
available. Renaming and the sealed maintenance lease keep the header-only
check, as does the reader's choice of the Managed projection: they depend on
the Managed Session log format (a Managed title is a committed domain record),
which an owner record alone does not have. Paired hosts are unchanged; their
selector already refuses a Managed owner that no engine can run.

#### Purpose marking

The worktree reset's replacement session is now spawned with the worktree
metadata it receives later (slug, checkout path and branch), as a fresh
worktree creation is. The selector keeps it on Legacy. The child also defers
MCP discovery until the session moves into the checkout, where relocation
refreshes MCP, as it does for a fresh worktree session; before, the
replacement first discovered MCP servers in the workspace root.

The other internal creators already mark their sessions:

| Creator                            | Marked by                                                                |
| ---------------------------------- | ------------------------------------------------------------------------ |
| Conversations standalone service   | `daemonOwnedStandalone`                                                  |
| Sub-session (`create_sub_session`) | `parentSessionId`                                                        |
| Scheduled task controller          | `sourceType: "scheduled_task"`                                           |
| Scheduled task run                 | `default` source with `scheduled_task_run:` id and a parent              |
| Live conversation                  | `default` source with `realtime_voice:` id, on the Conversations runtime |
| Channel worker                     | `sourceType: "channel"`                                                  |
| Managed Runtime provider           | `sourceType: "managed-gateway"`                                          |
| Fresh worktree or branch session   | `worktree`, `branch`                                                     |
| Branch and side task               | restore of a verified Legacy source; a Managed source rejects            |
| Live task thread in a project      | ordinary creation (Decision 6)                                           |

## Files and consumers

| Slice | Files                                                                                                                                |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------ |
| M1    | core `utils/sessionStorageUtils.ts`, `services/sessionService.ts`, `services/chatRecordingService.ts`; CLI `serve/routes/session.ts` |
| M2    | CLI `acp-integration/acpAgent.ts`; acp-bridge `inMemoryChannel.ts`                                                                   |
| M3    | CLI `config/settings.ts`, `config/mcpJson.ts`; core extension store; a new CLI serve evaluation module                               |
| M4    | core `config/config.ts`, `services/chatRecordingService.ts`, `managed-runtime/*`                                                     |
| M5    | core tools and scheduler; CLI `serve/managed-runtime-*`                                                                              |
| M6    | CLI `serve/session-execution-engine-selector.ts`, `serve/run-qwen-serve.ts`, `serve/server.ts`; a new Managed channel module         |

No daemon route or REST shape changes in any slice. M1 changes no public
classification: its refusals use the existing
`session_execution_engine_unavailable`.

## Validation and acceptance criteria

M1:

1. An unpaired Legacy host refuses to execute, fork or record a transcript
   whose only Managed evidence is its `managed` owner record, with the
   existing classification; the transcript bytes are unchanged and no fork
   target is created.
2. Transcripts with a Legacy owner, no owner record, a line that does not
   parse whole, or owner-record text inside a message or another record are
   not treated as Managed: unpaired Legacy hosts keep executing them, and a
   Legacy-owned transcript still forks.
3. Transcripts that carry the Managed Session header behave as before,
   including the rename refusal.
4. A worktree reset spawns its replacement with the worktree metadata, which
   the paired selector treats as a deferred purpose.
5. Build, typecheck and focused tests pass, and mutating each refusal point or
   the reset's metadata fails a test.

The engine as a whole is accepted by M6's exit check, together with the B2d
criteria that apply once an engine is registered: deferred purposes stay on
Legacy even when the evaluation returns `compatible`; `deferred`, `unknown`
and failed evaluations select Legacy for new sessions and fail Managed
restores precisely; changing the evaluation later changes neither an attached
nor a durably owned session.

## Risks and open questions

- The owner check reads the head window. An owner record written after the
  first 64 KiB is not seen; a Managed owner is always written first, and the
  paired selector reads the whole transcript anyway.
- `qwen --continue` whose most recent session is Managed-owned now fails
  instead of resuming it on Legacy. That is the intended refusal, but it is
  visible.
- An in-process host shares the daemon's process: an uncaught failure or
  memory growth in a Managed session affects the daemon, where a Legacy child
  is isolated. M2 must contain host failures to the channel, and M6 must
  decide what a Managed channel reports as its resource snapshot, since its
  memory is the daemon's own.
- The M4 recording path and the M5 Runtime tools are the largest ports; each
  may need further slicing in its own design update.
- Whether a Managed channel should answer preheat and keepalive stays with
  B2c's rule for now: both remain Legacy-only.
