# Paired engine host wiring

[English](./2026-09-26-paired-engine-host-wiring.md) | [简体中文](./2026-09-26-paired-engine-host-wiring.zh-CN.md)

## Status

**Priority update (2026-09-28):** keep the merged B2d foundation. The remaining
ordinary-host Managed engine work (M2, M4–M6) is deferred behind the first
deliverable Hosted Managed slice and is not its prerequisite. M1 and M3 remain
implemented; M4 and M2 have since landed without registering the engine, and
the local engine stays unregistered. See the
[engine status](./2026-09-27-ordinary-host-managed-engine.md#status) and #12737
for the schedule and the on-demand child-host decision. Hosted Runtime/Broker
work and recovery validation are not deferred by this decision.

Design for slice B2d of #12737, the Stage B host integration for #12380, based
on upstream `663d98eac5`. Implemented in #12828 behind
`--experimental-paired-engines`, with no Managed engine registered. It records
in this repository the selection and scope rules decided in #12737
([Q1/Q4](https://github.com/QwenLM/qwen-code/issues/12737#issuecomment-5846602143)),
so that B2d is reviewed against this document instead of the
[external engine-selection design](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-session-execution-engine.md).
It follows [paired engine owner selection](./2026-09-26-paired-engine-owner-selection.md)
(B2a). The slices that #12737 requires before ordinary hosts are paired have
merged: workspace contracts (B2b, #12776 and #12807) and per-engine operations
(B2c, #12795), which apply the
[Q2/Q3 decisions](https://github.com/QwenLM/qwen-code/issues/12737#issuecomment-5846370487).
The Managed engine itself is designed in
[ordinary-host Managed engine](./2026-09-27-ordinary-host-managed-engine.md).
Its slice M1 closes the Legacy refusal and purpose marking items of the
Managed engine seam below, and that design settles the seam's open questions.

## Problem and current behavior

After #12698 and B2a, a paired Bridge can hold both engines, the Legacy ACP host
persists or verifies the session owner, and a host selector restores cold
sessions from that owner. No production constructor uses any of it. The
primary, startup secondary and dynamic/replacement runtimes of `runQwenServe`
and the default Bridge of `createServeApp` all build single-factory Bridges.

The rules that decide which new sessions may run on Managed exist only in the
external design, in Chinese, in a personal fork. The B2a selector takes a fixed
`newSessionEngine` instead.

There is also no Managed engine that an ordinary host can pair. The reference
implementation's Managed channel, an in-process ACP host whose tools run in a
Tool Runtime, was not brought upstream. The `--experimental-managed-*` flags
reject startup, the Legacy ACP host refuses a Managed selection, and the Hosted
Harness (#12713) runs its sessions in-process from the private Session Store
without the Bridge.

Finally, an unpaired Legacy host refuses to restore or fork a transcript that
carries the Managed Session header, but not one whose only Managed evidence is
a `session_execution_engine` owner record. No ordinary host creates such a
transcript yet.

## Scope

In scope:

- One daemon-level opt-in, off by default, applied to the four ordinary
  construction sites.
- The selection policy of paired hosts: first-phase creation purposes,
  Managed-engine availability, and cold restore by durable owner with no
  fallback.
- The seam through which a Managed engine is registered together with its
  compatibility evaluation. B2d registers none.
- The configuration-compatibility contract, specified here and implemented with
  the Managed engine.
- Rejecting the opt-in in the Hosted Harness profile.

Out of scope: an ordinary-host Managed engine and the strict configuration
snapshot, which land together later; workspace contracts (B2b); per-engine
operations and quarantine recovery (B2c); default enablement; moving Hosted
sessions onto a paired Bridge; the Java-backed Managed WebShell product path;
Managed branching, which stays rejected. No daemon route or REST shape changes.

## Proposed design

### Invariants

1. A session's engine is fixed when it is created. Creation and cold restore
   choose the channel; prompt, cancel, approvals, model changes and close use
   the bound connection; a hot attach reuses the live entry. Client metadata
   never chooses the engine.
2. A new session runs on Managed only when its purpose is eligible and its
   configuration is proven compatible. Deferred or unknown configurations run
   on Legacy.
3. A cold restore uses the durable owner. A Managed owner must pass the same
   compatibility rule; if it does not, the restore fails precisely and the owner
   is kept. No failure selects, starts or dispatches to the other engine.
4. History without an owner record is Legacy only when it is complete and
   readable (B2a). Unknown versions, invalid values, conflicts and read failures
   reject.
5. Pairing does not multiply session, ID or process budgets; both engines share
   the Bridge's admission.

### Opt-in and construction sites

`qwen serve --experimental-paired-engines` sets
`ServeOptions.experimentalPairedEngines`. Without it, every site keeps its
current single-factory construction. With it, each site passes
`executionEngines` instead of `channelFactory`, built from that runtime's own
inputs; every other Bridge option is unchanged. Paired Bridges keep the
defaults of B2b and B2c, including the five-minute quarantine drain deadline;
B2d adds no operator setting for them.

| Site                    | Constructor                                             | Legacy factory                                 | Owner reads use                       |
| ----------------------- | ------------------------------------------------------- | ---------------------------------------------- | ------------------------------------- |
| Primary                 | `runQwenServe` at startup                               | the primary spawn factory                      | the primary session runtime directory |
| Startup secondary       | `runQwenServe`, per secondary workspace                 | that workspace's spawn factory                 | its session runtime directory         |
| Dynamic and replacement | the `runQwenServe` workspace runtime factory            | the new runtime's spawn factory                | its session runtime directory         |
| Embedded default        | `createServeApp` without an injected Bridge or registry | the spawn factory it uses today, made explicit | `Storage.getRuntimeBaseDir()`         |

- The dynamic factory builds registered workspaces, managed scratch workspaces,
  and the runtimes that replace a workspace, including the primary and startup
  secondary ones, when its trust changes. A replacement builds a new pair from
  its own inputs and never reuses the previous generation's selector or
  factories. An environment reload updates a runtime's environment in place and
  does not build a new pair.
- The Conversations runtime (`live-conversation` provenance) stays
  single-factory. Workspace routes never resolve it; its sessions are
  daemon-owned standalone conversations and the sessions they start, all of
  which the first phase keeps on Legacy. Its mandatory writer lease is attested
  only when every factory of its Bridge forwards the child environment, which a
  paired Bridge would extend to a Managed factory it can never use.
- A Bridge injected through `deps.bridge` or an injected workspace registry
  stays under its caller's control; the opt-in neither wraps nor replaces it.
  `qwen serve` itself injects its workspace registry into the serve app, so
  there the three `runQwenServe` sites do the work; the embedded default is
  paired when an embedder that injects neither sets the option.
- The embedded default reads owners from the embedding process's runtime
  directory, where it already reads artifact snapshots and attachments, while
  its children resolve theirs from their environment and the workspace
  settings. An embedder whose workspace settings move the runtime directory
  sets `QWEN_RUNTIME_DIR` for its process so that both agree; otherwise a
  paired embedded host looks for owners in the wrong directory and a cold
  restore answers 404. The daemon's runtimes set it for their children.
- Channels have no Bridge of their own. Channel workers create sessions through
  the daemon with `sourceType: 'channel'`, which the purpose rules keep on
  Legacy.

### Selection

Each paired runtime gets one selector, built in the CLI serve layer from the
B2a owner selector and the rules below. The Bridge calls it after shared
admission and ID reservation, as it does today.

**New sessions**, in order:

1. Deferred purposes select Legacy: daemon-owned standalone creation
   (`daemonOwnedStandalone`); a session with a parent (`parentSessionId`, which
   covers sub-sessions and other children); a worktree (`worktree`) or Git
   branch (`branch`) session; any `sourceType` other than `default`, which
   covers channels, scheduled task controllers, side tasks, Tool-only
   `managed-gateway` sessions and unknown future sources; and the `default`
   source with a `sourceId`, which internal creators use to mark scheduled task
   runs (`scheduled_task_run:`) and Live conversations (`realtime_voice:`).
2. Without a registered Managed engine, select Legacy.
3. Otherwise ask the engine's compatibility evaluation. Only `compatible`
   selects Managed; `deferred`, `unknown` or a failed evaluation selects Legacy.

Only a session with no source, or with the `default` source and no `sourceId`,
is an ordinary creation. `daemonOwnedStandalone` is set only by daemon-internal
creation, and parents, worktrees and branches are set by daemon routes.
`sourceType` and `sourceId` come from the creator, so they can only make a
session ineligible; an ordinary source is not proof of compatibility. With no
Managed engine the policy does no I/O and every new session selects Legacy.

**Cold load and resume.** The B2a selector reads the verified owner from the
session's own transcript.

- A Legacy owner selects Legacy.
- A Managed owner selects Managed only when a Managed engine is registered and
  its evaluation returns `compatible`. Otherwise the selector throws
  `SessionExecutionEngineError`, answered as 409
  `session_execution_engine_unavailable` before any channel starts; the owner
  record is left as it is. Creation purposes are not evaluated again, because
  the owner already reflects them.
- Unreadable, conflicting or incomplete ownership rejects, as in B2a. That
  includes a transcript with a line that does not parse whole, such as one left
  by a crash mid-append, or with a record type the daemon's version does not
  know; see Risks.

**Hot attach** reuses the live entry and does not call the selector.

| Operation                                       | Engine decided by                                                                               |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| New session (REST, ACP, internal creators)      | the policy above, once                                                                          |
| `single` attach, hot restore                    | the existing entry                                                                              |
| Cold load or resume                             | the durable owner                                                                               |
| Prompt, cancel, approvals, model, cwd, close    | the live session's connection                                                                   |
| Live transcript and turn reads, flushes         | the live session's owner; persisted reads without a live entry use the Legacy workspace channel |
| Workspace MCP, Hooks, skills and status control | the Legacy workspace-control channel; B2b delivers session-affecting changes to live engines    |
| Fork, session branch, in-session history switch | the verified source owner; a Managed source rejects                                             |
| Shutdown, force exit, idle reclamation          | every live channel and in-flight creation                                                       |

### Managed engine seam

To be paired, a Managed engine supplies, per workspace runtime:

- a `ChannelFactory` whose host follows the B2a contract with `managed`: it
  persists or verifies the owner before any initialization side effect and only
  then returns the engine receipt;
- a compatibility evaluation over the selection context and that runtime's
  inputs, returning `compatible`, `deferred` or `unknown` with a reason;
- revalidation: before Hooks, MCP, tools or the model start, the engine's host
  re-runs the same evaluation on the configuration it will actually use and
  fails the creation or restore precisely on a mismatch, never falling back;
- lifecycle: its processes and resources take part in the daemon's shutdown,
  workspace drain and revoke, generation invalidation and environment reload,
  and one workspace's cleanup never stops another engine's or workspace's
  processes;
- Legacy refusal: before it creates any session, every unpaired Legacy entry
  that restores or forks a transcript refuses its sessions, either because its
  transcripts carry the Managed Session header those entries already refuse, or
  because the refusal is extended to its owner record. Otherwise switching the
  opt-in off would let a Managed session run on Legacy. M1 of the engine design
  extends the refusal to the owner record;
- workspace control: permission rules and Skills changes need the Legacy
  workspace-control channel (B2b), so with only Managed live they cannot be
  applied. The engine slice decides whether the host starts workspace control
  for those routes; in B2d no Managed channel starts, so the case does not
  arise. The engine design starts it (Decision 3);
- a bounded evaluation: the Bridge bounds each selection, owner read included,
  by its initialize timeout, and a selection that exceeds it fails the creation
  or restore instead of selecting Legacy. The evaluation therefore settles well
  within that budget. A thrown or rejected evaluation counts as `unknown`; the
  selector keeps no detail of the failure, so the engine logs its own under the
  logging rule of the compatibility contract;
- purpose marking: every internal creator of a deferred purpose marks its
  sessions, or is otherwise kept on Legacy, before the engine is registered.
  The replacement session of a worktree reset does not today: it is created
  without `worktree` and moved into the checkout afterwards. A task that a Live
  conversation starts in a project also creates its thread with no source, and
  the engine slice decides whether that thread is a Live purpose. To the rules
  above, both are ordinary creations. M1 of the engine design marks the reset
  replacement with its worktree, and the engine design keeps the Live thread an
  ordinary creation (Decision 6).

B2d registers no engine. The paired `managed` factory then rejects with an
unavailable error. The selector never returns `managed` without a registered
engine, so this factory is not reached; it exists because a paired Bridge
requires both factories. Tests register an in-process double, with a stub
evaluation, through the serve app's dependency for its default Bridge. The
daemon's three `runQwenServe` sites register none until the engine slice
constructs an engine for each runtime.

### Configuration compatibility contract

The Managed engine slice implements this evaluation. It reads the actual
workspace runtime and never migrates, repairs, locks or writes what it reads.

| Input                | Compatible only when                                                                                                                                                                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace            | it is trusted, and the canonical request cwd equals the runtime workspace                                                                                                                                                                                                                      |
| Environment and argv | evaluated with the runtime's effective environment, which locates settings and extensions and substitutes settings variables, and with the arguments forwarded to children (`--experimental-lsp`, `--restore-ask-user-question`); an argument that enables a deferred capability is `deferred` |
| Settings             | every layer (system defaults, system, user, and workspace when trusted) is read without migration writes, backups or resets, and known older versions are migrated in memory only; an unknown `$version` or an unreadable layer is `unknown`                                                   |
| MCP                  | no server from any source: settings layers, `.mcp.json` (keeping its read and parse errors), `mcp.serverCommand`, extensions, agent definitions, runtime-added servers, client MCP over WebSocket and servers injected into a session                                                          |
| Hooks                | none from any settings layer (system, user, and project when trusted), active extensions, or dynamic registrations by skills and agent definitions                                                                                                                                             |
| Extensions           | a read-only proof that the installed set is empty, without the store's locking, recovery or cache refresh; partial or stale evidence is `unknown`                                                                                                                                              |
| Request options      | the engine can bind the requested model service, startup configuration and approval mode                                                                                                                                                                                                       |

`deferred` means a capability that the first-phase Managed engine does not
support is present; `unknown` means something could not be proven. The selector
and the engine's revalidation use the same rule on comparable inputs, so a
change between selection and initialization fails precisely instead of reaching
Managed with a deferred capability. Later changes, such as a runtime MCP add, a
client MCP registration, or a Hook or extension reload, must check existing
Managed owners and must not inject deferred capabilities into them; Legacy keeps
today's behavior. Logs name only the source category and the reason, never
configuration values or credentials.

| First phase selects Managed only with                                                               | First phase keeps Legacy for                                                                                       |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| an ordinary user session in a trusted workspace whose cwd matches exactly                           | existing Legacy sessions; unknown purpose or configuration                                                         |
| no unmigrated Hooks, dynamic MCP or extensions                                                      | Channel, Scheduled Task, Standalone, Worktree and Branch creation; sub-sessions, side tasks and Live conversations |
| a compatible Harness, AgentBundle and Runtime protocol, and complete owner and configuration proofs | dependencies on unmigrated capabilities; incomplete proofs; a server policy reservation                            |

### Hosted boundary

`validateHostedHarnessProfile` rejects `--experimental-paired-engines` with
`--profile hosted-harness`, as it rejects channels, shells and Runtime Broker
options, so a Hosted process cannot pair through the primary Bridge it still
constructs. Hosted sessions stay on the private Store-backed in-process Harness,
also after B2c defines Managed preheat and keepalive: preheat does not reconcile
the Store's authority with the transcript owner that the paired selector reads.
Moving Hosted sessions onto a paired Bridge needs a separate migration design
and a proof that Store authority and transcript owner agree. Both paths keep a
fixed owner and no cross-engine fallback.

The external design's statement that WebShell does not select Managed through
the four ordinary daemon factories refers to the Java-backed Managed WebShell
product path. It does not remove pairing for ordinary local `qwen serve` hosts.

### Switching the opt-in

Turning the opt-in on over existing sessions restores them on Legacy through the
rule for history without an owner record. Turning it off keeps each paired
Legacy session's owner record, and an unpaired Legacy host restores such a
session as before. With no Managed engine, paired hosts create only Legacy
sessions, so switching the opt-in on or off cannot move a session to another
engine. The Legacy refusal item of the Managed engine seam keeps this true once
Managed sessions exist. Until then, turning the opt-in off is also how an
operator restores a Legacy session that a paired host refuses because its
transcript cannot prove the owner.

## Files and consumers

| Area                  | Files                                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Opt-in                | CLI `commands/serve.ts`; `serve/types.ts`; `serve/hosted-harness-profile.ts`                                          |
| Pairing and selection | `serve/session-execution-engine-selector.ts`                                                                          |
| Construction sites    | `serve/run-qwen-serve.ts` (primary, startup secondary, dynamic and replacement); `serve/server.ts` (embedded default) |
| Owner evidence        | core `utils/transcript-records.ts` (the record types an owner read accepts)                                           |
| Design links          | this document; [ACP Bridge execution engines](./acp-bridge-execution-engines.md)                                      |

No daemon route is added. Workspace routes keep their scopes; session routes
keep the live-session-owner or selected-runtime scope, and their error
classification is B2a's.

## Validation and acceptance criteria

1. With the opt-in off, every site constructs its Bridge exactly as today, and
   the existing single-factory suites stay green.
2. With the opt-in on, each of the four sites builds a paired Bridge from its own
   Legacy factory and session storage; a replacement runtime gets a fresh pair;
   an injected Bridge and the Conversations runtime are unchanged.
3. With no Managed engine, new sessions of every purpose run on Legacy, and the
   Legacy host writes the owner as the first transcript record. A Managed-owned
   transcript fails load and resume with 409
   `session_execution_engine_unavailable` before any channel starts, and its
   bytes are unchanged. Legacy and owner-less histories restore on Legacy.
4. With a double registered on the serve app, the paired embedded host starts,
   restores and shuts down with both engines. Deferred purposes stay on Legacy
   even when the evaluation returns `compatible`. `deferred`, `unknown` and
   failed evaluations select Legacy for new sessions and fail Managed restores
   precisely, with no dispatch to the other engine.
5. Changing the double's evaluation after sessions exist changes neither an
   attached session nor a durably owned one.
6. `--profile hosted-harness` with `--experimental-paired-engines` rejects
   startup.
7. After paired use, an unpaired host restores paired Legacy sessions, and a
   paired host restores sessions created while unpaired on Legacy.
8. Build, typecheck, bundle, focused unit tests, and an isolated process check
   of a paired daemon with a real Legacy child: start, create, restore and
   shut down.

## Risks and open questions

- Until a Managed engine lands, the opt-in runs nothing on Managed, but it still
  changes Legacy behavior in three ways. Legacy sessions are durable from
  creation, with the owner-only transcripts for unused sessions described in
  B2a. A quarantined Legacy channel follows the B2c policy: it refuses new
  prompts, closes settled sessions and retires by the drain deadline, where an
  unpaired channel lets its sessions keep prompting until they drain. The
  follow-ups the B2c approval requires before B2d enables pairing (#12811: a
  background job finishing during a quarantine must not stall the drain, and
  exit verification must start when termination starts) therefore apply to
  paired Legacy-only hosts too. And a cold restore reads the transcript once
  more to verify its owner, which makes it stricter, as the items below
  describe.
- The serve app's Managed-engine dependency has no production caller until the
  engine slice lands; tests use it for the double.
- Paired hosts restore more strictly than unpaired ones. A transcript that
  cannot prove its owner, because a line does not parse whole or a record type
  is unknown to the daemon, is refused with 409 where an unpaired host restores
  it. A crash mid-append leaves such a line, and with the writer lease off,
  which is the default, a later writer keeps appending after it. A daemon
  upgraded in place keeps its older list of record types until it restarts,
  while its new children may already write newer ones. Nothing repairs such
  transcripts; B2c recovers channels, not transcripts. B2d still allows pairing
  with the lease off: the opt-in is experimental and off by default, the
  refusal is precise and leaves the bytes unchanged, and turning the opt-in off
  restores the session on Legacy. The lists of known record types and
  subtypes now cover every member of the chat record type, and a typechecked
  test fails when that type gains one the lists lack; writers that build
  records outside that type are not covered by it. Before this, a Legacy
  session that recorded text elements could not be restored on a paired host.
- The owner read runs within the selection budget, the initialize timeout
  (10 seconds by default), instead of the restore budget (60 seconds by
  default). A transcript too large, or storage too slow, to read within it
  fails the restore on a paired host. Reading a 100 MB transcript took well
  under a second in testing.
- The daemon does not sweep old transcripts, so the owner-only transcripts of
  sessions that are never used accumulate on a paired host (B2a). Default
  enablement needs an answer for them.
- The purpose rules rely on creator-attributed sources, which can only make a
  session ineligible. An internal creator of a deferred purpose that does not
  mark its sessions becomes eligible once an engine exists; the purpose marking
  item of the Managed engine seam names the known cases, and the engine slice
  re-audits the rest. M1 of the engine design records that audit.
- Until M1 of the engine design, an unpaired Legacy host did not recognize a
  Managed owner record. That was harmless while no ordinary host created
  Managed sessions, and the Managed engine seam made closing it a precondition
  of the engine slice, which also settles how `session_execution_engine`
  relates to the Managed Session header (engine design, Decision 1).
- How the engine shares its evaluated inputs with its host for revalidation is
  decided together with the engine: the host re-reads and re-evaluates the
  same strict snapshot (engine design, Decision 5).
