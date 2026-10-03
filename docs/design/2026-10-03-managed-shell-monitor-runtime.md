# Managed background Shell and Monitor runtime (H3)

[English](2026-10-03-managed-shell-monitor-runtime.md) | [简体中文](2026-10-03-managed-shell-monitor-runtime.zh-CN.md)

Status: design; nothing here is implemented. This is slice H3 of [#12827](https://github.com/QwenLM/qwen-code/issues/12827), stage H of the Managed Agent proposal [#12380](https://github.com/QwenLM/qwen-code/issues/12380), following H1 ([MCP](2026-09-28-managed-mcp-runtime.md)) and H2 ([Hooks](2026-09-30-managed-hooks-runtime.md)). The references are sections 3, 9, 10, 12, 13 and 14 of the [extension runtime design](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-extension-runtime.md), the Monitor tool contract of the [tools and history design](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-tools-history.md), and the process-ownership and recovery rules of the [recovery operations design](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-recovery-operations.md) at the commit that #12827 pins, plus the in-repo H0a ([task contract](2026-09-27-managed-agent-task-contract.md)), H0b ([record contract](2026-09-27-managed-extension-record-contract.md)) and H0c ([authority](2026-09-27-managed-extension-authority.md)) designs, whose H3 obligations this document closes.

## Problem and scope

Two Legacy capabilities run entirely on in-memory state: `BackgroundShellRegistry`, whose evidence is output files, a best-effort status sidecar and PIDs, and `MonitorRegistry`, whose retained output path has no writer, per section 2 of the reference design. Neither survives a Harness replacement or a Runtime loss, and neither can prove what its processes did. H3 brings both onto the Managed path with durable records, a real process owner, log Artifacts, Runtime hold, stop/drain, and recovery that either re-attaches the original process or blocks accurately. This is the first Stage H slice that produces user-visible tasks, so it also maps the task events route that H0c left `planned`.

The implementation extends the existing private Hosted Workspace profiles, as H1 and H2 did. Production AgentBundle enablement remains separate.

Out of scope, named by the contracts that defer them:

- **Public task cancel.** `cancelSessionTask` and `cancelWebShellTask` stay `planned` for the H4–H5 cancel slice (A6/A7 of #12847). H3 stops its own tasks through the Monitor stop and Shell terminate operations and through Session-close drain, never through a public route.
- **`send_input`.** The `TaskActionCapability` value stays reserved; interactive input to a background Shell is a later slice.
- **Detach.** A background process with an explicit detach survives Session close only after migrating to an independent durable owner (reference design §9). H3 owns every process by its Session; Session close always terminates and drains. Detach is follow-up work.
- **Cross-boot process attach.** W0e deliberately retires registrations across a host reboot; a host reboot ends every Linux process H3 could attach. What H3 must do across a host reboot is block accurately and let rebuildable Monitors restart, per Recovery below.

## Records

### Background Shell: `child_run` with `kind: "shell"`

The reference design §3.1 assigns background Shell the existing `child_run` domain with `kind=shell`. `child_run` is already a name of the closed v1 domain index, so this raises no index version. This slice defines the `managed-child_run` record body, schema version 1, with what a background Shell needs and no more; H4 extends `kind` to `child_agent`/`workflow`/`team` under their own body version. A Shell record carries:

- the Shell's own identity (`shellId`), the owning Session scope, and the start invocation pin: workspace generation, `cwdRef`, `commandRef` (the start call's args; its digest is the command digest), and definition revision of the tool profile;
- the process identity: `processId`, the Runtime binding and generation that owns the process, and `startReceiptRef`, null until the supervisor has started the process (mirroring the Monitor's start-receipt rule);
- `status`, the run block states with the Shell-specific stop marker: a first revision opens `reserved/admitted`; a successor may carry a stop request, which projects the task's Runtime state as `draining` (the H0c debt "the run block does not carry a stop request; H3 adds it");
- output identity: `outputRef`, a `managed-tool-result-manifest` version 1 reference that gains revisions as log pages publish, and the output cursor described under Task events;
- terminal accounting: exit code or signal when proven, and the closed stop reasons, mirroring the Monitor's rules — `settled` by `exited`, `failed` by `start_failed`, `process_failed` or `quota_exceeded`, `cancelled` by `stop_requested` — each with the state it may close and the evidence it requires.

The Shell's run names the start call's `executionCallId` and nothing else: no `effectId`, `dispatchId`, `deliveryId` or `definition` beyond the pin. A Shell has no delivery line and joins no outbox: its completion is observed through the task projection and its output through Artifacts, exactly as the Monitor notifies through its watermark record rather than a delivery. The Shell record's revision rules mirror the Monitor rules that the H0b fixtures already pin: identity and pin never change; output may only grow; a start receipt is set once and changes only with a new Runtime binding under a later generation; a settled Shell never reopens.

### Monitor: enable `monitor_run`

The H0b contract fixes the `monitor_run` body and its revision and rebuild rules, and H0c ships the projection and fixtures on both sides with the domain disabled. H3:

1. adds `monitor_run` to `MANAGED_SESSION_ENABLED_DOMAINS`;
2. fills the physical sides the contract already names: the Runtime start receipt behind `startReceiptRef`, observations behind `observationSequence`/`lastObservationRef`, the output manifest behind `outputRef`, and notification inputs that advance `notifiedThrough`;
3. enforces what the contract leaves to H3: the rebuild policy (only a purely observational command may be re-watched), the stop flow (seal observations, then cancel the process, then finalize output, then commit the terminal revision), and open question 6 of H0b — a notification that covers several observations names their summaries from the output behind `outputRef`, so the record continues to commit one revision per accepted observation rather than one per notification.

Nothing else about the body changes; the 568 H0b fixtures and the H0c projection and chain fixtures keep passing unchanged.

### Reader gating

A binary older than H0b refuses the `monitor_run` name, so a Session that holds `monitor_run` records must keep such binaries out. The requirement is enforced in one of two ways, fixed with the implementation: raising the Session's `minimumReader` in the transaction that commits its first `monitor_run` record, if the header can be rewritten in-journal; or, if headers are immutable, giving H3-era Sessions a higher minimum reader at creation and refusing `monitor_run` on Sessions an older binary could open. Either way, a pre-H0b reader never opens a log whose records it cannot parse.

`child_run` parses on every managed-session/1 reader, but only H3 understands its body: older writers refuse to commit it (their `MANAGED_EXTENSION_RECORD_BODIES` lacks the body). The asymmetric hazard is the server: an older Java store passes unknown-domain events through silently, and per H0c open question 7, a server that gains the body later sees a non-start first revision, refuses it and stops the writer. The server must therefore gain the `child_run` body no later than any writer that can commit it: `child_run` stays disabled in `MANAGED_SESSION_ENABLED_DOMAINS` until one release carries both sides and the server has been deployed first — the sequencing H1 and H2 already used. There is no runtime admission switch beyond the enabled-domains constant and that deployment order.

### Resource closure

The Java store commits a body only with every resource the body names, and refuses one that names a resource the Session does not hold (H0c open question 3). Every reference an H3 body carries is therefore a Session resource at commit time: `commandRef` is the start call's args resource, which the authority already commits with the invocation; `startReceiptRef` and the output manifest behind `outputRef` arrive through the same Session resource pipeline as the record transaction that names them — a receipt or manifest revision still held only in the Runtime or the tool-result store cannot be named. The writer checks each reference before publishing the body, as H0c instructs, so a failed check stops the writer instead of committing a reference the store must refuse. No resource kind is exempted.

## Runtime ownership

### One physical owner per task, one execution per process

As on the Legacy path, every background Shell and every Monitor watch is a child process of the managed-runtime worker, which is TypeScript; the Java control plane supervises no processes. H3 replaces the two refusal gates — `ManagedToolDispatcher.execute` ("Managed Runtime does not admit background shell execution") and `executeV3` ("Background Shell capture is unavailable") — with the managed admission path; it does not relax `RuntimeBrokerService`'s foreground-only check for v2-style direct dispatches.

The start of a Shell reuses the Shell tool's approval, preflight and execution gates without change, then hands the process to the supervisor described below and returns the durable handle as the tool result. The tool result settles; the physical work does not. Each background process is one execution of the Runtime's ledger for its whole life: its row stays active — and thereby holds the Runtime against `hasActiveByRuntimeSession` and `hasActiveByBinding` — until the process is proven exited or lost, even though the model-visible result (the handle) was delivered at start. Status, read-output, terminate and kill are operations against that same execution: a model-initiated one (the Monitor stop call, a status read) rides the current activation like any tool call, while owner-side maintenance (recovery reconciliation, close-triggered stop) rides an `OperationGrant`, following the Hook async pattern: they carry the original `targetOperationId`, validate the Session, the process owner and the generation, and never create a new model turn. Terminate settles the execution only with evidence (exit, or the cgroup empty check below); an outcome that cannot be proven stays active and keeps its hold, exactly the #12670 wedge semantics, so a Runtime with unresolved background work can neither be released nor silently reclaimed.

A Monitor watch is the same shape: one execution for the life of the watch, holding the Runtime, with its accepted observations committed as `monitor_run` revisions and its stop as a maintenance operation. A Monitor occupies no active model turn; it occupies Runtime process, log and quota capacity.

### Supervision: Linux cgroup v2, as H2

Managed Shell and Monitor processes run under a dedicated cgroup v2 unit per process, created before spawn under the same delegated root H2 uses (`QWEN_MANAGED_HOOK_CGROUP_ROOT` gains a sibling or is generalized), reusing `hook-command-cgroup.ts`. The unit name derives from the execution identity, so it is the stable process identity across a worker replacement: membership survives `setsid` and detached descendants, `cgroup.events` reports the true descendant count, and `cgroup.kill` is the only accepted way to make a stop stick; exit of the root alone is never proof. Stop drains output, escalates TERM and then `cgroup.kill` on the drain bound, waits for `cgroup.events` to report empty, then settles; a stop that cannot prove emptiness retains the hold. A process group alone is never accepted as proof, as H2 decided.

On platforms without delegated cgroup v2, managed background Shell and Monitor admission refuse accurately (`…_isolation_unavailable`, sibling to `managed_hook_command_isolation_unavailable`) before any side effect; the record keeps `start_failed` with `handler_unavailable`, as H2's ledger does. The weaker macOS process-group profile of the recovery design stays a separate later decision; it is not claimed here.

### Logs: bounded capture, one Artifact per task

Background stdout/stderr are captured incrementally, not per invocation. A long-lived capture continues the `managed-tool-result/1` envelope that O1c established for foreground Shell — bounded segments and pages within its contract limits, one growing manifest per task — but stays open across the task's life instead of sealing at exit:

- segments and pages publish through the existing v3 publisher route as soon as they are durable, so a reader never waits for process exit;
- each page closes against backpressure: the producer pauses at pipe level while a segment enters the bounded sink, as O1c does, so memory stays bounded for a loud process;
- the manifest gains revisions; when the process ends the final revision seals the stream, and then the capture closes;
- a worker replacement re-opens the manifest at its last published revision and continues; a revision it cannot verify blocks output admission rather than forking the stream.

On the Java side the publications land through the existing `ManagedToolResultStore`/`ManagedArtifactService` pipeline as one Artifact per task, referenced from the task's `artifact_refs`. The `artifact_refs` 100-entry bound is therefore structural — one task holds one output Artifact whose manifest grows — and the projection still refuses a record that would rotate past the bound rather than dropping the oldest reference (no Artifact-to-task attribution exists yet; the task-contract obligation stands). High-volume output never becomes Session events: the task events route below exposes bounded output chunks with cursors, and the full text lives in the Artifact.

Retention: O4 covers foreground Shell publications only. H3 background publications join the same Session retention root with an explicit statement of the coverage gap until the O4 lineage extends to background streams; they are not silently collected by the foreground collector, and Session deletion retires them under the same ordered close.

### Quotas and admission

Per Session, proposed defaults to pin in the contract and size against the existing worker budgets: at most 8 active background Shells and 4 active Monitors, per-worker total 32 active background executions; per-task log bytes bounded by the publication budget (a task that reaches its log budget keeps running but stops publishing new output pages and reports the cap in its next status; it never silently discards). Monitor observation commits are rate-limited by a managed minimum debounce (1 s), so the 10,000-observation record bound also bounds reopen replay cost to 10,000 small bodies — measured and reported in validation; a checkpoint chain stays follow-up if the measurement demands it. Admission failures are committed refusals visible in the journal, not silent drops: starting a ninth Shell answers an over-quota refusal as its tool result, committed in the Session journal, and creates no `child_run` record.

### Session close: terminate, then drain, in order

The distributed close sequence gains its missing step. On Session close, before the Harness activation is closed, the Session authority seals new admissions, issues stop operations for every active Shell and Monitor of the Session, and waits for each process to drain (cgroup empty, output sealed, terminal revision committed). Only then does close proceed to activation close, and the broker-side `drainClaimedBinding` finds no active executions. A Session whose Runtime is lost drains nothing: the processes stay unproven, the close operation reports `workspace_close_execution_unsettled` as it does today for unsettled executions, and the records keep their blocked holds. There is no detach path: close never leaves a live process behind it.

## Task projection and events

### Projection

The task kinds `background_shell` and `monitor` project as H0c defines, with two additions this slice owns:

- the Runtime state gains its missing `draining` row: a record whose latest revision carries a stop request and whose execution has not settled projects `draining`;
- as #12847 A9 decided, a Legacy `paused` or `pausing` state crossing any adapter H3 touches maps to `waiting`; `TaskState` keeps its eight values.

A task that produces output advertises `read_output`; `cancel` stays unadvertised until the cancel slice; `send_input` stays reserved. A task session must have `capabilities.artifacts` before it may admit an output-producing Shell or Monitor, as the contract's §6.1 demonstrates.

### Task events route

`listSessionTaskEvents` and `queryWebShellTaskEvents` become `partial`, `output_cursor`/`outputCursor` lift with them, and the contract minor bumps at merge time (v1.30+; renumber against main, where #13210 and #13247 both claim v1.30). The event kinds are `output`, `state_changed` and `artifact`, subject to the settled contract: one logical cursor position per event, cursors assigned in commit order so a read never passes a concurrently committing event, and a durable retention floor that survives an empty retained set, restarts and projection rebuilds.

Storage: a bounded per-task event journal in SQL (new Flyway table, V35+ on today's main; renumber against #13210/#13217 before landing), written in the same transaction as the commit that produces the event — an output chunk event when a log page of the task becomes durable, a `state_changed` event with each record revision, an `artifact` event when the output Artifact first becomes visible. The floor advances only behind events whose full text is already durably readable in the task's Artifact and discoverable through the task view's `artifact_refs` (the contract's visibility barrier); an archival failure never advances the floor past unarchived output, and the backlog bound is the per-task page budget above plus the held event rows, which the producer backpressure keeps finite.

Output segmentation for the post-`cursor_expired` join: an output event's cursor range is (`stream_id`, first page ordinal, first segment ordinal) to the same triple exclusive at its end, matching the `managed-tool-result/1` page/segment identities, so a client that resumes from the floor reads the Artifact for everything older and the event stream for everything newer with neither overlap nor gap. This closes the H0a follow-up "H3 defines stable output segments".

Before the routes flip, the §6.1 demonstrations run as contract-test traffic: floor expiry including the empty retained set, no behind-the-cursor visibility, cursor identity across restart and rebuild, delayed Artifact projection and archival failure not losing output, the 100-reference bound, the `capabilities.artifacts` admission gate, and segment joins without duplication. The `PlannedTaskContractTest` gaps of #12847 C15/C16 close in the same change, since the event schemas are finally load-bearing.

## Notifications

A Monitor's accepted observation commits its revision and, when the notification policy is due, one notification input plus its `wake.requested` in the same transaction — the machinery H0c already has. H3 makes the wake effective: the embedded scheduler treats a `wake.requested` of a Monitor notification as a runnable Session activation, subject to the Session's ordinary admission (busy Sessions queue the input in the inbox, as channel and Goal inputs already do), and the turn consumes the notification, settling it so that `hosted_turn_recovery_required` never blocks a reopen (H0c open question 6). Notification inputs deduplicate by the watermark: a revision re-delivered during recovery re-runs nothing, because `notifiedThrough` already covers it. Late observations from a revoked generation are refused at the worker route before they can commit.

## Recovery

Recovery follows the classification of the recovery operations design, per outcome:

- **Worker replacement, same boot** (broker alive): a worker that survived is re-adopted by the durable provisioner as today and needs nothing new. A worker that actually died is replaced; the replacement re-attaches a surviving background process by its cgroup unit — the unit exists, the recorded command digest and start receipt match, `cgroup.events` shows members — and resumes capture at the manifest's last revision. A unit empty with no exit evidence, or evidence that cannot be verified, is `outcome_unknown`: the record goes `recovery_blocked` with `runtime_lost`, the execution keeps its hold, and nothing reruns. A proven empty unit with sealed output and exit evidence settles `exited`.
- **Host reboot** (trusted reboot recovery default-on since #13211): every process of the old boot is physically gone but its pre-reboot outcome is unknowable. The durable-provisioning evidence (`JOURNAL_LOST`/`WRITERS_STOPPED`, same trust model) drives the binding LOST; H3's still-active background executions block blind cleanup exactly like other unsettled executions (the #12670 wedge). The existing `abandonByBinding` reclaim path, under its loss evidence, may then release the ledger rows — an abandoned row clears the Runtime hold but is a ledger outcome, not a physical one: the H3 records keep `recovery_blocked`/`outcome_unknown`, because whether the process exited before the reboot is unknowable, and abandonment never projects as settled. H3 does not claim cross-boot attach. The still-owed W0e-3 exact-head physical reboot acceptance must also cover H3's executions in this shape; this design states the obligation and claims no proof.
- **Broker restart / reconciliation**: unchanged mechanics; active executions keep their sessions and bindings held, reconciliation re-grants claims per generation as today.
- **Console stop/kill during uncertainty**: stop requests are durable (committed revisions); a late generation's answer is reconciled against the record, never treated as a new effect.

**Monitor rebuild.** Only a Monitor whose command is known read-only may be rebuilt after Runtime loss: a maintenance phase under an `OperationGrant` starts a fresh watch under the new generation, commits a new start receipt, and continues `observationSequence` from the committed watermark with the `runtime_lost` reason kept, projecting `degraded` meanwhile — the H0b rebuild rules as the fixtures pin them, including that a rebuild starts only from `outcome_unknown`, never from a settled execution, and that a non-rebuildable target stays blocked (H0b open question 5 answered as the design states: H3 never returns such a run to `running`/`waiting`). Every other Monitor, and every background Shell, stays blocked; starting over is always an explicit new call under a new activation, never recovery.

**LOST-wedge interaction.** A binding with active H3 executions that goes LOST keeps pinning placement until its executions stop with evidence, as any unsettled execution does. When the reclaim path applies `abandonByBinding` under its loss evidence, the released rows clear their holds, but an abandoned execution is never physical evidence about its process: the records keep their blocked states, and nothing projects a possibly-live process as settled.

## Interfaces and compatibility

- **Worker protocol.** One new private route sibling to `ManagedHookProtocol` (`/internal/managed-runtime/v3/…`) with kinds for shell-start/status/terminate/kill, monitor-start/status/stop, and the read-output stream; `RECOVERY_KINDS` for status/terminate carry `targetOperationId`. The route validates the Session, workspace generation and operation grant before new effects, exactly as the Hook and MCP routes do.
- **Public API.** The task events routes flip `planned`→`partial` on both surfaces with their controllers and contract-test traffic; no other public route changes. No PID, absolute path, Runtime endpoint or cgroup name crosses the public surface — `status` projections carry only the managed states, and diagnostics are authorized Artifact references, as the task view already promises. No new public error codes: a platform isolation refusal surfaces the way H2 defines it, as a recorded failed admission (`start_failed` with `handler_unavailable`), not a transport error.
- **Legacy surfaces unchanged.** Daemon `/session/:id/tasks`, `BackgroundShellRegistry`, `MonitorRegistry` and the Legacy Shell/Monitor tools keep their behavior; nothing here migrates Legacy sessions or reuses their in-memory registries as evidence.
- **Flyway/contract.** One new Flyway migration (task-event journal table; any execution-ledger columns the hold accounting needs) at the next free version, and the contract minor bump, both renumbered against main at merge.
- **Enablement.** `monitor_run` and `child_run` stay disabled until one release carries both sides and the server is deployed before writers, per Reader gating; Sessions receiving their first `monitor_run` record gain that section's reader protection.

## Acceptance

The reference design §13 H3 gate and the §14 items this slice can take, made checkable:

1. A background Shell started with a loud child tree is supervised by its cgroup unit; stop kills root and descendants, proves the unit empty, seals output and settles; the kill is observable in the SQL commit sequence and the unit's `cgroup.events`, never in a PID file. (§14.3)
2. A loud Shell publishes bounded segments with pipe-level backpressure; peak worker memory stays flat while 1 GiB streams; the full text is readable from the Artifact with digest identity, and no line ever becomes a Session event. (§14.8)
3. A Runtime executing a running Shell or an active Monitor refuses workspace close with `workspace_close_execution_unsettled` and Session release with `runtime_session_busy`; after stop and drain both succeed. (§13 hold)
4. Worker sigkill mid-stream: the replacement attaches the same unit and continues the manifest from its last revision; output before and after the replacement has exactly one copy each and the event stream has no gap. Host-reboot simulation (trusted recovery): records go `recovery_blocked`/`runtime_lost`, holds persist until evidenced reclaim, nothing reruns. (§14.1, §14.3)
5. A Monitor at high event rate aggregates within its debounce, commits at most its quota of observations, notifies each due watermark advance exactly once with no duplicates across a worker replacement, and stops with `max_events`/`idle_timeout`/`stop_requested` reasons exactly as the contract requires. (§10, §14.8)
6. A read-only Monitor (e.g. watching a file's size) survives Runtime loss as `degraded`, rebuilds under the new generation, and continues from its watermark; a side-effecting Monitor and every Shell in the same failure stay blocked. (§10)
7. Task events route: the §6.1 demonstration list passes as contract-test traffic on MariaDB and MySQL; `cursor_expired` recovery joins Artifacts and events with no overlap in a property-style loop. Restart, rebuild and archival preserve cursor identity. (contract §6.1)
8. A Session close with active Shells drains them before the activation closes; a close over a lost Runtime reports `workspace_close_execution_unsettled` and leaves the blocked records queryable. (§12 close order)
9. Cross-tenant, cross-session and client-scope violations on task events read 404/403 per the contract; public responses expose no PID/path/endpoint/cgroup name. (§14.9)
10. Every H3 failure classifies as `not_started_proven` / settled / attachable / `unknown` or `corrupt`; an unknown outcome is never reported as success and never auto-reruns. (§14.10)

Validation keeps the H1/H2 shape: collocated unit tests per store/protocol/authority change, the shared-fixture replays for the `child_run` body and its chains in both languages, contract tests for the flipped routes and the closed event schemas, the fault-gate suites extended with H3's executions, and real-process evidence (exact cgroup unit, exit evidence, manifest digests and SQL commit sequence) in the run reports. Physical acceptance on a Linux host with delegated cgroup v2 is owed at exact merge head, in the same style as H2's eleven real-stack rounds.

## Open questions

1. **Whether `capabilities.artifacts` can ever be false for a Hosted Session.** If every Hosted profile already guarantees it, the admission gate is a contract demonstration only; if local profiles lack it, the refusal needs a surfacing path in session creation diagnostics.
2. **The 100-reference bound.** One output Artifact per task makes it unreachable in practice; should the projection refuse (fail-loud) or hold (stop new `artifact` events, keep output publishing) at the bound? This document says refuse, because silently aging out a reference is the failure the contract forbids.
3. **Stop while blocked.** A stop request on a `recovery_blocked` Shell cannot reach its owner. H3 records the stop intent but settles nothing until the owner answers or reclaims; whether a later operator route force-closes such a record is the cancel slice's question (cf. H0b open question 4).

## Follow-up work

| Slice                       | Scope                                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| H4–H5                       | `child_run` kinds `child_agent`/`workflow`/`team`; outbox dispatchers; public task cancel with `task_id`/`failure_code` persistence. |
| send_input                  | Interactive stdin to a background Shell; the `TaskActionCapability.send_input` route.                                                |
| Detach                      | Migrating an explicitly detached process to an independent durable owner across Session close.                                       |
| macOS process-group profile | Weaker supervision claims for non-Linux developers; local-only, never Hosted.                                                        |
| Reopen-cost checkpoints     | A monitor-chain checkpoint if the measured 10,000-body replay demands it.                                                            |
| Artifact→task attribution   | Enumerating older Artifacts for a task, lifting the structural need for the 100-reference bound.                                     |
