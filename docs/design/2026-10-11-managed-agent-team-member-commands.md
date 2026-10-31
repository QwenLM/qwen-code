# Managed agent teams: member commands, plan approval and shutdown (H4e-b3)

[English](2026-10-11-managed-agent-team-member-commands.md) | [简体中文](2026-10-11-managed-agent-team-member-commands.zh-CN.md)

Status: design. This is the third and last runtime slice of **H4e** of [#12827](https://github.com/QwenLM/qwen-code/issues/12827), stage H of the Managed Agent proposal [#12380](https://github.com/QwenLM/qwen-code/issues/12380), tracked by [#13745](https://github.com/QwenLM/qwen-code/issues/13745).

It builds on:

- H4e-a: the [team record contract](2026-10-10-managed-agent-teams.md), #13811;
- H4e-b1: the [lead-side team runtime](2026-10-10-managed-agent-team-lead-runtime.md), #13824, enabled by #13846;
- H4e-b2: the [lead's mailbox](2026-10-11-managed-agent-team-mailbox.md), #13879 and #13892;
- H4d-b: the [Session message runtime](2026-10-10-managed-session-message-runtime.md), #13822;
- H4b: child Sessions and the [foreground child wait](2026-10-09-foreground-child-wait-continuation.md).

It answers H4e-b2 open question 1 and its decision 8, and the items H4e-a left to "H4e-b": `team_plan_approval`, `request_shutdown`, legacy import and enablement. One design covers the whole slice; the implementation lands in the four batches of decision 13.

## Problem and scope

After H4e-b2, the lead of a Hosted team can launch named members, keep a board, message any member by name or all of them at once, and continue a finished member. Everything runs from the lead. A member can do one thing towards its team: send a message to its parent with H4d-b's `send_message` to `"parent"`, which arrives as the lead's next input. A member cannot:

- read or change the team's board;
- message another member;
- submit a plan and wait for the leader's approval before it acts.

And the lead cannot stop a member it no longer needs: `team_delete` refuses while a member runs, and the lead's model has no way to stop one (a user's H4f cancel and the close cascade can).

Legacy teams have all four. This slice brings them to Hosted teams. A member's board read or write, its message to another member and its plan submission ask the lead's journal to act on the member's behalf, and nothing can carry such a request today:

- no route lets one Session's tool call commit in another Session's journal;
- every cross-Session effect is a durable record that a Java relay drives into the other Session through private Harness routes;
- H4d-b's `to_parent` entry is the wrong carrier, because its receipt commits an input that wakes the lead's model, and a board read must be answered without one.

So this slice builds one member-to-lead **command channel** for those calls. The plan decision and the shutdown need no command: the lead acts on its own child, as H4e-b2's continuations and H4f's stops already do.

## Current state

- **Team records.** The lead's journal holds every team record: `team_state` (roster and lifecycle), `team_task` (the board), and the disabled `team_message` and `team_plan`. Every revision is a `trusted_entry` commit by the lead. A member's journal holds none, only because the team tools are declared at child depth 0.
- **Identity.** A member is its continuation chain (H4e-b2 decision 2): the roster names the chain's first run, and the member's state is its chain head's. The lead finds a run's member through the chain root, and every lead-side record of a member names a run of the lead's own `child_run` domain.
- **The member's view.** A member's Session has a lineage (`parentSessionId`, `parentChildRunId`) and no team record. It learns its name and team only from the preamble that opens the instruction of every run of its chain (H4e-b2 decision 5). Java composes the run's first input: a launch's is `[description]`, a blank line and the launch prompt; a continuation's is its history, with every earlier instruction and result XML-escaped, then `Your next instruction:` and the new instruction. The description is the lead's own text and is not escaped. So, apart from whatever a description holds, a run's own preamble is the only unescaped one in its first input. The history keeps each earlier run's instruction and final answer, not its tool calls.
- **Session messages.** H4d-b's relay scans outbound entries every 2 s, hands each over, has the target receive it, and records the receipt back on the sender. Its ledger (`qwen_managed_session_message_relay`, V64) is keyed by sender Session and record id, with no domain column, and its queries name the `session_message` domain in their SQL.
- **Parking a call on another Session.** Only H4b's foreground child wait does it and survives a restart: the parent commits an `await_agent` checkpoint, polls its own journal, and the child result relay commits the answer into that journal. It rests on two refusals: an agent-only batch takes no Workspace mount, and a Turn that holds the mount may not wait in the foreground, because a wait that holds the shared Workspace's mount can deadlock with the Session it waits on.
- **Waits and deadlines.** An API Turn ends at its 30-minute deadline with `deadline_exceeded`, and the child result relay then settles its run `child_failed`: the member has ended for good. A message (wake) turn has no deadline; while a message input is owed, the relay fails a child whose journal has had no event for 30 minutes.
- **Actions.** A D6 Action is only a `tool_call` permission ticket today. Java's action store refuses any other source, and the public `ActionSource` and `PermissionAction` shapes do not fit a plan request (#13785 point A1).
- **Plan mode.** Hosted Sessions have no plan mode: the approval modes are `yolo`, `default` and `auto-edit`, `plan` is refused, and there is no `exit_plan_mode`. `plan_mode_required` is refused at the Agent admission, and the H4e-b1 join writes `planModeRequired: false`. The closed domain index registers `plan_mode`, with no body and no rule.
- **Stops.** A user's H4f task cancel, and the close cascade, commit `stopRequested` on a child run in the lead's journal. The child result relay's stop arm acts on any committed stop while the lead is active: it stops the child's message turns, cancels its Turn and settles the run. The lead's model has no way to request one.

## Decisions

1. **One command channel, a new domain `session_command`.**
   - **Why a new domain.** `session_message` v1 is enabled and has a closed key set, a closed `route` enum, and a rule that an inbound receipt opens with exactly the input that wakes its target. A command has a reply and no input. Stretching v1 would also put commands under the message budgets, under the child result relay's message rules (a session message makes it read the member's whole journal, and an owed one holds the member's settlement and close), and under the Workspace admission of `receive`. The closed domain index has taken additions before (`file_history`, `session_source`, `monitor_run`).
   - **Two records per write.** An **outbound** command in the member's journal, and, for a command that changes anything, an **inbound** receipt in the lead's journal, under the same `commandId`:

     | Key                       | Outbound (member)                                                   | Inbound (lead)                                  |
     | ------------------------- | ------------------------------------------------------------------- | ----------------------------------------------- |
     | `commandId`               | `cmd_` + 32 hex of `sha256(senderSessionId \0 promptKey \0 callId)` | the same                                        |
     | `direction`               | `outbound`                                                          | `inbound`                                       |
     | `route`                   | `to_parent`, the only value                                         | `to_parent`                                     |
     | `kind`                    | `board_read`, `board_write`, `member_message`, `plan_submit`        | the same, never `board_read`                    |
     | `childRunId`              | the member's own run, from its lineage                              | the lead's run that the member Session attached |
     | `senderSessionId`         | the member                                                          | the member                                      |
     | `targetSessionId`         | set once, at the handover                                           | the lead                                        |
     | `argsRef`, `argsDigest`   | the call's arguments, ≤ 64 KiB                                      | the same digest                                 |
     | `replyRef`, `replyDigest` | set once, on the `accepted` revision                                | set at the opening                              |

     `promptKey` is the member Turn's prompt id, collapsed as H4e-b2's call keys are, so the id is replay-stable.

   - **Replies.** A reply is a small JSON document, `{ "outcome": "answered" | "refused", "text": "…" }`. `answered` is the call's result; `refused` ends the call with a tool error. A refusal is still a reply: only a record the lead cannot accept at all (a lineage or digest mismatch) is `rejected`. No reply ever carries a decision a Harness acts on; the plan decision travels as an instruction (decision 9).
   - **Delivery lines.** Both use the shared extension delivery states:
     - outbound: `planned` → `accepting` (handed over) → `accepted` (the reply is copied back with it) → `consumed` (the call read it); or `cancelled` (withdrawn or given up before the handover), `rejected` (the lead refused the record) and `unknown` (the relay gave up after the handover with no reply);
     - inbound: opens `consumed` with its reply, which the lead knows at once.
   - **No inputs.** No `session_command` record carries an input or wakes a model.
   - **Identity.** Java's record rules check the member's outbound against its lineage, as H4d-b does for `to_parent`; the TypeScript funnel writes the lineage run it read from the member's definition. Both languages check that the lead's inbound names a run of the lead's own `child_run` domain that the sender attached. The lead's team funnel then maps that run to a member through the chain root and the open team's roster. A command never names its member in its arguments.

2. **The relay is H4d-b's, made aware of the new domain.**
   - **Discovery** reads both domains. The ledger keeps its key, (sender Session, record id); `cmd_` ids never meet `msg_`, `msgb_` or `msgc_` ids, so no migration is needed. The SQL that names `session_message` takes the domain as a parameter, and V54's (domain, delivery state) index already covers the scan.
   - **One pass per command:**
     1. `handover` on the member fixes the target (the lineage parent) and moves the outbound entry to `accepting`;
     2. `execute` on the lead runs the command (decision 3) and returns its reply in the response. For a command that changes anything, it has committed the inbound receipt first. The Harness client and the connector's message operation return that body; today they return nothing;
     3. `answered` on the member commits `accepted` with the reply. The member's call then commits `consumed` when it reads the reply (decision 4).
   - **One sender, one command at a time.** The relay hands over and executes a sender Session's commands in the order they were committed, and takes none while an earlier command of the same sender is unfinished: its outbound `planned` or `accepting`, whether or not it has a ledger row yet. An outbound `accepted`, `consumed`, `cancelled`, `rejected` or `unknown` is finished, whatever its ledger row says, and the command pass never executes an entry it finds `unknown`: it only classifies its ledger row. A retried command therefore never falls behind a later one, and a later call that times out while an earlier command waits finds its own entry still `planned` and cancels it (decision 4).
   - **No waiting step.** Every reply is known when `execute` returns. A command entry left `accepted` is finished for the relay: its dispatch never sends a command to H4d-b's `consume` step.
   - **Failures.**
     - The lead's refusal of the record (lineage, digest) makes the outbound `rejected`. The route answers it with its own error code, and the relay maps only that code to `rejected`; the generic conflict answer of the message route is never read as one.
     - A member whose Session is closing or gone before the handover makes the ledger row `orphaned`, as for messages; the outbound stays `planned`, and its call has ended with its Turn.
     - After 64 attempts the relay gives up. Before the handover the outbound becomes `cancelled`, as H4d-b's give-up does. After it, if the lead holds a receipt, the give-up copies its reply as `answered` does; otherwise the outbound becomes `unknown`.
     - A deterministic refusal by the lead's authority, met after `execute` has committed anything, is part of its reply (decision 3), never an error the relay retries.
     - Every step is replay-safe by the command id, as H4d-b's are by the message id.
   - **The close hold.** An owed command never holds a member's settlement or close: the child result relay's owed-outbox check reads `session_message` only, and stays that way.
   - **Latency.** A command takes one relay pass: a scan delay (2 s) and three Harness calls. A kick on the outbound commit, like `ActionResponseCoordinator.dispatch`, would remove the scan delay; it is left to open question 2.

3. **The lead executes a command on its funnels, never in its model.**
   - **Where.** `execute` runs on the lead's Harness without a model turn. The connector loads the lead as it does for `receive`, and loading an unattached lead starts its wake pump, which may run inputs the lead already owes; `execute` itself starts nothing. It is refused like `receive` when the lead is blocked for recovery or closing, and the relay retries. No kind needs the lead's new-work admission: `execute` starts no Turn and changes no Workspace. A member message's delivery takes H4d-b's own admission on the recipient's side.
   - **The order of checks.** `execute`:
     1. returns the reply of the lead's receipt for the command, if one is committed;
     2. else finds everything already committed under the `commandId`: the board writes under command ids derived from it (H4e-b1's committed-command lookup), the `team_plan` whose `requestId` is the `commandId`, the cancel of the member's earlier waiting plan made under the `commandId`, and the `msgc_` message of each roster position. A found `team_plan` answers the submission as it stands, with no supersede; a found cancel without its new `team_plan` completes the submission without running admission again. Remaining board writes are re-checked against the member rules and the board as it now stands; the ones that still hold commit, and the answer says what was committed and what was not. Remaining member messages are sent as decision 8 says;
     3. else admits the command as new: the sending run must be the chain head of a member of the open team, running, with no stop requested. Otherwise the reply is `refused`:
        - `This Session is not a member of an open team.` for a run no open team lists, which includes a member whose team was deleted while its command waited;
        - `Your run has ended or is being stopped; it takes no more team commands.` for a run that is not its member's head, has settled, or is being stopped.
   - **Partial plan supersede recovery.** Only an exact `withdrawTeamPlan` receipt keyed by `supersede:<commandId>:<oldRequestId>` bypasses fresh run admission. The replacement keeps the cancelled plan's revision plus one, never the recovery-time maximum. If another submission already occupies that revision or a later one, recovery answers that the old submission was superseded, naming the newer request, without opening a competing plan or cancelling anything. Its inbound command receipt preserves this outcome. Otherwise recovery opens the owed plan even after its run settles. Fresh submissions retain both initial and pre-withdrawal head checks; after a cancellation commits, settlement cannot turn the owed successor into a refusal. Domain rollback does not authorize new writes: a missing successor remains retryable without a refused inbound receipt until reenablement. Existing authority constraints still require an active team and a plan-mode member.
   - **Reads commit nothing.** A `board_read` checks the sender's lineage and attach itself, since no record rule does, and returns the board as it stands. It commits no receipt: it changes nothing, and a re-run may answer a newer board. Only the member's journal keeps its reply.
   - **Ordering between the funnels.** The team funnel and the child funnel each have a writes chain, and one never waits on the other inside its chain (H4e-b2 decision 10). `execute` reads and validates on the team chain, leaves it, and only then calls the child funnel for a message (decision 8). Board writes run on the team chain, between two of the lead's own calls, never in the middle of one.
   - **A closing team** follows H4e-b1: `task_create` is refused while the team closes, and `task_update` is allowed. A `plan_submit` is refused, because a `team_plan` opens only in an active team.
   - **Member-facing texts.** Every reply speaks to the member. None of the lead's notices or owner-rule refusals, which address the lead, reaches a member as written.

4. **The member's call parks until the reply arrives, briefly.**
   - **The park.** Before the first call of a batch that holds a command call runs, the Turn commits a new checkpoint phase, `await_command`, naming every command call of the batch with its command id. Each command call then commits its outbound entry and polls its own journal for the entry's reply, as `await_agent` does for a child's acceptance. The wait reads the journal without holding the member's funnel chain, on which the relay's `handover` and `answered` commit.
   - **An interrupted batch.** A Turn interrupted at any point of the batch finds the checkpoint. A command call with no outbound entry is answered as not sent; one with an entry is answered by decision 14; the batch's other calls (`send_message` to `"parent"`) are filled from the journal, as the parked round of a foreground wait is. So no call of the batch strands its Turn at `model_output_committed`.
   - **Cancels and stops.** The cancel route and the interrupted-turn flows settle an `await_command` Turn as they settle an `await_agent` one, answering each call by what committed, so an H4f stop or `request_shutdown` of a member parked on a command ends its Turn.
   - **The checkpoint.** `await_command` carries a `commandWait` group shaped like `agentWait`: per call, the `commandId`, the function call id, the tool name, the model message id, and whether the reply was folded; plus whether the Turn holds the Workspace mount. A null group is not encoded, as `agentWait` is not. The phase joins the closed phase list in TypeScript and in the qwencode Harness recovery wire, which reports it as a known outcome, and Java's `HarnessCoordinator` and `ToolPublicationStore` are audited for the new phase, which the foreground child wait design names as the drift to watch. A Harness that does not know the phase reads such a checkpoint as `checkpoint_blocked`.
   - **The batch.** A command call shares its batch only with other command calls and with calls that commit only in the member's own journal (`send_message` to `"parent"`). A batch that mixes one with Workspace or Runtime calls is refused before anything runs, as H4b refuses a foreground agent beside a non-agent call. So a command batch takes no mount of its own, and its approvals resolve before it runs. Its command calls park one after another, in call order, so a write is answered before the next call reads.
   - **The mount.** A Turn that took the Workspace mount in an earlier batch still holds it while a command parks. That cannot deadlock: `execute` never takes the mount and never waits on the member. A resumed wait takes back the Turn's Runtime lease when the checkpoint says it held one, so the Turn's finish releases it.
   - **The bounds.** A wait ends after 2 minutes from the outbound's commit, well inside the Turn deadline and the relay's inactivity bound, or at an H4f stop of the member. Once one command call of a Turn has timed out, every later command call of that Turn is refused at once (`The leader is not answering; end your turn.`), so a Turn never holds the mount through a string of waits. Whether a call of the Turn has timed out is read from the Turn's own journal, so a resumed Turn keeps the refusal.
   - **A timeout.** A call that times out cancels its outbound entry if it is still `planned`, and answers it as not sent. If the entry was handed over, the answer says the command reached the leader, its reply did not arrive, and a write may have taken effect: the model ends its turn and says so in its result, and a later turn, or the leader, reads the board before the write is repeated. A reply that arrives after the call ended is never read; the write it describes stands. The relay's per-sender order (decision 2) keeps that write ahead of any later command of the member.

5. **Members learn their tools from their preamble; the lead decides.**
   - A member Session holds no team record, so its Harness reads the run's first input; only a Session with a lineage does, so a root Session's user prompt never makes one. The run declares the member tools (decision 6) when the input's instruction part opens with a well-formed member preamble block: the same form check as H4e-b2 decision 5's replay, applied after `[description]` and its blank line for a launch, and after `Your next instruction:` for a continuation. Earlier instructions in a continuation's history are escaped, so only the run's own preamble counts. The plan-mode attribute is read more widely (decision 9): any unescaped block that carries it restricts the run. A run with none, which includes a former member continued after `team_delete`, declares no member tool.
   - The declaration is a convenience, not an authorization: the lead answers every command by the chain head and the roster (decision 3). A plain child whose prompt happens to carry a preamble-shaped block gets the tools and is told it is not a member.
   - **Gating.** The member tools are declared only when `session_command` is enabled; `exit_plan_mode` also needs `team_plan`, and is declared only in a run in plan mode (decision 9).
   - **The preamble's wording follows what the member can do**, not the batch that ships it: it stops saying the member cannot edit the board once `session_command` is enabled, and that it cannot message other members once the build carries member messages (b3c) with `session_command` enabled.
   - **The plan-mode attribute.** The open tag takes an optional `plan-mode="required"` attribute, and the body then says the member is in plan mode until the leader approves its plan; the body never contains `<`, as the form requires. b3a ships, ahead of their use, the widened form check, the plan-mode refusal, and decision 9's composition rule at both places a member's preamble is composed (the named launch and a continuation); none of them needs the command channel. Before b3d no member can be plan-required, so nothing writes the attribute. A rollback from b3d to any build that carries b3a and can still load the Session (see the plan-mode floor in decision 13) keeps a plan-required member in plan mode, failing closed, with no `exit_plan_mode` to leave it until the build carries b3d again; in such a build the plan-mode refusal says the run may only read and does not name `exit_plan_mode`. A build without b3a ignores the attribute, so decision 13 sets b3a as the floor below which plan mode is not kept.

6. **Member board tools.** They are commands, and their answers are the replies.

   | Tool          | Kind          | Parameters                                                  | Answer                                      |
   | ------------- | ------------- | ----------------------------------------------------------- | ------------------------------------------- |
   | `task_list`   | `board_read`  | as H4e-b1's: optional `status`, `owner`, `blockedBy`        | the board and the roster's names and states |
   | `task_create` | `board_write` | `subject`, `description`, optional `activeForm`, `metadata` | the new task's number                       |
   | `task_update` | `board_write` | `taskId` and H4e-b1's fields                                | the revised task, or the refusal            |
   - **What a member sees.** A member's `task_list` shows the board, with its task numbers, and each member's name and state, without the members' child task ids (`task_…`), the lead's notices, or any plan.
   - **The rules for a member author,** from Legacy:
     - it may change a task's status, owner, subject and description only on a task it owns or that has no owner;
     - it may add `addBlockedBy` edges only to a task it owns or that has no owner; `addBlocks` writes each named task, so each of them must be its own or unowned too. Hosted stores an edge on the blocked task only (H4e-a decision 5), and Legacy checks only the updated task, so this is stricter than Legacy on purpose: a member never writes a task another member holds;
     - it may set `activeForm` and `metadata` on any task;
     - it may delete only a task it owns or that has no owner;
     - it may set the owner only to itself or `""`: work for another member travels as a message, never as a board write (H4e-b2 decision 7);
     - moving an unowned task to `in_progress` makes the member its owner.
   - The lead's owner rule (H4e-b1, H4e-b2 decision 7) still guards every owner change: a member writing as itself is running, so it may own open work.
   - Everything else from H4e-b1's board rules holds: numbers, edges, the blocker bound, `in_progress` needs an owner, `deleted` freezes.
   - **Approval.** A member's tool calls follow its own Session's approval mode. `task_list` stays pre-approved, since it only reads its team's board. `task_create` and `task_update` are already on the input preview lists in both languages (H4e-b1).
   - **Legacy's auto-claim** stays out: a member that finishes ends its run, and the lead gives the next work.

7. **Member messages to the lead stay H4d-b's.** `send_message` to `"parent"` is unchanged. The join reserves the name `parent`, as it reserves `leader`, so no member can be addressed by the word a member uses for its leader. A member already named `parent` keeps its name and cannot be messaged by other members. A member's `send_message` to `"leader"` is refused locally, with a hint to use `"parent"`.

8. **Member-to-member messages travel through the lead, to running members only.**
   - **The tool.** A member's `send_message` takes `to`: `"parent"`, a member name, or `"*"`. A member name or `"*"` sends a `member_message` command. The sender's own name is refused locally, before anything is sent.
   - **Running members only.** For each recipient, the lead's child funnel takes a new **running-only send**: on its own writes chain it checks that the recipient's head runs with no stop requested, and then commits H4d-b's outbound `to_child` entry; it never routes to a continuation. A recipient whose head has finished, ended or is being stopped is not reached, and its line in the answer says so: a finished member gets more work from the leader, not from a peer. So member messages never launch a continuation and never spend H4b's active cap or H4c's launch budget, however the recipient's state changes between the team chain's check and the child chain's commit.
   - **Recipients.** `"*"` means every other member; the sender and the leader are never recipients. A name not on the roster is refused in the reply.
   - **Ids.** Each recipient's message id is `msgc_` + 32 hex of `sha256(leadSessionId \0 commandId \0 position)`, where `position` is the recipient's 1-based roster position. It meets neither a lead call's ids nor a broadcast's. Each names the `commandId` as its `executionCallId`, so none counts as work the lead gave in one of its Turns (H4e-b2 decision 7). A re-run of `execute` probes each position's `msgc_` id first, as H4e-b2's broadcast recovery does, so a recipient reached on the first run is reported as reached and nothing is sent twice.
   - **What the recipient sees.** The content opens with a fixed header line, `<member-message from="alice">`, then the text, then `</member-message>`. On the recipient's side, a message whose id starts with `msgc_` is rendered with `<from>member alice</from>`, the name read from the header anchored at the content's start and limited to the member-name characters, the header and footer stripped, and the reply hint `send_message with to "alice"`; a recipient in plan mode is told to reply through `"parent"` instead. The lead alone mints `msgc_` ids, and the name in the header is the lead's word, not the sending member's.
   - **The recipient's result.** H4d-b makes a running member's answer to its newest message its whole result (H4e-b2 open question 3), and that includes a member message. The wrapper says so: reply to the sender with `send_message`, then answer the leader's last instruction in full.
   - **Bounds.** Each recipient's message is H4d-b's message to a running child, bounded by its continuation envelope (≤ 32 KiB). Member messages share H4d-b's 8 in flight and 64 per run on the recipient's head with the lead's own messages, and take at most 4 in flight and 16 in all per receiving run, so the lead always keeps room for its own. They do not count among the messages that H4e-b2's never-started note tells the lead to send again: their sender is another member.
   - **The answer** lists each recipient's outcome, as H4e-b2's broadcast answer does.

9. **Plan approval: the member submits, the lead's model decides with a tool, and the decision arrives as an instruction.**
   - **A plan-required member.** The lead's named `agent` launch takes `plan_mode_required: true`; an unnamed launch still refuses it. The join records `planModeRequired: true` on the roster entry, which never changes, as every roster entry.
   - **One rule for every run's plan mode.** Every run of a plan-required member's chain, its launch and every continuation however it is made (a send by name, by task id, a broadcast, a decision), carries `plan-mode="required"` in its preamble until the lead holds an approved plan from that member of that team, keyed by the team id and the member's name. After the first approval, no later run of the member carries it, as a Legacy teammate leaves plan mode for good once approved. The one exception is the approval's own continuation, which is composed after the decision and so carries none. The rule lives at both places a member's preamble is composed, so no route can skip it, and ships in b3a (decision 5).
   - **Plan mode is a rule of an open team.** A chain that no open team lists runs without a preamble, so without plan mode: a former member continued after `team_delete`, and a plan-required launch whose join never committed, continued later as a plain child. The launch's own run keeps the attribute it was launched with.
   - **Plan mode on Hosted.** A run whose first input carries an unescaped preamble with `plan-mode="required"` is in plan mode for its whole run. Its batches admit only `read_file`, `glob` on the search profiles that declare it, `task_list`, `send_message` to `"parent"`, and `exit_plan_mode`; every other call, including a shell command and `send_message` to a member, is refused before it runs, with a text that points to `exit_plan_mode`. A read-only shell is open question 6. Legacy also lets a teammate waiting for approval claim a free task; a run in plan mode writes nothing to the board. The attribute is the lead's decision, and nothing in the member's own journal can lift it.
   - **The submission.** `exit_plan_mode({plan})` sends a `plan_submit` command and does not wait for the decision. A run has one accepted submission: a second call while an earlier submission of the run is in flight, or after one whose reply was `answered`, is refused locally (`Your plan is already submitted; end your turn.`). A submission answered `refused` (for instance `byte_limit`), cancelled before its handover, or `rejected` was not accepted, so the run may send a corrected one. The lead's funnel:
     - checks the plan's size (below);
     - cancels the member's waiting plan, if any: one waiting plan per member, a newer one supersedes it (Legacy refuses a second pending plan instead);
     - commits a `team_plan` revision `waiting`, with `requestId` = the `commandId` and `planRevision` one above the member's last;
     - answers `Your plan was submitted as revision N. End your turn now; the leader's decision arrives as your next instruction.`
   - **The plan's bound.** The decision quotes the plan, so the plan, XML-escaped, must fit the member's continuation envelope (≤ 32 KiB, which also holds the launch's description and definition) together with the preamble, the decision's fixed text and room for 4 KiB of feedback, escaped. Only the lead knows that envelope, so `execute` checks it and answers a longer plan `refused`, `byte_limit`.
   - **The lead learns of it from the member's result.** When the member's run settles, the lead's result notification for it carries a `<plan-approval-request request="…" revision="N">` block with the plan that run submitted, if it is still waiting, XML-escaped, before the result text. The result text is cut first when the notification is over its bound; the plan block fits by the bound above. The lead's `task_list` lists each waiting plan by member, request id, revision and size, and `team_plan_approval` with `action: "show"` returns the text of any plan of the team by its request id, waiting or decided, with its state and decision; it commits nothing and is pre-approved. So a request is never lost to a compacted context, nor to a submission that lands after the notification was composed, and the lead never decides blind.
   - **The decision.** The lead's model calls `team_plan_approval({request_id, action: "approve" | "reject" | "show", message?})`, with feedback of at most 4 KiB. A re-driven call first finds its committed settle and continuation by the call's ids. Then:
     1. it checks that the decision can be delivered:
        - the plan is the member's newest and still waiting; one already decided answers its decision;
        - the member's head has completed with no stop requested. While the head runs, or a continuation of it waits to start, the answer is `decide after alice's run settles`. If the head has ended or completed after a stop request, the plan is withdrawn (a write) and the answer says so;
        - the team is active, and the continuation passes its launch admission (H4b's active cap, H4c's launch budget, the envelope bound).

        Otherwise, apart from that withdrawal, it commits nothing, the plan stays waiting, and the answer says why and when to try again;

     2. it settles the `team_plan` with the decision and the feedback;
     3. it continues the member as H4e-b2's `send_message` would, under the call's own ids, with an instruction that quotes the plan, escaped, and the feedback: approved, carry out the plan; rejected, revise it and call `exit_plan_mode` again. The preamble follows the rule above.

   - **A decision recorded but not delivered.** A Turn interrupted between steps 2 and 3, or a step 3 refused at once, is answered from the records: `The decision on alice's plan revision N was recorded (approved). The call stopped before alice was continued; send her the decision with send_message, quoting the plan (team_plan_approval with action "show" returns it).` Any later continuation of the member follows the recorded decision under the rule above, so a resend can never lift plan mode after a rejection. If a decision's continuation never starts, H4e-b2's never-started note asks the lead to send that work again; for a decision it says to quote the plan.
   - **Costs.** Every decision continues the member, so it spends one of H4c's 64 launches per Session, which never recover; a long reject-and-revise loop spends them quickly. A run has one accepted submission, so a looping model cannot spend them faster than its runs.
   - **Withdrawals.** A waiting plan is cancelled only on a path that already writes: a newer submission from the member, `team_plan_approval` finding the member's head ended or completed after a stop request, `request_shutdown`, and `team_delete`. The lead's `task_list` only marks a waiting plan whose member has ended.
   - **The contract.** `team_plan.requestId` is the submission's `commandId`, not a D6 Action. The H4e-a texts in both languages change to say so; no record rule reads it. The plan-required check on `team_plan`'s opening already exists in both languages. The D6 action source `team_plan` stays reserved and unproduced.
   - **No D6 card, no OpenAPI change.** The user does not see plan requests as Actions in this slice; #13785 can project them later from the committed records. `exit_plan_mode` and `team_plan_approval` are pre-approved in `default` and `auto-edit`, so a lead's decision never waits on a user's card, as in Legacy. Both also join the input preview lists, which stay identical in both languages, for a hook that asks.
   - **`plan_mode` stays unused.** That domain names a Session's own plan mode. A member's plan mode is per run, and its preamble carries it.

10. **Shutdown is a stop the lead requests.**
    - `request_shutdown({to})` is a lead tool. For a member whose head runs, it commits `stopRequested` on the head, and the child result relay's stop arm cancels the member's Turn and settles the run, as a user's H4f cancel does. In every case it withdraws the member's waiting plan.
    - **The answer reads the head's state:**
      - a running member: `alice is being stopped. Delete the team once task_list shows it ended.`;
      - a continuation that has not started yet: it may end without starting, and the member then goes back to its predecessor, so the answer says so instead of calling the member ended;
      - a member whose head has finished takes no work unless the lead sends it some: the answer says so, and the head is not touched;
      - a member already being stopped, or ended: its state.
    - The member is not asked. Legacy's cooperative reply cannot reach a Hosted member, which has settled by the time it is idle, and an answer mid-run would replace its result.
    - **`team_delete`** still refuses while a member runs, including one being stopped, and its refusal now points to `request_shutdown`. This replaces the "Member stop" follow-up of H4e-b1, which H4e-b2 carried, in which `team_delete` would request the stop itself.
    - The tool asks for approval in `default` and `auto-edit` modes, as Legacy's does, and joins the input preview lists in both languages so the card names the member.

11. **`team_message` and `task_assignment` stay registered, disabled and unproduced.**
    - Lead-to-member traffic is Session messages (H4e-b2), member-to-lead traffic is commands and `to_parent` messages, member-to-member traffic is the lead's messages, and assignments are messages (H4e-b2 decision 7). Nothing needs the domain.
    - Its rules stay as they are, including the target rule that binds a member to its first run. The H4e-a design marks the domain and its `task_assignment` kind reserved; removing them from the closed index is left to a contract revision.

12. **Legacy teams are not imported.**
    - Legacy team files live under the CLI host's home directory, which no Hosted Harness can read. Its roster names live teammates, while a Hosted roster entry needs a live child run of the lead. A member's name is capped at 64 characters, and Legacy names are not. Legacy task ids are reused after a deletion; Hosted numbers are not.
    - A user who wants the board of a Legacy team in a Hosted Session asks the lead to recreate it with `task_create`. Import is a non-goal of H4e, not a deferred piece.

13. **Four batches, each enabling what it adds.**

    | Batch | Scope                                                                                                                                                                 | Enables                                     |
    | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
    | b3a   | `request_shutdown` and `team_delete`'s refusal (decision 10); the widened preamble form, the plan-mode refusal and the plan-mode composition rule (decisions 5 and 9) | nothing new                                 |
    | b3b   | `session_command` records and rules in both languages, the relay's command pass, `execute`, `await_command`, member board tools, the reserved `parent` name, recovery | `session_command`, after its physical pass  |
    | b3c   | member-to-member messages and the running-only send (decision 8)                                                                                                      | nothing new; merges after its physical pass |
    | b3d   | plan-required launches, `exit_plan_mode`, `team_plan_approval`, the `team_plan` records and withdrawals                                                               | `team_plan`, after its physical pass        |
    - b3a needs no channel and lands first. Every batch runs a physical pass on a real Hosted stack before it enables anything new or merges, as H4e-b1 and H4e-b2 did.
    - **Plan mode's floor.** b3d accepts `plan_mode_required` only once the rollback floor of the deployment, and every Harness serving it, carries b3a. A build without b3a composes a plan-required member's continuation without the attribute and admits every tool, so a rollback below that floor is not supported while plan-required members exist. Records a later batch commits raise the floor for the Session that holds them, even while that batch's domain is disabled: every Harness that may reopen a Session holding `session_command` records, and the rollback floor, must carry b3b, and for a lead that has committed a `team_plan` record they must carry b3d. A Harness below that floor refuses to load the Session (see the [team plans design](2026-10-12-managed-agent-team-plans.md)).
    - Each batch adds the domain it enables to the Hosted reopen whitelist.

14. **Interrupted turns are answered by what committed (extends H4e-b2 decision 9).**
    - **The member's command call.** Recovery and the PostToolUse dispatch evidence look a call up under its `commandId`, and a member's `send_message` under both its `msg_` and its `cmd_` ids, since a hook may have rewritten `to`:
      - `accepted` or `consumed`, with a reply: the reply;
      - `accepting`, no reply yet: on a route that resumes the Turn, the wait resumes with what is left of its bound, measured from the outbound's commit; on a route that settles it, the answer says the command reached the leader, its reply did not arrive, and a write may have taken effect, so the board is read before the write is repeated;
      - `planned`: the entry is cancelled, and the call answered as not sent; a handover that wins the race is answered as an `accepting` entry is;
      - a checkpoint naming a command call with no outbound entry: answered as not sent, and the batch's other calls filled from the journal (decision 4);
      - `rejected`, `cancelled`, `unknown`: said so, with `unknown` never presented as done.
      - For a `member_message` in `accepting` or `unknown`, the answer says some recipients may already have the message or receive it later, and prohibits sending it again. The task board cannot establish message delivery. Live, resumed and interrupted-turn answers use the command kind committed in the journal; board commands and `plan_submit` retain their existing wording.
    - **The lead's calls** (`team_plan_approval`, `request_shutdown`) are answered from their committed records, as H4e-b1's team calls are, with the split answer of decision 9 for a decision recorded but not delivered.

## Tools

| Tool                 | Who                 | Commits                                                                    | Differs from Legacy                                                                                                                                   |
| -------------------- | ------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task_list`          | member              | an outbound `board_read` command                                           | reads through the lead                                                                                                                                |
| `task_create`        | member              | an outbound `board_write` command; the lead commits the task               | no auto-claim                                                                                                                                         |
| `task_update`        | member              | an outbound `board_write` command; the lead commits the revision           | owner only itself or `""`; sends no assignment                                                                                                        |
| `send_message`       | member              | to a member or `*`: a `member_message` command; to `"parent"`: H4d-b       | relayed by the lead to running members only; labeled with the sender                                                                                  |
| `exit_plan_mode`     | member in plan mode | a `plan_submit` command; the lead commits a `team_plan`                    | does not wait; one accepted submission per run; a newer plan supersedes the waiting one; the decision arrives as the next instruction; no target mode |
| `team_plan_approval` | lead                | the `team_plan` decision; a continuation of the member; nothing for `show` | only once the member's run has settled; `show` reads any plan of the team                                                                             |
| `request_shutdown`   | lead                | `stopRequested` on the member's head; the waiting plan's withdrawal        | a stop, not a request the member may decline                                                                                                          |
| `agent` with `name`  | lead                | unchanged, plus `plan_mode_required`                                       | unchanged                                                                                                                                             |

## A command's path

Member `alice` runs `task_update` on task 3:

| Step | Journal | Commit                                                                                                     | By                              |
| ---- | ------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 1    | alice   | the `await_command` checkpoint naming the batch's command calls; then outbound `session_command` `planned` | `task_update`                   |
| 2    | alice   | outbound `accepting`, target = the lead                                                                    | relay (`handover`)              |
| 3    | lead    | `team_task` revision of task 3; then inbound `consumed` with the reply                                     | relay (`execute`) → team funnel |
| 4    | alice   | outbound `accepted` with the reply                                                                         | relay (`answered`)              |
| 5    | alice   | outbound `consumed`; the call's tool result, from the reply                                                | the parked call                 |

A `board_read` commits nothing at step 3. A `member_message` commits, at step 3, one outbound `session_message` per running recipient on the lead, then the receipt, and H4d-b's pipeline delivers each.

## Bounds

| Bound                   | Value                                                                                                                       | Refusal                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Command arguments       | ≤ 64 KiB                                                                                                                    | tool error, `byte_limit`                       |
| Reply                   | ≤ 64 KiB; a longer `task_list` is cut with a marker                                                                         | truncation, never refusal                      |
| Commands per member run | 256, reads included                                                                                                         | tool error, `budget_exhausted`                 |
| A command's wait        | 2 minutes from the outbound's commit, or an H4f stop                                                                        | the call ends; answered by what committed      |
| After a timeout         | every later command call of the Turn                                                                                        | tool error, at once                            |
| Plan text               | escaped, it fits the continuation envelope with the preamble, the decision's text and 4 KiB of feedback; the lead checks it | `refused`, `byte_limit`                        |
| Feedback                | ≤ 4 KiB                                                                                                                     | tool error, `byte_limit`                       |
| Waiting plans           | one per member; a newer one supersedes it                                                                                   | the older is cancelled                         |
| Plan submissions        | one accepted per run; a refused, cancelled or rejected one may be sent again                                                | refused locally                                |
| Plan decisions          | each spends one of H4c's 64 launches per Session                                                                            | `team_plan_approval` refused before it commits |
| Member messages         | per recipient ≤ 32 KiB; 4 in flight and 16 in all per receiving run, inside H4d-b's 8 and 64                                | per recipient, in the answer                   |
| Commands of one sender  | one at a time, in commit order                                                                                              | a later one waits behind an earlier one        |

## Non-goals

- **A user approval card for plans,** and any change to D6 Actions, Java's action store or the public OpenAPI (#13785 owns the public projection). Java's input preview list does change.
- **A cooperative shutdown** that a member may accept or decline.
- **Legacy team import** (decision 12).
- **Messages between members that bypass the lead,** a peer route outside the lineage (H4d-a open question 4), and member messages that continue a finished member.
- **Legacy's auto-claim,** idle notifications, and read-only or retyped members.
- **Freeing roster slots:** an ended member still takes one of the 10.
- **Producing `team_message`** (decision 11).
- **Changing H4d-b's result rule:** a member's answer to a member message can still become its result (decision 8).

## Files affected

- **Contract (both languages):**
  - `packages/core/src/managed-runtime/managed-session-records.ts`: `session_command` in the closed domain index, and the enablements;
  - `managed-session-command-record.ts` and `managed-session-command-operations.ts` (new): the record, its successor rule, ids and bodies;
  - `managed-session-authority.ts`: the inbound lineage rule and the no-input rule;
  - `managed-extension-projection.ts`, `contracts/managed-extension-record-v1.schema.json`, the shared record and projection fixtures, and new command fixtures;
  - `managed-harness-checkpoint.ts` and `managed-harness-factory.ts`: the `await_command` phase and its `commandWait` group;
  - `managed-team-record.ts` comments: `team_plan.requestId` is a submission's command id;
  - Java: `ManagedExtensionRecords.DOMAINS`, `ManagedExtensionProjection`, a `session_command` validator, `ManagedExtensionRecordStore`'s lineage and no-input rules, the `ManagedTeamRecords` comments, and `ContractTest`.
- **Relay (Java):**
  - `SessionMessageRelay` and `SessionMessageRelayStore`: the domain as a parameter, the command pass, and its give-up;
  - `QwenHostedHarnessConnector`, `HarnessConnector` and the qwencode `HostedHarnessClient.runMessageOperation`: the `execute` and `answered` verbs, and a response body for `execute`;
  - the qwencode Harness recovery wire: `await_command`;
  - `HarnessCoordinator` and `ToolPublicationStore`: the phase audit;
  - `ManagedActionService.PREVIEW_TOOLS`: `request_shutdown`, `exit_plan_mode` and `team_plan_approval`, as in `HOSTED_INPUT_PREVIEW_TOOLS`.
- **Harness (TypeScript):**
  - `hosted-member-chain.ts`: the preamble wordings by gate, the widened form, the `plan-mode` attribute, and the never-started note's lost messages leaving out `msgc_` ones;
  - `hosted-session-command-session.ts` (new): the member's outbox and wait, and the lead's `execute`;
  - `hosted-team-session.ts`: member-authored board writes and member-facing texts, the reserved `parent` name, `member_message` routing, `team_plan_approval`, `request_shutdown`, plan withdrawals, waiting plans in the lead's `task_list`, and the `planModeRequired` join;
  - `hosted-child-agent-session.ts`: the running-only send, the plan block in a member's result notification, and the plan-mode rule where a continuation's preamble is composed;
  - `hosted-session-message-session.ts`: the `msgc_` rendering on the recipient's side;
  - `hosted-workspace-tool-turn.ts`: member tool declarations, the command batch rule, plan mode admission, `await_command`, the lead tools, `plan_mode_required` on the named `agent` launch's schema and admission, the plan-mode rule where a launch's preamble is composed, and `HOSTED_INPUT_PREVIEW_TOOLS`;
  - `hosted-runtime-recovery.ts`: decision 14, the batch's gap fill, the cancel and settle routes for `await_command`, and the resumed wait's lease;
  - `hosted-harness-session.ts`: the `execute` and `answered` verbs on the message operations route, `execute`'s own error code for a record refusal, and the reopen whitelist;
  - `hosted-tool-approval.ts`: the pre-approved lists.
- **Tests that flip:** the preamble wording tests, `team_delete`'s refusal text, and the member `send_message` refusal of a member name.
- **Designs:** this document, its Chinese twin, and pointers in the H4e-a, H4e-b1, H4e-b2 and H4d-b designs and in the H4a and H4b delivery maps; an E2E plan under `.qwen/e2e-tests/` per physical pass.

No Flyway migration: the relay's ledger and index are reused.

## Validation plan

- **Records, both languages.** The `session_command` parse, successor and lineage rules on shared fixtures; no input on any revision; the reply set once on `accepted`; `cmd_` and `msgc_` ids never meeting another namespace; `team_plan` opening only for a plan-required member.
- **Relay (Java).** Two-domain discovery; the command pass and `execute`'s response body; one sender's commands taken one at a time, in commit order, through a retry's backoff; `rejected`, `orphaned`, `cancelled` and `unknown` outcomes, and a give-up that copies a committed reply; a redelivered `execute` and `answered`; a lead that is blocked, closing or not loaded; a command entry left `accepted` never sent to `consume`.
- **Team funnel.**
  - Each Legacy board rule for a member author, including an edge across two tasks; the owner rule on a member's own claim; member-facing texts; what a member's `task_list` hides.
  - A non-member's command, a stopped, settled or non-head run's command, a closing team, a re-run `execute` that returns the committed reply, a half-applied write re-checked against a board that changed in between, and a re-run `plan_submit` that finds its own `team_plan`.
  - `member_message` to a running member, a finished one, a member that settles between the two chains, `"*"`, the sender itself, `leader`, `parent` and a stranger; the bounds; the rendering on the recipient's side, in and out of plan mode; ids and probes on a re-run.
  - Plans: a submission, a second one in the same run, a corrected one after `byte_limit` and after a timeout that sent nothing, a supersede, a submission interrupted between its cancel and its new plan, the size check at `execute`, the result notification's block at the bound, `show` on a waiting and on a decided plan, an approval and a rejection quoting the plan, every route of a continuation following the plan-mode rule, a chain no open team lists, each refusal of `team_plan_approval` before it commits, a decision already made, the split answer after an interrupted or refused continuation, and each withdrawal.
  - `request_shutdown` on a running member, a continuation not yet started, a finished one and an ended one, each withdrawing a waiting plan, and `team_delete` after the stop settles.
- **Tool turn.** Member tools declared only behind an unescaped preamble, only in a Session with a lineage, and only when enabled; the command batch rule; plan mode admission in a plan-mode run and in a later run without the attribute; `await_command` across a Harness restart, with and without the mount held; the 2-minute bound and the refusal after a timeout, across a restart; the checkpoint committed before the batch's first call, and its gap fill; a stop and a cancel of a Turn parked on a command; each answer of decision 14.
- **Physical passes**, on a real Hosted stack with a scripted model, driven through the public API:
  - b3a: the lead stops a running member, then deletes the team once the stop settles;
  - b3b: two members read and write the board, the lead reads it, a member's write races one of the lead's, and a member's Harness is restarted while its command waits;
  - b3c: member-to-member messages to a running member and to `"*"`, a refused finished recipient, and the recipient's reply to the sender;
  - b3d: a plan-required member is rejected, revises, is approved, and only then edits files; a lead message to it before the approval keeps it in plan mode; a rollback to b3d with the `team_plan` domain disabled keeps it in plan mode, since a build below b3d cannot load a lead holding `team_plan` records (decision 13);
  - before each enablement, one run with a real model, approved by the user.

## Acceptance criteria

- A member reads and writes the board under Legacy's rules, and every write lands in the lead's journal as a lead commit.
- A member messages a running member or all of them, each recipient sees who wrote and can answer the sender, and no member message launches a continuation.
- A plan-required member edits nothing before the lead's model approves its plan, whatever route continues it, and the approval arrives as a run without plan mode that quotes the plan.
- The lead stops a running member with `request_shutdown`, then deletes the team once the stop has settled.
- No member-authored command is ever applied twice, and an interrupted call is never answered as done when its outcome is unknown.
- `team_message` stays unproduced, and nothing reads a Legacy team's files.

## Open questions

1. **Commands and blocked Sessions.** A lead parked by #13847 answers no command, so every member's command call times out after 2 minutes, and the rest of its Turn's command calls are refused. The fix belongs to #13847. The member's own journal-only window is narrowed by committing the checkpoint before the batch's first call (decision 4), as far as the foreground child wait narrows its own.
2. **Command latency.** One relay pass costs a scan delay and three Harness calls. A kick on the outbound commit would remove the scan delay; it is a Java change to the store's append path.
3. **A member's identity in its own Session.** Reading the preamble from the first input is in-band. A typed marker on the child's launch would be cleaner, and is a contract change to the launch envelope or the lineage. Plan mode fails closed under it: a block with the attribute restricts the run wherever it is unescaped, and a run with no readable block gets no member tools.
4. **A member's answer to a member message becomes its result** (H4d-b's result rule). Skipping member-message turns when the child result relay picks the result would keep a member's report for the lead; it is a change to Java's completion rule.
5. **The public view of plans** (#13785): a projection of waiting `team_plan` records as Actions, with an agent-identity source.
6. **A read-only shell in plan mode.** A run in plan mode cannot list or search the Workspace beyond `read_file` and, on the search profiles, `glob`. A shell restricted to reading would help it plan, and needs a read-only Runtime mode that does not exist yet.

## Follow-up work

| Slice    | Scope                                                                                     |
| -------- | ----------------------------------------------------------------------------------------- |
| #13847   | A lead blocked after a journal-only batch crash, which also stalls its members' commands. |
| #13901   | H4e-b2's wording and efficiency gaps; several texts this slice reuses.                    |
| #13785   | The public agent-identity dimension, and plans as public Actions.                         |
| Contract | Retiring `team_message` and `task_assignment` from the closed index (decision 11).        |
