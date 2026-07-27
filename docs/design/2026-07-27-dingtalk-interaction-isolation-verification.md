# DingTalk Interaction Isolation Verification Design

## Status

Approved test-design direction for PR #6930. This document defines the
acceptance model for complete automated and real-device verification. It does
not expand the production feature scope to persistence, multi-worker routing,
or other IM implementations.

## Goal

Prove that DingTalk status cards and question cards preserve the exact user,
session, run, segment, request, and platform-callback context under normal,
concurrent, stale, and failure conditions.

The verification must distinguish:

- shared Channel semantics from DingTalk projection behavior;
- permission settlement from native-card terminal projection;
- automated protocol evidence from real DingTalk delivery evidence;
- supported single-process behavior from explicit durability boundaries.

## Acceptance model

The authoritative correlation chain is:

```text
channelName
  -> SessionTarget(chatId, threadId, senderId)
  -> sessionId
  -> runId + owner
  -> segmentId | requestId
  -> DingTalk outTrackId
```

Every test must identify the boundary it proves. A test that only asserts a
card update does not prove permission settlement. A test that only asserts an
HTTP request does not prove DingTalk displayed the expected state.

## Test layers

### Layer 1: Unit state machines

Use deterministic fakes for the Card OpenAPI and permission responder.

Prove:

- question reservation, claim, settlement, timeout, and tombstones;
- status-card lazy creation, streaming, completion, Stop, and tombstones;
- owner validation and one-shot callback claims;
- projection ordering when creation or terminal updates are delayed;
- bounded records, snapshots, and terminal identity caches.

### Layer 2: Channel-to-adapter integration

Exercise `ChannelBase`, the DingTalk adapter hooks, presenter, and controllers
in one process.

Prove:

- `runId`, `owner`, `segmentId`, and `requestId` remain correlated end to end;
- all `sessionScope` modes use the active prompt's owner and target;
- permission settlement and card projection remain separate;
- stale lifecycle events and callbacks cannot mutate a newer run or request;
- capability combinations preserve their documented fallback behavior.

### Layer 3: Daemon and ACP runtime

Run the locally built daemon and a real Agent session while capturing redacted
logs and transcript evidence.

Prove:

- a card answer settles the original permission request;
- the Agent resumes the same model turn without a synthetic inbound message;
- sequential question requests preserve their individual permission identity;
- `/cancel`, `/clear`, steer, and session death settle the owning run only;
- stream reconnect is distinct from process restart.

### Layer 4: Real DingTalk device

Use the DingTalk desktop client, the real Stream callback, and the real Card
OpenAPI.

Prove:

- visible card count, order, content, actions, and in-place terminal states;
- callback acknowledgement and subsequent Agent continuation;
- direct-message and group delivery targets;
- owner-only Submit, Cancel, and Stop behavior with two real users;
- recoverable platform failures produce a visible fallback.

## Isolation matrix

### User and owner isolation

| Case                                                      | Expected result                                                                           |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Same user, same session                                   | Requests remain ordered and correlated to that user.                                      |
| Different users, different user-scoped sessions           | Both users may hold one active question card independently.                               |
| Different users sharing a `single` session                | The active run uses the current prompt owner and target; an older owner cannot act on it. |
| Non-owner submits or cancels                              | Callback is acknowledged and ignored; no permission settlement occurs.                    |
| Non-owner presses Stop                                    | No run is cancelled.                                                                      |
| Callback identity is missing or spoofed in nested payload | The action fails closed.                                                                  |

### Session-scope isolation

| Scope    | Expected result                                                                                                                              |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `user`   | Sender identity partitions sessions even inside one group.                                                                                   |
| `thread` | Base routing partitions by `threadId`; DingTalk currently supplies no topic `threadId`, so its real behavior is conversation-level fallback. |
| `single` | All targets share one Agent session, but every new run captures its own current owner and target.                                            |

The test report must not claim DingTalk topic-level isolation until the adapter
actually supplies a `threadId`.

### Run isolation

| Case                                                  | Expected result                                           |
| ----------------------------------------------------- | --------------------------------------------------------- |
| Two runs in different sessions                        | Their cards, cancellation, and callbacks are independent. |
| Two sequential runs in one session                    | Each receives a different `runId`.                        |
| A stale terminal event for run 1 arrives during run 2 | Run 2 remains registered and interactive.                 |
| A run 1 callback arrives after run 2 starts           | The callback cannot settle or cancel run 2.               |
| Stop is pressed on a historical card                  | The current run continues.                                |

### Segment isolation

| Case                                      | Expected result                                             |
| ----------------------------------------- | ----------------------------------------------------------- |
| Direct question                           | No output segment or status card is created.                |
| First visible text                        | Exactly one segment is allocated lazily.                    |
| Multiple chunks                           | They reuse the same segment and card.                       |
| Text followed by a question               | The old segment completes before the question card appears. |
| Answer followed by text                   | A new segment and status card are created.                  |
| Colliding segment IDs from different runs | Records are not merged.                                     |
| Late chunk after terminal state           | The chunk is ignored.                                       |

### Request isolation

| Case                                       | Expected result                                                                                                             |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Sequential questions                       | Each request has its own card and permission response.                                                                      |
| First terminal update is slow              | The second question can be delivered and answered without waiting for the old native update.                                |
| New run supersedes an old pending question | The old run's shared cancellation settles the permission; the old card becomes non-interactive without injecting an answer. |
| Different sessions or owners               | Their active requests are independent.                                                                                      |

Top-level `ask_user_question` calls are serialized by the current tool
schedulers. Concurrent nested questions from parallel Agent tools are not part
of this PR's card acceptance contract.

### Callback isolation

Verify:

- duplicate Submit;
- Submit followed by late Cancel;
- Cancel followed by late Submit;
- callback redelivery after terminal projection;
- old-card callback after a new card becomes active;
- malformed form fields and unknown answer keys;
- non-business callbacks;
- callback delivery while the terminal OpenAPI update is pending;
- callback delivery after Stream reconnect.

Every callback frame must be acknowledged once by the receiving Stream client.
Only the first valid owner action may claim a pending record.

### Settlement and lifecycle isolation

Verify these mappings end to end:

| Cause                              | Permission effect       | Question-card projection              |
| ---------------------------------- | ----------------------- | ------------------------------------- |
| Accepted Submit                    | selected response       | `submitted`                           |
| Accepted user Cancel               | cancelled response      | `cancelled`                           |
| Timeout                            | cancelled response      | `expired`                             |
| External Web/IDE resolution        | no second response      | `expired`, resolved outside presenter |
| `/cancel` or `/clear`              | shared run cancellation | `cancelled`                           |
| Steer or unrelated run replacement | shared run cancellation | `expired`                             |
| Agent failure or session death     | shared cleanup          | `expired`                             |

Card projection failure after accepted permission settlement must not roll back
or repeat the permission response.

### Capability and failure isolation

Verify:

- status cards enabled and question cards enabled;
- status cards disabled and question cards enabled;
- status cards enabled and question cards disabled;
- both card types disabled;
- `blockStreaming=on` with working question cards;
- question-card creation failure;
- status-card creation, streaming, and finalization failure;
- Card OpenAPI rejection, timeout, and invalid recipient response;
- final text fallback after a failed native output projection.

### Metadata

Verify:

- `Running · <model> · <seconds>s`;
- terminal `Completed`, `Stopped`, `Cancelled`, or `Failed` status;
- elapsed time advances only when the existing stream flushes;
- terminal projection writes the exact elapsed second;
- missing model is omitted.

Token usage is not an acceptance item because the current Channel bridge does
not expose an authoritative per-turn token snapshot.

## Automated-test priorities

### P0

1. Same-run sequential request integration with a blocked first terminal
   update and two accepted permission responses.
2. DingTalk card-level `user`, `thread`, and `single` scope matrix.
3. Same session and owner across run 1 and run 2 with late run 1 lifecycle,
   settlement, and callback events.

### P1

1. Claim-versus-timeout, external settlement, and run-terminal races.
2. Full adapter callback redelivery and out-of-order action matrix.
3. Lifecycle-to-question-terminal mapping.
4. Stop cancellation success, failure, retry, and late completion.
5. Tombstone, record, and segment cache bounds.

### P2

1. Card capability combinations through real adapter hooks.
2. Stream reconnect and callback-client ownership.
3. Extended Card OpenAPI and fallback failure injection.

## Real-device scenarios

1. Direct question in a DM: one question card and no status card.
2. Text, question, and continuation: completed status card, question card, then
   a new status card in that order.
3. Two sequential questions while the first terminal update is slow.
4. One to four questions with single-select, multi-select, and custom Other
   answers.
5. Cancel, timeout, and external Web/IDE settlement with in-place terminal
   updates.
6. Two accounts in one group: independent user-scoped cards and owner-only
   Submit and Stop.
7. Current-run Stop, double-click Stop, and a historical-card Stop attempt.
8. `blockStreaming=on` and the supported independent card toggles.
9. Card creation or update failure with a visible fallback.
10. Stream reconnect followed by a successful new callback and response.

## Evidence requirements

For every automated scenario, retain:

- command and exit code;
- exact test name and assertion;
- relevant redacted `sessionId`, `runId`, `segmentId`, and `requestId`;
- whether the assertion covers transaction state, projection state, or both.

For every real-device scenario, retain:

- timestamp and conversation type;
- redacted card instance correlation;
- screenshot or recording of visible ordering and terminal state;
- daemon log showing callback acknowledgement;
- transcript or permission log showing the original request settled;
- final Agent response when continuation is expected.

Credentials, access tokens, secrets, and raw callback payloads containing user
data must not be recorded.

## Explicit boundaries

The following are documented limitations rather than pass criteria:

- recovery of live cards after a process restart;
- shared pending-card state across multiple non-sticky workers;
- DingTalk topic-level `threadId` isolation;
- Feishu or other IM native presenter implementation;
- simultaneous nested user questions from parallel Agent tools;
- pause/resume, model switching, and token telemetry.

A process-restart or wrong-worker callback may be acknowledged without finding
an in-memory record. The release report must state this limitation and must not
describe the implementation as restart-resilient or multi-worker-safe.

## Completion gate

The PR remains Draft unless:

- all P0 automated tests pass;
- existing Channel Base and DingTalk package suites remain green;
- daemon/ACP evidence proves no synthetic message in the supported top-level
  question flow;
- all real-device scenarios possible in the available environment pass;
- unavailable two-user or external-client scenarios are explicitly marked
  unverified rather than inferred;
- every failure is classified as implementation defect, environment blocker,
  or explicit non-goal.
