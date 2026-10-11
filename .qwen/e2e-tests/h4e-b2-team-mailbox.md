# E2E plan: H4e-b2 the lead's mailbox over Session messages

Scope: the lead's `send_message` to a member by name and to every member
(`to: "*"`), continued members (the roster follows a member's continuation
chain), the member preamble, the `<teammate>` label on a member's messages
and continued results, and the owner rule's "work given in this Turn", on a
real Hosted stack with `team_state`, `team_task` and `session_message`
enabled. See `docs/design/2026-10-11-managed-agent-team-mailbox.md`.

## Rig

- aarch64 Linux host. The packaged `qwen-managed-agent-server` jar (Store,
  Runtime Broker, child result relay, Session message relay, Session
  coordinator), the bundled CLI as `serve --profile hosted-harness`, durable
  local workers, MySQL, and a scripted OpenAI-compatible model that answers
  each Turn with the tool calls the scenario names.
- Driving goes through the public `/v1/agents/sessions` API only. One
  declared rig step, as in H4e-b1: a fresh Session is moved to the private
  `hosted-workspace-shell/1` profile by SQL before its first Turn; child
  Sessions inherit it.
- Evidence: every revision of `team_state`, `team_task`, `child_run`,
  `child_acceptance` and `session_message` read back from the Store, the
  launch envelopes of member runs, the message relay ledger, the inputs the
  lead and the members received, and Session and Turn states.

## Physical acceptance

1. Lead creates a team, launches two members by name, and receives both
   reports labeled. Expect: each member's launch envelope prompt opens with
   the `<team-member name=… team=…>` preamble; both notifications carry
   `<teammate>`.
2. In one batch, the lead sends one finished member new work by name and
   records the task on the board with that member as owner. Expect: a
   continuation `child_run` whose predecessor is the member's first run and
   whose instruction is the preamble plus the message; the `task_update`
   commits the owner on the `in_progress` task, and its answer acknowledges
   that send and asks for no second one.
3. The continued result arrives labeled with the member's name; then the
   lead broadcasts with `to: "*"`. Expect: one message or continuation per
   member under `msgb_…` / `bcast_…` ids, each with the broadcast call's key
   as `executionCallId`; the answer lists every member.
4. A member asks the lead something with `send_message` to `"parent"`.
   Expect: the lead's input carries `<teammate>` and H4d-b's reply hint by
   task id; the lead's answer by task id is answered naming the member, and
   reaches it as a message if it still runs, or as a continuation if it has
   settled; the result is labeled.
   Whether the member's last answer repeats its earlier work is recorded as
   an observation.
5. `team_delete` is refused while a continued member runs, and succeeds once
   it ends. After the delete, a send by `task_id` to the former member
   continues it with no preamble, and its result arrives unlabeled.

## Results

Final run on `7cd23e2fb4` (the PR's code, rebased on main `d9c6f8c0fe`),
2026-10-11 07:27–07:30Z, Linux aarch64 (Orange Pi 6 Plus), JDK 21, MySQL 8.4
in Docker, Node 24: **57/57 checks passed**, no product bug found. Earlier
runs on `f741e8df22` (55/55) and `48d2a4fa3f` (57/57) also passed. Only the
scripted model was used.

| Scenario | Checks | Result |
| -------- | ------ | ------ |
| Rig: fresh lead moved to `hosted-workspace-shell/1` before its first Turn | 1 | PASS |
| 1. Named launches with the preamble, member tools, labeled reports | 12 | PASS |
| 2. Send by name + `task_update` in one response; continuation envelope and input; acknowledged answer; labeled result | 7 | PASS |
| 2b/2c. Same Turn after the continuation settled accepts the owner; a later Turn refuses with the conditional text | 3 | PASS |
| 3. Broadcast to finished members (`bcast_…`) and to running ones (`msgb_…`); ids equal the design digests; answers list every member; labeled results | 9 | PASS |
| 4a/4b. Member questions labeled with the task-id hint; replies by task id answered naming the member, as a message or a continuation | 11 | PASS |
| 5. `team_delete` refused while a continued member runs, then deleted; former member continued by task id with no preamble, unlabeled; `to` refused | 9 | PASS |
| Run: Sessions closed, child runs settled, relay ledgers done, no failed Turn | 5 | PASS |

Observations:

- A member's result after a broadcast holds only its answer to the last
  instruction (H4d-b's result rule, open question 3). The scripted model
  answers only the last instruction, so whether a real model repeats its
  earlier work is not shown.
- `HostedTeamLeadMySqlIT` (#13867) passed on the same head against MySQL
  8.4 (3 tests), with its owner-refusal assertion updated for this slice.
