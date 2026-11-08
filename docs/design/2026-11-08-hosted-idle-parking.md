# Idle parking for resident Hosted Sessions

[English](2026-11-08-hosted-idle-parking.md) | [简体中文](2026-11-08-hosted-idle-parking.zh-CN.md)

Status: proposal for discussion, not accepted. This is step 6 of [#16320](https://github.com/QwenLM/qwen-code/issues/16320), whose steps 1–5 have merged, and it is discussed under [#15082](https://github.com/QwenLM/qwen-code/issues/15082). It extends the non-destructive release of the [Kubernetes shared Hosted Harness pool](2026-10-21-managed-harness-kubernetes.md). Code references are to `main` at `0807f5d391`. A bare `:line` refers to the file named last.

## What parking has to remove

While a Session stays loaded in the Hosted Harness, it costs platform work with nothing running. #16320 measured 51–56 statements a minute per resident Session. The sources of that work:

- **Activation renewal.** One `/writers:renew` every 20 s (`managed-session-assembly.ts:60`, a third of the 60 s lease).
- **Heartbeat.** One `POST /session/:id/heartbeat` from Java every 30 s (`ManagedAgentProperties.java:636`). The Harness handler only echoes (`hosted-harness-session.ts:12411`).
- **Harness memory.** The Session's whole event log stays in the Harness (`managed-session-authority.ts:469`).
- **Listener.** A Session that ran a Shell also keeps a loopback listener (`HostedShellPublisher`).

In #16320's idle windows, almost all the statements that grew with the number of Sessions belong to the activation renewal transaction, which runs three times a minute per Session. Each renewal is therefore about 17–19 statements. The heartbeat runs no SQL: the SDK only sends the HTTP request (`HostedHarnessClient.java:2486-2490`), and the Harness handler only echoes.

A longer writer lease would cut those statements without new code, but not the rest:

- The renewal interval is a third of `writer-lease-duration`, which Java sends with each load (`QwenHostedHarnessConnector.java:2236-2237`). It defaults to 60 s and can be set up to 300 s (`docs/users/managed-agent-configuration-reference.md`). At 300 s the renewals cost a fifth as much.
- The lease also decides how long a Session waits, after its Harness stops or crashes, before another Harness can take it over: an acquire is refused while another writer's lease is live (`JournalWriterLifecycle.java:266-271`). The phase 0 rig below waited 65 s after a graceful stop. A 300 s lease therefore leaves each resident Session unable to load for up to five minutes after every Harness crash, and after every restart that does not release its Sessions first. Today only a pool drain releases them, and only the idle ones.
- It leaves the heartbeat, the Harness memory and the listener in place.

A longer lease combines with parking, but it shrinks what parking saves, and so lengthens the break-even below.

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
   - The gate on a releasing Session's non-GET requests (`:7935`) and request tracking (`:4418`) also exist only with an instance.
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

1. **Idle clock.** The clock is the latest of five times: the Session's last admitted mutation, its last journal commit other than an activation renewal, its last `turn.settled`, the end of its current load, and the end of its last park attempt that left it loaded. A long Turn that just settled, or a wake-pump Turn with no POST, therefore restarts the clock, and a Session that a read woke stays loaded for at least `park-after`. A load's activation install is itself a journal commit, but the clock should not rely on that. Activation renewals must not count, because without the Store's in-place renewal each one commits a journal transaction (`managed-session-authority.ts:3766-3789`). Heartbeats and read-only status requests do not count either. `GET` session asks the Harness for recovery status whenever the node caches an attachment of a non-initial Session with no active Turn (`SessionRecoveryService.java:121-135`, `:160-169`), so a client polling a Session would otherwise keep it loaded. After `park-after`, the Harness tries to park. An attempt that leaves the Session loaded (a failed pre-check, check or stage, an abandoned wait or an intact refusal) therefore restarts the clock, so the next attempt comes `park-after` later.
2. **Pre-check.** Before raising the gate, check every condition that can be read without it:
   - MCP, Hooks and CSI;
   - the conditions of step 5, except this Session's own in-flight requests and openings;
   - in a pool, no drain owns the Session: the instance is accepting work, and no ownership release has started (`session.ownershipRelease`, `hosted-harness-session.ts:4494`).

   A Session that cannot park now, for example one that holds a publisher or a running Monitor, therefore does not raise the gate. The gate is left to settle only the Session's in-flight work. The last item concerns the pool and the instance rather than the Session's own work: a drain owns a Session it has started to release, and a park never starts once the instance stops accepting. The pre-check, raising the gate and the busy test of `releaseIdleOwner` run in one synchronous step, so a drain and a park never both take the same Session.

3. **Gate.** Set a per-Session gate, in both modes:
   - every request to the Session other than a GET answers `409 hosted_session_parking`, as the release gate does (`hosted-harness-session.ts:7935`). That includes heartbeats, lifecycle calls and `DELETE /session/:id`. The Java section says how each caller handles it;
   - a load for it waits inside `open()`, and that waiting load is counted neither as an opening nor as an in-flight request. It waits only for a short bound and then answers a retryable `409 hosted_session_parking`, which Java treats as a wait (below). A plain load runs under Java's `request-timeout`, 30 s by default (`ManagedAgentProperties.java:632`, `HostedHarnessClient.java:370-371`), and that time also has to cover the load itself.
   - In a pool, a load can carry the pre-park placement token: a held load, or one that selected the placement before the receipt and arrives after the Session is gone, while the instance still accepts work. After a receipt it fails with `harness_placement_released` (persistence module `HarnessPlacementStore.java:195-197`), and `open()` would report that as a generic 503. So a pool member answers any load whose acquire meets `harness_placement_released` or `harness_placement_changed` with a retryable 409 that carries the code, held or not, as drain does with `hosted_harness_quiescing` (`hosted-harness-session.ts:4993`). `isPoolWait` must accept that form; from the Harness it accepts only `hosted_harness_quiescing` today (`HarnessCoordinator.java:1694-1703`).
4. **Wait, bounded.** Wait until this Session's other in-flight operations settle, tracking each until its own work settles rather than until the response finishes.
   - The instance counter waits for `finish` on purpose, because a disconnected response cannot prove its operation ended (`hosted-harness-instance.ts:79-82`). But a client that gives up then keeps the owner unreleasable for the life of the process. Drain accepts that because it ends in the crash path; a park cannot.
   - If the wait outlasts a bound, abandon the attempt and clear the gate.
5. **Check.** Run the conditions again under the gate. If one fails, clear the gate. They are the existing list with the instance-wide terms replaced by this Session's own requests and openings, plus:
   - no pending inputs at all. Today an unattempted wake input is allowed (`hosted-harness-session.ts:4500-4512`);
   - none of the post-Turn completions that the drain gate admits are still owed (`:7940-7975`): channel receipts and deliveries, message and child operations, automation reconciles;
   - no open `/events` stream. Java opens one only while it drives a Turn (`HarnessCoordinator.java:868`, `:1384`);
   - no pending channel reply-plan retry;
   - no unsettled append or activation renewal in the authority. Each turn of its serial queue settles them first (`managed-session-authority.ts:3355-3358`), and settling can renew or reacquire;
   - a writer that still accepts appends. A Session whose writer has stopped (`writesStopped`, `managed-session-authority.ts:635`) cannot stage a release, so it is not a candidate.
6. **Stage.** Pause the renewals and wait for any in-flight renewal to finish before entering the authority's serial queue. Activation renewal runs inside that queue (`managed-session-authority.ts:3737`), so pausing from inside it would deadlock; today's `prepareOwnershipRelease` also stops renewal first (`managed-session-assembly.ts:334-335`). Until the outcome, the Store client makes no lease extension of its own either: no timer renewal, no on-demand renewal before a read or write (`http-managed-session-store.ts:2496-2508`), and no reacquire. Reads run on the remaining lease.

   Then, in one turn of the queue:
   - run the pending-input check;
   - encode the activation release as the next journal transaction, without applying it;
   - hold the queue until there is an outcome, so nothing else is encoded against the same head.

   If anything fails before the park verb is sent, the attempt ends as an intact refusal does: nothing staged is kept, the renewals resume and the gate clears. That covers an in-flight renewal from either loop that ends without a grant or leaves a renewal unsettled, and a failed pending-input check. The park's turn of the queue refuses on unsettled state instead of settling it, because settling can renew or reacquire. Two cases drop the Session locally instead: a definitive writer or lease refusal at any of these steps, and a local grant with less than a third of its lease left, because resuming would then reacquire. Judging the second by the local clock is fine, because dropping is always safe.

   The release's boundary body (`managed-session-authority.ts:3856-3865`) is only staged locally (`http-managed-session-store.ts:622-643`) and travels with the commit as `bytesBase64` (`:700-713`). The park verb's request therefore carries it, and an exact retry carries the same staged body.

   While a Session parks, `releaseIdleOwner` treats it as busy.

7. **Commit.** Call the Store park verb described below.
8. **Outcome.**
   - **Refusals that leave the head and the writer intact** (a protocol-2 lifecycle claim) discard the staged transaction, resume the renewals and clear the gate.
     - Only a refusal that also confirms the writer and its lease counts as intact. Today the release checks the claim and `QUIESCING` before the writer (`JournalWriterLifecycle.java:502-511`), so the park verb must check the writer first, or report its verdict with the refusal.
     - Without that verdict, a refusal drops the Session. After an unknown outcome, every later refusal drops it too, because the earlier attempt may have committed.
     - A protocol-1 lifecycle admission does not refuse a park, because `requireNoLifecycleClaim` matches only protocol 2 (`JournalFencing.java:202-207`). A park can then commit under a protocol-1 close, which still converges, because the close loads the Session first.
   - **Every other refusal drops the Session locally.** That covers a writer or proof conflict, a changed generation, and an expired lease. The Store decides expiry by database time, so the Harness must not judge it by its own clock. Resuming after such a refusal would silently reacquire the writer (`http-managed-session-store.ts:1281-1285`). Both possible heads, sealed or active with a lapsed lease, can be reacquired.
   - **An unknown outcome keeps the gate.** The Harness retries the same operation until it reads back a receipt or a refusal, or reaches the cap below. The Store looks the receipt up before it checks the writer (`JournalWriterLifecycle.java:487-501`), and the checks before that lookup are MAC checks, so an exact retry still finds the receipt after a successor has acquired.
     - Retries back off exponentially with jitter, so that a slow Store does not meet a retry storm from every parking Session.
     - At a cap, the Harness drops the Session locally, as after a refusal that is not intact, and counts the abandonment in a metric. Clearing the gate and resuming is not safe, because the park may have committed, or may still commit before the next renewal advances the counter.
     - A drop after a refusal leaves no receipt, and one after an unknown outcome may leave none. Without a receipt, until the next load, `GET` session reports `operator_required` (`SessionRecoveryService.java:131-135`), and once the lease lapses, a wake hint that is still set costs a scan of the whole journal (`WakeRecoveryStore.java:109-139`). The metric, which also counts abandoned waits, shows how often this happens.
     - Dropping is safe at any time because of the park verb's lease fence (below). An attempt still in flight cannot seal the head under a later load: a reload by this Harness with the same token extends the lease in the same generation (`JournalWriterLifecycle.java:266-283`), a takeover after the lease lapses bumps the generation, and either one refuses the attempt.
     - Without a binding key, each Store client makes up its own token (`http-managed-session-store.ts:1034-1035`). After a drop with the lease still live, the next load in single mode therefore waits for the lease to lapse, up to one `writer-lease-duration`, instead of extending it.
     - In a pool, after any drop that follows an unknown outcome, a member answers held loads with the retryable 409, because it cannot tell whether a receipt exists.
   - **After a receipt, and on every local drop**, stop every timer of the Session, including the channel reply-plan retries, which release leaves running today (`hosted-harness-session.ts:6940-6963`). Then delete it.

**The Store park verb.** One JDBC transaction does the following:

- runs `JournalCommit`'s validation and head update for the staged activation release;
- seals the head;
- writes the receipt;
- clears `is_wake_pending` and sets `wake_head_revision` to the new revision. `is_wake_scan_pending` is also true whenever `wake_head_revision` differs from `journal_revision` (`V1__managed_schema.sql:222`).

It is fenced by:

- the writer: an `ACTIVE` head, the writer id, generation and token, and an unexpired lease;
- a proof of the pre-park revision, committed sequence and last digest;
- the activation id and epoch being released;
- `requireNoLifecycleClaim`, as the current release is (`JournalWriterLifecycle.java:506`);
- the lease as the attempt's grant last saw it. Any acquire or renewal since that grant then refuses the attempt, including a reload by the same Harness in the same generation (`JournalWriterLifecycle.java:266-283`) and a renewal the Store runs late. That needs a counter on the head that every acquire and renewal advances. `writer_lease_until` does not serve: `laterOf` leaves it unchanged when a shorter lease is requested, within one millisecond, or after the database clock steps back (`:273-274`, `:347-348`, `:639-641`). Lifecycle admission also moves it (`AgentLifecycleOperations.java:533-543`). The counter need not count that: once admitted, the claim refuses every later attempt (`JournalFencing.java:202-207`), and counting it would turn that intact refusal into one that is not intact.

The verb reads the database time and checks the lease only after it has locked the head, as the release does (`JournalWriterLifecycle.java:507-510`). An attempt that already holds the head when a reload arrives therefore commits first. The reload's acquire takes the placement guard first (`:170-171`), which the verb already holds, as the release does (`:465`). So it waits behind the attempt and then finds the head sealed if the attempt committed, or times out and is retried.

In a pool it also moves the `ACTIVE` placement to `RELEASED` and checks the epoch.

The receipt:

- is keyed by writer generation, or by placement epoch when there is one;
- carries the post-commit revision, sequence and digest, which the SQL `ready` view needs. Today the receipt copies the request's revision and commit proof (`JournalWriterLifecycle.java:481-483`). Those equal the final head only because the activation release committed before the call (`:511-515`). The park's request proves the pre-park head, so the receipt needs post-commit fields beside the proof: `committedSequence` must equal the proof's (`ManagedHarnessReleaseRecords.java:32-34`). Of the fields the schema requires (`:14-24`), `instanceId` and `placementEpoch` come only from a pool placement. `bootId` exists in both modes, because the writer id is the Harness's boot id (`QwenHostedHarnessConnector.java:2235`) and the release requires the two to be equal (`JournalWriterLifecycle.java:459`);
- needs a retention rule. Each park writes a resource, a record and a ref row (`JournalWriterLifecycle.java:527-539`), where today's receipts are one per placement epoch. Keep at least the latest, so that an exact retry still finds it. If a successor has acquired and parked again since, the older receipt may be gone. An exact retry of the old attempt is then refused and the Session dropped, which is safe.

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
- Remove the stale entry and its pending-recovery marker in one atomic step per key: one `attachments.computeIfPresent` call that removes the entry only if it is still the reference that answered 404, and clears the marker inside the same call.
  - A compare-and-remove followed by a separate marker removal is not enough, and `doSettleLifecycle` has that gap (`QwenHostedHarnessConnector.java:358-360`). Between the two steps a concurrent recovery load can publish a new reference and set its marker, and the cleanup then removes the new marker. The new reference survives, but the recovery entry, `doRecoverManagedRuntime`, hands out its snapshot only while the marker is set (`:1989-1991`), so the next dispatch answers that nothing is parked.
  - The rule is general: the marker changes only inside a per-key step that checks the entry is still the reference the change is for, and every publication or removal of an entry sets or clears its marker in that same step. Phase 2 brings every connector path under it, and merges the passive load's two steps into one.
    - Three paths already follow it. The cancellation takeover publishes and sets its marker in one such step (`:1892-1902`). `doCancelManagedRuntime` clears its marker only while the entry is still its reference (`:982-990`), and the recovery cleanup load does the same for its own (`:1853-1862`).
    - The passive load publishes first and then sets the marker in a second step that checks the entry is still its own (`:566-603`). That is safe against a stale cleanup, but between the two steps the new entry carries the old marker.
    - The other paths do not follow it yet:
      - `doContinueManagedRuntime` (`:955`) and `doCancel` (`:1144`) clear the marker by key after their call, the hazard described above;
      - the approval-mode check (`:1924-1925`) clears it after a separate compare-and-remove, as `doSettleLifecycle` does, and `releaseOwnership` clears it whether or not its compare-and-remove succeeded (`:283-284`);
      - the recovery entry (`:1968-1973`) and `committedStopAttachment` (`:1326-1331`) publish with a `put` and update the marker afterwards;
      - `discardManagedRecovery` (`:1784-1785`), the recovery entry's failure path (`:1981-1982`), lifecycle detach (`:451-453`) and close (`:1432-1434`) remove both by key alone;
      - generation adoption and the connector's own close change the markers in bulk (`:2347-2351`, `:1460-1462`);
      - `lifecycleAttachment` and the first load publish with a `put` (`:387`, `:539`), and two failure paths of the attach remove by compare-and-remove (`:551`, `:557`), all without touching the marker, so a newer reference can inherit a stale one.
  - The `mcpManagementAttachments` entry is also removed only if it is still the entry the connector read before the call.
  - A regression test forces the interleaving above, and checks that the newer reference keeps its marker and that the recovery entry still returns its snapshot.
- A 404 on the Turn path goes through `recoverManagedRuntime`, so that `pendingRecovery` and `bindRecoveredHarness` still apply.
- In a pool, the retry goes back through `HarnessPoolConnector.select` with acquiring allowed. The leaf connector's thread-local `PoolCall` still carries the old placement (`QwenHostedHarnessConnector.java:126-137`).
- Lifecycle settle keeps its rule that absence proves nothing.
- Cancel stays out of the rule, because its 404s can follow side effects (`hosted-harness-session.ts:11743-11745`).
- `409 hosted_session_parking` is a wait. For the Turn path it joins `isPoolWait` (`HarnessCoordinator.java:1694-1703`). The relay verbs need the same wait, because today they pass a Harness 409 straight back.
  - Lifecycle settle and detach, the load that close and delete start with, and `DELETE /session/:id`, the close of a Session without lifecycle protocol 2 (`QwenHostedHarnessConnector.java:1431-1436`), classify it as a wait through `isPoolWait` (`SessionLifecycleCoordinator.java:335-339`), which reschedules them outside the retry budget.
  - The heartbeat already treats a 409 as transient: it retires its attachment only on a `404 hosted_session_not_found` or a generation change (`HostedHarnessClient.java:2539-2563`).
  - Other verbs, and loaders outside the 404 rule, return it as a transient error, as they do a stale reference.
  - `channelAttachment` and `create()` answer any 409 with a passive load (`QwenHostedHarnessConnector.java:1481-1489`, `:1626-1630`), so they must recognise this code first.
- The SDK tells the connector when a heartbeat retires an attachment. The notice carries the retired reference, and the connector removes it through the same per-key step, so a notice that arrives after a newer load leaves that load's entry and marker alone. Verbs outside the rule then see a stale reference for at most one heartbeat interval per node: rename, reading a context compression, opening a Turn's Harness stream, MCP management, extension management (`applyExtensions`, `continueExtensionOperation`), and cancel.
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

| Work                                                      | Driven by                                 | Parked behaviour                                                                                                                                                                        |
| --------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompts, approvals, questions                             | Java                                      | The next verb loads the Session. A pending approval or question means a Turn is running, so that Session is not idle.                                                                   |
| Cancel                                                    | Java                                      | A cache miss runs recovery. A parked Session has no Turn to cancel. A stale cached reference answers 404 until the heartbeat notice drops it. A 409 during a park attempt is transient. |
| Rename, context compression, MCP and extension management | Java                                      | Outside the 404 rule. A cache miss loads the Session; a stale reference fails for at most one heartbeat interval, and a 409 during a park attempt is transient.                         |
| Close, delete, archive                                    | Java lifecycle                            | Load the Session first, then take the existing close path. A `409 hosted_session_parking` is rescheduled as a wait. Archive needs a closed Session and makes no Harness call.           |
| Automations, channels, Session messages, child results    | Java clock and relays                     | They load the Session.                                                                                                                                                                  |
| Public event stream                                       | SQL and the event hub                     | Unchanged. The Harness's own event streams stop with the Session.                                                                                                                       |
| MQ owner subscriptions                                    | `OwnerSubscriptions`                      | They drop the Session once it has no active writer, and the MQ wake loads it.                                                                                                           |
| Background Shells, Monitors                               | The Harness's publisher and Monitor loops | Not parkable: nothing outside the Harness receives their output.                                                                                                                        |
| MCP servers, Hooks                                        | A Runtime Session held for the Session    | Not parkable until phase 5.                                                                                                                                                             |
| CSI-guarded Sessions                                      | —                                         | Not parkable.                                                                                                                                                                           |

## Phases

0. **Measure before choosing defaults.** The first measurements are below; they change the order of the later phases. Still open:
   - how often a parked Session is reloaded without new input, for example by a late MQ wake notice;
   - how many resident Sessions each blocker above excludes in a real deployment. On the #16320 rig every Session runs a Shell, so the publisher alone excludes them all.
1. **Make "held" mean live work.**
   - Close a Session's publisher once it has no open capture and no held Runtime.
   - Remove a Monitor loop when it stops.
   - Remove a `heldRuntimeTurns` entry when its hold ends, and release that Runtime Session at the Broker. Otherwise the next load re-adds the entry from the Broker's hold rows, which only the Runtime Session's `RELEASED` record discharges (`RuntimeHoldInventory.java:13-21`). That changes what close has to drain.

   This overlaps #16320 step 7's shared publisher listener, so one of the two should go first.

2. **Java tolerance.** The connector rule, including the per-key marker rule on every path, the waits on `409 hosted_session_parking`, the heartbeat notice and the recovery view. These are useful without parking.
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
   - the one-transaction Store park verb and its receipt shape, and a lease counter on the head that every acquire and renewal advances and every writer grant carries (a schema change);
   - non-latching staging, a pause of every lease extension the Store client makes on its own, and Store-client park;
   - the idle clock, the per-Session conditions, and the gate on non-GET requests and loads;
   - the retry rule for an unknown outcome, with its backoff and cap;
   - a `park-after` setting, off by default until the load cost after phase 3 picks a value;
   - the tests and the rig checks listed for phase 4 under Validation.
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

Statements come from `performance_schema.events_statements_summary_by_digest`, truncated before each measured Turn. Read-lease round trips are its count of `INSERT INTO ma_read_lease`. CPU is utime and stime from `/proc`. Every number is from a single run with no repetition, so the table is indicative. The per-Turn slopes come from three history lengths. The rig scripts are not in the repository; #16320 describes how to set up the same stack.

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
  - These figures assume the default 60 s lease. With a 300 s lease the idle traffic is about a fifth, and each break-even about five times as long.
  - Measured in MySQL CPU the picture is worse, assuming an idle statement costs what a loaded Turn's statement costs. For the 40- and 200-Turn loads, a cold load's statements cost about twice as much MySQL CPU each (1.2 times for the 1-Turn load); the rig did not find out why.
  - The wake also adds about 85 ms per earlier Turn to the first Turn: 17 s at 200 Turns.
- **Harness memory.** These figures are for the Harness process alone, after a forced GC, without the three Runtime workers. In the restarted Harness, before any Session was loaded, the heap was 90.3 MiB and USS 163.3 MiB. With the three Sessions loaded again it was 119.8 MiB and 294.7 MiB. Most of the USS growth is native or retained memory rather than heap. The message-body cache is bounded at 64 MiB, but it held under 1 MiB here: external memory grew by 0.9 MiB.

  This growth is not what unloading would return. Before the restart the old Harness had the same three Sessions loaded at the same heap, 119.8 MiB, but 334.6 MiB USS. So USS depends on the process's history: warm-up and memory the allocator keeps. The three Sessions' own state is at most the 29.5 MiB heap growth, about 24 MiB of it outside code space. How much an unload returns has to be measured by unloading within one process.

That is why phase 3 comes before parking.

## Validation

Each phase lands with tests for its own rules. The deterministic outcomes need tests as much as the races do. A mis-plumbed verdict either drops a Session whose head still says it is owned, or keeps the gate up so that every non-GET request answers `409 hosted_session_parking`. Java's 404 retry would hide the first from an end-to-end test.

- **Phase 1.**
  - A Session whose Shells, Monitors and held Runtime Sessions have all ended is not held.
  - A load does not re-add a hold the Broker has released.
  - Close still drains what is live.
- **Phase 2.**
  - The interleaving in the Java section: neither a stale reference's 404 nor a late heartbeat notice removes a newer reference or its recovery marker.
  - A 404 on an admission verb retries once through a passive load. The 404 rule does not apply to cancel or lifecycle settle.
  - The Turn path and the relay verbs wait on `409 hosted_session_parking` instead of failing.
  - A heartbeat that retires an attachment also drops the connector's entry.
  - Every connector path that writes the recovery marker writes only its own reference's.
  - A 404 on the Turn path goes through `recoverManagedRuntime`, a pool retry goes back through `select`, and the `mcpManagementAttachments` entry is removed only by identity.
  - Lifecycle settle, detach, the close load and `DELETE /session/:id` reschedule a `409 hosted_session_parking` as a wait, other verbs return it as transient, `channelAttachment` and `create()` do not turn it into a load, and a heartbeat that meets it keeps its attachment.
  - `GET` session reports `ready` for a head sealed behind a release receipt at the current revision with no unsettled inputs, and keeps today's answer otherwise.
- **Phase 3.**
  - On the phase 0 rig, the statements and time a load adds per earlier Turn, before and after.
  - With (a) and (b), a corrupted or missing resource still fails the load with `restore_verification_failed`.
- **Phase 4, in the Harness.** One test per outcome:
  - an intact refusal: the staged transaction is discarded, the renewals resume, the gate clears and the next POST is accepted;
  - an unknown outcome followed by an intact refusal: the Session is dropped, not resumed;
  - a protocol-1 lifecycle admission does not refuse a park, and the close that follows still converges;
  - a refusal that is not intact: the Session is dropped locally with its timers stopped, and the next load acquires the head as any load would;
  - an unknown outcome followed by an exact retry that reads back the receipt, including after a successor has acquired;
  - an unknown outcome that outlasts the cap: the retries are spaced by the backoff, the Session is dropped locally with its timers stopped, and an attempt still in flight cannot seal the head under a reload by the same Harness;
  - during the stage, no read, timer or reacquire extends the lease, and any failure before the park verb is sent ends the attempt as an intact refusal: an unsettled renewal or a failed pending-input check. A definitive writer or lease refusal, or a grant with less than a third of its lease left, drops the Session instead;
  - a wait that outlasts its bound, a failed check and an intact refusal: the gate clears and the clock restarts;
  - a Session that a drain has started to release, on an instance that is not accepting work, or whose writer has stopped raises no gate, and a drain and a park never both take the same Session;
  - a held load answers the retryable `409 hosted_session_parking` after its bound. In single mode, a load held across a receipt goes on to take the sealed head over. In a pool, any load that meets a released or changed placement answers a retryable 409, held or not, and Java reselects;
  - a receipt stops every timer of the Session, including the channel reply-plan retries, and deletes it; an abandonment is counted in the metric;
  - a Session that fails the pre-check, such as one holding a publisher or a running Monitor: across several `park-after` periods it raises no gate and answers no 409;
  - heartbeats, `GET` session polling and activation renewals, including renewals committed as journal transactions, do not restart the clock, and a Session that a read woke is not parked before `park-after` has passed;
  - an input, a load, and a Java or Harness restart, each racing a park.
- **Phase 4, in the Store.**
  - The park verb checks the writer before the lifecycle claim and the placement state, or returns its writer verdict with the refusal.
  - An exact retry finds the receipt before any writer check, including after a successor has acquired.
  - An attempt is refused once the lease has lapsed, and once any acquire or renewal has run since its grant, including one that asked for a shorter lease, a same-generation reload by the same Harness and a renewal the Store runs late. Lifecycle admission does not count.
  - The lease is checked only after the head is locked, so an attempt that holds the head commits before a reload's acquire reads it.
  - The park verb's request carries the staged boundary body, and an exact retry carries the same one.
  - The commit clears `is_wake_pending` and sets `wake_head_revision` for an uncompacted journal, and leaves the hint of a compacted journal unchanged, as today.
  - The receipt carries the post-commit revision, sequence and digest, with `committedSequence` equal to the proof's, and the retention rule keeps at least the latest receipt.
  - In a pool, the placement moves from `ACTIVE` to `RELEASED` only at the matching epoch.
  - The verb takes the placement guard, the tenant guard and the Session root in that order.
- **Phase 4, on the rig.**
  - A parked Session adds no statements and no heartbeats per idle minute, against the 51–56 statements a minute a resident Session adds today. Measure it as #16320 did: the slope between idle windows with different numbers of Sessions.
  - A wake takes a sealed head over without waiting for a lease to lapse.
  - The idle budget per resident Session joins the regression check of #16320 step 8.
- **Phase 5.**
  - With (a), an idle hold does not count as work, and a load adopts the held Runtime Session.
  - With (b), a wake starts the servers again before the first Turn uses them.

## Questions to agree on

1. Does the Harness own the trigger, as proposed? A Java-owned trigger would need a per-Session lock shared by all control-plane nodes and every verb.
2. Single-address mode: is the writer fence (boot id, generation, lease) enough, given that a stale load can reopen a parked Session for as long as it stays parked? Or should single mode get a placement row, so that a placement epoch fences it as in a pool?
3. Phase 5: should MCP servers keep running across a park (a), or restart on wake (b)? This decides what parking saves for the target deployment.
4. Should a parked Session be visible as such in the public API, for example as a field next to `ready`, or only in metrics?
5. Phase 3: are reading each body once (a) and reading in batches (b) enough? Or should a wake after a clean park receipt also skip re-reading what the receipt covers (c)? Option (c) defers the detection of a lost or corrupted resource to its first use, which may never come, and turns it into a failed Turn instead of a refused load. It also drops the checks that have no first use, among them the publication, capture and lineage checks and the `publication_incomplete` refusal, unless a clean park requires every capture to be complete.
