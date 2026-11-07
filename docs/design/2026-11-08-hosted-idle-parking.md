# Idle parking for resident Hosted Sessions

[English](2026-11-08-hosted-idle-parking.md) | [简体中文](2026-11-08-hosted-idle-parking.zh-CN.md)

Status: proposal for discussion, not accepted. This is step 6 of [#16320](https://github.com/QwenLM/qwen-code/issues/16320), whose steps 1–5 have merged, and it is discussed under [#15082](https://github.com/QwenLM/qwen-code/issues/15082). It extends the non-destructive release of the [Kubernetes shared Hosted Harness pool](2026-10-21-managed-harness-kubernetes.md). Code references are to `main` at `0807f5d391`. A bare `:line` refers to the file named last.

## What parking has to remove

While a Session stays loaded in the Hosted Harness, it costs platform work with nothing running. #16320 measured 51–56 statements a minute per resident Session. The sources:

- **Activation renewal.** One `/writers:renew` every 20 s (`managed-session-assembly.ts:60`, a third of the 60 s lease).
- **Heartbeat.** One `POST /session/:id/heartbeat` from Java every 30 s (`ManagedAgentProperties.java:636`). The Harness handler only echoes (`hosted-harness-session.ts:12411`).
- **Harness memory.** The Session's whole event log stays in the Harness (`managed-session-authority.ts:469`).
- **Listener.** A Session that ran a Shell also keeps a loopback listener (`HostedShellPublisher`).

Parking means: unload the Session from the Harness after it idles, keep its sandbox resident, and load it again on the next input.

## What main already has

1. **Loading on the next input.** A Java-driven verb whose Session is not in the attachment cache loads it:
   - prompts, through `HarnessCoordinator.runClaimed`;
   - approval and question answers (`QwenHostedHarnessConnector.java:1085`);
   - channel operations (`:1471`);
   - automation runs (`:1186`);
   - Session messages and child results.

   Two loaders also pick up committed wake inputs once the journal is unowned:
   - `WakeRecovery`, for public, active, non-CSI Sessions whose journal has not been compacted, and six input sources (`WakeRecoveryStore.java:27-34`, `:69-73`);
   - the MQ wake path, `TransportWakeActivator`.

2. **A non-destructive release.** The Kubernetes drain design (`docs/design/2026-10-21-managed-harness-kubernetes.md`) added `releaseIdleOwner` (`hosted-harness-session.ts:4467`). It does the following:
   - checks a list of idle conditions;
   - stops the renewals and releases the activation;
   - has the Store seal the head behind a durable `hosted_harness_release` receipt;
   - drops the Session without cancelling accepted input.

   The Store halves are `quiesceOwnership` and `releaseOwnership` (`JournalWriterLifecycle.java:437-448`, `:450-546`).

3. **Runtime bindings that do not depend on the Harness attachment.** For non-CSI Sessions, binding and Workspace admission do not consult the activation, so a Session without one keeps its sandbox. CSI-guarded Sessions couple the two (`JdbcCsiActivationAdmission`), and they already refuse a release (`hosted-csi-session.ts:316`).

`POST /session/:id/detach` is not a candidate. It is the same `close()` as delete (`hosted-harness-session.ts:12794-13066`):

- it drains background runs;
- it cancels pending wake inputs as `session_closing`;
- it releases the MCP Runtime;
- it seals the writer.

## Why the release does not park today's resident Sessions

1. **It is built for a draining pool member, and only that.**
   - The route exists only when the Harness has an `instanceId` (`hosted-harness-session.ts:4416-4419`), and it refuses while the instance accepts work (`:4443-4446`).
   - The POST gate on a releasing Session (`:7935`) and request tracking (`:4418`) also exist only with an instance.
   - Loads are not gated per Session at all. The load route (`:7924`) is registered before that gate, and `open()` refuses only when the whole instance is quiescing (`:4993`).
   - The Store requires a `QUIESCING` pool placement (`JournalWriterLifecycle.java:503`). The receipt is keyed by placement epoch (`HarnessPlacementStore.releaseId`, contracts module `HarnessPlacementStore.java:29-31`), and its schema requires `instanceId`, `bootId` and `placementEpoch` (`ManagedHarnessReleaseRecords.java:14-24`).
   - The SDK and connector refuse without a placement (`QwenHostedHarnessConnector.java:273-275`). Nothing in the control plane calls `releaseOwnership`.
2. **It cannot back out.**
   - `session.ownershipRelease` is set before the pending-input check (`hosted-harness-session.ts:4494` vs `:4507-4514`) and is never cleared. The route refuses any other `operationId` (`:4448-4451`).
   - Preparing stops the activation renewal loop for good (`managed-session-assembly.ts:334`) and commits the activation release. The Store client's release call stops the writer renewal for good and refuses later writes (`http-managed-session-store.ts:2384-2403`, `:2496-2498`).
   - In a pool, quiescing cannot be undone. A `QUIESCING` placement refuses any new active activation (`JournalCommit.java:345-350`), and only a takeover sets it back to `ACTIVE`.
   - A draining process exits and crash recovery takes over. A Harness that keeps serving would hold the Session wedged.
3. **Its idle test counts objects that are never removed.** `heldResources` (`hosted-harness-session.ts:4360-4380`) counts:
   - whether a publisher exists. The first Shell or Monitor call creates `shell.publisher` (`hosted-workspace-tool-turn.ts:4903`), and the first background or Monitor call in publication mode creates `backgroundLane.publisher` (`:4925`). Neither is ever cleared;
   - every Monitor loop. Loops are added (`hosted-workspace-tool-turn.ts:7955`) and never removed;
   - every `heldRuntimeTurns` entry. Only `close()` removes those (`hosted-harness-session.ts:12919-12948`), and a load re-adds them from Broker hold rows (`:7818`);
   - `session.mcp` and `session.hooks`. These exist whenever MCP servers or settings, or a hook catalog, are configured (`hosted-harness-session.ts:6414-6427`). The MCP servers run in the Runtime, and `HostedMcpSession` holds the Session's Workspace mount.

   The last point matters most for the target deployment: resident sandboxes that register MCP servers and install Skills and software.

   Three other terms are instance-wide: `inFlightMutations`, `opening.size` and `initialReconciliations` (`hosted-harness-session.ts:4475-4477`). Any other Session's traffic, including heartbeats, therefore blocks the release.

4. **Java does not expect a Harness to drop a Session.**
   - `HarnessCoordinator.java:62-66` assumes the daemon drops an attachment only on an explicit detach or delete.
   - Verbs read the cached attachment and then call the Harness. The Turn dispatcher classifies a `404 hosted_session_not_found` as a terminal `hosted_harness_rejected` (`HarnessCoordinator.java:398-402`), and other verbs pass the error on.
   - #15795 hit this during drain. #15990 fixed the automation retirement and made the pool answer 503 for a released placement with no accepting member, but not the other verbs.
   - On the heartbeat's 404 the SDK retires its attachment, but nothing tells the connector.
   - `GET` session reports `operator_required` for a non-initial Session with no cached attachment (`SessionRecoveryService.java:131-135`, `QwenHostedHarnessConnector.java:1789-1795`). That already happens after any Java restart.

## Proposal

**The Harness parks. Java treats a missing Session as parked.**

The Harness is the right owner, for three reasons:

- it alone knows what the Session holds;
- the control plane can run on several nodes, so no Java-side lock keeps a release from racing a verb;
- an idle clock in Java would be lost on a Java restart, leaving those Sessions loaded and renewing.

**Park sequence in the Harness.**

1. **Idle clock.** The clock is the latest of three times: the Session's last admitted mutation, its last journal commit, and its last `turn.settled`. A long Turn that just settled, or a wake-pump Turn with no POST, therefore restarts the clock. Heartbeats and read-only status requests do not count. `GET` session asks the Harness for recovery status whenever the node caches an attachment of a non-initial Session with no active Turn (`SessionRecoveryService.java:121-135`, `:160-169`), so a client polling a Session would otherwise keep it loaded. After `park-after`, the Harness tries to park.
2. **Pre-check.** Check the conditions that do not change while the Session is idle: MCP, Hooks, CSI, a pool placement that is `ACTIVE`, and an instance that is accepting work. A Session that can never park therefore never raises the gate. A drain owns a quiescing Session, and a park never starts once the instance stops accepting.
3. **Gate.** Set a per-Session gate, in both modes:
   - POSTs to the Session answer `409 hosted_session_parking`;
   - a load for it waits inside `open()`, and that waiting load is counted neither as an opening nor as an in-flight request.
   - In a pool, a held load carries the pre-park placement token. After a receipt it would fail with `harness_placement_released` (`HarnessPlacementStore.java:195-197`), and `open()` would report that as a generic 503. So after a receipt a pool member answers the held load with a retryable 409, as drain does with `hosted_harness_quiescing` (`hosted-harness-session.ts:4993`).
4. **Wait, bounded.** Wait until this Session's other in-flight operations settle, tracking each until its own work settles rather than until the response finishes.
   - The instance counter waits for `finish` on purpose, because a disconnected response cannot prove its operation ended (`hosted-harness-instance.ts:79-82`). But a client that gives up then keeps the owner unreleasable for the life of the process. Drain accepts that because it ends in the crash path; a park cannot.
   - If the wait outlasts a bound, abandon the attempt and clear the gate.
5. **Check.** Run the remaining conditions. If one fails, clear the gate. They are the existing list with the instance-wide terms replaced by this Session's own requests and openings, plus:
   - no pending inputs at all. Today an unattempted wake input is allowed (`hosted-harness-session.ts:4500-4512`);
   - none of the post-Turn completions that the drain gate admits are still owed (`:7940-7975`): channel receipts and deliveries, message and child operations, automation reconciles;
   - no open `/events` stream. Java opens one only while it drives a Turn (`HarnessCoordinator.java:868`, `:1384`);
   - no pending channel reply-plan retry.
6. **Stage.** Pause the renewals and wait for any in-flight renewal to finish before entering the authority's serial queue. Activation renewal runs inside that queue (`managed-session-authority.ts:3737`), so pausing from inside it would deadlock; today's `prepareOwnershipRelease` also stops renewal first (`managed-session-assembly.ts:334-335`).

   Then, in one turn of the queue:
   - run the pending-input check;
   - encode the activation release as the next journal transaction, without applying it;
   - hold the queue until there is an outcome, so nothing else is encoded against the same head.

   While a Session parks, `releaseIdleOwner` treats it as busy.

7. **Commit.** Call the Store park verb described below.
8. **Outcome.**
   - **Refusals that leave the head and the writer intact** (a lifecycle claim, a quiescing placement) discard the staged transaction, resume the renewals and clear the gate.
     - Only a refusal that also confirms the writer and its lease counts as intact. Today the release checks the claim and `QUIESCING` before the writer (`JournalWriterLifecycle.java:502-511`), so the park verb must check the writer first, or report its verdict with the refusal.
     - Without that verdict, for example after an unknown outcome, a refusal drops the Session.
   - **Every other refusal drops the Session locally.** That covers a writer or proof conflict, a changed generation, and an expired lease. The Store decides expiry by database time, so the Harness must not judge it by its own clock. Resuming after such a refusal would silently reacquire the writer (`http-managed-session-store.ts:1281-1285`). Both possible heads, sealed or active with a lapsed lease, can be reacquired.
   - **An unknown outcome keeps the gate.** The Harness retries the same operation until it reads back a receipt or a refusal. The Store looks the receipt up before it checks the writer (`JournalWriterLifecycle.java:487-501`), and the checks before that lookup are MAC checks, so an exact retry still finds the receipt after a successor has acquired.
   - **After a receipt**, stop every timer of the Session, including the channel reply-plan retries, which release leaves running today (`hosted-harness-session.ts:6940-6963`). Then delete it.

**The Store park verb.** One JDBC transaction does the following:

- runs `JournalCommit`'s validation and head update for the staged activation release;
- seals the head;
- writes the receipt;
- clears `is_wake_pending` and sets `wake_head_revision` to the new revision. `is_wake_scan_pending` is also true whenever `wake_head_revision` differs from `journal_revision` (`V1__managed_schema.sql:222`).

It is fenced by:

- the writer: an `ACTIVE` head, the writer id, generation and token, and an unexpired lease;
- a proof of the pre-park revision, committed sequence and last digest;
- the activation id and epoch being released;
- `requireNoLifecycleClaim`, as the current release is (`JournalWriterLifecycle.java:506`).

In a pool it also moves the `ACTIVE` placement to `RELEASED` and checks the epoch.

The receipt:

- is keyed by writer generation, or by placement epoch when there is one;
- carries the post-commit revision, sequence and digest, which the SQL `ready` view needs. Today the receipt copies the request's revision and commit proof (`JournalWriterLifecycle.java:481-483`). Those equal the final head only because the activation release committed before the call (`:511-515`). The park's request proves the pre-park head, so the receipt needs post-commit fields beside the proof: `committedSequence` must equal the proof's (`ManagedHarnessReleaseRecords.java:32-34`). The schema also requires `instanceId`, `bootId` and `placementEpoch` (`:14-24`), which single mode lacks;
- needs a retention rule. Each park writes a resource, a record and a ref row (`JournalWriterLifecycle.java:527-539`), where today's receipts are one per placement epoch. Keep at least the latest, so that an exact retry still finds it.

The verb should follow an existing lock order: placement guard, then tenant guard, then Session root, as the release does (`JournalWriterLifecycle.java:465-467`).

`JournalCommit.commitCsiTerminal` (`JournalCommit.java:483`) is a precedent: it already commits a staged activation release and seals the head together.

The wake hint has to be cleared because it is costly to leave set:

- While the head stays owned, `is_wake_pending` stays set on any Session that ever took a channel, automation, message, child, Monitor or workflow input (`JournalCommit.java:361`).
- A sealed head is unowned, and the scan that clears the hint re-reads the journal from the start (`WakeRecoveryStore.java:109-139`).

Clearing it this way changes an invariant. `2026-10-18-hosted-wake-recovery.md` clears the hint only after an independent replay of the committed prefix, and `WakeRecoveryStore.java:243` says so: "Only a full prefix at this exact revision may clear the hint". The park replaces that backstop with the writer's own assertion. That is justified on three grounds:

- the writer can already commit `turn.settled` for the same inputs;
- its in-memory prefix is complete for an uncompacted journal;
- the park requires no pending input of any source. That is a superset of the six sources the scan counts (`hosted-wake-intake.ts:42-57`, `WakeRecoveryStore.java:27-28`). The proof fences the head.

Compacted journals keep today's rule.

**Today's primitives latch, so they cannot be reused as they are.**

- `prepareOwnershipRelease` commits the activation release before the seal (`managed-session-assembly.ts:329-341`).
- The renewal loop's `stop()` is final (`managed-session-assembly.ts:111-115`).
- The Store client's `ownershipRelease` fences every later request (`http-managed-session-store.ts:2899`), and `stopWriterRenewal` stops renewal for good (`:2492`, `:2662`).
- `prepareOriginalCsiRelease` (`managed-session-authority.ts:3891-3954`) already encodes a release without applying it, for the Store to commit with a retirement. But it latches the authority (`:3343-3349`).

The park needs non-latching versions of these. On a refusal the authority stays consistent: only `applyCommitted` advances its committed state (`managed-session-authority.ts:3578-3618`).

**Fencing in single-address mode.** A write is fenced by an `ACTIVE` head, the writer id (the Harness's boot id), the generation, the writer token and an unexpired lease (`JournalFencing.java:288-299`).

The token does not tell Harnesses apart:

- With a binding key, it is a per-Session MAC that every Harness receives (`WriterCredentialPolicy.java:55-62`).
- Without one, each Store client makes up a random token (`http-managed-session-store.ts:1034-1035`). That fences a live lease, but like the MAC it does not stop a new acquire once the head is sealed.

After the seal, any writer may acquire with the next generation (`JournalWriterLifecycle.java:258-301`). So a stale load from an old Harness can reopen a parked Session for as long as it stays parked.

- Today a detach or close also seals the head, but the control plane detaches only under a lifecycle claim, after which ordinary acquires are refused (`JournalWriterLifecycle.java:186-197`). In practice, then, that exposure exists only after a lease lapses.
- The pool's placement epoch prevents it during drain, and single mode has none. Question 2 asks whether that is acceptable.
- The next acquire bumps the generation, and the load issues a new `clientId`.

**Java.** A connector rule for admission verbs: prompts, approval and question answers, channel, automation, message and child operations.

- A `404 hosted_session_not_found` on a cached attachment retries once through a passive load. A 404 comes from the gate or the handler's identity check before any work (`hosted-harness-session.ts:1214-1229`), and relay verbs replay by derived command ids, so the retry cannot execute anything twice.
- Remove the entry with compare-and-remove, as `doSettleLifecycle` does (`QwenHostedHarnessConnector.java:357-360`). Only when that succeeds, also remove its pending recovery and its `mcpManagementAttachments` entry. Otherwise a stale reference's 404 could wipe the entry a concurrent recovery load just set.
- A 404 on the Turn path goes through `recoverManagedRuntime`, so that `pendingRecovery` and `bindRecoveredHarness` still apply.
- In a pool, the retry goes back through `HarnessPoolConnector.select` with acquiring allowed. The leaf connector's thread-local `PoolCall` still carries the old placement (`QwenHostedHarnessConnector.java:126-137`).
- Lifecycle settle keeps its rule that absence proves nothing.
- Cancel stays out of the rule, because its 404s can follow side effects (`hosted-harness-session.ts:11743-11745`).
- `409 hosted_session_parking` is a wait. For the Turn path it joins `isPoolWait` (`HarnessCoordinator.java:1694-1703`). The relay verbs need the same wait, because today they pass a Harness 409 straight back.
- The SDK tells the connector when a heartbeat retires an attachment. Verbs outside the rule then see a stale reference for at most one heartbeat interval per node: rename, reading a context compression, opening a Turn's Harness stream, MCP management, extension management (`applyExtensions`, `continueExtensionOperation`), and cancel.
- Pool verbs reselect from SQL on every call (`HarnessPoolConnector.java:245-300`), so stale references are mainly a single-mode problem.
- `GET` session reports `ready` from SQL for a head sealed behind a release receipt at the current revision, with no unsettled inputs.

Prompt admission dedupes against the journal, and a parked Session has no pending action. These changes also close the drain-era gap behind #15795, so they can land first.

**Wake is the existing load.** Only the writer appends, so nothing is committed while a Session is parked.

A parked Session loads again on:

- a verb's cache miss;
- a read that goes to the Harness, such as reading a context compression or opening a Turn's Harness stream (`QwenHostedHarnessConnector.java:858`, `:1009`). The public event stream is served from SQL and does not load;
- an MQ wake notice first delivered after the park. `TransportWakeActivator` loads any head that has no live writer without checking that the input is still pending (`TransportWakeActivator.java:133-147`). `claimWake` takes each sequence once, so redeliveries are refused. Phase 0 counts how often this happens.

Because the head is sealed, a load takes it over at once instead of waiting for the lease to lapse.

**What keeps working while parked**

| Work                                                      | Driven by                                 | Parked behaviour                                                                                                                              |
| --------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompts, approvals, questions                             | Java                                      | The next verb loads the Session. A pending approval or question means a Turn is running, so that Session is not idle.                         |
| Cancel                                                    | Java                                      | A cache miss runs recovery. A parked Session has no Turn to cancel. A stale cached reference answers 404 until the heartbeat notice drops it. |
| Rename, context compression, MCP and extension management | Java                                      | Outside the 404 rule. A cache miss loads the Session; a stale reference fails for at most one heartbeat interval.                             |
| Close, delete, archive                                    | Java lifecycle                            | Load the Session first, then take the existing close path.                                                                                    |
| Automations, channels, Session messages, child results    | Java clock and relays                     | They load the Session.                                                                                                                        |
| Public event stream                                       | SQL and the event hub                     | Unchanged. The Harness's own event streams stop with the Session.                                                                             |
| MQ owner subscriptions                                    | `OwnerSubscriptions`                      | They drop the Session once it has no active writer, and the MQ wake loads it.                                                                 |
| Background Shells, Monitors                               | The Harness's publisher and Monitor loops | Not parkable: nothing outside the Harness receives their output.                                                                              |
| MCP servers, Hooks                                        | A Runtime Session held for the Session    | Not parkable until phase 5.                                                                                                                   |
| CSI-guarded Sessions                                      | —                                         | Not parkable.                                                                                                                                 |

## Phases

0. **Measure before choosing defaults.** The first measurements are below; they change the order of the later phases. Still open:
   - how often a parked Session is reloaded without new input, for example by a late MQ wake notice;
   - how many resident Sessions each blocker above excludes in a real deployment. On the #16320 rig every Session runs a Shell, so the publisher alone excludes them all.
1. **Make "held" mean live work.**
   - Close a Session's publisher once it has no open capture and no held Runtime.
   - Remove a Monitor loop when it stops.
   - Remove a `heldRuntimeTurns` entry when its hold ends, and release that Runtime Session at the Broker. Otherwise the next load re-adds the entry from the Broker's hold rows, which only the Runtime Session's `RELEASED` record discharges (`RuntimeHoldInventory.java:13-21`). That changes what close has to drain.

   This overlaps #16320 step 7's shared publisher listener, so one of the two should go first.

2. **Java tolerance.** The connector rule, the heartbeat notice and the recovery view. These are useful without parking.
3. **Make a load cheaper per Turn of history.** A Workspace load reads every durable reference the journal holds at least once, and phase 0 measured about 43 reads and 870 statements per earlier Turn (below). Parking would cost more than it saves for any Session that is not parked long. The options are:
   - (a) **Read each body once.** Reuse the bytes the restore verification already read:
     - fill the message-body cache with the message bodies it reads, so the projection does not read them again;
     - let the checkpoint, Shell receipt and tool-result manifest checks use those bytes instead of reading them a second time (`hosted-harness-session.ts:2792`, `:2623`, `:3023`);
     - do the same for the definition, instructions and skills that the load route reads before the verification reads them again, and for the container records that opening the Session already verified but the verification queues again (`RESTORE_CONTAINER_KINDS`, `hosted-harness-session.ts:410-429`, `:2683-2686`).

     This changes no safety property.

   - (b) **Read in batches.** Verify and read the references through one Store call per batch, under one read lease, instead of one lease round trip per resource. The batched call keeps every check a single read makes today, including the writer credential and read authorization, the head, retirement and CSI checks, the digest recomputation (`JournalStoreRows.java:489`), the quarantined tool-outcome refusal (`:492-501`), the tool-publication capture match and the lease check after the read.
   - (c) **Skip what a clean park covers.** After a clean park receipt, skip re-reading the references its commit proof covers, and verify each one when it is first used.
     - The message bodies and extension record bodies are still read to rebuild state, so this removes only the rest.
     - A reference whose first use never comes is never checked again.
     - Checks that have no first use are dropped with the reads. They include:
       - the reference-conflict check (`hosted-harness-session.ts:2690-2701`);
       - the checkpoint layout refusal (`:2794-2798`);
       - the publication receipt cross-check (`:2935`) and the check that a publication has a verified receipt (`:3035`);
       - the capture completeness and content digest checks (`:2952-2987`, `:3038-3040`);
       - the detached-capture lineage checks (`:3042-3072`).

       So is the `publication_incomplete` load refusal the cross-check feeds (`:7707-7731`), unless a clean park requires every capture to be complete.

     - A lost resource then fails a Turn instead of the load answering `409 hosted_turn_recovery_required` with reason `restore_verification_failed`.

   None of these makes a load independent of history, because the state a Session needs grows with it: its messages and extension records. They cut the cost per earlier Turn. Question 5 asks which to take.

4. **Parking for Sessions without MCP, Hooks or live background runs.** It covers:
   - the one-transaction Store park verb and its receipt shape;
   - non-latching staging, renewal pause and Store-client park;
   - the idle clock, the per-Session conditions, and the gate on POSTs and loads;
   - the retry rule for an unknown outcome;
   - a `park-after` setting, off by default until the load cost after phase 3 picks a value;
   - tests where an input, a load and a Java or Harness restart race a release.
5. **MCP and Hook Sessions.** Choose one of:
   - (a) Keep their Runtime Session held across the park, and adopt it on load without counting an idle hold as work.
   - (b) Stop the servers on park and start them on wake. This frees sandbox memory but adds their startup to the first Turn after a wake.

Out of scope:

- Retiring idle Runtime bindings or Workspaces. `2026-10-15-managed-workspace-resident-runtime.md` §4.5 defers that.
- Receiving background-Shell output outside the Harness.

## Phase 0 results

**Setup.** The stack is the #16320 rig on one Linux x86_64 host with 16 cores, built from `main` at `a32684604a`. That build differs from the pinned `0807f5d391` in `hosted-harness-session.ts` only in `retryHostedCleanup` and its `cleanupRetry` field, so the read paths are the same. It ran:

- the Spring exec jar with the embedded Runtime Broker;
- `qwen serve --profile hosted-harness`;
- MySQL 8.4.6 in Docker, on tmpfs with the binary log off. Wall times are therefore lower bounds, but statement counts do not depend on it;
- a scripted model, with each Turn making one approved `run_shell_command` call.

**Procedure.**

1. Build three Sessions with 1, 40 and 200 Turns of history.
2. Measure one Turn of each while it is loaded.
3. Stop the Harness gracefully, start a new one, and wait 65 s for the old writer leases to lapse.
4. Measure the first and second Turn of each Session, one Session at a time.

A restarted Harness loads a Session through the same `open()` as a wake after a park: it replays the journal, runs the Workspace restore verification and starts with a cold message-body cache. Two things differ:

- The rig's heads were active with lapsed leases rather than sealed. They take the same takeover path.
- Java first had to adopt the new Harness generation. That took about 1.7 s and fell on the first Session measured, so about half of the 1-Turn row's 3.3 s is restart overhead.

|   History | Turn while loaded        | First Turn after a load    | The load request alone | Second Turn after a load |
| --------: | ------------------------ | -------------------------- | ---------------------: | ------------------------ |
|    1 Turn | 2,681 statements, 0.84 s | 5,093 statements, 3.3 s    |                 0.37 s | 2,673 statements         |
|  40 Turns | 2,678 statements, 0.84 s | 38,705 statements, 4.5 s   |                  3.3 s | 2,682 statements         |
| 200 Turns | 2,713 statements, 1.25 s | 177,992 statements, 18.5 s |                 17.2 s | 2,732 statements         |

Each load follows one more Turn than the history column shows, because the loaded Turn of step 2 ran first. The loads therefore replay 2, 41 and 201 Turns.

**Where the cost goes.**

- A load adds about 870 statements and 85 ms for every earlier Turn.
- At 200 Turns the first Turn after the load also took 14 s of Java CPU and 43 s of MySQL CPU, against 0.4 s and 0.3 s while loaded.
- Almost all of it is resource reads. The first Turn after the 200-Turn load made 8,681 read-lease round trips, where a loaded Turn makes 32. Each round trip is about 20 statements. They include the resource-row select, the head and retirement checks, the lease insert, check and delete, the `last_verified_at` update, clock reads, `ma_session` upserts and the commit. Together they account for about 99% of the extra statements.
- The reads that grow with history happen inside the load request. The load's own time grows by about 85 ms per earlier Turn, while the rest of the first Turn stays at about 1.2–1.3 s at every history length. For the 1-Turn row that holds once the 1.7 s generation adoption is excluded. Read leases fit 32 + 6 + 43 per earlier Turn; the 6 constant extra reads are too few to matter.
- The reads that grow with history come from three places, all through the Store:
  - replaying the journal rebuilds the extension records and reads their bodies (`rebuildExtensionRecords`, `managed-session-authority.ts:3112`, while the Session opens);
  - the Workspace restore verification reads every durable reference the journal holds, message bodies included, and checks each against its digest (`verifyWorkspaceRestore`, `hosted-harness-session.ts:2666`);
  - the verification then projects the messages (`:3074`), which reads the message bodies again, because the cache of #16337 keeps only the bodies it read itself.

  These are not the only duplicates. The verification itself reads checkpoints, Shell receipts and tool-result manifests twice. It reads the definition, instructions and skills again after the load route has read them. And it queues again the container records that opening the Session already verified. The rig did not record how the reads split between the sites.

- Statement time is dominated by the `ma_session` upsert. Over the first Turn after the 200-Turn load, it took 69.9 of the 82.6 s of statement time, at 8.0 ms each. In the loaded Turns it took 0.33 ms and 0.17 ms.
  - This fits waiting on that row's lock. The verification runs 32 reads at once (`RESTORE_READ_BATCH`, `hosted-harness-session.ts:404`), and each one upserts the same `ma_session` row.
  - The digests do not record lock time, so this is an inference.

**What parking would save.**

- **Idle traffic and break-even.**
  - Idle traffic is 51–56 statements a minute per resident Session, as #16320 measured. This run did not measure idle traffic.
  - Each earlier Turn adds about 16 minutes to how long a Session must stay parked before its next wake costs less than the idle traffic it saved. That comes to about 45 minutes for the 1-Turn Session, about 11–12 hours for the 40-Turn one, and 52–57 hours for the 200-Turn one.
  - Measured in MySQL CPU the picture is worse, assuming an idle statement costs what a loaded Turn's statement costs. For the 40- and 200-Turn loads, a cold load's statements cost about twice as much MySQL CPU each (1.2 times for the 1-Turn load); the rig did not find out why.
  - The wake also adds about 85 ms per earlier Turn to the first Turn: 17 s at 200 Turns.
- **Harness memory.** These figures are for the Harness process alone, after a forced GC, without the three Runtime workers. In the restarted Harness, before any Session was loaded, the heap was 90.3 MiB and USS 163.3 MiB. With the three Sessions loaded again it was 119.8 MiB and 294.7 MiB. Most of the USS growth is native or retained memory rather than heap. The message-body cache is bounded at 64 MiB, but it held under 1 MiB here: external memory grew by 0.9 MiB.

  This growth is not what unloading would return. Before the restart the old Harness had the same three Sessions loaded at the same heap, 119.8 MiB, but 334.6 MiB USS. So USS depends on the process's history: warm-up and memory the allocator keeps. The three Sessions' own state is at most the 29.5 MiB heap growth, about 24 MiB of it outside code space. How much an unload returns has to be measured by unloading within one process.

That is why phase 3 comes before parking.

## Questions to agree on

1. Does the Harness own the trigger, as proposed? A Java-owned trigger would need a per-Session lock shared by all control-plane nodes and every verb.
2. Single-address mode: is the writer fence (boot id, generation, lease) enough, given that a stale load can reopen a parked Session for as long as it stays parked? Or should single mode get a placement row, so that a placement epoch fences it as in a pool?
3. Phase 5: should MCP servers keep running across a park (a), or restart on wake (b)? This decides what parking saves for the target deployment.
4. Should a parked Session be visible as such in the public API, for example as a field next to `ready`, or only in metrics?
5. Phase 3: are reading each body once (a) and reading in batches (b) enough? Or should a wake after a clean park receipt also skip re-reading what the receipt covers (c)? Option (c) defers the detection of a lost or corrupted resource to its first use, which may never come, and turns it into a failed Turn instead of a refused load. It also drops the checks that have no first use, among them the publication, capture and lineage checks and the `publication_incomplete` refusal, unless a clean park requires every capture to be complete.
