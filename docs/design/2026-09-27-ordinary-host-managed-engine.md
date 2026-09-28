# Ordinary-host Managed engine

[English](./2026-09-27-ordinary-host-managed-engine.md) | [简体中文](./2026-09-27-ordinary-host-managed-engine.zh-CN.md)

## Status

Design for the Managed execution engine of ordinary `qwen serve` hosts, the
part of #12737 that [paired engine host wiring](./2026-09-26-paired-engine-host-wiring.md)
(B2d, #12828) left out of scope, for #12380. Based on upstream `302e7d88ef`;
the M3 update is based on `3f5ae3ffeb`. It implements the "Managed engine
seam" and the "Configuration compatibility contract" of the B2d design and
splits the work into slices M1 to M6. Slice M1, the preconditions the B2d
design requires before any Managed session exists (Legacy refusal and purpose
marking), is implemented (#12861); an M1 follow-up extends the refusal to
renaming and aligns the owner evidence with the owner reader. Slice M3, the
configuration snapshot and the compatibility evaluation, is implemented with
the M3 update. M2 and M4 to M6 are proposals; each lands with its own design
update.

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
- The implementation of M1 and M3.

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

| Slice                                              | Deliverable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Exit check                                                                                                                                                                                                                                                                                                                                                                           | Reference                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| **M1 — preconditions** (#12861)                    | Legacy refusal of a `managed` owner record; worktree reset purpose marking; the Live task decision; this design.                                                                                                                                                                                                                                                                                                                                                                                                                                             | See the M1 acceptance criteria.                                                                                                                                                                                                                                                                                                                                                      | `2f00ac26e3` (refusal, reworked to positive evidence) |
| **M2 — in-process ACP host**                       | Split `runAcpAgent` into the process owner (stdio, environment deletion, console redirection, event-loop monitor, exit) and a host that serves `QwenAgent` on any ACP stream and releases everything it owns on disposal without exiting the process. `runAcpAgent` uses the host.                                                                                                                                                                                                                                                                           | ACP suites unchanged; a host on `createInMemoryChannel` creates, prompts and closes a session, then disposes with no leaked handles, timers, MCP clients or environment changes.                                                                                                                                                                                                     | `bf06117511`, `d63eec71a1`                            |
| **M3 — strict configuration snapshot** (M3 update) | A read-only snapshot of the configuration inputs of the compatibility contract, as the M3 section refines them: settings layers read without migration writes, backups or resets (in-memory migration only; missing, unreadable, corrupt and unknown-version layers kept distinct), `.mcp.json` with its errors, Hooks from every settings layer, a lock-free proof that the extension store is empty, forwarded argv, trust and cwd, and the requested approval mode; plus the evaluation that returns `compatible`, `deferred` or `unknown` with a reason. | Reading leaves every byte and every metadata file unchanged; each input source alone makes a configuration `deferred` or `unknown`; an evaluation of an empty trusted workspace is `compatible`.                                                                                                                                                                                     | `a836081466`, `306cf17546`, `d48161bc4a`              |
| **M4 — Managed Session log recording**             | The host's recorder writes through the authority's record sink under the certified writer lease; restore reads the log's projection; the log is sealed on close.                                                                                                                                                                                                                                                                                                                                                                                             | A session recorded this way restores with the same history; Legacy entries refuse it by its header; a crash before the first commit leaves no Managed session that Legacy can run.                                                                                                                                                                                                   | `e98cda5c95`, `1ed806ca85`, `f501d9694d`              |
| **M5 — Runtime-backed tools**                      | A session-exclusive local Runtime worker launched lazily at the first tool call and bound to the session's directory; Read, Write, Edit and foreground Shell declared without waiting for the worker, prepared and permission-checked in the host, executed in the worker; cancellation that reaches the worker's processes; results durable in the log before the model continues; an unknown outcome blocks instead of replaying.                                                                                                                          | The host performs no file write or process spawn for a tool call; cancellation has physical-stop evidence; a lost result blocks the session.                                                                                                                                                                                                                                         | `7786edd123`, `5dde5c8dd7`, `174e072ac4`              |
| **M6 — the engine**                                | The Managed channel factory (M2 host, M4 recording, M5 tools, M3 revalidation, owner and receipt), the extension methods the Bridge calls on a Managed channel (session close, workspace-change acknowledgement, user language, resource snapshot), the workspace-control decision, registration at the three daemon sites and the embedded default behind `--experimental-paired-engines`, and lifecycle (shutdown, drain, revoke, generation and environment reload).                                                                                      | On a paired daemon, an ordinary new session in a trusted workspace with an empty configuration runs on Managed through the real routes: create, prompt, tool call, cancel, close, and a cold restore after a daemon restart. A deferred configuration stays on Legacy, a new deny rule reaches the live Managed session, and with the opt-in off Legacy refuses the Managed session. | `824e92d84f`, `306cf17546`                            |

M2 and M3 are independent of each other. M4 and M5 need M2. M6 needs all of
them and is the only slice that can make a session select Managed.

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
  the runtime applied. On Windows, the locating names and the placeholders are
  read as a spawned session host sees them: case-insensitively, and of several
  spellings the first in sorted order. A location that depends on the working
  directory is `unknown`, because a session host resolves it against its own:
  a relative path, on Windows also a path without a drive root or a UNC server
  and share, and a value that is not a string. So is an empty or relative home
  directory, which settings loading resolves both for the user directory and
  to tell whether the workspace is the home directory. `QWEN_HOME` may be `~`
  or start with `~/` or `~\`, which expands against the home directory. In the
  daemon, the locating variables and `HOME` are excluded from workspace
  overlays, and on Windows an overlay does not replace the `USERPROFILE` that
  gives the home directory once it is set, so they equal the daemon's own; in a
  session host, they are its own environment.
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

## Files and consumers

| Slice | Files                                                                                                                                                                                                                                                                                 |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1    | core `utils/sessionStorageUtils.ts`, `services/sessionService.ts`, `services/chatRecordingService.ts`; CLI `serve/routes/session.ts`                                                                                                                                                  |
| M2    | CLI `acp-integration/acpAgent.ts`; acp-bridge `inMemoryChannel.ts`                                                                                                                                                                                                                    |
| M3    | CLI `config/settings.ts`, `config/mcpJson.ts`, `config/storage-paths-lite.ts`, `config/config.ts`, and the new `config/read-config-file.ts`, `config/approval-mode-value.ts` and `config/managed-compatibility.ts`; core `extension/extension-store.ts` and `utils/envVarResolver.ts` |
| M4    | core `config/config.ts`, `services/chatRecordingService.ts`, `managed-runtime/*`                                                                                                                                                                                                      |
| M5    | core tools and scheduler; CLI `serve/managed-runtime-*`                                                                                                                                                                                                                               |
| M6    | CLI `serve/session-execution-engine-selector.ts`, `serve/run-qwen-serve.ts`, `serve/server.ts`; a new Managed channel module                                                                                                                                                          |

No daemon route or REST shape changes in any slice. M1 changes no public
classification: its refusals use the existing
`session_execution_engine_unavailable`. M3 adds no production caller: the
selector and the Managed host start calling the evaluation in M6.

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
- The host shape of Decision 2 is under review in #12737, with a proposal to
  run the daemon's Managed host in a child process. M3 does not depend on it:
  the evaluation runs wherever the selector and the host run.
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
