# Managed Agent Actions (Stage D6)

[English](2026-09-30-managed-agent-actions.md) | [简体中文](2026-09-30-managed-agent-actions.zh-CN.md)

Status: D6a (Hosted Harness) and D6b (Java server) implemented.
Date: 2026-09-30
Issue: [#12867](https://github.com/QwenLM/qwen-code/issues/12867), part of [#12380](https://github.com/QwenLM/qwen-code/issues/12380)
Decisions: [#12867 comment](https://github.com/QwenLM/qwen-code/issues/12867#issuecomment-5895205811)
Builds on: [API contract (D1)](2026-09-27-managed-agent-api-contract.md), [durable lifecycle (D4)](2026-09-28-managed-agent-durable-lifecycle.md), [Hosted Workspace tool turn](2026-09-27-hosted-workspace-tool-turn.md) and [Hosted public Workspace admission (G0)](2026-09-29-hosted-public-workspace-admission.md)

## 1. Problem

Section 10 of the [public API contract][contract] and section 3 of the
[contract closure][closure] define Actions: a tool call that needs a person's
permission pauses, a responder answers through either surface, and the tool
runs or is refused. #12867 defines D6's exit check: an approval that the
Harness requested can be answered through either surface and the Turn
continues, a replayed response returns the original result, and a responder
without the right gets `403`.

Before D6, `main` had the durable pieces but nothing that used them:

- The Session authority has `requestToolAction`, a permission ticket only the
  current Harness activation may open, and `resolveAction`, the trusted
  arbiter's final decision. Nothing calls either.
- The Harness handle has `commitDurableWait` and `resolveDurableWait`, which
  keep an `await_action` checkpoint while an approval is open, and Runtime
  dispatch refuses to start while one is.
- The Hosted Harness never asks. A no-tool turn refuses a tool confirmation,
  and a tool turn runs every call under `preapproved-workspace-tools/1`. Java
  sends the deployment's approval mode (`QWEN_MANAGED_AGENT_APPROVAL_MODE`,
  default `yolo`) when it creates a Hosted Session, but the Harness ignores
  it, and Java refuses to start with Workspace files enabled unless that mode
  is `yolo`.
- The contract's six Action operations and their schemas are `planned`.

## 2. Decisions made on the issue

- **Q1:** the Hosted Harness starts requesting approvals in D6.
- **Q4, first version:** a Session's creator is its only owner, and only the
  owner may answer its Actions. Tool turns run only on Workspace-bound
  Sessions, whose creating actor the server already records in
  `managed_workspace_create_command.actor_id`.
- **Voting:** a single arbiter. Every eligible response is final (`decided`);
  `vote_recorded` stays `planned`.

## 3. Goals

- The Hosted Harness asks before a tool call that its approval mode does not
  pre-approve, waits durably, and then runs or refuses the call.
- The Session's owner lists, reads and answers Actions on both surfaces. A
  response is a durable command operation that reaches the Harness's
  `resolveAction` through a trusted entry.
- An unanswered approval expires, so a Turn that nobody answers ends.

## 4. Non-goals

- Question Actions. The authority has no question source yet; `QuestionAction`
  and `QuestionResponse` stay `planned`.
- Several responders and votes, and roles beyond the creator-owner (Q4).
- Resuming an approval after the Harness restarts. Loading a Session with
  unsettled input already answers `409 hosted_turn_recovery_required`; the
  Stage G line owns takeover (#12952).
- Approvals for Sessions without a Workspace, which run no tools.
- `plan` and `auto` approval modes for tool turns.

## 5. D6a: the Hosted Harness asks

### 5.1 Approval mode

The Harness honours the approval mode that Java already sends as
`approvalMode` when it creates a Hosted Session, and the create request gains
`approvalTimeoutMs`, which D6b sends. The mode is pinned in the Session
definition next to the tool profile. A load uses the saved mode, so changing a
deployment's mode affects only new Sessions; a saved mode the Harness cannot
read fails the load with `409` rather than running unasked. A `yolo` Session
saves no mode, so its definition is unchanged and Sessions created before D6a
load as `yolo`. For a Session with a tool profile, create and load answer the
pinned mode as `approvalMode`; a Harness from before D6a omits it.

| Mode        | Pre-approves                         | Asks before                                  |
| ----------- | ------------------------------------ | -------------------------------------------- |
| `yolo`      | every call, as today                 | nothing                                      |
| `default`   | `read_file`                          | `write_file`, `edit` and `run_shell_command` |
| `auto-edit` | `read_file`, `write_file` and `edit` | `run_shell_command`                          |

Each mode lists what it pre-approves, so a tool added to a profile later is
asked about until someone lists it. The file profile that Java selects today,
`hosted-workspace-files/1`, has no shell tool, so `auto-edit` asks nothing
there; the shell row applies to `hosted-workspace-shell/1`.

For a tool profile, `plan` and `auto` answer `400 invalid_hosted_approval`:
plan mode needs its own planning semantics and auto mode a classifier, neither
of which the Hosted path has. A timeout outside its range answers the same, and
`yolo` ignores the timeout because it never waits. A Session without a tool
profile keeps ignoring the mode, because it runs no tools.

D6b enables `default` and `auto-edit` for Workspace files and serves their
Actions. `yolo` remains the deployment default.

### 5.2 Where the Turn waits

A tool round already runs in this order: validate the calls, warm and acquire
the Workspace, commit the model's assistant message, record each call's intent,
dispatch the batch and commit each result. The approval sits between the
assistant message and the first intent:

1. The assistant message is committed first, so a client can show the pending
   calls from the Session's Items before anyone answers.
2. For each call that the mode does not pre-approve, in the model's order, the
   Harness publishes the Action's options, opens the Action with
   `commitDurableWait` and waits. The authority keeps one approval per
   checkpoint, so calls are asked one at a time, and no further call is asked
   once the Harness sees that the Turn is cancelled.
3. When the Action is final, `resolveDurableWait` moves the checkpoint on. An
   allowed call joins the batch; any other outcome gives the call a refusal
   result, the way an invalid batch already does, and the model continues.
4. Only after every call in the round is settled does the Harness record
   intents and dispatch the allowed calls. If none is allowed, the round
   commits only refusal results.

The Runtime binding keeps `preapproved-workspace-tools/1`, because the
decision is made in the Harness before dispatch: the Runtime worker runs a
Workspace Session's calls pre-approved and has nobody to ask.

The Workspace is acquired once per Turn and stays held while the Turn waits,
as it does while the model thinks between rounds. Each approval's expiry bounds
that individual wait; cumulative waiting is described in section 8.

`commitDurableWait` today copies the previous checkpoint's Turn identity, so
an approval in a Turn's first round would leave the next Runtime batch
refusing to change the unfinished Turn. D6a adds the Turn binding that
`commitAwaitRuntimeBatch` already accepts.

### 5.3 The Action

| Field              | Value                                                                               |
| ------------------ | ----------------------------------------------------------------------------------- |
| request ID         | `tool_approval_` and 32 hex digits, unique in the Session                           |
| kind and source    | `permission` and `tool_call`                                                        |
| input revision     | `1`; the call's input cannot change while it waits                                  |
| policy revision    | `hosted-tool-approval/1`                                                            |
| options            | `allow` (Allow) and `deny` (Deny)                                                   |
| created and expiry | set by the Harness; expiry is the creation time plus the Session's approval timeout |

The options, the policy revision, both times, the Turn, the model's function
call ID and the tool name are published as the Action's `optionsRef` resource
before the request is committed, so Java can project the Action without asking
the Harness. The authority records only `tool_call` as the source, so the
function call ID lives in that resource; it names a call that the committed
assistant message carries. Version 1 public Actions show no tool arguments. The [Java-first input preview rollout](2026-10-04-hosted-action-input-preview.md) accepts version 2 options with an input reference and exposes a requested native tool's exact input up to 8192 UTF-8 bytes, with truncation and full-length metadata. Deploy that reader before a Harness emits version 2. Native write content is visible within the bound to Session readers; MCP internal grants are not previewed. General redaction remains separate.

The approval timeout is part of the Session definition, set from the create
request with a default of 10 minutes, from 1 second to 24 hours.

### 5.4 Resolving

A new private route, `POST /session/:id/actions/:requestId/resolve`, uses the
same client identity, bearer token and Harness protocol checks as the other
Session routes. Its body names the option and both revisions. The Harness then:

- answers `404 action_not_found` for an Action this Session does not have;
- answers `400 invalid_action_response` for an unknown option or a revision
  that does not match;
- answers `409 action_expired` or `409 action_cancelled` for an Action that
  ended that way, and `409 action_already_resolved` for a different decision
  on a decided Action. An answer that arrives after the expiry time ends the
  Action as expired even if the timer has not fired yet;
- otherwise publishes the decision as deterministic bytes, calls
  `resolveAction` with `decided`, wakes the waiting call and answers `200`
  with the request ID, `decided` and the option. Repeating the same decision
  answers the same result, because the Harness compares the digest of those
  bytes with the recorded decision. For the same reason the waiting call tells
  `allow` from the recorded digest without reading the decision back.

The decision bytes are the UTF-8 encoding of
`JSON.stringify({ v: 1, optionId, inputRevision, policyRevision })`, in exactly
that key order, without whitespace or a trailing newline. `v` and
`inputRevision` are JSON numbers; `inputRevision` is the Action record's own
value, not the checkpoint's string revision. `optionId` and `policyRevision`
are strings. For example:

```text
{"v":1,"optionId":"allow","inputRevision":1,"policyRevision":"hosted-tool-approval/1"}
```

The decision digest is SHA-256 of those bytes, encoded as lowercase hexadecimal
without a `sha256:` prefix. D6b uses this same encoding when comparing a
response with the projected Action's decision digest.

A failure before the decision is written answers `503 action_resolution_failed`
and leaves the Action as it was, so the caller can retry. A failed journal
write stops every later write of the Session, as any failed write does, so
the route instead wakes the waiting call, which then blocks the Session at once
rather than at the expiry, and answers `409 hosted_turn_recovery_required`. A
waiting call also checks every second whether the Session's writes have
stopped for another reason, so it does not wait for its expiry either.

A recovery-blocked Session still answers what it has already recorded, as
above: a repeated decision, a different decision and an ended Action. Where an
answer would write, it answers `409 hosted_turn_recovery_required` instead.
Both decision and expiry writes recheck this condition inside the authority's
serial queue, so blocking while a write waits its turn admits no new outcome.

### 5.5 Expiry and cancellation

- **Expiry:** at its expiry time the Harness resolves the Action as `expired`
  and refuses the call. Nobody is answering, so the Turn then asks no more:
  every later call that would ask is refused at once, in that round and in the
  model's later rounds. Bound Sessions cannot be cancelled through Java yet
  (G0), so expiry is what ends a Turn nobody answers, about one timeout after
  its first question.
- **Cancellation:** when the Turn is aborted, by a cancel request or the
  prompt's deadline, the Harness resolves the waiting Action as `cancelled`
  and refuses every call in the round before it settles the Turn, so no
  settled Turn leaves a `requested` Action and nothing is dispatched. Closing
  or deleting the Session is refused while its Turn is active.
- **Restart:** a Harness that stops while waiting leaves the Action
  `requested` and the Turn unsettled; see section 4.

## 6. D6b: Java serves Actions

### 6.1 Projection

The Session Store already reads every committed journal line to project Stage
H records. It also projects `action.changed` into a new Actions table in the
same transaction, reading the options from the `optionsRef` resource that the
Harness publishes before it commits the request, and appends an
`action.updated` Session event. The table
uses Flyway migration V24; tool publication uses V20–V22 and the Session MCP
catalog uses V23.
Projection validates the original options resource and immutable revision chain.
Decision receipt IDs are opaque product handles derived from the recorded
decision, never raw storage resource IDs. The public Turn ID is resolved from
the Hosted prompt ID when a matching Java Turn exists.

### 6.2 Routes

- **List:** `GET …/actions` and WebShell `actions/query` page the Session's
  `requested` Actions, newest first, with the Turn list's cursor and limit
  rules.
- **Get:** `GET …/actions/{actionId}` and WebShell `actions/get` return an
  Action in any state; a decided Action carries `decision_receipt_id`.
- **Respond:** `POST …/actions/{actionId}/responses` and WebShell
  `actions/respond` answer `202` with an `action_response` command operation.
  The request is checked against the Action's kind, revisions, options, state
  and expiry before admission. The operation is idempotent in D4's domain
  (tenant, Session, kind, actor and key). A worker forwards it to the Harness
  route and returns a failed attempt to pending with the dispatch backoff; as
  in D4 there is no last attempt. The worker takes the outcome from the Action
  that Java projects from the journal, never from the clock or from a failed
  call alone, because a decision the Harness recorded may already have run its
  call although its answer was lost or the Harness restarted. The Harness
  commits the decision before it answers `200`, so the projection already
  shows it. The operation completes once the projected Action is final: with
  `action_resolution` (`decided`, with the decision receipt) when it is
  decided with this response's decision (Java compares the digest using the
  exact decision encoding in section 5.4), and with its end state
  (`action_expired`, `action_cancelled` or `action_already_resolved`)
  otherwise, exposed as `failure_code` (`failureCode` on WebShell). A `400` from the Harness completes it with that error. While the
  Action stays `requested`, for example on a recovery-blocked Session, the
  operation stays `running`. The WebShell request gains `requestId`.

### 6.3 Checks

- Reads keep the other Session reads' checks.
- Only the Session's owner, the trusted actor recorded as its creator, may
  respond. Another actor gets `403 action_forbidden`.
- Late responses get `409 action_expired`, `409 action_cancelled` or
  `409 action_already_resolved`, and an unknown Action gets
  `404 action_not_found`. The contract gains these codes.
- The Session capability `actions` reads `true` for a Session whose approval
  mode can ask. Java pins that mode on Workspace Session admission; migrated
  Sessions default to `yolo`. Owner checks use the existing creator record
  without adding grants or owners. Unknown creators fail closed.
- `allow` and `deny` are stable option IDs. Actions expose both revisions, the
  function call ID, tool name and expiry. Version 1 arguments are not projected to Items; version 2 can supply the bounded Action input preview described above. Only one
  Hosted approval is pending per Turn; list returns requested Actions, newest
  first, without locally expiring them.

The Turn keeps reading `running` while it waits; its pending Actions are what
tells a client that it is waiting.

### 6.4 Java configuration

A deployment with Workspace files enabled may set `default` or `auto-edit`.
Java sends `QWEN_MANAGED_AGENT_APPROVAL_TIMEOUT` (default `10m`, between `1s`
and `24h`) with the mode, and `yolo` stays the default. For a Session with a tool profile, Java records the mode it sent
at creation and uses the Session only when the Harness reports that mode as
`approvalMode` on create and on every load: a Harness from before D6a omits
it, and would ignore the mode and run every call unasked.

## 7. Tests

- **D6a:** core tests for the Turn binding of a first-round approval. Hosted
  tests with a fake model: an allowed write runs, a denied one returns a
  refusal and the model continues, a mixed batch runs only the allowed call,
  an expired approval refuses the call, an aborted Turn cancels its Action
  and asks nothing further, replays of the same decision answer the same
  result, other decisions and late decisions answer `409`, a denied Shell
  call in `auto-edit` mode leaves the edit to run, an expired approval stops
  later questions in the Turn, a failed journal write blocks the Session at
  once, a write failure elsewhere is noticed within a second, a
  recovery-blocked Session answers what it already recorded and admits no
  decision or expiry write that was queued before it blocked, a cancel request
  releases the Workspace, and a load keeps and reports the saved mode.
- **D6b:** projection and route tests on H2 and MariaDB (MySQL driver), owner and non-owner
  responses, replay, expiry and the contract test's traffic on both surfaces,
  and a Hosted process test in which the owner answers through the public API
  and WebShell, and the Turn completes.

## 8. Risks and follow-up

- The Workspace stays held while a Turn waits for an answer, up to about one
  approval timeout of waiting for a Turn nobody answers. If the owner keeps
  answering near each expiry, cumulative approval waiting can approach the
  number of asked calls times the timeout, across up to 16 model rounds per
  Turn, in addition to model and tool execution time. There is no cumulative
  approval-wait budget; a prompt deadline or cancellation can end the wait
  earlier.
- A Harness restart strands a waiting approval until Stage G can take the
  Session over.
- A Harness rolled back to a build before D6a would ignore a saved mode; D6b
  detects it because such a Harness does not report `approvalMode`.
- `input_revision` is always `1` until a call's input can change while it
  waits.
- Question Actions, votes, roles beyond the owner, and `plan` and `auto` modes
  for tool turns are follow-up work.

[contract]: https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-api-contract.md
[closure]: https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-contract-closure.md
