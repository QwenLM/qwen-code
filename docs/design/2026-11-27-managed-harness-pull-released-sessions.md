# Managed Harness Pull for Released Sessions (P1)

[English](2026-11-27-managed-harness-pull-released-sessions.md) | [简体中文](2026-11-27-managed-harness-pull-released-sessions.zh-CN.md)

Status: proposed design, 2026-11-27. Current-state claims are checked against `main` at `8327d40b17`, which includes #18557. This is phase P1 of the pull-scheduling proposal in #18514. It builds on [suspension placement release](2026-11-26-managed-suspension-placement-release.md) and [Harness event ingest](2026-11-27-managed-harness-event-ingest.md). Its first slice does not depend on ingest; its second slice does.

## 1. Problem and current state

Since #18404, a clean idle suspension or Action park leaves a Session in a defined released state: the placement is `RELEASED`, the head is `SEALED`, and a release receipt exists for the placement epoch. Any member can take such a Session over without waiting for a lease.

Who takes it over is decided by Java, inside `HarnessPoolConnector.select`. When a call needs the Session and the placement is not `ACTIVE`, Java picks an accepting member round robin, runs `JdbcHarnessPlacementStore.takeover` for it, and then calls that member. Every work source for a released Session ends in that call:

| Work                                  | Java path today                                                                                                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Wake input (seal-time stamp or input) | `WakeRecovery.scan` (every 2 s) and `TransportWakeActivator` call `recoverForWake`, a passive load. The loaded Session's wake pump runs the inputs                                                           |
| Parked Action decision                | Decision admission unparks the Turn. `ActionResponseCoordinator` calls `resolveAction`, which loads on a cache miss. The `HarnessCoordinator` sweep claims the Turn and runs its recovery path on the stream |
| Relay work                            | `SessionMessageRelay`, `ChildResultRelay`, `ManagedChannelService` and others call `runMessageOperation`, `runChildOperation` or `runChannelOperation`; each answer drives the relay's state machine         |

Three problems follow.

1. **Java places before it knows capacity.** A member at its cold-open limit (`HOSTED_COLD_OPEN_LIMIT`, 8 concurrent cold opens by default) answers 409 `hosted_session_open_busy`. The Session then waits on that member, and an idle member gets the Session only when round robin reaches it.
2. **Assignment and admission share one validity interval.** When a takeover consumes a release receipt, it cuts the sealed writer's lease to the current time (`takeover`, "A successor that never acquires a writer must not inherit the released writer's lease"). The next takeover then passes through the expired-lease arm at once. Under push this is harmless, because the Java instance that assigned the member calls it immediately. Under pull, the claim response can be lost and other pollers keep polling, so another poller could displace a claimer before it acquires the writer. The fence still holds, since the displaced claimer's acquisition fails on the placement epoch, but the Session churns. The comment on #18514 that raised this proposes a bounded reservation between assignment and writer acquisition.
3. **Java must know and reach every Harness.** Every call goes over HTTP to a member from the static pool list, so a Harness that Java has not been configured with, or cannot reach, can never hold a Session. Pull scheduling is meant to remove that: a Harness only needs to reach Java.

## 2. Goals and scope

### Goals

- A released Session with pending work is placed by a Harness that claims it with free capacity, not by Java round robin.
- One claim per assignment: a lost claim response, a retried poll, a second poller and a late write from an earlier holder never produce a second effective writer, and a claimer that loses its response keeps its claim for a bounded time.
- A Session held through a claim is served without Java knowing or reaching the holder's address. Every call Java makes for it, including decisions, relay work, cancellation, the next Turn and lifecycle operations, reaches the holder through the holder's own poll, and no Turn on it needs a Harness event stream.
- Wake work for a released Session runs without any Java-to-Harness call.
- With the flag off, behavior is today's. With it on, a released Session waits for a claim no longer than the fallback window.

### Non-goals

- Placing Sessions that have no placement yet, such as a new Session's first Turn. That stays with the push pool until P3, which also needs a reservation rule for a Session with no head. Side queries also keep picking a push member.
- Taking over a Session from a live push-placed holder. Push placements keep their owner routing.
- Java-side reads (P5), removing the private Harness listener or the static pool (P6).
- Per-instance poller identity such as mTLS. Until it exists, P1 requires every Harness that holds the token to be equally trusted (§15).
- Message-queue hints, tenant fairness beyond oldest-first, and latency-specific signals for cancellation and decisions. P3 measures the channel against today's direct calls and adds native signals only where it misses the budget.

## 3. Design decisions

| Decision                      | Choice                                                                                                                                                                        | Rationale                                                                                                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Who places a released Session | The poller that claims it. Push paths stop assigning one                                                                                                                      | Only the Harness knows whether it has a free slot                                                                                                                        |
| Work derivation               | A push path that would take over a placement that is not `ACTIVE` records claim demand on the Session row (`harness_claim_requested_at`). Writer acquisition clears it        | Reuses every work source's own durable record and retry loop. No per-kind predicate, and the same column is the scaling signal                                           |
| Route                         | `POST /internal/managed-harness-work/v1/poll` on the internal listener                                                                                                        | The Harness calls out; any Java instance behind the internal origin serves it                                                                                            |
| Poller authentication         | The Harness bearer token. Compatibility is checked on every poll against Java's configured capability digest and required features. No member list                            | Java does not need to know which Harness instances exist. The token does not show which instance polls, so every Harness that holds it is trusted with every claim (§15) |
| Claim                         | The existing `takeover` CAS and a reservation, in one transaction                                                                                                             | No second ownership protocol; the Store's placement fence is unchanged                                                                                                   |
| Reservation                   | 30 s of database time. A same-boot poll gets the same claim back. Writer acquisition consumes it under the placement lock. Expiry reopens the Session to any poller           | The assignment-to-admission contract from #18514, bounded without a new registry                                                                                         |
| Claim payload                 | The passive load request Java would have sent a member                                                                                                                        | One load implementation; the Harness reads no Session configuration itself                                                                                               |
| Calls to a held Session       | A placement claimed by pull is marked pull-held. Every connector call for it becomes a request item in SQL, delivered in the holder's poll and answered by the holder (§7)    | Java never needs the holder's address. The connector and SDK logic run unchanged over a different transport                                                              |
| Event streams                 | A Turn on a pull-held Session never opens a Harness stream. Where the dispatcher would open one, it hands the Turn to the holder and asks it to push from the cursor (§8)     | A stream is the one exchange a request item cannot carry                                                                                                                 |
| Cancellation                  | On a pull-held Session, cancel is delivered to the holder as a request; the Turn stays with the Harness, which ingests the terminal                                           | A take-back would need a stream                                                                                                                                          |
| Long poll                     | Up to 20 s. The handler rechecks SQL every 500 ms and wakes early when its own instance records demand or a request                                                           | Works across Java instances without a message queue                                                                                                                      |
| Capacity                      | The poll reports free cold-open slots; Java returns at most that many claims, oldest demand first. Requests for held Sessions are not capacity-gated                          | A full Harness stops claiming but keeps serving what it holds                                                                                                            |
| Liveness fallback             | Demand unclaimed for 30 s lets the push path assign as today                                                                                                                  | A poller outage cannot strand work while push members exist                                                                                                              |
| Opt-in                        | `qwen.managed-agent.harness-pull.enabled` (default `false`) and the Harness feature `work-pull/1`. The holder channel also requires `qwen.managed-agent.event-ingest.enabled` | Rollback per deployment                                                                                                                                                  |
| Clock                         | Reservation, demand and request deadlines use database time (`ManagedSchemaTime.SQL_NOW`)                                                                                     | Many instances read and write them; the Turn-lease clock problem (#14248) is not repeated                                                                                |

## 4. Work pull protocol

### Request

```json
{
  "instanceId": "harness-b",
  "bootId": "1f0c…",
  "capabilityDigest": "sha256:…",
  "features": ["work-pull/1", "event-ingest/1"],
  "freeSlots": 3,
  "waitMillis": 20000
}
```

The request carries `Authorization: Bearer <harness token>`. `freeSlots` is the cold-open limit minus the cold opens in flight. A Harness polls while it has a free slot or holds any pull-held Session; a quiescing Harness reports no free slot and keeps polling for the Sessions it holds.

### Handling

1. **Authenticate.** Compare the bearer token with `qwen.managed-agent.harness.token` in constant time. Require `capabilityDigest` to equal `qwen.managed-agent.harness.capability-digest` and `features` to include `work-pull/1` and the features this Java instance requires of any Harness. Validate `instanceId` and `bootId` with the existing identifier rules. Otherwise answer 403 `harness_work_poller_refused`. No member list is consulted; in P1.1 only, a transitional rule restricts claims to configured members (§9).
2. **Requests.** Deliver the pending request items for Sessions this instance and boot hold at their current epoch (§7). They are not counted against `freeSlots`.
3. **Re-offer.** Return every Session whose placement is `ACTIVE` for this instance and boot with an unconsumed, unexpired reservation. The epoch, token and deadline stay as they are. These count against `freeSlots`.
4. **Claim.** Read candidates oldest demand first: `harness_claim_requested_at IS NOT NULL` and no live reservation. For each candidate, run the claim transaction (§5). The takeover CAS decides eligibility exactly as today: a released placement with its receipt, or an expired writer lease with a known activation. A refusal (`harness_owner_still_live`, `harness_placement_changed`, `harness_placement_not_admitted`) skips the candidate.
5. **Build the payload.** For each claim, build the passive load request a member connector would send for `recoverForWake`, under a pool call that carries the new placement and its writer token, and return it instead of sending it.
6. **Wait.** With nothing to return and time left, wait until this instance records demand or a request, or 500 ms pass, then go back to step 2.

### Reply

```json
{
  "claims": [
    {
      "tenantId": "…",
      "sessionId": "…",
      "placementEpoch": 8,
      "reservedUntil": 1764260000000,
      "load": {
        "sessionId": "…",
        "managedSessionStore": { "…": "…" },
        "harnessPlacement": { "…": "…" },
        "passiveManagedRuntimeRecovery": true
      }
    }
  ],
  "requests": [
    {
      "requestId": "…",
      "sessionId": "…",
      "placementEpoch": 8,
      "method": "POST",
      "path": "/session/…/actions/…",
      "headers": { "content-type": "application/json" },
      "body": "…",
      "deadline": 1764260030000
    }
  ]
}
```

Empty lists mean the wait elapsed. The Harness polls again at once.

### Harness side

- The poll loop runs in the `hosted-harness` profile when `QWEN_MANAGED_HARNESS_WORK_URL` is set, with `QWEN_HOSTED_HARNESS_INSTANCE_ID` and `QWEN_SERVER_TOKEN`.
- Each claim runs its `load` body through the existing load handler, as if Java had posted it, and takes a cold-open slot like any load. The load refuses a descriptor that does not name this process as writer and placement owner, as today. That check guards only this load path (§15).
- The load's writer acquisition consumes the reservation. If the load fails, the Harness logs it and lets the reservation lapse.
- Each request runs through the Harness's own HTTP handler in process, with the original method, path, headers and body. The status and body are posted to `POST /internal/managed-harness-work/v1/requests/{requestId}:reply`.
- Transport failures back off and retry. A 403 backs off for a minute and is logged, because it means the Harness and Java disagree on the contract.

## 5. Claim reservation

`ma_session` gains three columns in the V1 baseline (edited in place, as this module requires before its first release): nullable `harness_claim_requested_at` and `harness_claim_reserved_until`, both milliseconds of database time, and `is_harness_pull_held`, default `FALSE`. An index on `(harness_claim_requested_at)` serves the candidate query.

**Claim transaction.** Under the existing placement lock order, run `takeover` for the poller's instance and boot against the placement just read, then set `harness_claim_reserved_until = now + 30 s`, and, when the holder channel is enabled, `is_harness_pull_held = TRUE`. When the takeover consumes a release receipt, it still cuts the sealed writer's lease as today; the reservation, not that lease, now protects the claimer.

**Takeover.** `takeover` gains one refusal: an `ACTIVE` placement with `harness_claim_reserved_until > now` answers `harness_owner_still_live`, whatever the head says. The push path's takeover and the departed-placement reaper go through the same CAS, so they respect it too. A takeover by the push path clears `is_harness_pull_held`.

**Consumption.** `JournalWriterLifecycle.acquireWriter` already locks the placement row in `requirePlacement` before it touches the head. In the same transaction it clears `harness_claim_reserved_until` and `harness_claim_requested_at` for the placement epoch it verified. From then on the existing writer-lease and recovery rules decide every takeover.

| Placement state                                   | Same instance and boot polls                      | Another poller polls                                | Push path                                                                        |
| ------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------- |
| `RELEASED`, demand recorded                       | Claims (new epoch)                                | Claims; the first CAS wins                          | Records demand and answers `harness_placement_released`, up to the fallback (§6) |
| `ACTIVE`, reservation live, no writer acquired    | The same claim again: no new epoch, same deadline | Nothing                                             | Reaches the claimer; a takeover is refused with `harness_owner_still_live` (§6)  |
| `ACTIVE`, reservation expired, no writer acquired | May claim again (new epoch)                       | May claim through the expired-lease arm (new epoch) | Reaches a reachable claimer; otherwise takes over at once (§6)                   |
| `ACTIVE`, writer acquired (reservation consumed)  | Nothing; it holds the Session                     | Nothing; writer-lease rules apply                   | Reaches the holder (§6)                                                          |

A grant from an earlier epoch is refused at acquisition with `harness_placement_changed`. A claimer that acquires just before the deadline keeps the Session under the writer lease; the deadline never authorizes taking over a live writer.

## 6. Push-side gate and fallback

In `HarnessPoolConnector.select`, with `mayAcquire`, no lifecycle operation and the flag on, a takeover of a placement that is not `ACTIVE` no longer goes to round robin; §7 adds a pull-held placement whose holder is unreachable. Every other selection keeps today's path. A Session with no placement, such as a new Session's first Turn, is assigned at once, because a claim is a `takeover` of an existing placement and no poller could claim it (§2). A takeover of an `ACTIVE` placement from an unreachable or quiescing member also stays as today. In P1.1 the gate also requires `work-pull/1` in the pool contract, because only members can claim. In P1.2 it does not consult the pool, because pollers need not be members.

1. If `harness_claim_requested_at` is null, set it to now (`IS NULL` CAS) and wake this instance's poll waiters.
2. If the demand is younger than 30 s, throw 409 `harness_placement_released`.
3. Otherwise assign as today. The fallback keeps work moving when no poller is running; its count is a rollout metric.

A claim whose reservation lapses before writer acquisition does not wait a second time. In P1.1 the claimer's placement is `ACTIVE`, which the gate does not cover. In P1.2 the demand predates the claim, so it is already past the fallback. Either way, a push path that finds the claimer unreachable takes over at once, through the same CAS that admits pollers (§5). While the reservation is live, that takeover is refused with `harness_owner_still_live`, which `HarnessCoordinator` already treats as a pool wait.

`harness_placement_released` already reaches callers today when an owner releases between selection and call. `HarnessCoordinator` treats it as a pool wait that does not charge the retry budget, and `WakeRecovery` has already pushed `wake_retry_at` 30 s ahead when it claimed the candidate. The implementation confirms that `ActionResponseCoordinator`, the message, child-result and channel relays and the automation scanner retry it without a terminal outcome, and adds the code where one does not.

After a claim, the next attempt of each push path finds an `ACTIVE` placement owned by the claimer. A push-placed owner is called over HTTP as today. A pull-held owner is called through the holder channel (§7). A call that reaches the claimer while its own claim load is still running converges on one resident, under the same attachment rules (#17521) that make today's decision-delivery load and dispatch load converge.

## 7. Holder channel

**Routing.** When `select` returns a pull-held placement, `call` runs the same `QwenHostedHarnessConnector` logic against an SDK client whose HTTP exchange is the channel instead of a socket. The SDK client takes an injected `HttpClient`, and the channel implements it: an exchange becomes a request item, and the item's reply becomes the response. The channel client negotiates capabilities like any client, through a request item, so a Java instance that never saw the holder's poll still learns its contract.

**Holder liveness.** Java has no member entry to mark a pull holder unreachable, so it reads liveness from the Store. `select` reads the head's writer lease with the placement. A pull-held placement counts as an unreachable owner when its holder acquired and the writer lease has expired, or when its reservation expired before any acquisition. Then `select` records demand as in §6 instead of queuing a request, and a poller claims the Session through the expired-lease arm. A placement still inside its reservation is routed to the channel, where the claimer will find the request once it polls.

A holder that is alive but no longer polls would keep its writer lease, because the Store client renews it apart from the poll loop, and requests to it would wait out each caller's timeout. The Harness therefore ties the lease to its poll loop: when no poll has completed for 45 s, more than twice the long-poll wait, it stops the writer renewal (`stopWriterRenewal`) of every pull-held Session it holds. The lease lapses, and the rule above applies.

**Request items.** A new table `ma_harness_request` holds `request_id`, `tenant_id`, `session_id`, `placement_epoch`, `holder_boot_id`, `method`, `path`, the headers on a fixed allowlist of those the Harness routes read (never `authorization`), `body` (`MEDIUMBLOB`, covering the 8 MiB attachment input), `deadline`, `state` (`PENDING`, `DELIVERED`, `ANSWERED`, `EXPIRED`), `reply_status`, `reply_body` and timestamps. Items are tenant-scoped and keyed by `request_id`. The channel stores no credential: it removes credential fields such as `managedSessionStore.writerToken` from a body before the insert, and the poll handler issues the token again for the item's placement when it delivers the item.

**Delivery.** A poll moves the holder's `PENDING` items for its current epochs to `DELIVERED` in one CAS and returns them. A reply is a CAS from `DELIVERED` to `ANSWERED`, accepted only from the boot the item was delivered to, at the item's epoch. A takeover expires every item of the old epoch in its transaction. Callers of an undelivered item see `harness_placement_changed` and select again. Callers of a delivered item see an unknown outcome, as on a timeout, because the old holder may have run it; a late reply from the old boot finds the item `EXPIRED` and is refused.

**Waiting.** The caller waits up to its existing call timeout. An answer that lands on the caller's own Java instance wakes it at once; otherwise it rechecks SQL every 100 ms. On timeout the caller gets the same exception a transport failure raises after the request may have been delivered. Callers already treat that as an unknown outcome and retry under their own operation or command IDs, which the Harness routes deduplicate today.

**Limits.** A request is one exchange. Streaming exchanges, the Harness event stream among them, are refused on the channel; §8 removes the event streams from pull-held Sessions, and implementation lists any other streaming route a pull-held Session can reach. Answered and expired items are deleted after 10 minutes.

## 8. Turns on pull-held Sessions

A pull-held Session never opens a Harness event stream.

- **Fresh submissions** use ingest as #18557 defines it: the submission asks for `eventDelivery`, and the admission hands the Turn to the Harness.
- **Every other stream site.** `HarnessCoordinator` opens a stream at the end of `runClaimed` (after a recovery admission, continuation or cancellation), in `observeBlockedHarness`, and in `replaySettledTurn`. For a pull-held Session, each site instead:
  1. hands the Turn's dispatch lease to `harness:` + holder boot with a CAS on the dispatcher's live lease and the recorded event epoch, for a `RUNNING` or `CANCELLING` Turn;
  2. calls a new Harness route, `POST /session/:id/events/push` with `turnId`, `promptId`, `eventEpoch` and `afterSequence` set to the Turn's consumed cursor, through the channel; the Harness starts a pusher, replacing any pusher for that prompt;
  3. returns without streaming.

  This stream-site hand-off is new in P1.2. #18557's admission hand-off (`AgentTurnHandOff.recordAdmissionHandOff`) serves fresh submissions and accepts only a `RUNNING` Turn, leaving a cancelling one with the dispatcher. The hand-off comes first: a pusher that starts before it would get `managed_event_ingest_not_owner` and stop. If the call fails, the lease lapses within 60 s and the Turn recovers through today's path. In `observeBlockedHarness`, the recovery-blocked probe reads the Harness status through the channel instead of the stream.

- **Cancellation.** P1.2 narrows the take-back predicate that #18557 added to `findDispatchable` and `claimTurn` (`AgentTurnHandOff.HARNESS_HELD_CANCEL`) so that it excludes pull-held Sessions. For a Harness-held Turn on a pull-held Session, `HarnessCoordinator.cancel` and a once-per-second sweep deliver `cancelOriginalTurn` through the channel without taking the Turn. The sweep paces each Turn through `retry_after`, which the Harness's lease renewals do not touch. The Harness aborts the Turn, and its pusher ingests the terminal. A cancel the dispatcher itself delivers inside `runClaimed` hands the Turn back as above, which is why the stream-site hand-off accepts `CANCELLING`. With only #18557's `RUNNING` predicate, such a Turn would wait out the 60 s lease lapse.

The recovery logic itself does not move. Java still runs attach, takeover, recovery admission, continuation and every check in `runClaimed`; only the transport and the event delivery change.

## 9. Slices

P1 lands in two slices, each behind the same flag.

1. **P1.1 — claims, reservation and wake.** Everything in §4 to §6. Wake work for released Sessions makes no Java-to-Harness call. Until P1.2, other calls reach the claimer by push, so a transitional rule issues claims only to pollers whose instance and boot match a configured, negotiated pool member. That rule is the only place P1 consults the member list, and P1.2 removes it. Independent of ingest.
2. **P1.2 — holder channel and stream-free Turns.** §7 and §8, and the pull-held marker. Any compatible poller can claim, and Java makes no HTTP call to a pull-held Session. Builds on #18557, adding the stream-site hand-off and narrowing its take-back predicate (§8), and requires `qwen.managed-agent.event-ingest.enabled`; with ingest disabled, the deployment stays at P1.1.

The proposal's P1 exit criterion, that these paths never call a Harness, is met for wake at P1.1 and for everything else on a pull-held Session at P1.2. Native signals for cancellation and decisions are not part of P1. P3 adds them where the channel misses the latency budget measured against today's direct calls, and P3 extends claims to Sessions without a placement.

## 10. Compatibility and rollout

| Control plane         | Harness                    | Behavior                                                                              |
| --------------------- | -------------------------- | ------------------------------------------------------------------------------------- |
| Flag off, any version | any                        | Today                                                                                 |
| Flag on, ingest off   | pool without `work-pull/1` | Today; the gate stays inactive                                                        |
| Flag on, ingest off   | with `work-pull/1`         | P1.1: released Sessions placed by claims from configured members; calls by push       |
| Flag on, ingest on    | with `work-pull/1`         | P1.2: released Sessions placed by claims from any compatible poller; calls by channel |
| Flag on, ingest on    | no poller running          | Every released Session waits out the 30 s fallback and is then placed by push         |

- **Enable.** Deploy the control plane with the route, the gate, the reservation and the channel first. Then roll the Harness with `work-pull/1` and its poll URL. Then turn the flag on. In P1.2 the gate cannot tell whether pollers run, so turning the flag on before the Harness rollout delays every released Session by the fallback.
- **Disable.** The gate opens at once and new claims stop. Outstanding reservations lapse within 30 s. Pull-held Sessions keep their holder and stay on the channel until they release or their holder dies; the poll and reply routes stay served while any exist.
- **Control-plane rollback.** Roll back only after pull-held Sessions have released. A pull-held Session whose holder Java cannot address waits for the holder's writer lease to lapse and is then recovered by push. Pollers get 404 and back off.
- **Harness rollback.** A Harness without the feature never polls; its Sessions stay push-placed.

## 11. Failure and race semantics

| Window                                                    | Required outcome                                                                                                                                                |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claim response lost                                       | The same poller gets the same claim on its next poll; others get nothing until the reservation expires                                                          |
| Claimer dies before acquiring                             | The reservation expires; any poller claims at a new epoch; the dead claimer's late grant is fenced                                                              |
| Holder dies after acquiring                               | Its writer lease lapses; pending work records demand; any poller claims through the expired-lease arm                                                           |
| Holder alive but its poll loop stopped                    | After 45 s without a completed poll it stops renewing its writer leases; they lapse as above                                                                    |
| Two pollers on different Java instances claim one Session | The placement CAS admits one; the other skips it                                                                                                                |
| Demand or a request recorded on Java A, poll held on B    | B finds it on its next 500 ms recheck                                                                                                                           |
| No poller runs                                            | After 30 s the push path assigns as today                                                                                                                       |
| Push fallback and a poll race                             | The placement CAS admits one; the push path's next attempt reaches whichever owns the placement                                                                 |
| Request reply lost or late                                | The caller times out with an unknown outcome and retries; the Harness route deduplicates                                                                        |
| Takeover while requests are pending                       | Every old-epoch item expires: undelivered ones answer `harness_placement_changed`, delivered ones an unknown outcome; a late reply from the old boot is refused |
| Pusher start fails after the hand-off                     | The Turn lease lapses within 60 s and the Turn recovers through today's path                                                                                    |
| Cancel while a pull-held Turn runs                        | The channel delivers it; the Turn stays with the Harness and ingests one terminal                                                                               |
| Earlier holder writes late                                | Placement epoch and writer generation refuse it, as today                                                                                                       |
| Load slower than the reservation                          | Another poller may claim; the slow load's acquisition fails on the epoch; measured as churn                                                                     |
| Java restarts                                             | Demand, reservations and requests are in SQL; polls resume on any instance                                                                                      |

## 12. Affected files

### Control plane

- `persistence/src/main/resources/db/managed-schema/V1__managed_schema.sql`: the three `ma_session` columns and their index, and `ma_harness_request`.
- `persistence/.../JdbcHarnessPlacementStore.java`: the claim transaction, the reservation refusal and pull-held clearing in `takeover`, demand marking, candidate and re-offer queries.
- `persistence/.../JournalWriterLifecycle.java`: consumption in `acquireWriter`.
- `persistence/.../AgentTurnHandOff.java`: the stream-site hand-off, which also accepts a `CANCELLING` Turn, and the pull-held exclusion in `HARNESS_HELD_CANCEL`.
- `persistence/.../AgentTurnExecution.java`: the cancel-delivery sweep.
- `persistence/` (new store): request items.
- `adapters/.../harness/HarnessPoolConnector.java`: the gate, routing pull-held placements to the channel, and the P1.1 transitional rule.
- `adapters/.../harness/QwenHostedHarnessConnector.java`: the passive load request for a pool call, built without sending it.
- `adapters/.../harness/HarnessRequestChannel.java` (new): the channel `HttpClient`.
- `adapters/.../harness/HarnessFeature.java`: `work-pull/1`.
- `control-plane/.../session/HarnessWorkPoll.java` (new): authentication, requests, re-offer, claims and the long poll.
- `control-plane/.../session/HarnessCoordinator.java`: the stream sites and pull-held cancellation.
- `server/.../api/` (new controller): the poll and reply routes.
- `verification/.../api/SurfaceRegistry.java` and `capability-parity/managed-surface.txt`: register and re-capture those routes.
- `packages/sdk-java/qwencode/.../daemon/HostedHarnessClient.java`: accept an injected `HttpClient`.
- `application.yml` and `configuration-descriptions.json`: `qwen.managed-agent.harness-pull.enabled`.

### Harness

- `packages/cli/src/serve/hosted-harness-contract.ts`: `work-pull/1`.
- `packages/cli/src/serve/hosted-harness-work-poll.ts` (new): the poll loop, capacity, claim and request execution, replies, backoff, and stopping writer renewal when polls stall.
- `packages/cli/src/serve/hosted-harness-session/session-open.ts`: run a claim's load body through the load handler.
- `packages/cli/src/serve/hosted-harness-session/observation-routes.ts`: the `events/push` route.
- `deploy/kubernetes/chart`: pass the internal origin to each Harness as `QWEN_MANAGED_HARNESS_WORK_URL`.

### Tests

- Java, H2 and MySQL 8.4: the reservation matrix in §5, the gate and fallback, demand clearing, poller refusal, request delivery, reply fencing and expiry, the stream-site hand-off, pull-held cancellation, flag-off behavior, and the existing takeover and reaper tests.
- TypeScript: poll cadence, capacity gating, claim and request execution, replies, `events/push`, the descriptor refusal, and writer renewal stopping when polls stall.
- Real process: two Java instances and two Harness processes on MySQL 8.4 (§13).

## 13. Validation plan

- **Baseline first.** Show on today's store that after a release is consumed by a takeover that never acquires, a second takeover succeeds at once. That is the churn the reservation removes.
- **Reservation matrix**, on H2 and MySQL 8.4:
  - Hold A's claim response. B polls with A's current epoch before the deadline and gets nothing. B polls after the deadline and claims. A's delayed load is fenced at acquisition.
  - A acquires just before the deadline. B then follows the writer-lease rule and gets nothing.
  - A polls again before the deadline and gets the same epoch and deadline.
- **Gate.** Flag off, and Harness instances without the feature, behave as today. Flag on records demand, answers the wait code, and falls back after 30 s. With the flag on, a Session with no placement is assigned at once, and a claim whose reservation lapsed is taken over at once when its claimer is unreachable.
- **Channel.** A lost reply, a reply after the deadline, a reply from the wrong boot or epoch, a takeover with pending and with delivered items, a reply landing on another Java instance, a holder whose poll loop stops while its process runs, and a request body that never stores its writer token. Each call's caller sees today's outcome for the matching HTTP failure.
- **Real process, P1.1.** The first P1 scenario from #18514: two Java instances and two Harness processes on MySQL 8.4. Harness A asks a structured question, parks and releases while staying healthy. Submit the answer through Java. B claims the Session and the original Turn continues. Repeat with a lost claim response before writer acquisition, a duplicate answer and a late write from A. Require one effective writer, one applied answer and one terminal event. Run it with RocketMQ disabled.
- **Real process, P1.2.** The same scenario with B absent from Java's pool configuration. After the claim, the answer, the continuation, a cancel during the continued Turn, the next Turn and a close all reach B without any Java-to-Harness HTTP call, and every Turn's events arrive through ingest.
- **Measure** demand-to-acquire latency, the fallback count, request round-trip time, cancellation and approval-delivery latency through the channel, poll and request query rates and lock waits, against the push baseline.

## 14. Acceptance criteria

- With the flag off, or in P1.1 with a pool without `work-pull/1`, behavior is byte-for-byte today's.
- With the flag on, a Session with no placement, such as a new Session's first Turn, is still assigned at once.
- A released Session with pending work is placed only by a claiming poller while pollers run, and a poller with no free slot claims nothing.
- A lost claim response never leads to a second claim within the reservation, and a late grant from an earlier epoch never acquires a writer.
- Wake work for a released Session completes without any Java-to-Harness call.
- After P1.2, a poller that is not in Java's configuration can claim a released Session and serve all of its later calls. Java makes no HTTP call to it, and no Turn on the Session opens a Harness stream.
- Decisions, relay work and cancellation for a claimed Session complete with today's outcomes: Allow executes once, Deny never, and a cancelled Turn settles once.
- With no poller running, work proceeds after the fallback.
- No public route or projection changes. The schema change stays in the V1 baseline.

## 15. Risks and open questions

1. **Fallback window.** 30 s bounds the cost of a poller outage while push members exist, but it also delays work when pollers are merely slow. Measure it before default-on. A deployment with no push members has no fallback.
2. **Reservation length.** The claimer must acquire within 30 s. Measure claim-to-acquire time under load before fixing the constant.
3. **Poller identity.** The bearer token is shared by every Harness and does not show which instance polls, and boot IDs are not secrets. A Harness that holds the token can poll in another Harness's name and receive its claims, re-offers and requests; in P1.2 it can also claim any released Session in its own name. Each claim's load body carries the placement's writer token, which the Store accepts from any caller that presents it with the placement's boot ID; the load's descriptor refusal guards only the Harness's own load path. Such a Harness can therefore acquire the writer, commit journal rows and answer requests for those Sessions, not only read their configuration and content, and the rightful holder misses the requests it took. Under push, Java sends a writer token only to the member it placed the Session on. P1 is therefore safe only where every Harness that holds the token is equally trusted, inside the Java Pod's trust boundary. Before any other Harness may poll, per-instance identity must bind both the poll and the writer token to the instance.
4. **Channel cost and latency.** Each call costs an insert, a delivery update and a reply update, plus a 100 ms reply recheck across instances. Cancellation and approval latency through the channel is P3's exit measurement. The 45 s poll-stall limit (§7) is measured with it.
5. **Streaming routes.** Implementation must list every streaming exchange a pull-held Session can reach and either replace it or refuse it with a coded wait.
6. **Load convergence.** The claim load and a delivered decision or recovery load must converge on one resident. Cover it with a test rather than assume it from today's two-load case.
7. **Callers of the wait code.** Some relay callers may treat `harness_placement_released` as terminal. Audit them in P1.1.
8. **Fairness.** Oldest demand first does not stop one tenant from filling the queue.
9. **Remaining member dependency.** Until P3, a new Session's first placement and side queries still need a push member.
10. **Content at rest.** Request and reply bodies carry Session content, including attachments up to 8 MiB, and stay in `ma_harness_request` until 10 minutes after the answer. Retention and access rules for Session content must cover this table.
