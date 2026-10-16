# Ordinary-host Managed engine

[English](./2026-09-27-ordinary-host-managed-engine.md) | [简体中文](./2026-09-27-ordinary-host-managed-engine.zh-CN.md)

## Status

**Priority update (2026-09-28): deferred behind the first deliverable Hosted
Managed slice.** Ordinary local `qwen serve` Managed execution is an optional
follow-up, not a prerequisite for Hosted delivery. Keep the merged paired-host
foundation, M1 protections (#12861, #12906), and M3 compatibility evaluation
(#12883, #12903). M2 and M4–M6, including local engine registration and
activation, are lower-priority backlog; revisit their schedule after the Hosted
slice's tool execution, durable results, and required fault checks are accepted.
M4, M2, M5a and M5b have since landed without registering the engine; see below.
Deferral does not waive acceptance. This revision also adapts the M2/M5 exit
checks to the child-host boundary: M2 verifies resource cleanup and isolation
(the M2 update narrows this; see the slice plan);
M5 permits host-side worker provisioning and session recording while keeping
tool file writes and Shell processes in the worker. Hosted's local Runtime
workers, Broker, output persistence, and recovery validation continue on their
own tracks. Track scheduling in #12380 and #12737.

[wenshao's 2026-09-27 host recommendation](https://github.com/QwenLM/qwen-code/issues/12737#issuecomment-5858038609)
replaces the original in-daemon M2 proposal with an on-demand Managed child per
workspace runtime. [doudouOUC's 2026-09-28 response](https://github.com/QwenLM/qwen-code/issues/12737#issuecomment-5864516602)
agrees with that host boundary and keeps session-exclusive workers for the
first M5. The later [scheduling update](https://github.com/QwenLM/qwen-code/issues/12737#issuecomment-5867178768)
changes the "revise the designs, then implement and verify M2" sequence in both
earlier comments, while retaining the host boundary and lifecycle requirements.
[wenshao subsequently acknowledged the update](https://github.com/QwenLM/qwen-code/issues/12737#issuecomment-5869898053)
and parked the prepared M4 work. [Its later PR #12935](https://github.com/QwenLM/qwen-code/issues/12737#issuecomment-5870071280)
is for CI and review while waiting; it does not change the deferred delivery
schedule or register or enable the engine. M2 follows the same way: it adds
the Managed host and its tests, registers and enables nothing, and leaves M5,
M6 and the delivery schedule where the scheduling update put them. M5a, the
first part of M5, adds the Runtime-backed tools and their tests: it registers
no engine and no daemon route, its tools run only in a host already selected
as Managed. M5b, the second part, makes their outcomes durable with the same
authority that records the session and registers nothing either. M5c,
physical stop, lands after it in #13352: it registers and enables nothing
either, and each leaves M6 and the delivery schedule where the scheduling
update put them.

Design for the Managed execution engine of ordinary `qwen serve` hosts, the
part of #12737 that [paired engine host wiring](./2026-09-26-paired-engine-host-wiring.md)
(B2d, #12828) left out of scope, for #12380. Based on upstream `302e7d88ef`;
the M3 update is based on `3f5ae3ffeb`. It implements the "Managed engine
seam" and the "Configuration compatibility contract" of the B2d design and
splits the work into slices M1 to M6. Slice M1, the preconditions the B2d
design requires before any Managed session exists (Legacy refusal and purpose
marking), is implemented (#12861); an M1 follow-up extends the refusal to
renaming and aligns the owner evidence with the owner reader. Slice M3, the
configuration snapshot and the compatibility evaluation, is implemented in
#12883, with the #12903 follow-up. Slice M4, Managed Session log recording, is
implemented in #12935, with the #12995 follow-up. Slice M2, the child-process
host, is implemented in #13131. The M5 section below updates M5's worker
ownership, sharing, cleanup and session-isolation requirements, as the host
decision asked before implementation, and splits M5 into three parts; the
first, M5a, is implemented in #13167, the second, M5b, in #13291, and the
third, M5c, in #13352, below under "physical stop". M6 remains a deferred
proposal; it lands with its own design update after rescheduling. The M2
update is based on `afb911a3c8`, the M5 update on `f3bf699476`, the M5b
update on `1a5aae80d9`, and the M5c update on `2c591ecc08`.

The reference implementation is the branch
`doudouOUC/qwen-code:feature/managed-agents-p0-p8` at `032392a673`. This
document records what is brought upstream, in which order, and where the
upstream port deliberately differs.

## Problem and current behavior

The following describes the original pre-M1/M3 baseline. Completed work and
current scheduling are recorded in Status above.

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
- The implementation of M1 to M4.

Out of scope: default enablement; Hosted sessions on a paired Bridge; Managed
branching, which stays rejected; Stage G takeover; Stage H extensions (MCP,
Hooks, background Shell, child agents) on Managed sessions; the Java-backed
Managed WebShell product path; any daemon route or REST shape change.

## Proposed design

### What the engine is

Per paired workspace runtime, the engine is one Managed `ChannelFactory` and
one compatibility evaluation, registered through the seam B2d defined.

- **On-demand child host.** Each paired workspace runtime starts at most one
  Managed child, using the existing spawn factory and ACP transport. Its
  sessions share that child, which hosts the ordinary `QwenAgent`; model,
  permission, cancellation, and other session state retain their own scope.
  Sessions keep Legacy's prompts, approvals, compaction, model changes, and
  model loop. Without Managed work, no Managed host or worker starts.
- **Tools in the Runtime.** The Managed host registers only Runtime-backed
  tools. A tool call is prepared and permission-checked in the host, then
  executed by a session-exclusive local Runtime worker that the Managed child
  launches at the first tool operation and binds to the session directory. The
  host never performs a tool's side effect itself. The first phase supports the worker's existing tool set:
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
2. **A child host per workspace runtime.** The ordinary agent path mutates
   `process.env` and uses process-wide services. An on-demand Managed child
   isolates workspace environments and failures without making a global-state
   refactor a prerequisite. The child owns normal worker lifecycle management;
   daemon-side cleanup must also work after its crash or forced termination,
   covering workers, separate process groups, and Shell descendants. Release
   admission and IDs only after verified physical cleanup, preserving durable
   ownership; otherwise keep the engine quarantined and unknown tool outcomes
   blocked, without replay or Legacy fallback. Hosted keeps its independent
   Harness. Full Hosted loop reuse and worker sharing are separate work.
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

M1 to M4 are implemented and retained; M2, M4, M5a, M5b and M5c landed
ahead of the priority review described in Status without registering the
engine. Only M6 is deferred until that review; the dependency order and
exit checks below do not schedule its implementation. Reference commits
describe the original port; the linked host decision supersedes the old
in-process M2 approach.

| Slice                                                                 | Deliverable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Exit check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Reference                                                                                                                                                                                       |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M1 — preconditions** (#12861)                                       | Legacy refusal of a `managed` owner record; worktree reset purpose marking; the Live task decision; this design.                                                                                                                                                                                                                                                                                                                                                                                                                                             | See the M1 acceptance criteria.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `2f00ac26e3` (refusal, reworked to positive evidence)                                                                                                                                           |
| **M2 — child-process ACP host** (#13131)                              | At most one on-demand Managed child per workspace runtime using the existing spawn factory and ACP transport, with workspace environment isolation and complete host lifecycle; the host accepts only Managed sessions, records them through M4 with the owner and receipt, and its tool registry refuses every tool, whichever path registers it; keep Hosted on its independent Harness.                                                                                                                                                                   | ACP suites stay green; create, prompt, close and dispose through the child, which exits by its own shutdown with its whole process tree released, its environment writes kept in its own process. A failed child leaves the daemon and unrelated Legacy sessions usable. Other workspaces' isolation, worker-descendant cleanup (with M5) and whole-tree resource use are verified before M6.                                                                                                                                                                          | [Host recommendation](https://github.com/QwenLM/qwen-code/issues/12737#issuecomment-5858038609); [First-worker scope](https://github.com/QwenLM/qwen-code/issues/12737#issuecomment-5864516602) |
| **M3 — strict configuration snapshot** (#12883)                       | A read-only snapshot of the configuration inputs of the compatibility contract, as the M3 section refines them: settings layers read without migration writes, backups or resets (in-memory migration only; missing, unreadable, corrupt and unknown-version layers kept distinct), `.mcp.json` with its errors, Hooks from every settings layer, a lock-free proof that the extension store is empty, forwarded argv, trust and cwd, and the requested approval mode; plus the evaluation that returns `compatible`, `deferred` or `unknown` with a reason. | Reading leaves every byte and every metadata file unchanged; each input source alone makes a configuration `deferred` or `unknown`; an evaluation of an empty trusted workspace is `compatible`.                                                                                                                                                                                                                                                                                                                                                                       | `a836081466`, `306cf17546`, `d48161bc4a`                                                                                                                                                        |
| **M4 — Managed Session log recording** (#12935)                       | The host's recorder writes through the authority's record sink under the certified writer lease; restore reads the log's projection; the log is sealed on close.                                                                                                                                                                                                                                                                                                                                                                                             | A session recorded this way restores with the same history; Legacy entries refuse it by its header; a crash before the first commit leaves no Managed session that Legacy can run.                                                                                                                                                                                                                                                                                                                                                                                     | `e98cda5c95`, `1ed806ca85`, `f501d9694d`                                                                                                                                                        |
| **M5 — Runtime-backed tools** (M5a: #13167; M5b: #13291; M5c: #13352) | A session-exclusive local Runtime worker launched by the Managed child lazily at the first tool call and bound to the session's directory; Read, Write, Edit and foreground Shell declared without waiting for the worker, prepared and permission-checked in the host, executed in the worker; cancellation that reaches the worker's processes and waits for their process groups to exit; results durable in the log before the model continues; an unknown outcome blocks instead of replaying.                                                          | Tool file writes and Shell processes run only in the worker; host-side worker provisioning and session recording remain allowed. Cancellation has physical-stop evidence; a crash of the child or the worker leaves no Shell process group the ledger cannot name (except the holes the M5c section accepts: the spawn-to-pid-callback window, the setsid/daemonize residual, and ledger tampering by a Shell running with the worker's own permissions); an unprovable stop keeps the engine quarantined while a reaper retries it; a lost result blocks the session. | `7786edd123`, `5dde5c8dd7`, `174e072ac4`                                                                                                                                                        |
| **M6 — the engine** (deferred)                                        | The Managed channel factory (the M2 host, M5 tools, M3 revalidation), the workspace-change acknowledgement the host lacks and a check of the other extension methods the Bridge calls on a Managed channel (session close, user language, resource snapshot), which the host already answers, the workspace-control decision, registration at the three daemon sites and the embedded default behind `--experimental-paired-engines`, and lifecycle (shutdown, drain, revoke, generation and environment reload).                                            | On a paired daemon, an ordinary new session in a trusted workspace with an empty configuration runs on Managed through the real routes: create, prompt, tool call, cancel, close, and a cold restore after a daemon restart. A deferred configuration stays on Legacy, a new deny rule reaches the live Managed session, and with the opt-in off Legacy refuses the Managed session.                                                                                                                                                                                   | `824e92d84f`, `306cf17546`                                                                                                                                                                      |

M2 and M3 are independent of each other. M4 and M5 need M2 for the host that
drives them; the M4 recording itself landed first (see the M4 section). M6
needs all of them and is the only slice that can make a session select
Managed.

### M1: preconditions

#### Legacy refusal

Positive Managed evidence is the Managed Session header, as before, or a
`type: "system"` record with `subtype: "session_execution_engine"` and
`systemPayload.engine: "managed"` that the owner reader's line parser recovers
from a head line. When a line does not parse whole, that parser still
recovers the complete records it can delimit, so such a record counts even
when another record shares its line; a line cut inside the record yields none.
Text inside a message does not count. A
Managed owner is written before anything else, so the check reads the same
64 KiB head window as the header check. It fails open on a read error, like
the header check; the risks below record where that lets a Managed transcript
through. One predicate, `isManagedOwnerRecord`, defines the owner
evidence for this check and for the listing's Managed detection. The owner
reader validates owner records more strictly (for example, it requires
`version: 1`) and reports a record it rejects as unavailable, never as Legacy.

The three existing refusal points and a rename without a live recorder take
the new check. Every Legacy entry that executes, records, renames or forks a
transcript reaches one of them:

| Entry                                                                                                                          | Refusal point                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| CLI `--resume` and `--continue`                                                                                                | `loadCliConfig` → `SessionService.assertLegacySessionExecution`                                                     |
| CLI `--fork-session`                                                                                                           | the same, then `SessionService.forkSession`                                                                         |
| ACP cold `session/load` and `session/resume` on an unpaired host, including IDE clients, channels and unpaired daemon runtimes | `loadCliConfig` → `assertLegacySessionExecution`, answered as -32024 and 409 `session_execution_engine_unavailable` |
| ACP session source copy                                                                                                        | its temporary resume Config through `loadCliConfig`                                                                 |
| TUI `/resume` (Ink and OpenTUI)                                                                                                | `assertLegacySessionExecution`                                                                                      |
| TUI `/branch`, ACP branch and side task                                                                                        | `SessionService.forkSession`                                                                                        |
| A recorder writing without the writer lease                                                                                    | the conversation file check in `ChatRecordingService`                                                               |
| Rename without a live recorder: daemon metadata routes (standalone included), ACP, TUI `/rename`, branch, unarchive            | `SessionService.renameSession` or `renameSessionForLifecycle`                                                       |

A hot attach or live load reuses a live session, which a Legacy child only
holds for Legacy sessions. Read-only transcript reads, replay and listing stay
available. The sealed maintenance lease keeps the header-only check, as does
the reader's choice of the Managed projection: they depend on the Managed
Session log format, which an owner record alone does not have. The refusals
that gate executing, recording and forking leave paired hosts unchanged:
their selector already refuses a Managed owner that no engine can run.

A rename refuses either evidence on every host, paired or not, because a
rename without a live recorder appends to the transcript directly. A Managed
create that stops between its owner record and its header leaves only the
owner record, and the next Managed open completes that create only while the
transcript holds nothing but owner records. Before the follow-up, a Legacy
rename appended its title there and left a transcript that neither engine
could open.

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

### M2: child-process host

M2 is the Managed host: the ordinary `qwen --acp` child in a private Managed
mode, and the daemon factory that starts it. It adds no production caller: the
factory is registered at the daemon sites in M6, and until then no session
selects Managed. The tests drive a paired Bridge with real children, as the
daemon will.

#### Starting the host

`createManagedEngineChannelFactory` in `serve/managed-engine-channel-factory.ts`
is the existing spawn factory with `--acp-execution-engine managed` appended to
the child's arguments. M6 passes it the options of the runtime's Legacy
factory, so both children share the runtime's process registry, heap policy,
idle reclamation, pipe limits and diagnostics, and the daemon's process budget
counts the Managed child. The mode travels as an argument, not an environment
variable, because the Bridge hands both engines' factories the same child
environment overrides, and an argument is not inherited by the child's own
descendants.

The hidden option accepts only `managed`. `llm.tsx` accepts it only in ACP mode
with the private parent capability and outside the Conversations runtime,
which is never paired; otherwise startup fails before settings load.
`runAcpAgent` repeats the capability check.

The Bridge starts the Managed channel only when a spawn, load or resume selects
Managed. Preheat, keepalive and workspace control stay on the Legacy channel,
and resource sampling reaches a Managed channel only while it is live, so a
paired runtime without Managed work runs no Managed process. The other
extension methods the Bridge calls on a Managed channel (session close, user
language, resource snapshot) are the ordinary host's handlers, which the
Managed host keeps.

#### Sessions in the host

- **Engine.** The host executes only `managed`: `session/new`, `session/load`
  and `session/resume` that name another engine or none are refused with
  -32024 `session_execution_engine_unavailable` before a Config exists. The
  Legacy host keeps its refusal of `managed`.
- **Recording.** The engine reaches `Config` as `sessionExecutionEngine`, so
  M4 records the session as a Managed Session log: the authority writes the
  `managed` owner record and the header before any initialization side effect,
  and only then does the host return the `managed` receipt. The writer lease is
  frozen on at startup, whatever the settings say, because the log requires
  it. A Config that cannot record, for example with chat recording off, fails
  the creation with -32024 instead of running unrecorded.
- **No host tools.** A Managed session's tool registry refuses every tool,
  whichever path registers it: the built-in set at creation, and the tools
  added after the session starts, such as image generation when an image
  model is configured, the workflow tool that `/review` enables, the advisor,
  `create_sub_session` and tools of a runtime-added MCP server. A Managed
  Config also has no MCP servers and reconciles none, at startup, on a
  settings reload or after a working-directory change. The model is offered
  no tool until M5 lets the Runtime-backed ones through, so no tool call of a
  Managed session runs in the host (Invariant 1). Its OpenAI-compatible
  requests carry no tool list at all, because some of those providers reject
  an empty one.
- **Restore.** Load and resume stay refused: `loadCliConfig` still applies the
  Legacy owner check, so the host answers -32024 and the Bridge starts no
  Legacy channel for the session. M6 lifts the check and provides the
  projection.

#### Lifecycle and isolation

Closing a session seals its log (M4). Once the Managed channel has no work,
the Bridge reclaims it under the runtime's `channelIdleTimeoutMs` like any
channel: the process group receives SIGTERM, the child runs its own shutdown
and exits with code 0, and the registry releases the child when its process
tree is gone. A Managed child that dies tears down only its own sessions; the
Legacy channel and its sessions keep working, and the next Managed selection
starts a new child. The agent path's environment writes (`.env` and settings
reloads, the session and model variables core claims) stay in the child: the
process boundary guarantees it, so no test asserts it. The host always ends
with `process.exit` after its shutdown, so a leaked handle or timer could not
keep it alive; the evidence of a clean end is its exit code and the released
process tree.

#### Contract refinements

- The owner and the receipt move from M6 to M2: a host that accepts `managed`
  must record the session as a Managed Session log and return the receipt,
  or it would violate Decision 1 and the B2a contract from its first session.
  M6 keeps the composition with M5 tools and the M3 revalidation.
- A registry that refuses every tool is the M2 form of "registers only
  Runtime-backed tools". M5 lets those tools through it.

#### Risks for later slices

- The host has no handler for `qwen/control/workspace/change`. A
  session-affecting workspace change while a Managed channel is live therefore
  quarantines it with `workspace_change_unacknowledged`. M6 must acknowledge
  it after applying the change to each live session.
- The host does not yet revalidate the configuration (Decision 5). Hooks,
  skills and extensions of the workspace would load in a Managed session; M6
  adds the revalidation before anything selects the engine.
- The restore refusal comes from the Legacy owner check, whose message names
  Legacy. M6 replaces it with the Managed restore path.
- A shell command from `POST /session/:id/shell` runs in the daemon through
  the Bridge for either engine, not in the host. Slash commands a user runs in
  the session, by contrast, run in the host, and several have side effects
  there, such as `/init`, `/export`, `/dream` and file-based commands with
  `!{…}`; a tool one of them registers is refused, but the command's own
  effect is not. M6 decides per command whether Managed sessions refuse it.
- A session MCP runtime-add still connects its server, which the daemon's
  callers limit to SDK and client-hosted servers, although the registry
  refuses its tools. M6 decides whether a Managed session refuses the request.
- M3 has no rule for `general.chatRecording: false`. Once M6 registers the
  engine, a workspace with that setting would select Managed and fail every
  new session with -32024, which the daemon's HTTP layer words as a session
  that cannot be resumed. M6 must add the rule, as `deferred`, first.
- Omni policies name tools, and the empty registry has none of them. With
  omni enabled, by `omni.enabled` or `QWEN_CODE_ENABLE_OMNI=1`, every Managed
  creation fails with the omni configuration error, even with no policy
  configured, because the system's default transport-guard policies name the
  `omni_downsample_image`, `omni_downscale_video` and `omni_downsample_audio`
  tools. M3 has no omni rule either; M6 must add one, as `deferred`, before
  registration.
- M3 answers `unknown` for any forwarded argument it does not know. The M2
  factory adds `--acp-execution-engine managed` to the child's arguments, so
  the arguments M6 passes to the evaluation, in the selector and in the host's
  revalidation, must be the Legacy factory's, without the mode argument.
- Not every host side effect is a tool. Beyond the slash commands above,
  initialization still sweeps stale `agent-*` worktrees of the workspace from
  the host, as a Legacy child does for the same workspace. M6 decides
  whether a Managed host keeps doing so.
- The host still builds two internal Configs as Legacy, with the full tool
  set but without MCP discovery or hooks: the temporary target of a fork's
  source copy, and the transcript replay. For a Managed session the first is refused by the Legacy owner check
  and the second only reads, so neither runs a tool today. M6 decides their
  engine together with the Managed restore path.
- A paired runtime with Managed work takes two slots of the daemon's process
  budget, and up to four while channels are replaced. The cold-start and
  whole-tree resource measurements stay with M6, before registration.

### M3: configuration snapshot and compatibility evaluation

M3 implements the configuration compatibility contract of the B2d design as
one function in the CLI configuration layer, `evaluateManagedCompatibility`.
In M6, the daemon's selector and the Managed host's revalidation call the
same function with their own inputs, so it lives where both can import it.
Nothing in production calls it before then.

#### Inputs

The request carries the session's workspace directory and its requested
approval mode. The runtime carries:

- its canonical workspace directory and its trust;
- the effective environment it gives its session hosts;
- the arguments the daemon forwards to every session host;
- whether the running workspace holds MCP servers outside its files, added at
  runtime or registered by a client. Only the daemon knows this, and M6
  supplies it.

#### Reading without side effects

- **Settings.** `readSettingsSnapshot` applies the merge, migration, trust and
  `${VAR}` rules of `loadSettings` to every layer. It skips each step of
  `loadSettings` that writes:
  - pre-resolving home `.env` values into `process.env`;
  - the operator sandbox pre-read, which copies a corrupt user file to
    `.corrupted`;
  - the temporary `QWEN_HOME` swap of the redirect warning;
  - corruption recovery, and consuming the corruption markers a relaunch
    leaves in `process.env`;
  - persisting migrations and version normalization;
  - loading the environment.

  A strict reader tells an absent file apart from a dangling link, a
  non-regular file, a read failure and a file that changes while it is read.
  Those throw, as do invalid JSON, a value that is not an object, and a
  version that is not an integer from 1 or that stays above the current
  version after migration.

- **Environment.** The given environment is the environment of the runtime's
  session hosts. Its `QWEN_HOME` and two system settings paths locate the user
  and system settings files and the extension store; without `QWEN_HOME`, the
  user directory is under the process's home directory. It is also the only
  source for placeholders, and it already carries the user-level `.env` values
  the runtime applied. The evaluation reads it once, and M6 must spawn the
  hosts with the same variables. The locating variables and the placeholders
  are read as a spawned session host receives them: as strings; on Windows,
  case-insensitively, and of several spellings the first in sorted order. A
  variable named like an array index, such as `0`, is left out, since a Node
  process gets no value for such a name from `process.env`. An environment
  that a host would not receive as it is cannot be read: a missing one, for
  which spawn passes on its own; a variable that cannot be read, a Symbol value
  or a NUL byte, which spawn refuses or which cuts the value short; and a name
  that reaches the host as another name because it contains `=`. A location
  that depends on the working directory is `unknown`, because a session host
  resolves it against its own: a relative path, and on Windows also a path
  without a drive root or a UNC server and share. So is an empty or relative
  home directory, which settings loading resolves both for the user directory
  and to tell whether the workspace is the home directory. A home directory
  that cannot be looked up cannot be read, and neither can any other that
  cannot be resolved, for example because it does not exist. `QWEN_HOME` may
  be `~` or start with `~/` or `~\`, which expands against the home
  directory. In the daemon, the locating variables and `HOME` are excluded
  from workspace overlays, and on Windows an overlay does not replace the
  `USERPROFILE` that gives the home directory once it is set, so they equal
  the daemon's own; in a session host, they are its own environment.
- **Project MCP file.** In strict mode, a read failure of `.mcp.json` is kept as
  an error instead of counting as an absent file. In both modes, a file that
  does not parse, has no `mcpServers` object or holds an entry that is not an
  object is an error.
- **Extensions.** `ExtensionStore.inspectEmptiness` proves the installed set
  empty without the store's lock, recovery or initialization.
  - An extension directory, or a link to one, is `installed`. So is a store
    that records an extension, but the store's entries are checked before its
    state is read: a store in doubt is `unknown` whatever its state records.
  - These are `unknown`: a held lock, a journal in the `transactions`
    directory, content in the `staging` or `rollback` directory, an unexpected
    store entry, a previous state without a current one, a corrupt state, an
    enablement file that is corrupt or not a regular file, a projection that
    disagrees with the state, enablement records without a state, a read
    failure, and a change to the store's listings or state files while it is
    read.
  - Files in the extensions directory are control files and never count. What
    an idle daemon or an initialized empty store leaves is accepted too: the
    `lock` file, a state that records no extension and its previous copy, empty
    `staging` and `rollback` directories, a `transactions` directory without
    journals, `plugin-data`, and the legacy enablement rules a state keeps for
    extensions that are not installed. So are the files the store leaves for
    good and never reads again: journals its recovery quarantined, and the
    temporary files of interrupted state and journal writes. Entries whose names
    start with a dot, which the store never creates, such as `.DS_Store`, are
    ignored in the store and its `staging` and `rollback` directories.

#### Rules

The first condition that applies decides the result:

| Condition                                                               | Result     |
| ----------------------------------------------------------------------- | ---------- |
| The workspace is not trusted                                            | deferred   |
| The session or workspace directory cannot be resolved                   | unknown    |
| The session directory is not the runtime workspace                      | deferred   |
| `--experimental-lsp` is forwarded                                       | deferred   |
| `--restore-ask-user-question` is forwarded                              | deferred   |
| Another argument is forwarded                                           | unknown    |
| The running workspace holds MCP servers outside its files               | deferred   |
| The home directory or the environment cannot be read                    | unknown    |
| A settings location in the environment depends on the working directory | unknown    |
| A settings layer cannot be read                                         | unknown    |
| MCP servers in any settings layer, or `mcp.serverCommand`               | deferred   |
| `tools.discoveryCommand` or `tools.callCommand`                         | deferred   |
| Hooks in the system, user or trusted project layer                      | deferred   |
| The approval mode in settings is not valid                              | unknown    |
| Approval mode `plan`, requested or from settings                        | deferred   |
| `.mcp.json` cannot be read or is malformed                              | unknown    |
| Servers in `.mcp.json`                                                  | deferred   |
| Extensions are installed                                                | deferred   |
| The extension store cannot be proven empty                              | unknown    |
| Otherwise                                                               | compatible |

A hooks entry counts unless it is an empty list or one of the configuration
fields `enabled`, `disabled` and `notifications`, which the hook registry
skips. The settings approval mode is normalized as session creation normalizes
it, and a requested mode replaces it; session creation still parses the
settings value first, so a value it rejects is `unknown` either way. Reasons
name the source and never configuration values.

#### Contract refinements

M3 settles these details of the contract:

- **Skill and agent definitions are not read.** Their hooks and MCP servers
  register only through the Skill and Agent tools, skill commands and agent
  orchestration. The first-phase engine provides none of these, and M6
  registers none of them for Managed sessions. A later phase that adds them
  extends this evaluation.
- **Only the approval mode is evaluated among the request options.** The
  Managed host is the same `QwenAgent`, so it binds the requested model
  service and startup configuration exactly as a Legacy host does. The `plan`
  approval mode needs plan-mode tools the engine does not provide.
- **Tool discovery and call commands count like MCP.** They add tools that run
  commands in the host.
- **Servers injected into a session are not an input.** The Bridge creates and
  restores every session with an empty `mcpServers` list, so no session starts
  with injected servers. Servers added to a running workspace are the runtime
  input above.
- **An argument the evaluation does not know is `unknown`.** The arguments the
  daemon forwards today each enable a deferred capability. A new forwarded
  argument keeps sessions on Legacy until the evaluation learns what it
  enables.

Settings that only enable further built-in tools or background features, such
as cron, artifacts or automatic memory, are not inputs. The first-phase engine
does not register or run them, which M5 and M6 enforce.

### M4: Managed Session log recording

M4 records a Managed session as a Managed Session log through the #12693
authority, with its local JSONL journal and resource stores. It changes core
`Config`, `ChatRecordingService`, the record sink and the reader's Managed
restore projection, and adds no production caller: the M2 host uses it, and
nothing selects the engine before M6. The slice plan's "M4 and M5 need M2" is
about the host that drives a Managed session. The recording itself lands in
core without that host: the engine a host selects already reaches `Config` as
`sessionExecutionEngine`, and the tests drive `Config` as a host will. M4 left
the slice plan as the scheduling update (#12920) had it.

#### Trigger

A `Config` whose `sessionExecutionEngine` is `managed` records its session as
a Managed Session log. Only a host that runs Managed sessions sets that value;
the ordinary ACP host refuses a `managed` request before a `Config` exists.
Such a `Config` requires chat recording and the session writer lease, and
without them initialization fails with `SessionExecutionEngineError`. Before
M4, a `managed` engine would only have written a `managed` owner record into
an ordinary transcript, which Decision 1 rules out.

#### Writer and opening

- A transcript that holds records but has no Managed evidence in its head is
  a Legacy session's, and a Managed activation refuses it before it takes the
  lease: a certified takeover would retire a Legacy session's handoff seal
  before any later check could refuse the restore.
- The recorder's writer lease is acquired as a Managed writer: lock schema 3
  with the Managed format version, and certified takeover. A binary that does
  not know schema 3 and takes the writer lease refuses the lock instead of
  writing into the log, and a sealed Managed lock is reopened only when the
  log still matches the commit proof in the seal. The TUI, the headless CLI
  and a daemon without `experimental.sessionWriterLease` take no lease:
  current binaries refuse a Managed log by its header, and releases before
  0.24.6 append to it, after which the log fails closed on its next open.
- After the lease is held and before the recorder accepts a record, `Config`
  opens the log with `openManagedSession` on that lease. The authority adopts
  the lease, so the session keeps one writer.
- When the transcript has no header, `Config` publishes the definition (the
  engine, model and approval mode, never credentials) and the root snapshot,
  and the authority writes the owner record and then the header. That covers
  a new session and a create that stopped after its owner record. Any other
  record before the header makes the open fail.
- A restore goes through the reader's restore projection, whose owner must
  verify as `managed` before the log is opened. The Legacy loader is never
  used for a Managed log, and a Managed restore without a projection fails.
- A log whose last transaction has no commit marker, because a crash stopped
  the write, is repaired when it is opened: the writer holds the lease, so it
  moves the records after the last commit marker to the diagnostic file
  beside the transcript and opens the log at that commit. Those records were
  never committed.
- A log the authority cannot open, such as one that no longer matches its
  seal, fails the activation with the authority's own error, not as writer
  unavailability.
- The activation names the session as its worker, records a five-minute
  horizon and is renewed at a third of it while the session is open.

#### Records

- The recorder binds the authority's record sink before activation. Every
  record it accepts is committed through the sink as a Managed transaction;
  nothing is appended raw, and the recorder does not write a second owner
  record.
- The sink carries messages and tool results, titles, compaction, goal state,
  file history, turn results, branch checkpoints, the session source, slash
  and `@` commands, UI telemetry and attribution snapshots, each in the shape
  its mapping needs: a title that is not empty, a turn result with its prompt
  id and state, a compaction with its history.
- The recorder refuses any other record, or a carried kind in another shape,
  before it is queued, and the session keeps recording. Today any failed
  write stops the recorder for the rest of the session, so a refusal must not
  reach the queue. An awaited record method that returns nothing rejects with
  `ManagedSessionRecordRefusedError`; one whose contract returns a boolean,
  such as `recordCustomTitle` and `recordParentSession`, resolves `false`
  and logs, as it does for any failed write; a record written without waiting
  is dropped with a debug log. A write that still fails in the queue, such as
  a conflict in the authority or a failed append, stops the recorder as
  before.
- The sink reads the range a compaction replaces before it publishes the
  summary, since that is the history the summary covers, and numbers the
  compaction's event where it commits it. A renewal can commit while the
  summary is published, and an event numbered before it would conflict and
  stop the recorder.
- A Managed title is metadata the log keeps outside the records a reader
  replays, so it does not become the parent of the next record.
- The session list finds the title and the source in 64 KiB windows at each
  end of the log, as on a Legacy transcript, so the recorder re-anchors both.
  It measures how far the log grew, because a record's own size does not
  tell: each record is committed inside transaction records, its content goes
  to a resource, and renewals append between records. A due anchor is written
  right behind the record that made it due; a close writes the anchors that
  are due, and `finalize()` the title, also when renewals alone moved the log
  on. A restored session counts both as due, since it cannot tell how far
  they are from the end.
- A restore reads the title from the whole log and the source from the
  records a reader replays, so a log whose title has left the windows, for
  example after a crash, does not restore an older title. A title whose body
  cannot be read restores as none, as the session list shows it.
- Goal evidence reads the active chain from the records a reader replays.
  That chain matches Legacy's, without the owner record and the title.

In the first phase, these records have no mapping, or a shape the format
does not carry:

- A model switch is not persisted: the daemon ignores the refused write, and
  a rewind drops the model record it would re-append. A restored session uses
  the model its configuration selects.
- Web Shell text elements, session artifacts, source snapshots, the goal
  runtime's turn-end record and notifications the daemon delivers fail when
  they are written. Clearing a title fails too.
- A rewind record is dropped. The live session and its active chain are
  right, because later records chain past the removed turns, but the Managed
  restore projection reads the log as linear history. Record A and B, rewind
  to A and record C: a restored Managed session gives the model A, B and C,
  where Legacy gives A and C.
- Background task, cron and omni recall records are dropped. A first-phase
  Managed session has none of those features.
- A sub-session's parent record and Live conversation records are refused.
  Both purposes stay on Legacy.

M6 decides per feature whether a Managed session refuses it or its record
gets a mapping, which changes the Managed Session format and needs the
agreement of the format's owners. Rewind must be refused for Managed sessions
until the projection follows the chain; `Session.rewindToTurn` already
validates a request before it changes anything.

#### Close

- The recorder flushes and writes the anchors that are due, the authority
  records that the activation stopped advancing, and the recorder seals the
  lease with the authority's commit proof instead of releasing it. A handoff
  closes the same way, although it runs no `finalize()`.
- A failed write does not change that: the due anchors are still attempted,
  the commit proof covers committed transactions only, and the next open
  repairs the tail.
- A close during activation does not release a Managed writer early, as it
  does a Legacy one: the activation ends it when it fails.
  - A log that was opened is sealed at the authority's commit proof.
  - A lease that took over a sealed lock gets that seal back. The open checks
    the log against the seal before it writes anything, and sealing at the
    position read from the log would accept a log that changed behind the
    seal.
  - A transcript that is missing or empty, or whose head shows no Managed
    evidence, has its lock released: it holds nothing to guard.
  - Any other log is sealed at the committed position read from it. One whose
    head or log cannot be read keeps its lock held until the process exits,
    since nothing tells what it holds or where to seal it. The lease may have
    reclaimed a crashed Managed writer's lock, which releasing would drop.
- A Managed session closed without content keeps its sealed log. M6 decides
  whether to discard it.

#### Risks for later slices

- Each renewal commits an activation event, so an open session's log grows
  by a transaction of about 2 KB every 100 seconds, idle or not. Renewals
  alone move the title out of the tail window after 25 to 50 minutes idle,
  and the session list then shows an older title, or none, until the next
  record or the close re-anchors it; a restore reads the whole log. M6 may
  lengthen the horizon for local sessions; liveness of a local session is its
  writer lock.
- A renewal appends through the lease outside the recorder's write barrier. A
  live restore that reads the log under that barrier and then checks its size
  could see it change. M6 must account for that before it restores Managed
  sessions live.
- The repair drops records that were never committed. M5 must keep a Runtime
  tool's outcome durable on its own, so that a dropped tail cannot hide a side
  effect that happened.
- `loadCliConfig` refuses a restore whose owner is `managed`. The M6 host must
  restore Managed sessions without that Legacy check, and must supply the
  restore projection.
- An ordinary Managed child cannot reopen a crashed Managed child's log:
  `acpAgent.ts` gives it reclaim policy `never`, so the dead child's writer
  lock is never reclaimed and the open fails with `session_writer_conflict`.
  The M6 host must decide who reclaims that lock. Until then the repair an
  open after a crash performs is reachable only at the `Config` layer, whose
  default policy is `local`: a `Config`-level crash test passes while the ACP
  host refuses the same open.
- Recording a Managed session costs more than a Legacy transcript. Measured
  over 300 turns on one host, writing a turn took about 3.4 times as long,
  the log was about 2.8 times as large and disk use about 9 times, and
  reading the active chain, which goal verification does on every attempt,
  took 30 to 80 times as long and grows with the log. M6 must bound or cache
  that read before goals run on Managed sessions.
- A log with Managed evidence that cannot be read keeps its lock held by the
  process that failed to open it, so a retry in the same process meets a
  writer conflict until that process exits. A long-lived M6 host must recover
  such a lock, for example by reclaiming one that no live lease in the
  process holds.
- Releases before 0.24.6 take no writer lease in the TUI or headless mode and
  append to a Managed log, which then fails closed. M6 may state a minimum
  version for installs that mix binaries.

### M5: Runtime-backed tools

M5 lets the first-phase tools through the Managed host's registry and executes
them in a Runtime worker the session owns. Like M2, it registers nothing at
the daemon sites, so no session selects Managed before M6. It lands in three
parts, each with its own exit check:

- **M5a, tools in the worker** (#13167): the session's worker, the four
  Runtime-backed tools, and the block on an unknown outcome while the host
  runs.
- **M5b, durable outcomes** (#13291): the intent and the `await_runtime`
  checkpoint before a call is dispatched, the result committed before the
  model continues, and a block that survives a restore.
- **M5c, physical stop** (#13352): cancellation that waits for the Shell's
  process group to exit, and cleanup after the Managed child or the worker
  crashes that relies on neither.

#### Worker ownership, sharing and isolation

- **One worker per session, started by its first call.** The Managed child
  starts the session's worker when the session executes its first tool call,
  not at creation, preheat or registration; a session that calls no tool
  starts none. Sessions do not share workers. Whether to share them is decided
  later, from measurements of the whole process tree under Managed workloads
  (#12737).
- **The existing worker.** The worker is `qwen managed-runtime-worker` with
  boot v1, the protocol the Java Broker launches it with: the child writes the
  boot document to the worker's standard input and closes it, reads the ready
  line from its standard output, and attests the worker before the first call.
  The identity is local and fresh for each worker: the session id as
  `runtimeInstanceId`, so a Shell the worker starts sees the session's id as a
  Legacy Shell does; a random incarnation, lease id and bearer token;
  isolation class `session`; and the session's directory as `workspaceCwd`.
  Nothing reaches a Broker, a tenant store or the network.
- **Bound to the session's directory.** The worker resolves relative paths
  against it and refuses a Shell `directory` outside it. M3 already defers a
  session whose directory is not the runtime workspace. The session keeps
  that directory: `session/cd` is refused, because the worker and M3's
  verdict are bound to it.
- **Environment.** The worker inherits the Managed child's environment, as a
  Legacy Shell inherits its host's, so the workspace `.env` and the session
  variables reach its commands. The child's boot scrub removed the loader
  variables that only started it; the worker boots with the same ones and
  scrubs them in turn, so its commands never see them. Inspector flags, in
  its arguments or in `NODE_OPTIONS`, are dropped under every spelling Node
  reads, so the worker opens no debugger and never waits for one; the options
  kept are copied as written. Options files (`--env-file`, Node's config
  file) are not read again, because they would give back what was removed and
  resolve against the session's directory; options that only such a file
  holds do not reach the worker. The private parent variables the child deletes
  at startup never reach it.
- **Lifetime.** The worker runs in its own process group, with an IPC channel
  that carries no messages. When the channel closes, however the child ended,
  the worker stops its calls, lets them settle and exits. The child tracks the
  worker in an acp-bridge `ProcessRegistry` that owns its process tree.
  Closing the session, or shutting the Managed child down, terminates that
  tree before the session's log is finished or handed off: SIGTERM to every
  known process group, which the worker answers by stopping its calls and
  exiting, then SIGKILL after the grace period. A stop the registry cannot
  prove on its own, such as a process group that outlives the deadline, goes
  through the ledger and the sweeps below, and one that stays unproven keeps
  the engine quarantined. Once the worker
  exited, the host sends nothing to the port it held, which any process may
  take: a call in flight then has an unknown outcome. Since the exit is seen
  only after the port is free, the host also reads no result or state from an
  answer that does not name the worker's incarnation, which no request
  carries; a refusal needs no name, since the request it refuses did not run. A worker that exited
  between calls is replaced at the next call, and after the close the session
  has no environment, so a registry made later has no Runtime-backed tools.

#### Tools in the host

- **Declared without the worker.** A Managed Config's registry takes the four
  tools through one path, which admits only `read_file`, `write_file`, `edit`
  and `run_shell_command` wrapped to execute in that session's environment.
  Every other path keeps refusing, and so does this one for any other name or
  tool. The permission manager decides their registration as it does for
  Legacy: a disabled tool stays absent, and one that `tools.eager` demotes
  stays deferred. Declaring them starts nothing.
- **Prepared and permission-checked in the host.** The wrapper is the
  `ExecutionTool` that SSH workspaces and container subagents already use.
  Its environment builds the real tool's invocation in the host, so parameter
  validation, the default permission, the confirmation details (which read
  files here to show a diff), the permission rules, the approval mode and the
  ACP permission request run as they do for Legacy. Only execution differs:
  the call's final parameters go to the worker. When a permission hook's
  updated input or a plan-mode directory changed them after preparation, the
  wrapper prepares them again before the next confirmation or execution. The
  worker builds the call again from the parameters it receives, so before a
  call leaves, the host builds them again too and refuses the call if that
  changes them, as unescaping a path a second time does: the worker runs what
  the host approved and nothing else.
- **Executed in the worker.** The worker runs the same core tools without
  approval, because the host has already decided. A background Shell, or a
  Shell `directory` outside the session's directory, is refused in the host
  before anything is asked, because the worker runs foreground commands in
  that directory only.
- **Results.** The worker returns the tool's model content. The host reports
  it as the result and shows its text, except for a read, which shows no copy
  of the file, as in Legacy; diffs and live Shell output do not reach the
  client. When a call ends, however it ends, the host releases its
  preparation, as the core scheduler does.
- **No read cache.** A Managed Config, like the worker, disables the file read
  cache. The reads happen in the worker, so the host could neither elide a
  repeated read nor prove the read that Edit and Write require. A Managed
  session therefore edits without that check, as Hosted tool turns do.

#### Calls and outcomes

- **The call.** The host sends `execute` with a reference made of the session
  id, the prompt id, a fresh call id and the digest of the parameters as JSON
  carries them, and waits for the settled result. If the response is lost, it
  asks `status` by the same reference until the call settles; the worker's
  journal never runs a call twice. A call the worker refuses before running
  it, with a 4xx answer, or that reaches no worker, fails without having run;
  a call cancelled while the worker starts returns at once and is not sent.
- **Cancellation.** An aborted call sends `cancel` and waits until the worker
  reports it settled. A settled cancel of a v2 Shell call is proven: since
  M5c the worker reports one only once the Shell's whole process group, not
  just its leader, is gone, as "Physical stop" below specifies.
- **Unknown outcome.** When the host cannot learn how a call ended, because
  the worker exited or stopped answering, answered `unknown`, or did not
  settle a cancelled call within 15 seconds, it reports no result. The session
  is blocked: the turn fails with -32603 and `errorKind`
  `managed_runtime_outcome_unknown`, no request continues the conversation,
  later turns fail the same way, a goal turn refused this way pauses its goal
  instead of being retried, and the worker is terminated. Side queries,
  such as the title, and a compression attempt can still reach the model;
  none of them runs a tool. M5b makes the block durable.

#### Durable outcomes (M5b)

M5a could lose settled results with the turn that recorded them, could not
tell a call that never ran from a call that failed, blocked only until the
process ended, and let the worker grow without bound. M5b makes every Runtime
outcome durable with the same authority that records the session, so the log
alone says which call took effect.

- **One writer, one shape.** The outcome path writes through the Managed
  Session authority the M4 recorder already uses, in the Hosted Harness
  checkpoint schema with the Hosted `tool.intent` and `tool.receipt` events
  and the Hosted dispatch gate: no local variant, so the tooling that reads
  Hosted logs reads these, and both paths answer the same questions. Intents
  and checkpoints name the `harness` actor with the activation subject;
  receipts name `trusted_entry`, as in Hosted. The restore gate reads only
  the log the local authority just opened; the Hosted stores present through
  their own open paths and never hand this gate a checkpointless log.
- **Admitted before dispatch.** Before the host sends a call, it publishes
  the call's final parameters and, once per session and tool, the tool's
  definition, appends a `tool.intent` naming both with the call's
  `executionCallId` (the call id), and commits an `await_runtime` checkpoint
  covering the accumulating batch of the prompt. The checkpoint binding names
  the worker's incarnation, so the log answers which physical worker the call
  went to. The Hosted schema's remaining fields carry the host's honest
  values: the prompt id as the attempt, one lazily published per-session
  route resource, the tool protocol as `capabilityVersion`, the host's
  approval contract as `policyVersion`, a disclosed prompt-scoped identifier
  as `modelMessageId`, and the call's ordinal in the prompt. The local
  host asserts none of these on read: the gating fields are the call id, the
  argument digest and the incarnation. A call cancelled while its worker
  starts is not sent and commits nothing; a call whose admission write fails
  is not dispatched, and the turn fails with the recording error; a call
  cancelled after its admission settles as cancelled without contacting the
  worker.
- **Committed as each settles, before the model continues.** A call the
  worker settles, however it settles, publishes a `managed-tool-outcome`
  resource with its execution status and wire payload, appends its
  `tool.receipt`, and settles the checkpoint item through
  `resolveAwaitRuntime`; only then does the result return to the model loop.
  A call the worker refused, or that reached no worker, commits the same
  evidence with execution status `not_started`: the log says the call did not
  run, and the recorded result says so too, instead of reading as a tool
  failure. A call whose outcome is unknown commits nothing new: its
  checkpoint item stays `in_progress`, which is the durable form of the block
  below.
- **The batch closes in order.** After a batch's results are recorded, the
  host waits for those `tool_result` commits to land, then marks the settled
  receipts consumed and closes the checkpoint continuation. The model's next
  request leaves only after those commits resolve, so a log sealed or tailed
  at any point either shows a call's result or shows the call still on the
  worker — never a model that continued on a result nothing recorded. A turn
  that is aborted after its results were recorded leaves them consumed and
  the continuation closed, and a later open finds a session whose history
  holds the same results.
- **The block is durable.** The in-memory block M5a added still holds for the
  live process, and no write in the turn moves the open `await_runtime` item.
  Any later open of the log — a restore after a clean close, or an open after
  the child crashed — first repairs what the log already proves: every pending
  item whose `tool.receipt` committed settles from that receipt, a settled
  result whose record never landed is re-recorded, and the open's restore
  projection is re-read so the chat starts from the repaired history. Only
  then does the open check the newest checkpoint: an unresolved Runtime state
  blocks the session again with `managed_runtime_outcome_unknown` before any
  model request, and the reason says it comes from the log. A log whose latest
  Runtime state is `results_ready` restores normally: every outcome is
  committed, and nothing replays the Runtime. The session's next admission closes a leftover from an
  earlier turn — consumed and settled, since its outcomes are committed;
  that is not replaying — while the live turn's own `results_ready` closes
  only at the batch end, after its records are flushed, so a sealed log
  never claims the model saw results it did not; and a turn that settled
  under an earlier prompt ends with its own boundary, so the new prompt's
  batch and attempt are its own. A fresh open's dispatch gate is empty, and
  a blocked session admits no prompt, so the gate cannot claim a re-dispatch
  of the original call. Recovery of a blocked session stays with M6.
- **The worker forgets what is committed.** The host acknowledges each call
  once its commit has landed, over an `acknowledge` route added to the same
  tool v2 protocol; the worker then drops the call's parameters and result
  payload and keeps only the journal fact it needs to refuse a repeat. A
  worker that never receives the acknowledgement is as correct, and as
  large, as in M5a.

#### Contract refinements

- "Prepared in the host" means that the host builds and checks the real
  tool's invocation. The worker's provider route, which prepares in the
  worker, is not used; the tool v2 execute route is the one the Hosted Harness
  reaches through the Broker.
- The registry admits exactly the Runtime-backed tools, as the M2 contract
  foresaw.
- Prior-read enforcement and read elision do not apply to Managed sessions.
- The tool v2 routes name the worker's incarnation in a response header once
  a request is authorized. The addition is backward compatible: other clients
  ignore it.
- The tool v2 protocol gains an `acknowledge` route: after a committed call's
  acknowledgement the worker drops its payload, answers `status` with
  `acknowledged`, and refuses `execute` with the same reference. An
  acknowledged cancellation is forgotten the same way. The addition is
  backward compatible: workers answer an unknown route with their existing
  error, and hosts that never call it change nothing.
- A `not_started` outcome is durable evidence that the call did not run, in
  the outcome resource and in the recorded result, and the result the model
  reads says the call did not run, not 'the tool failed' — the shape of a
  side effect. The refusal or transport answer remains attached as its
  message.

#### Physical stop (M5c)

M5c gives a settled cancel and every close process-group evidence, and makes
a crash of the Managed child, of the session's worker, or of both leave no
Shell process group that a later sweep cannot attribute — apart from the
accepted holes this section names: the spawn-to-pid-callback window, the
`setsid`/double-fork residual that leaves the worker's process tree
entirely, the ledger's non-security-boundary (a Shell command runs with
the worker's own permissions and could rewrite or delete its own record),
the pid-callback failure window — a group the ledger cannot record is
killed at once, but its proof is discarded, so no unproven stop is reported
for it — and the group a sweep cannot date: one that outlived its leader
with no member old enough to match its record, backgrounded late, is
indistinguishable from a recycled id, so it is held unproven and signalled
by nothing until its own death proves it.
Like M5a, it
registers and enables nothing. On POSIX everything below names process
groups; Windows has none, and the ledger names a command's leader instead,
whose exit after `taskkill /t` is the stop evidence its close already waits
for. The POSIX behavior is verified with real processes, attribution included;
the Windows paths are exercised by unit doubles only, so on Windows the
attribution guarantee above stays unverified until a Windows host gets the
real-process verification before M6.

- **The worker keeps a ledger of its Shell process groups.** The host starts
  each worker with a ledger file of its own under the project's runtime temp
  directory (`<project temp>/managed-runtime/<incarnation>.json`), named in
  the launch environment. At boot the worker writes itself — pid, process
  group, incarnation and start time — synchronously. When a Shell reports its
  pid through the tool's pid callback, before the invocation can settle or
  answer another request, the worker adds the call's group the same way: a
  temporary file rewritten and renamed onto the ledger, never an append.
  The ledger keeps every group until the group provably dies, not until its
  call settles, so a backgrounded command that outlives its leader stays
  attributed to the worker that started it. The once-a-second prune reads
  liveness only — asking the whole process table every second would fork a
  blocking `ps` past the loop that pumps PTY output — and identity is judged
  only where it owes a consequence: the settle proof, the close-time sweep
  and the host's sweeps. There the judgement is of the group, not just the
  id: where no member is old enough to have been there at the record's
  write, a live leader provably younger than the record proves its pid
  recycled and resolves the record as the group's death, without a signal. A group the table cannot date — leader
  gone, no survivor old enough — keeps its entry for the close to judge,
  never dropped by the watch, because that shape cannot be told from work
  the session itself backgrounded late. Only where the process table is
  unreadable, or on Windows, does liveness stay the evidence. A clean
  close proves every
  tracked group gone — a call's own cancellation first, SIGKILL for what is
  left — and then deletes the ledger; a close that cannot prove one leaves
  the completed truth on disk and lets the host judge. A crash between a
  Shell's spawn and its pid callback can still lose a group: the window is
  the handful of instructions from `spawn` to the callback, no request can
  interleave, and it is accepted.
- **A settled cancel carries the group's exit evidence.** A v2 call that
  ends after a cancel — through the `cancel` route or because the worker is
  closing — is journaled settled only once no member of its process group
  answers `process.kill(-pgid, 0)` or the id provably outlived the group
  through recycling, or it is not journaled settled at all:
  the worker keeps it in `cancel_requested` while it polls, up to 10
  seconds, inside the host's 15-second settle budget. A group that outlives
  the budget makes the call's outcome unknown: the session blocks, the host
  stops the worker, and the ledger entry names the group for the sweeps. A
  call that settles without a cancel needs no group evidence, as before.
- **The host sweeps a dead worker's ledger.** Whenever the session's worker
  exits, however it ended — crash, close or replacement — the host reads
  its ledger, SIGKILLs every group still named there and proves each one
  empty before it deletes the file. A group the signal cannot reach or that
  outlives the proof budget is an unproven stop; the ledger stays. The exit
  the host just witnessed stands in for identity where no process table can
  be read; where one can, the sweep still judges it, so a reaper's retry
  long after the exit resolves a recycled id without a signal instead of
  killing the id's new holder.
- **A new child sweeps older ledgers, relying on neither.** At every
  session-environment creation a Managed child sweeps the project's ledger
  directory, in the background, so a wasted worker's debris finds its sweep
  however long this child has been up. The startup sweep judges only ledgers
  this process never launched: a worker this child itself started, however
  it later ends, is its own sweep's business.
  For each file: a ledger whose worker is not running is
  swept as above; a ledger whose pid still runs is swept together with the
  worker when the pid is provably that worker — the `managed-runtime-worker`
  marker on the command line and a process at least as old as its record —
  because only a worker orphaned when its child died gets that far; anything
  else means the pid was recycled, and the worker's own record is resolved
  without a signal — the groups are still judged on their own — and no live
  group is ever signalled while the process table itself went missing. The ledger's worker record names its launcher as `hostPid`:
  a live pid that still answers for an ACP child makes the ledger that
  child-led sibling's own sweep, and this one holds it untouched — pid 1
  included, recorded as-is for the container whose ACP host IS pid 1, where
  the hold reads the live table's argv to tell the host from init, which is
  always alive and carries no marker. A group
  with a member old enough to have been there at the record's write is
  still the recorded one — judged first, so a SIGTERM-ignoring survivor
  keeps it accountable even where its dead leader's pid was recycled.
  With no such member, a live leader provably younger than the record
  proves the id recycled and the group is resolved without a kill: age is
  a one-sided test, and no two-sided window can be talked into killing a
  group the id outlived. A group that outlived its leader with no
  old-enough member to date it is held unproven, signalled by nothing —
  that shape cannot be told from the late-backgrounded work it may still
  be. A sweep the child cannot prove quarantines the engine as below. The
  age checks use the process table's elapsed-seconds column and allow a
  few seconds of birth-to-record lag and whole-second truncation; on Linux
  both ages come from the boot clock (the record stamps `os.uptime()`
  beside `startedAt`), so a wall-clock step — chrony, a VM snapshot, a
  container correction — cannot turn the group's own leader into an
  impostor, and a laptop suspended between the crash and the restart
  disturbs neither clock.
- **An unproven stop quarantines the engine until it is proven.** A stop
  the host cannot prove — a close that fails, a sweep that fails, a ledger
  that outlives its budget — is reported through the session Config to the
  Managed host, which keeps a reaper retrying the remaining groups, backing
  off from once a second to once every thirty, and refuses every new
  Managed session with -32024 `managed_engine_quarantined`, naming the
  quarantine as the reason. The refusal lifts only on the sweep's own
  proof: a ledger file that has vanished proves nothing, so the lift then
  waits for the deaths of the groups the last failure named. A ledger
  nobody can read quarantines the same way, and once it outlives the debris
  age it is set aside as `<incarnation>.unreadable` — nothing it named can
  ever be proven, so its refusal is held, not lifted, until the child
  restarts.
  The startup sweep runs after the session that triggered
  it was already admitted, so the refusal binds admissions made AFTER the
  report — the newly admitted session is never untracked work beside the
  debris: it has its own ledger and its own close-time sweep. Sessions
  already open still close, and one blocked on an unknown outcome
  stays blocked. The quarantine lives in the Managed child: how the Bridge
  and the daemon learn it is M6's contract, with the engine's registration.
  A group no one can ever kill, one running as another user, keeps the
  engine quarantined and the ledger on disk: an operator sees it. So does
  a ledger that vanished without ever being judged: never readable, set
  aside unreadable, or deleted from outside the sweep. Its disappearance
  proves nothing, so the quarantine stands on the same terminal rule as
  its single-ledger sibling, until the groups it still names provably
  die (or an operator clears the debris by hand).

M5a had no ledger, and its settled cancel was the worker's word that the
call ended: a Shell member that ignored SIGTERM survived its leader's exit,
and a worker that crashed left the Shell process groups it started orphaned
where the child's registry, which knows only the groups it saw in a
snapshot, could not name them. M5c removes both gaps. What it does not
change: the worker's own group is still the registry's to stop, and a shell
started by a command inside another Shell is not the tool's — both stay
inside the registry's tree snapshot while the worker lives, and inside the
ledger's groups once it is swept.

On POSIX the worker's Shells run on a PTY, so a worker that dies also takes
its foreground Shell group down with it: the hangup is the kernel's work,
not the child's, and an armed member dies as fast as a plain one. The
ledger's worth shows where the PTY model does not reach: the cancel whose
whole group is asked to be proven dead before it settles, wherever a member
ignores the escalation; the Shells a Windows registry kills with
`taskkill`; and any Shell that ever runs without a PTY. What stays out of
both coverages: a command that daemonizes itself off the worker's process
tree (double-fork, `setsid`) is nobody's ledger entry and no PTY's
foreground either, and a dead worker keeps no trace of it — that residual
is unchanged from M5a and recorded here rather than claimed away.

#### Risks for later slices

- The ledger, and the whole sweep model, is a crash-recovery record, not a
  security boundary: a Shell command runs with the worker's own
  permissions, so it can rewrite or delete the ledger or kill the worker
  outright, exactly as it can already kill its own process group. M6
  decides whether the engine's registration hardens this.
- The worker runs its tools with their defaults rather than the user's
  settings: Shell timeouts and heartbeats, output truncation, file filtering
  and encoding. M6 must carry those settings to the worker or defer a
  configuration that sets them.
- A Shell `sed` edit runs in the worker without the preview the host showed:
  Legacy refuses to apply it when the file changed after the preview, while
  the worker applies the command to the file as it is. M5b left this with
  durability only: M6 must carry the previewed content to the worker or
  refuse such edits.
- The child hands its logs off only once its workers stopped. A worker slower
  to stop than the parent's grace period loses the handoff to SIGKILL, which
  keeps the writer lock for safety; M6 sets the shutdown budgets together.
- The worker writes files directly, not through the daemon's workspace file
  system that a Legacy session's ACP file writes go through: a new file gets
  the process umask's mode (0644, where Legacy creates 0600), the write is not
  atomic and the file-system audit does not record it. M6 must bring those
  guarantees to the worker before it registers the engine.
- A command in the worker sees the model and model identity the worker
  started with and no prompt id, and a `gh pr create` it runs binds the pull
  request without notifying the host, so the client's badge does not update.
  M6 decides how the host passes these to the worker.
- The Shell tool still offers `is_background`, which a Managed session
  refuses, so the model can spend a turn on a refused call. M6 narrows the
  declared schema.
- Reading an image, a PDF or other media returns no media: the worker's tools
  run without a model, so they decline media input, and its results keep text
  and part lists only.
- On Windows the registry kills the worker's tree with `taskkill` instead of
  asking it to stop, so its calls do not settle first. M5c's ledger and
  witnessed sweeps record and reap the leaders there, and a settled cancel
  waits for the leader's exit; an UNWITNESSED crash-recovery sweep has no
  identity on Windows and therefore holds the ledger — signals nothing —
  quarantining until the child that owns it or an operator proves it.
  Every Windows stop path is exercised by unit
  doubles only: a Windows host still needs the real-process cleanup
  verification, for cancel, worker crash and child crash, before M6.
- Results carry only model content, up to 1 MiB, and a call's parameters at
  most 256 KiB, so a larger Write fails before it runs.
- The worker is bound to the session's directory at boot, and the session
  refuses `session/cd`. Further workspace directories are out of its reach,
  and a working-directory change needs a new worker; M6 decides both with its
  workspace-change handler.
- Runtime-backed edits record no file history or checkpoints, so rewinding a
  Managed session could not restore files; M4 already requires Managed
  sessions to refuse rewind.
- With `tools.codeModeOnly`, the registry declares only `exec`, which it
  refuses, so the session has no tools; a tool that `tools.eager` demotes has
  no `tool_search` to reach it. M3 needs rules for both before M6.
- The cost of the first call, which starts the worker, and the worker's
  memory are measured with the whole process tree before M6.

## Files and consumers

| Slice | Files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M1    | core `utils/sessionStorageUtils.ts`, `services/sessionService.ts`, `services/chatRecordingService.ts`; CLI `serve/routes/session.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| M2    | CLI `llm.tsx`, `config/config.ts`, `acp-integration/acpAgent.ts` and the new `serve/managed-engine-channel-factory.ts`; core `config/config.ts`, `tools/tool-registry.ts` and `core/client.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| M3    | CLI `config/settings.ts`, `config/mcpJson.ts`, `config/storage-paths-lite.ts`, `config/config.ts`, and the new `config/read-config-file.ts`, `config/approval-mode-value.ts` and `config/managed-compatibility.ts`; core `extension/extension-store.ts` and `utils/envVarResolver.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| M4    | core `config/config.ts`, `services/chatRecordingService.ts`, `services/session-transcript-reader.ts` and `utils/sessionStorageUtils.ts`; `managed-runtime/managed-session-record-sink.ts`, `managed-session-message-projection.ts` and `managed-session-authority.ts` (one export)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| M5    | M5a: core `services/execution-environment.ts`, `services/local-execution-environment.ts`, `tools/execution-tool.ts`, `tools/tool-registry.ts`, `config/config.ts` and `core/llm-chat.ts`; CLI `llm.tsx`, `config/config.ts`, `config/shared-env-keys.ts`, `acp-integration/acpAgent.ts`, `acp-integration/session/Session.ts`, `serve/managed-runtime-attestation-worker.ts` and the new `serve/managed-runtime-session-worker.ts`. M5c: CLI `serve/managed-runtime-ledger.ts`, `serve/managed-runtime-session-worker.ts`, `serve/managed-runtime-tool-executor.ts`, `serve/managed-runtime-attestation-worker.ts`, `serve/acp-http/dispatch.ts` and `serve/server/error-response.ts` (the quarantine refusal's 503 mapping), `acp-integration/acpAgent.ts`, `acp-integration/session/Session.ts` (the mid-activation lift check that lets a recovered engine's calls run) and `config/config.ts` (the hostPolicy pass-through); core `config/config.ts` (the quarantine sink only). M5b: the Managed Session log, Harness checkpoints and CLI `serve/managed-runtime-*` |
| M6    | CLI `serve/session-execution-engine-selector.ts`, `serve/run-qwen-serve.ts` and `serve/server.ts`, which register the M2 factory; the host's restore path, workspace-change handler and command decisions in `acp-integration/acpAgent.ts` and `config/config.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

No daemon route or REST shape changes in any slice. M1 changes no public
classification: its refusals use the existing
`session_execution_engine_unavailable`. M3 adds no production caller: the
selector and the Managed host start calling the evaluation in M6. M4 adds none
either: a Managed host starts creating `managed` sessions in M6. Nor does M2:
the daemon sites register its factory in M6. Nor does M5a: its tools run only
in a Managed host. M5c adds one daemon-side mapping — the ACP child's
`managed_engine_quarantined` refusal surfaces as a 503 that keeps the reason —
through the same mappers every child error kind already passes, not a new
route or shape.

## Validation and acceptance criteria

M1:

1. An unpaired Legacy host refuses to execute, fork, record or rename a
   transcript whose only Managed evidence is its `managed` owner record, with
   the existing classification; the transcript bytes are unchanged and no fork
   target is created. A Managed create that stopped before its header stays
   completable by the next Managed open.
2. Only the header, or a Managed owner record that the owner reader's line
   parser recovers from a head line, makes a transcript Managed. A Legacy
   owner, no owner record, a line cut inside an owner record, or owner-record
   text inside a message or inside another record on a line that parses whole
   does not: unpaired Legacy hosts keep executing and renaming such
   transcripts, and a Legacy-owned transcript still forks. Within the head
   window, a record the owner reader verifies as Managed is owner evidence, and
   owner evidence the reader rejects leaves the owner unavailable.
3. Transcripts that carry the Managed Session header behave as before,
   including the rename refusal.
4. A worktree reset spawns its replacement with the worktree metadata, which
   the paired selector treats as a deferred purpose.
5. Build, typecheck and focused tests pass, and mutating each refusal point or
   the reset's metadata fails a test.

M2:

1. `--acp-execution-engine managed` starts a Managed host only in ACP mode
   with the private parent capability; without either, or with the
   Conversations marker, startup fails before settings load. The option
   accepts no other engine.
2. The host creates, loads or resumes a session only for a `managed`
   selection and refuses any other, or none, with -32024 before a Config
   exists. A created session's transcript is a Managed Session log whose
   owner reads as a verified `managed`, and the response carries the
   `managed` receipt. The writer lease is on whatever the settings say; a
   Config that cannot record fails the creation with -32024.
3. A Managed session's registry refuses every tool, through each way of
   registering one, and a Managed Config has no MCP servers and starts no MCP
   discovery. With an image model configured, the OpenAI-compatible model
   requests of a Managed session carry no tool list, while a Legacy session's declare image
   generation among others. (M5a then admits the Runtime-backed tools.)
4. Through a paired Bridge with real children, a Managed session is created,
   prompted and closed. Once idle, the Managed child exits with code 0 by its
   own shutdown and its process tree leaves the registry. Restoring the
   session is refused with -32024 and starts no Legacy channel.
5. Killing the Managed child tears down only its sessions: a Legacy session
   on the same Bridge still completes a prompt, and the next Managed session
   starts a new child.
6. Build, typecheck and focused tests pass, and mutating the startup
   acceptance, the registry's refusal, the forced writer lease or the creation
   error mapping fails a test.

M3:

1. An empty trusted workspace is `compatible`. So is ordinary configuration,
   including files that need migration and the files an idle daemon or an
   initialized empty store leave. Afterwards every file's bytes, inode,
   modification time and change time, and the process environment, are
   unchanged.
2. Each condition of the rules, arranged alone, yields its result and reason.
3. The strict settings read, the strict `.mcp.json` read and the extension
   store inspection leave the tree unchanged on every failure they report.
4. Build, typecheck and focused tests pass, and mutating each rule or each
   refusal of the strict reads fails a test.

M4:

1. A new Managed session writes the owner record, then the header, then only
   committed Managed transactions: no raw record and no second owner record.
   Legacy entries refuse it, and its lock uses the Managed schema.
2. Closing records that the activation stopped and seals the lock with the
   commit proof. A restore through the projection gives the same active chain
   and keeps recording, again after each close. The active chain passes
   through turn results and the session source and matches Legacy's without
   the owner record and the title.
3. A create that stopped after its owner record is refused by Legacy and
   completed by the next Managed restore.
4. A transaction a crash left without its commit marker is moved to the
   diagnostic file when the log is next opened; the committed prefix is
   unchanged.
5. A record the log cannot carry, or a carried kind in another shape, is
   refused before it is queued, and the session keeps recording: an awaited
   method that returns nothing rejects with a typed error, a boolean one
   resolves `false`, and a record written without waiting is dropped. A
   compaction commits, covering the history before its summary, when a
   renewal commits while the summary is published.
6. In a long session whose log renewals alone moved on, the session list
   reads the latest title after a close, a handoff or a close after a failed
   write, and a restore reads it after a crash too. A due anchor lands right
   behind the record that made it due, `finalize()` adds no title right
   behind one, and a restored rename commits one title record. A restore
   brings back the session source, the restored session refuses a different
   one, and a title whose body is missing restores as none.
7. A `managed` session without chat recording or the writer lease fails
   before anything is written, and one that fails before it writes anything
   releases its lock. A Managed restore without a projection fails and leaves
   the lock sealed. A Legacy-owned transcript is refused before the lease is
   taken, so a Legacy handoff seal stays in place. A restore that took over a
   seal the log does not match fails with the authority's error and leaves
   that seal in place. A close during a restore or a create leaves the log
   sealed, and so does a handoff close whose last flush failed. A log with
   Managed evidence that cannot be read keeps its lock held, and so does a
   reclaimed lock whose log head cannot be read.
8. Build, typecheck and focused tests pass, and mutating each of these
   behaviors fails a test.

M5a:

1. A Managed session's model requests declare exactly `read_file`,
   `write_file`, `edit` and `run_shell_command`; a disabled one stays absent,
   and the Runtime-backed path admits no other name and no tool that does not
   execute in the session's environment.
2. Through a paired Bridge with real children, a write, an edit, a read and a
   command of a Managed session run in the session's worker, a
   `managed-runtime-worker` process of the Managed child, after the host's
   approval flow decided them: it asked about the write, the edit and the
   command. Closing the session stops the worker, and a session that calls no
   tool starts none.
3. Cancelling a turn stops a running command and keeps the worker. Killing the
   Managed child stops the worker and its command.
4. A call whose outcome the host cannot learn, because the worker died
   mid-call, `status` answers `unknown` or a cancelled call does not settle,
   fails the turn with `managed_runtime_outcome_unknown`, sends no further
   conversation request and blocks later turns. A call whose response was
   lost is learned by reference without running again; a refused call and one
   that reached no worker fail without running, and one cancelled while the
   worker started ends cancelled without being sent.
5. Build, typecheck and focused tests pass, and mutating each of these
   behaviors fails a test.

M5b:

1. Through a paired Bridge with real children, each write, edit, read and
   command of a Managed session is preceded by its committed `tool.intent`
   and the `await_runtime` checkpoint covering it: the worker receives no
   `execute` whose admission has not landed, and the checkpoint binding names
   the worker's incarnation. A call whose admission write fails is not
   dispatched, one cancelled while its worker starts sends nothing and
   commits nothing, and one cancelled after its admission settles as
   cancelled without reaching the worker.
2. Each settled call commits its `managed-tool-outcome`, `tool.receipt` and
   checkpoint settlement before the model loop receives the result; a turn
   stopped between two calls has the first call's receipt in the sealed log,
   and a crash leaves no result the model saw uncommitted.
3. A call the worker refused, or that reached no worker, commits a not-run
   outcome, settles its checkpoint item, and is recorded and reported as a
   call that did not run — the model-facing message says so — rather than
   like the tool failed; the turn continues. A cancelled call settles as
   cancelled the same way.
4. A session blocked on an unknown outcome stays blocked after a clean close
   and restore, and on a fresh open of a crashed child's log: a prompt fails
   with `managed_runtime_outcome_unknown` before any model request, and the
   reason names the log as its source. A log whose latest Runtime state is
   `results_ready` restores; its next admission closes the leftover
   continuation, and its tools run again, with the new prompt's batch and
   attempt its own.
5. An acknowledged call no longer occupies the worker: its parameters and
   result are dropped, `status` answers `acknowledged`, a repeated `execute`
   of the same reference is refused, and a worker that is never asked still
   answers the old routes.
6. Build, typecheck and focused tests pass, and mutating each of these
   behaviors fails a test.

M5c:

1. Cancelling a turn whose Shell ignores SIGTERM settles the call only once
   its process group is proven gone, not just its leader; M5a's settle
   needed no such proof. A group that stays past the 10-second budget turns
   the call's outcome unknown, blocks the session and stays named in the
   ledger.
2. Through a paired Bridge with real children, the worker keeps the Shell's
   process group in its ledger while the call runs; killing the worker
   mid-Shell sweeps its groups, removes the ledger and blocks the session
   with `managed_runtime_outcome_unknown`.
3. Killing the Managed child mid-Shell lets the worker stop the call with
   group evidence, exit and leave the ledger deleted; starting the next
   Managed child sweeps a ledger the worker could not finish, without
   touching a group whose id was recycled.
4. A stop the sweep cannot prove — injected to fail — keeps the ledger,
   refuses a new Managed session with -32024 `managed_engine_quarantined`
   naming the quarantine, and lifts the refusal once the reaper proves the
   group gone.
5. Build, typecheck and focused tests pass, and mutating each of these
   behaviors fails a test.

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
- A Managed child isolates the daemon but adds process cost and can leave
  descendants after a crash. M2 verifies the child's own process-tree cleanup
  and the isolation of Legacy sessions on the same runtime with real
  processes. Before M6, verify cleanup of worker descendants (M5), isolation
  of other workspaces, and cold-start costs and resource use across the whole
  process tree within the existing daemon budget. With the flag off, Legacy
  must see no material regression; with the flag on but no Managed work, no
  Managed host or worker may start.
- The M4 recording path and the M5 Runtime tools are the largest ports. M5 is
  split into M5a, M5b and M5c; each later part updates this design when it
  lands.
- Whether a Managed channel should answer preheat and keepalive stays with
  B2c's rule for now: both remain Legacy-only.
- Decision 2 follows #12737's child-host decision. M3 does not depend on that
  host shape: the evaluation runs wherever the selector and the host run.
  Worker sharing and default enablement require separate decisions based on
  measured results; neither is part of the deferred first implementation.
- The evaluation reads the settings layers, `.mcp.json` and the extension store
  for every new session. The settings and `.mcp.json` reads are synchronous and
  block the daemon's event loop while they run. The reads are local and small,
  but a slow file system delays session creation, and a selection that exceeds
  the Bridge's budget fails the creation. M6 must move these reads off the
  event loop, or bound how long they take, before it calls the evaluation when
  a session is created.
- The store never removes a staging directory that an install leaves when it
  stops before it commits, nor what a transaction leaves in `staging` or
  `rollback` when recovery quarantined its journal; recovery clears the rest at
  the next store operation. A Ctrl-C during `qwen extensions install` is
  enough to leave one. Such a leftover keeps sessions on Legacy until it is
  removed. Before it relies on the evaluation, M6 must either remove such a
  staging directory once it can tell the directory is abandoned, or tell the
  user why sessions stay on Legacy. The store lock alone cannot tell: an
  install creates and fills its staging directory before it takes the lock, so
  a sweep under the lock can delete the staging directory of an install that
  is still running.
- Any other opening of the extension store at the same moment, by another qwen
  process or by the daemon itself, can make a single evaluation `unknown`. M6
  must retry rather than fail a Managed restore on it.
- File-based custom commands can inject shell output (`!{…}`), which runs a
  process in the host when a user invokes the command. They are not an input
  of the contract; M5 or M6 decides whether a Managed session refuses them or
  the evaluation defers them.
- Unarchiving a Managed session fails when its title collides with the title
  of an active session: the collision retitle is a Legacy rename, which
  refuses a Managed transcript. Local Managed logs first appear with M4, so M4
  or M6 must retitle through the session authority or skip the retitle.
- The head read behind the owner and header checks opens the transcript
  without following links. On Windows, which has no such open, it proves the
  file's identity instead and refuses every file on a volume without inode
  numbers (FAT, exFAT, some SMB shares). The checks then find no evidence and
  let the operation through, while the offline rename follows links and
  appends. A linked Managed transcript, and on Windows any Managed transcript
  on such a volume, therefore escapes the Legacy refusal. The header check had
  the same gap before M1. A later change should read the head for evidence the
  way the guarded operation opens the file.
