# Managed agent teams: the lead's mailbox over Session messages (H4e-b2)

[English](2026-10-11-managed-agent-team-mailbox.md) | [简体中文](2026-10-11-managed-agent-team-mailbox.zh-CN.md)

Status: implemented, except the physical acceptance pass on a real Hosted stack (decision 10), which runs before this change merges. This is the second runtime slice of **H4e** of [#12827](https://github.com/QwenLM/qwen-code/issues/12827), stage H of the Managed Agent proposal [#12380](https://github.com/QwenLM/qwen-code/issues/12380), tracked by [#13745](https://github.com/QwenLM/qwen-code/issues/13745). It builds on H4e-a ([team record contract](2026-10-10-managed-agent-teams.md), #13811), H4e-b1 ([lead-side team runtime](2026-10-10-managed-agent-team-lead-runtime.md), #13824, enabled by #13846) and H4d-b ([Session message runtime](2026-10-10-managed-session-message-runtime.md), #13822). It answers H4e-a open questions 1, 2 and 4, and H4e-b1 open question 3. It also re-scopes H4e-b2 and H4e-b3 from the H4e-b1 design: see decisions 1, 7 and 8 below.

## Problem and scope

H4e-b1 gave the lead a team: a roster of named members, a board, labeled reports and a guarded delete. Its members are one-shot H4b children. A member runs on its launch prompt, reports, and is closed. H4d-b since lets a parent message a running child and continue a finished one, and members are children of the lead. So while a member runs, the lead can message it by its task id. But a continuation would be a new run that no roster names, so #13846 refuses to continue a member of an open team until this slice. A finished member therefore takes no more work. Members cannot be addressed by name or reached all at once, and a member does not know it is in a team.

The H4e-b1 design planned H4e-b2 as five pieces, enabling `team_message`:

- a `team_message` relay with member-side delivery and receipts;
- the team route of `send_message`;
- member-side board tools;
- assignment delivery;
- continued members.

This design keeps the lead's half of that list, changes how it travels, and replaces assignment delivery:

- **The lead's mailbox:**
  - `send_message` from the lead by member name and to every member;
  - the member's message to the lead, labeled with its name.
- **Continued members:** a member is its continuation chain, so a finished member takes more work and stays a member.
- **Member identity:** the instruction of every run of a member's chain opens with who it is, how its result reaches the lead, and how to reach the lead.
- **Work travels in instructions, not board writes:** the lead gives a member work with `send_message`, and `task_update` stays a board record (decision 7).
- **Not here:** everything a member would ask the lead to do:
  - board reads and writes;
  - messages to other members;
  - plan requests and shutdown replies, which were already H4e-b3's.

  These need a channel from a member to its lead that commits on the lead's journal without a model turn. No such channel exists, and H4e-b3 builds it once for all of them (decision 8).

## Current state

The facts below are from `main` at `66ddb151cb`, which includes #13846 (merged at its head `9909df4523`, enabling the H4e-b1 team domains).

- **Members.**
  - **Joining.** A named Agent launch commits an H4b `child_run`, then joins the roster: `team_state.members` gains `{ name, childRunId, planModeRequired: false }`. The roster is append-only and names the first run forever.
  - **Who is a member.** `hostedTeamMembership` matches a run only by its exact `childRunId`. A member's state is the state of that one run (`memberRunState`): a settled run reads `completed`, and a run still going reads `running` even after a stop was requested.
  - **Deleting.** `team_delete` refuses while that run has not ended.
  - **The roster view.** `task_list` shows each member with its state and the stop reason of a failed or cancelled run, and, while that run is running, its task id.
  - **Owners** (`assertOwner`, #13846's rule from its physical pass):
    - A running member may be named as an owner.
    - A completed member may be named only on a task the call leaves `completed`, so the board records who did the work.
    - A kept owner whose run ended is checked again when the call moves the task to another open status, so an ended member never lands on open work.
  - **Board answers.** On a running owner, `task_update`'s answer says the member was not notified and points to `send_message` by its task id.
- **Continuing a member.** `sendToChild` refuses to continue a finished member of an open team (`hostedOpenTeamMembership`): "a member of an open team cannot be continued yet". Once its team is deleted, a former member continues as a plain child, its result unlabeled. The lead's `send_message` takes only `task_id`. Beside the team tools it is declared as `HOSTED_TEAM_SEND_MESSAGE_TO_CHILD_TOOL`, with H4d-b's schema and a description saying that a member is addressed by the task id `task_list` shows while it runs, and that a finished member cannot be continued until its team is deleted. A `to` is refused, and where the team tools are declared the refusal points at the task ids `task_list` shows.
- **Inside a member.** The member Session holds no team record. Its launch envelope is `{ description, prompt, definition }`, and its first input is `[description]` followed by the prompt. A member learns its name only if the lead's model writes it into the prompt.
- **Messages (H4d-b).**
  - **Routing.** `session_message` is enabled. The lead's `send_message` routes on the child funnel's writes chain:
    - the task's chain head running: an outbound `session_message` to that run;
    - completed with no stop requested: a continuation `child_run` with the message as its instruction, except for the open-team member above;
    - anything else: a named refusal.
  - **The chain head** is the newest continuation that did not prove it never started (`not_started_proven`). A continuation that fails its creation, or is cancelled before it starts, leaves the head where it was.
  - **Ids.** The message id is `msg_` plus 32 hex characters of `sha256(sender | turn | call)`. A continuation's run id is the call key, `${promptKey}:${callId}`.
  - **Delivery.** The relay hands each message to the run's attached child, which commits a `session_message` receipt with its input and wake. The child's settlement, a task cancel and a close all wait for, stop or classify the messages a child holds. A failed or cancelled child sends no notification.
  - **The result.** A child's result is its newest settled API or message turn (H4d-b decision 8). A continuation's first input is `[description]`, then the chain's history, then `Your next instruction:` and the new instruction.
  - **Child to parent.** A child messages its parent with `to: "parent"`. The lead's input then reads `<from>child agent {taskId}</from>`, with no name.
  - **Shared keys.** The Java relay, the child result relay's journal predicates, the wake pump and the close all key on the `session_message` domain and input source.
- **The `team_message` domain.**
  - It has a body and the H4e-a rules, and it is disabled. Nothing produces it, and the reopen whitelist does not admit it.
  - Its target rule binds a member to the Session of the run its roster entry names.
  - Only a message to `leader` could carry its input in the same transaction, because a member's journal holds no team record.
  - H4e-a decision 5 calls a task assignment a `team_message` of kind `task_assignment`.
- **Cross-Session calls.** The Harness calls Java only for its own Session's store, tool publications and Runtime Broker. Every cross-Session effect is a durable record that a Java relay picks up and drives through private Harness routes. No route lets one Session's tool call make another Session commit.
- **Legacy.**
  - **`send_message`.** It takes `to` (a teammate name, `leader`, `*` for a broadcast, or a peer) or `task_id`, plus `message` and an optional `summary`. Leader→member and member→member text lives only in memory, and a terminated teammate loses it.
  - **Teammates.** A teammate is long-lived and gets one queued message per idle transition. Its last text of every turn is forwarded to the leader. A teammate has `send_message`, `task_list`, `task_update` and `task_create`.
  - **Assignment.** It is a direct prompt carrying the task's subject and description. `task_update` sends it when a task is `in_progress` under an owner that the call changed or just moved there. A blocked task cannot be assigned.
  - **Unused types.** `task_assignment` and the two `plan_approval_*` mailbox types are declared but never written.

## Decisions

1. **Messages between the lead and its members are Session messages (answers H4e-a open questions 1 and 2).** A member is a child run of the lead. So every lead-to-member message travels the lineage edge that H4d-b already relays, and every member-to-lead message is the member's own `to_parent` entry.
   - The lead commits each message as an outbound `session_message`, or as a continuation `child_run` when the member has finished.
   - The member's receipt is H4d-b's inbound `session_message`, committed with its input and wake. That answers open question 1: a member needs no receipt of its own kind.
   - A member's message to the lead is its own outbox entry. The lead's receipt carries its input under H4d-a decision 6. That answers open question 2: no `team_message` binding is needed.

   Delivery, the settlement hold on a child holding messages, H4f's stop over message turns and the close-time cancellation therefore all apply unchanged, and no Java code changes.

   A `team_message` relay would redo all of this for a delivery that is the same delivery. It would need:
   - a second domain in the relay's queries and ledger;
   - `team_message` branches in the child result relay's journal and edge reads;
   - a team twin of the parent's `child_messages_pending` veto and of the stop arm;
   - a second continuation path.

   `team_message` stays disabled and unproduced in this slice. What a team adds on top of H4d-b is routing and presentation: a name, a broadcast, a label and an identity. It is all derived from the roster in the lead's journal. Whether member-authored messages, assignments or the protocol kinds need `team_message` is H4e-b3's question (open question 1).

2. **A member is its continuation chain (answers H4e-a open question 4 and H4e-b1 open question 3).**
   - **The chain.** The roster entry names the chain's first run. A run belongs to a member of the open team when its chain root is on that team's roster. The root is found by following `predecessorChildRunId` back through the lead's `child_run` records. A launch is never itself a continuation, so every root is a launch. Each funnel call indexes the lead's `child_run` records by predecessor once and reuses that index for routing and its answer. A roster view and a recovered broadcast each index once for all members; a fresh broadcast has at most ten funnel calls.
   - **The member's state** is the state of its chain head, as H4d-b's routing defines the head. It reads:
     - `running`, or `running (stopping)` once a stop was requested;
     - `completed`, or `completed (stop requested)` for a head that settled after a stop request, which routing refuses to continue;
     - `failed` or `cancelled`, with the stop reason.
   - **The roster view.** `task_list` shows that state, and the head's task id whenever the member can still take work, running or continuable. When the head's newest continuation, the one committed last, never started, the line also says why, and how many messages sent to it never arrived (H4d-b cancels a message to a run that ended before its handover). For example: `alpha: completed — task_r1 (its latest continuation never started (creation_failed), so the work it carried did not arrive, nor did 1 message sent to it)`. One cancelled before its start at a user's request reads `was cancelled before it started (stop_requested)` instead. The line does not show that continuation's task id, which names no live run. For every child, member or plain, a send by that id still reaches the chain: routing walks back from a continuation that never started to its predecessor, where H4d-b refused such a send as ended. A failed or cancelled child sends no notification, so this line is how the lead learns that new work never reached the member, as H4e-b1 decision 6 meant the roster view for failures.
   - **What reads the state.**
     - `team_delete` refuses while any head runs.
     - The owner rules read the head too (decision 7). There a stopping head counts as ended and not completed, and a head that completed after a stop request counts as completed but not continuable.
     - A continuation stopped before it attached a child Session may still end without starting, which hands the member back to its predecessor. Until it settles, a send to the member and an owner change are refused as stopping, with a text that says so and asks the lead to check `task_list` once it settles, instead of pointing to a new member.
   - **Continuing is now allowed.** `sendToChild`'s refusal to continue a member of an open team, which #13846 added until this slice, is lifted for an active team. A finished member is continued like any finished child, and the continuation joins its chain. A team that is `closing` still refuses, because it admits no new work while it drains (H4e-a decision 8), and `team_delete` commits `closing` only once no member runs.
   - **Worktree members.** A worktree member's continuation keeps its `workspaceMode`, as every H4d-b continuation does, so it needs a host that serves child Workspaces.
   - **No record changes.** A continuation never joins a roster, because it is launched by `send_message`, not by a named Agent call. H4e-a's join rule, which admits only a live run that no other team lists, still guards every join.
   - **Ended members.** A member whose head failed or was cancelled after it started stays ended: H4d-a decision 9 never continues such a run. So does a head that completed after a stop was requested. The lead launches a new member instead, which takes another roster slot (open question 4).
   - **A continuation that never started** leaves its member as it was, because H4d-a decision 9 releases the predecessor. That covers a failed creation and an H4f cancel before the start. The next message continues the same head again. For every child, member or plain, its answer says that the previous continuation never started and how many messages sent to it were lost. It asks for the continuation's work again unless the new message carries it. For each lost message, it asks for one resend only when that message's own `send_message` answer has not already asked; this preserves a resend after an earlier live answer only said queued without duplicating one already requested by recovery or replay. A continuation a user cancelled before its start is told apart, and its work is asked for again only if it is still wanted, since the user may have cancelled it on purpose.
   - **Cancelling a member's work.** A user's H4f task cancel stops exactly the run its task id names. To stop a continued member's work, the user names the head's task, which is the member's newest open child task on the public task list. The first run's task answers that the task already settled.
   - **After `team_delete`.** Routing by name, broadcasts, the preamble and the continuation labels (decisions 3–6) concern the open team's roster only. Once its team is deleted, a former member's chain takes messages by `task_id` alone, and it continues as a plain child with no preamble and no label, as #13846 decided (open question 7).

3. **The lead addresses members by name.**
   - **Where it is declared.** The team form of `send_message` takes the place of the declaration #13846 puts beside the team tools (`HOSTED_TEAM_SEND_MESSAGE_TO_CHILD_TOOL`): where the team tools are (H4e-b1 decision 1) and `session_message` is enabled. Its schema gains `to`, and its description drops the refusal to continue a finished member.
   - **Parameters.** `to` or `task_id`, exactly one, plus `message`.
   - **Name resolution.** `to` is resolved when the call runs, not when the batch is admitted, so a member launched earlier in the same batch can be addressed.
     - A trimmed `*` is a broadcast (decision 4).
     - Any other `to` is sanitized with the Legacy name rule, and must then name a member of the open team.
   - **Refusals:**
     - `leader` is refused, because the lead is the sender.
     - An unknown name is refused, and the answer lists the roster.
     - Without an open team, `to` is refused, and the answer points to `team_create` or `task_id`.
   - **Routing.** A name routes exactly as the task id of that member's first run does:
     - a running head takes a message, unless it is stopping;
     - a continuable head (completed, with no stop requested) is continued;
     - any other head is refused, with the member's name and its state. An ended member's refusal points to a new member under a new name, because a plain launch would not join the team.
   - **Ids.** The message id and the continuation's run id are the ones the `task_id` form would mint for the same call. So H4d-b's replay and its bounds apply unchanged:
     - the envelope bound;
     - 8 messages in flight and 64 per run;
     - the continuation's launch admission (closing, H4b's active cap, H4c's launch budget, a worktree's need for child Workspaces).
   - **Replay order.** A replay looks the call's committed message or continuation up before it resolves `to`, so it answers the committed send even after the team has changed.
   - **Answers.** They name the member: `Message queued for delivery to member "<name>" (task <id>)…`, or `Member "<name>" had completed; continued it as task <id>…`. When the continuation taken just before the one the send launched never started, the answer says so (decision 2), without that continuation's task id. A send by `task_id` to a member of the open team gets the same answers, because the lead's reply hint names the task id (decision 6).
   - **Legacy's `summary`** is refused as an unsupported argument. An argument that would mean nothing is the dead switch H4b decision 11 refused.

4. **`to: "*"` reaches every member.** A broadcast sends to every member of the open team, in roster order. Each member is routed as in decision 3 and committed on its own. A Turn cancelled during a broadcast sends to no further member, since each send may launch a continuation; a replay reports positions already committed before it observes that cancellation. When the broadcast did not reach every member, its answer asks the lead to send by name only where the recipient's line says it did not get the message, the member can still take messages, and it still needs the work.
   - **Ids.** A recipient's ids live in a namespace no single send or launch can reach, whatever call ids the provider hands out. A digest of the call id alone would not do: a plain call whose provider id equals the digest would mint the same ids.
     - **The run id** of a recipient's continuation is `bcast_` plus the first 32 hex characters of `sha256(promptKey \0 callId \0 position)`, where `position` is the member's 1-based roster position. Every single-send or launch run id is `${promptKey}:${callId}` and so contains a colon. A broadcast run id contains none, so the two sets never meet.
     - **The message id** is `msgb_` plus the first 32 hex characters of `sha256(senderSessionId \0 turnId \0 callId \0 position)`. Every single-send message id starts with `msg_`, so the two sets never meet. Within broadcasts, the digest separates calls and positions.
     - Both have a fixed length of at most 38 characters, so a recipient's ids do not grow with the call id and stay within the 128-character `parentChildRunId` bound.
     - Positions never change on an append-only roster.
     - A recipient's continuation or message names the broadcast call's key, `${promptKey}:${callId}`, as its `executionCallId`, as a single send's does, so the owner rule of decision 7 counts it as work given in this Turn.
   - **Batch rule.** A batch that broadcasts must not also launch a member, create the team or delete it. The roster a broadcast reads is then the one its batch leaves, so a re-driven batch reaches the same members.
   - **Partial outcomes.** A refused recipient does not stop the others. A recipient is refused when its head ended or is stopping, when a message bound refuses it (`count_limit` or `budget_exhausted`), or when its continuation's launch admission refuses it (decision 3).
   - **Answers.** As in Legacy:
     - every member reached;
     - `sent to <n> of <m>`, with each refused member and its reason;
     - or, when none was reached, a tool error.
   - **Replay.** A replayed broadcast finds each recipient's committed message or continuation and adds nothing twice.
   - **Scope.** The lead is never a recipient. A broadcast never leaves the team.
   - **Approval.** One approval of `to: "*"` covers every recipient, up to 10 continuations. The card previews the first 8 KiB of the input, so the team form encodes `to` or `task_id` before `message`, and the recipients always show.

5. **The instruction of every run of a member's chain opens with who it is.** That instruction opens with a fixed preamble. The preamble:
   - names the member and its team;
   - says that the agent that launched it is the leader;
   - says how its result reaches the leader: only its answer to the last instruction it receives;
   - says how to ask the leader something;
   - says that it can neither message other members nor edit the board.

   ```text
   <team-member name="{name}" team="{team}">
   You are a member of this team. Your parent, the agent that launched you, is the team leader. Your result is your answer to the last instruction you receive: if another message from the leader arrives after you have answered, your answer to it becomes your whole result, so answer it in full and repeat anything from your earlier answers the leader still needs. To ask the leader something, use send_message with to "parent"; its reply reaches you after you have answered, as your next instruction. You cannot message other members or edit the team's task board.
   </team-member>
   ```
   - **Why the preamble explains the result.** H4d-b settles a run from its newest settled turn (decision 8 there). A message reaches a running member only after its current turn ends (H4d-b decision 6). So a member that has answered and then receives the lead's message delivers only its answer to that message. An unwarned member would lose the report of its earlier work.
   - **Where it goes.**
     - **The named launch.** The preamble goes before the model's prompt in the launch envelope, so the member's first input is `[description]`, the preamble, then the prompt. The launch admission encodes the envelope with the preamble once the member's name is admitted. An over-size prompt is then the same `byte_limit` refusal it is without a team.
     - **Every continuation.** A continuation of a member's chain puts the preamble before the new instruction, under `Your next instruction:`, after the chain's history. This holds whether the continuation came from a name, a broadcast or a `task_id`. The earlier preambles stay in the history, XML-escaped like the rest of it.
   - **Why on every continuation.** The continuation's history (H4d-b decision 9) leaves the oldest runs out when it is over its bound, so the identity cannot rely on the first instruction alone.
   - **The bound.** The preamble is part of the envelope, so it counts toward the envelope bound. H4d-b's single send bound therefore stays single: the size check builds the same envelope whether the head is running or completed. The preamble comes only with the open team, so near the bound a message refused before `team_delete` can fit after it.
   - **Running members.** A message to a running member carries no preamble. The member's current run already began with one, unless it was launched before this slice.
   - **Replay evidence.**
     - Names are sanitized to `[a-z0-9-]`, so the preamble needs no escaping.
     - A replay never rebuilds the preamble. Whether one is present depends on the team, which can change before a replay, and a replayed named launch may not have joined yet: H4e-b1's re-driven launch completes a join its first run lost.
     - So when the call's continuation or launch has committed, its committed instruction is accepted if it equals the sent text, or if it is one well-formed `<team-member name="…" team="…">` block followed by the sent text. The replay then goes on with the committed envelope as it is.
     - The check reads the block's form, not its wording, so it also holds across a release that rewords the preamble.
   - **A launch whose join never commits.** H4e-b1 has two such cases: a refused join and the crash window. The run still carries the preamble, with a name the roster does not hold. It runs and reports as an ordinary background child. Its parent is still the lead, so only the claimed name is wrong (open question 5).

6. **The lead sees who wrote.** On the lead's side, the receipt of a member's message to its parent becomes an input that reads:
   - `<from>child agent {taskId}</from>`, as before;
   - then `<teammate>{name}</teammate>`;
   - then H4d-b's reply hint, unchanged: `<reply>To answer, use send_message with task_id "{taskId}".</reply>`. The hint is fixed text once committed and can stay in the lead's context for many turns. A later team may reuse both the team's name and the member's name, so a hint by name could reach a different member. The task id always reaches the chain of the member that wrote, and while its team is open a send by task id gets the same routing, preamble and label as a send by name (decisions 3, 5 and 6).

   A former member's message after `team_delete` keeps H4d-b's input, with no label and its reply by `task_id`.

   The result notification of a continuation carries the member's `<teammate>` label while its chain root is on the open team's roster. This extends H4e-b1 decision 4 to continuations. Two cases keep their earlier rules:
   - a run that a roster names keeps H4e-b1's label lookup unchanged, which reads every team, deleted ones included;
   - a former member's continuation stays unlabeled, as #13846 decided.

   This leaves one asymmetry. A member's run that settles before `team_delete` and is accepted after it keeps its label when it is the member's first run, and loses it when it is a continuation. With a name reused by a later team, H4e-b1's lookup can then label a late first run with a name the open team also uses.

7. **Work travels in instructions; `task_update` stays a board record (replaces H4e-b1's "no assignment delivery yet").** This slice gives a member its work in its launch prompt or by `send_message`, which continues the member if it has finished. `task_update` sends nothing. Delivering from `task_update`, as Legacy does, goes wrong in each case the board allows:
   - **The member has finished.** #13846's physical pass found that a one-shot member usually finishes before the lead's `task_update` lands. Delivering the task to a finished owner would continue it to redo work it has done. #13846's rule, which lets a finished member own only a task the call leaves `completed` so the board records who did the work, stays.
   - **The member is running.** A running member usually runs on the very task the lead is recording, which its launch prompt carried, so a delivered assignment would repeat that work. When the task is new work, its turn becomes the member's newest and its result (decision 5), so the report of the work the member was doing would be lost.
   - **On replay.** A replayed `task_update` cannot tell whether the call owed a delivery. Its first revision has overwritten the owner and status the conditions compare.

   So a finished member takes new work in two steps, in one Turn and best in one batch:
   1. `send_message` to its name continues it, and its head runs.
   2. `task_update` then makes it the owner of the open task, because the member was given work in this Turn (below).

   One batch runs its calls in order, so the send is committed before `task_update` runs, but nothing keeps the member running until then. The relay commits and settles a child's result while the lead's Turn runs, and the two funnels share no lock across a batch. A member that the send continued, or that was running and read the message, can therefore complete between the two calls. The owner rule covers that with one notion, work given in this Turn:
   - **A Turn** is one prompt id. It spans all of its model rounds, and a Turn resumed after an interruption is the same Turn.
   - **Work given in this Turn.** A member was given work in this Turn when an earlier call of the same Turn committed, for its chain, either a continuation that has not been proven never to have started, or an outbound message to one of the chain's started runs that was not cancelled or rejected (a message to a continuation that never started is cancelled and never arrives). Both name the sending call's key as their `executionCallId`, which is one of this Turn's call keys, so the lead's records decide it.
   - **Accepted.** Such a member may be set as the owner of an open task whether its head still runs or has completed since. The send gave the work, so the board records who has it, and the lead sets the status `completed` when the report arrives.
   - **Still refused.** A member whose head failed, was cancelled after it started, is stopping, or completed after a stop request is refused, as decision 2 counts it ended.
   - **Completed work.** On a call that leaves the task completed, a member any run of whose chain completed is accepted, even when its head has ended since: that run may have done the work, and #13846 records who did it. A member whose chain never completed a run is refused, with a text that points to the member that did the work or to `leader`, not to a new member.

   The texts lead the model there. None of them claims which task a past send carried, because no record ties a send to a task, and none offers to skip a send for work that never arrived:
   - **The `task_update` answer.** For a member owner, it says that it notified nobody, and that if the member does not already have this work, `send_message` to its name gives it. It does not tell the model to send: a send earlier in the Turn, or the launch prompt, may already have given the work, and a second send would repeat it. When a send earlier in the Turn gave the member work, the answer says so, and asks for a send only if that one did not carry this task. A call that restates its task's owner and status is not checked again, so the answer reads the member itself: when its newest continuation never started, the answer says so, asks for that work again, and asks for each lost message only if its own answer has not already requested a resend; for a member that has ended it says that the member takes no more work.
   - **A completed, continuable member not given work in this Turn.** It is refused on open work with one conditional text. If it already did this task's work, from its launch prompt or a message the lead sent it, set the status `completed` with this owner once its report is in. Otherwise give it the work with `send_message` to its name first, which continues it, and then assign it. The first branch is #13846's way out, kept.
   - **A head whose newest continuation never started.** The refusal says that this continuation never started and why, and that the work it carried did not arrive, nor did the messages sent to it. It points to sending that work again by name, sending each lost message once unless its own answer already requested that resend, and then assigning the task. For a continuation a user cancelled before its start, it asks for the work again only if it is still wanted.
   - **A member that cannot be continued.** One that failed, was cancelled, is stopping or completed after a stop request is refused as ended. The refusal points to launching a new member, or, for one that completed, to completing the task with it as owner if it did the work.
   - **The descriptions.** The `task_update`, `task_create` and `task_list` descriptions, and the team form's `send_message` description, say the same. `task_list` no longer calls the task id the way to reach a member.

   If the continuation never starts after `task_update` accepted the owner, the board keeps the owner on the open task. `task_list` shows the continuation that never started (decision 2), and the kept-owner check refuses to keep that member when the task next moves to another open status.

   `task_assignment` stays unproduced, and Legacy's assignment prompt has no counterpart. The lead's own message is the assignment.

8. **Member-side work moves to H4e-b3, with a member-to-lead command channel.**
   - **What a member keeps.** H4d-b's `send_message` to `"parent"` and no team tool.
   - **Why the rest waits.** A member reading or writing the board, or messaging another member, asks the lead's journal to commit on its behalf. H4e-b3's plan request and shutdown reply do the same. Nothing can carry such a command today:
     - no route lets one Session's tool call commit in another;
     - an H4d-b `to_parent` entry is the wrong carrier, because its receipt must commit an input that wakes the lead's model, not a command its funnel runs.
   - **The plan.** H4e-b3 builds that channel once and puts all four uses on it. The [H4e-b3 design](2026-10-11-managed-agent-team-member-commands.md) builds it as the `session_command` domain and carries three of them on it: board reads and writes, member messages, and plan submissions. A shutdown reply is dropped, since the lead stops a member instead of asking it, and the plan decision needs no command, since the lead makes it on its own child.
   - **Refusals stay as they are.** A member's `send_message` to anything but `"parent"` is refused with H4d-b's text. A child Session holds no team record, so its refusal cannot tell a member from another child. The preamble is what tells a member it cannot reach other members.

9. **Interrupted turns are answered by what committed (extends H4d-b decision 16).**
   - **Which ids to probe.** Recovery and the PostToolUse dispatch evidence look up a `send_message` call under its base ids and under the ten broadcast positions' ids, whatever the journaled arguments say. A PreToolUse or permission hook can rewrite the input the call executed, so the journaled `to` may not be the one that ran.
   - **A single send.** One found under the base ids is answered as decision 3 answers a live send: with the member's name while its team is open, otherwise with H4d-b's task-id text. It never invites a retry of a send that arrived. When the run the send reached has proved since that it never started, the answer says that the message did not arrive and how to send it again: a failed child sends no notification, so nothing else would tell the lead. A recovered or replayed answer asks again only for its own message; the later previous-continuation note asks for that lost message only if its own answer has not already requested the resend, so an earlier live answer that only said queued does not hide the loss and two answers do not request one resend twice. For a launch that never started, it says that the member or child has ended. A message whose own delivery failed did not arrive either, though its run did not prove it never started: cancelled before its handover, rejected by its target, or still waiting for a handover that the relay cancels because its run ended or is being stopped (H4d-b). The answer points to a resend while the chain takes messages, to waiting while a continuation stopped before its start settles, to a replacement while an attached run is stopping, or, once the chain has ended, to a new member (a new agent for a plain child). A delivery recorded `unknown` is neither presented as reached nor as failed: the answer says it could not be confirmed and asks the lead to check with the member before sending again. If a handed-over `accepting` message's run is stopped before the relay records its later rejection, the earlier answer can still say queued because a receipt may already exist; the records cannot infer more in that window.
   - **A broadcast.**
     - One found under position ids is answered recipient by recipient, from the committed message or continuation of each position.
     - The answer lists who was reached, who was not, and whose delivery is unconfirmed. A recipient whose run never started, or whose message's delivery failed as above, counts as not reached. A member that is settling a never-started continuation, is stopping after attach, or has ended is listed apart with the same state-specific guidance used by a single send; a live replay notes it on the member's line. An unconfirmed recipient is never included in resend guidance until the lead checks with it. When the team was deleted or replaced since, the answer lists only the recipients it was sent to, as a live replay does.
     - A route that resumes the Turn answers a call that committed nothing as never run.
   - **Dispatch evidence.** A committed broadcast still counts as dispatched after a restart.

10. **No gate, no contract change, no Java change.**
    - **Gate.** The team form of `send_message`, the preamble, the labels and the continued members ride gates that are already open:
      - the team tools' gate (`team_state` and `team_task`, enabled by #13846);
      - H4d-b's `session_message` gate;
      - H4d-b's continuation gate.

      `team_message` and `team_plan` stay disabled.

    - **Unchanged.**
      - No record body or commit-time rule changes in either language. H4e-a decision 4's "its run's state is the member's liveness" becomes the head's state in the funnel, and no rule reads liveness except at a join.
      - The Java relays, `PREVIEW_TOOLS` and the reopen whitelist are unchanged. `send_message` already asks for approval and previews its whole input.
      - No route, OpenAPI or Flyway change.
    - **No waiting between the funnels.** No step on either funnel's writes chain waits on the other's. Routing and labels read the roster directly from the authority, as H4e-b1's label lookup already does. The tool turn calls the two funnels one after the other, never one inside the other, as H4e-b1's named launch already does.
    - **Acceptance.** The implementation runs a physical pass on a real Hosted stack before it merges, as H4d-b's real-stack acceptance did.

## Tools

| Tool                    | Parameters                                   | Commits                                                                                           | Differs from Legacy                                                                                       |
| ----------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `send_message` (lead)   | `to` (member or `*`) or `task_id`; `message` | per recipient: an outbound `session_message`, or a continuation `child_run` for a finished member | durable; a finished member is continued, not lost; no `summary`; no `leader`; no peers                    |
| `send_message` (member) | `to: "parent"`; `message`                    | an outbound `session_message` `to_parent` (H4d-b)                                                 | no member-to-member messages until H4e-b3; the lead's input names the member                              |
| `task_update`           | unchanged                                    | unchanged                                                                                         | sends no assignment; its answers point a member's work to `send_message` by name                          |
| `task_list`             | unchanged                                    | nothing                                                                                           | each member's state, stop reason and task id are its chain head's, with a continuation that never started |
| `agent` with `name`     | unchanged                                    | unchanged; the launch prompt opens with the member preamble                                       | the member is told its name, its team and how its result reaches the leader                               |

## A message's path

A lead's message to member `alpha`, whose first run `r1` completed:

| Step | Journal | Commit                                                                       | By                              |
| ---- | ------- | ---------------------------------------------------------------------------- | ------------------------------- |
| 1    | lead    | continuation `child_run` `r2` of `r1`; instruction = preamble + message      | `send_message` (`to: "alpha"`)  |
| 2–6  | both    | H4b's dispatch, attach, settle and acceptance; the result is labeled `alpha` | the H4b relay, as for any child |
| 7    | lead    | `alpha`'s next message routes to `r2`, the chain head                        | the next `send_message`         |

To a running member, step 1 is an outbound `session_message` to the head, and H4d-b's pipeline runs from its step 2. A member's message to the lead is H4d-b's `to_parent` pipeline, with the lead's input labeled. If `r2` never starts, `r1` stays the head, and `task_list` names `r2` and why.

## Bounds

| Bound                          | Value                                                                                                                | Refusal                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Message to a member            | fits the member's continuation envelope, preamble included (≤ 32 KiB, H4d-b decision 3)                              | tool error, `byte_limit`                        |
| Named launch prompt            | fits the launch envelope with the preamble (≤ 32 KiB)                                                                | tool error, `byte_limit`                        |
| Messages in flight and per run | 8 in flight and 64 in all per run (H4d-b), counted on the head                                                       | tool error, `count_limit` or `budget_exhausted` |
| Continued members              | H4b's 4 active children and H4c's 64 launches per Session, shared with other children; a spent launch never recovers | tool error naming the reason                    |
| Broadcast recipients           | the open team's roster, at most 10 members                                                                           | per recipient, reported in the answer           |
| Member preamble                | fixed text, under 750 bytes                                                                                          | counted in the envelope bound                   |

## Non-goals

- **The member side:**
  - board tools for members;
  - member-to-member messages;
  - the member-to-lead command channel;
  - plan approval, `request_shutdown` and legacy import.

  These are H4e-b3's (decision 8), and so is the decision whether `team_message` is produced at all.

- **Assignment delivery from `task_update`:** see decision 7.
- **Teams beyond the open one:** a broadcast beyond the team, a team spanning Sessions, and messages to `leader` from the lead.
- **Legacy auto-claim:** members have no board, so the lead gives the work.
- **Contract changes:** any record, rule, route, OpenAPI or Flyway change, and any Java change.

## Files affected

- `packages/cli/src/serve/hosted-member-chain.ts` (new): the pure reads the funnels share — the chain index (root, head, newest continuation), the open team's member of a run, the member view, work given in this Turn, the preamble and its replay form, and the broadcast ids.
- `packages/cli/src/serve/hosted-child-agent-session.ts`:
  - lifting #13846's refusal to continue an open team's member;
  - the preamble on a member's continuation envelope, and the replay check that admits it;
  - the replay check of a named launch;
  - the continuation label through the chain root;
  - the predecessor index and the newest continuation that never started.
- `packages/cli/src/serve/hosted-team-session.ts`:
  - chain-following membership and member state, including stopping heads;
  - the roster view over chain heads, with a continuation that never started;
  - `team_delete` over chain heads;
  - the owner rule reading the head, accepting a member given work in this Turn, and its refusal texts;
  - the recipients of a name or a broadcast;
  - the `task_update`, `task_create` and `task_list` texts that point to `send_message` by name.
- `packages/cli/src/serve/hosted-session-message-session.ts`: the `<teammate>` element on a member's message to the lead.
- `packages/cli/src/serve/hosted-workspace-tool-turn.ts`:
  - the lead's team form of `send_message`, its admission, the broadcast batch rule, and its name and broadcast execution;
  - the answers;
  - the member preamble in a named launch's admission;
  - the PostToolUse dispatch evidence over base and broadcast ids.
- `packages/cli/src/serve/hosted-runtime-recovery.ts`: the probes and answers of decision 9.
- Tests beside each file. These #13846 tests flip on purpose:
  - the refusal to continue a finished member (`hosted-workspace-tool-turn.team.test.ts`);
  - the `to` refusal that points at task ids (`hosted-workspace-tool-turn.team.test.ts`);
  - the "was not notified" text and the owner refusal text (`hosted-team-session.test.ts`);
  - the roster that shows a task id only for a running member (`hosted-team-session.test.ts`, and the roster assertion in `hosted-workspace-tool-turn.team.test.ts`);
  - the team `send_message` declaration, its description and its H4d-b schema (`hosted-workspace-tool-turn.team.test.ts`).
- The E2E plan in `.qwen/e2e-tests/`.
- This design in both languages, plus pointers from the H4e-a, H4e-b1 and H4d-b designs.

## Validation plan

- **Tool turn.**
  - The team form's admission matrix:
    - `to` or `task_id` but not both;
    - `*` with spaces;
    - an unknown name, with the roster in its answer;
    - `leader`, `summary`, and no open team;
    - the broadcast batch rule.
  - A member launched and addressed by name in one batch.
  - A send by name to a member that is running, completed, failed, stopping, or completed after a stop request.
  - A send by name after a continuation that never started, whose answer names it with the messages it lost; the same by task id; and one after a continuation a user cancelled before its start.
  - A replay of a send whose continuation, or the waiting run its message was queued for, has proved since that it never started.
  - A replayed or recovered send, single or broadcast, whose message was cancelled, rejected, or is still waiting for a handover to a run that ended or is being stopped, for a chain that takes messages, one that has ended and one stopping a continuation before its start.
  - A broadcast with mixed outcomes, including the active cap, and its replay.
  - A broadcast and, in the same turn, a plain call whose provider id equals the broadcast's derived `bcast_…` run id or `msgb_…` message id, or is a prefix of the broadcast's call id: every message and run id still differs, and recovery tells the two calls apart.
  - One approval covering a broadcast.
  - A replay by name after `team_delete`, which answers the committed send.
  - A named launch whose prompt fits alone but not with the preamble, refused as `byte_limit`.
  - A named launch re-driven before its join committed, which completes the join.
  - A replayed named launch whose team changed since.
  - A committed instruction whose preamble wording differs from the current one, still accepted.
  - Each interrupted answer of decision 9, including a call whose hook rewrote `to`.
  - The PostToolUse dispatch evidence of a broadcast after a restart.
  - A broadcast whose Turn is cancelled part-way, which sends to no further member.
  - A replayed or recovered broadcast whose recipients' runs never started, and a recovered one whose team was replaced since.
  - The owner rule in a wake turn, whose call keys collapse its prompt id.
- **Team funnel.**
  - Membership and state through a continuation chain, including stopping heads and a continuation that failed its creation or was cancelled before it started.
  - `team_delete` refused while a continued member runs.
  - `task_list` showing heads, stop requests and continuations that never started.
  - The owner rule reading the head:
    - a finished member not given work in this Turn, refused on open work with the conditional text;
    - the same member accepted after a send by name earlier in the Turn, while the continuation runs and after it has already completed;
    - a running member that was sent a message earlier in the Turn and has completed since, accepted;
    - a `task_update` in a later model round, or in the resumed Turn, of the Turn that sent, accepted as the same Turn;
    - a `task_update` in a later Turn, refused with the conditional text;
    - a member whose continuation from this Turn never started, refused with the never-started text, which has no branch that skips the send;
    - a member whose continuation from this Turn completed after a stop request, and a stopping member, refused as ended;
    - a member whose continuation is being stopped before it attached, refused with the text that waits for it to settle;
    - a member whose head failed or is stopping after an earlier run completed, accepted on a task the call completes, and one whose chain never completed a run refused there;
    - a message of this Turn to another member, which gives this one no work.
  - The `task_update` answer for a member owner, in a batch that sent the member the work first, which does not ask for another send; and for a restated owner whose newest continuation never started or who has ended.
  - The refusal texts for a continuable member and for one that cannot be continued.
- **Child funnel.**
  - A member's continuation envelope opening its instruction with the preamble, with its bound counted.
  - A non-member's continuation without it.
  - The replay check against a committed instruction with and without the preamble.
  - The `<teammate>` label on a continuation's result.
  - A continuation that settles before `team_delete` and is accepted after it, unlabeled.
  - A former member after `team_delete`: reached by `task_id` only, continued without the preamble, unlabeled.
- **Message funnel.**
  - The lead's input for a member's message, with the label and H4d-b's reply hint.
  - A later team that reuses the team's and the member's names, whose new member a reply by the hinted task id does not reach.
  - A non-member child's input, with H4d-b's reply hint and no label.
- **Every existing suite stays green:**
  - the H4d-b funnel, relay and recovery suites;
  - the H4e-b1 team suites, apart from the #13846 tests listed under Files affected;
  - the Java `managed-agent-server` suite, unchanged.
- **Physical acceptance** on a real Hosted stack before merge:
  1. A lead creates a team, launches two members and receives their labeled reports.
  2. In one batch, it sends one finished member new work by name and records the task on the board with that member as owner. The `task_update` answer asks for no second send.
  3. It receives the continued result labeled, and broadcasts to both.
  4. A member asks the lead something with `send_message` to `"parent"`. The lead answers, and the answer reaches the member as a message if it still runs, or as a continuation if it has settled; the result is labeled. Whether the member's last answer repeats its earlier work is recorded as an observation.
  5. `team_delete` is refused while a continued member runs, and succeeds once it ends.

## Acceptance criteria

- **Lead-to-member delivery.**
  - A lead reaches a member by name, and every member at once with `*`.
  - A running member receives the message as its next input.
  - A finished member is continued and stays a member: it is labeled, may own open work, and is counted by `team_delete`.
  - A `task_update` in the Turn of the send that gave the work records the owner even when the member has already completed, and no answer or refusal claims which task a past send carried or offers to skip a send for work that never arrived.
  - A member whose head failed or was cancelled after it started, or was stopped on request, is refused by name.
  - A continuation that never started is shown on the roster and in the next answer by name, and leaves its member continuable.
- **Member-to-lead delivery.** A member's message reaches the lead labeled with its name, with a hint to answer by its task id.
- **Identity.** The instruction of every run of an open team's member includes the preamble, including after a continuation whose history left the first run out.
- **Recovery.** A replayed or interrupted send never reaches a member twice, and never answers a committed send as unsent.
- **Unchanged.**
  - `task_update` sends nothing.
  - No record, rule, route, migration or Java change.
  - `team_message` and `team_plan` stay disabled.
  - Every existing H4d-b and H4e-b1 suite stays green, apart from the #13846 tests listed under Files affected.

## Open questions

1. **Whether `team_message` is produced at all.** Messages between the lead and its members are Session messages (decision 1), and assignments are the lead's own messages (decision 7). That leaves `team_message` to member-authored messages and the protocol kinds of plan approval and shutdown. H4e-b3 decides two things:
   - whether the member-to-lead channel commits them as `team_message` records, or routes them to their recipients as the lead's Session messages;
   - whether the domain, and its `task_assignment` kind, then retires.

   If `team_message` is produced, its target rule must change in both languages to follow the chain head. Today it binds a member to the Session of its first run, so any message to a continued member would be refused.

   The [H4e-b3 design](2026-10-11-managed-agent-team-member-commands.md) answers it: `team_message` and `task_assignment` stay unproduced and reserved (its decision 11).

2. **Members' share of the cap and the budget.** H4e-b1 left the active cap open (its open question 2).
   - Continuing a finished member counts against H4b's 4 active children. A broadcast to several finished members can then be refused for the cap while other members still run.
   - Every continuation also spends one of H4c's 64 launches per Session, and a spent launch never recovers, even when the continuation never starts. A team that keeps continuing its members exhausts the Session's launches sooner than one-shot members did.
3. **A result is the last answer only.** H4d-b's result rule makes a running member's answer to the lead's message its whole result. The preamble asks the member to repeat what the lead still needs (decision 5), but a member that does not loses the earlier report.
   - Keeping every turn's answer would change H4d-b's result rule, in Java.
   - Alternatively, a member could report each piece of work with `send_message` to `"parent"` before it takes the next.
4. **A failed member is gone.** A head that fails or is cancelled after it started ends its member for good (H4d-a decision 9), even after a transient failure. A replacement is a new member under a new name, and it takes one of the roster's 10 slots, which never free.
5. **A preamble without a roster entry.** A launch whose join never commits keeps a preamble naming a membership the roster lacks (decision 5). Writing the preamble only after the join would need a second input before the first turn, which H4b's launch does not have.
6. **The preamble in long histories.** Each earlier instruction in a continuation's history keeps its preamble, which costs about 600 to 750 bytes per run once escaped and encoded. The 48 KiB bound covers the whole first input, and its last instruction carries a preamble of its own too. Stripping it from earlier runs would make Java's composition team-aware, and this slice changes no Java.
7. **A former member's identity.** A former member continued after `team_delete` gets no preamble, but its history still holds the earlier ones, so it may still answer as a member of the deleted team. A line telling it that its team was deleted would correct that. It would also change the plain-child continuation #13846 settled on, so it is left open.

## Follow-up work

| Slice  | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| H4e-b3 | The member-to-lead command channel, and on it member board tools, member-to-member messages, plan approval through D6 actions with `plan_mode_required`, and shutdown replies; `request_shutdown`; legacy team import; the fate of `team_message` and `task_assignment` (open question 1); the enablement of `team_plan` after a physical pass. See the [H4e-b3 design](2026-10-11-managed-agent-team-member-commands.md), which decides plans with the lead's `team_plan_approval` instead of D6 actions, stops members instead of asking them, and leaves legacy import out. |
| H4f    | `team_delete` requests a stop of running members instead of refusing (unchanged from H4e-b1). The [H4e-b3 design](2026-10-11-managed-agent-team-member-commands.md) gives the lead `request_shutdown` instead, and `team_delete` keeps refusing (its decision 10).                                                                                                                                                                                                                                                                                                             |
| Detach | Unchanged from the H4a delivery map.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
