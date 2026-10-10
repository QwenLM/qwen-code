# E2E plan: H4e-b1 lead-side team runtime

Scope: the Hosted lead's team tools (team_create, team_delete, task_create,
task_update, task_list), the agent tool's `name`, the `<teammate>` label and
the lead close cascade, on a real Hosted stack with `team_state` and
`team_task` in `MANAGED_SESSION_ENABLED_DOMAINS` (the enablement change).

## Rig (run 2026-10-10)

- aarch64 Linux host. Packaged `qwen-managed-agent-server` jar (Store,
  Runtime Broker, child result relay, Session coordinator), the bundled CLI
  as `serve --profile hosted-harness`, durable local workers, a private
  MariaDB instance, and a real model (`qwen3.8-max`). Spring runs in the
  `default` approval mode; the driver answers every Action through the
  public Action API and records its input preview.
- Driving goes through the public `/v1/agents/sessions` API only. One
  declared rig step: a fresh Session is moved to the private
  `hosted-workspace-shell/1` profile by SQL before its first Turn, because
  the public create refuses a profile override; child Sessions inherit it.
- Fault hook: a proxy in front of the Session Store SIGKILLs the Harness on
  the commit whose command id ends with `:join`, either before forwarding it
  or after the Store answered it. The control arm fires the same hook after
  `startChildRun` of an unnamed background launch.
- Evidence: every revision of `team_state`, `team_task`, `child_run` and
  `child_acceptance` read back from `qwen_managed_session_resource`, the
  relay ledger row, Session and Turn states, and the proxy's commit log.

## Baseline (domains disabled)

Control arm: the same bundle with only `team_state` and `team_task` removed
from the enabled list.

1. The model lists `read_file`, `write_file`, `edit`, `run_shell_command`,
   `monitor` and `agent`; the agent tool has `description`, `prompt` and
   `run_in_background` and no `name`. **Observed.**
2. Asked to launch an agent with `name` anyway, the call is refused with
   "Hosted child agent received unsupported argument "name"", and no
   child_run or team record is committed. **Observed.**

## Physical acceptance (domains enabled)

1. Lead creates a team, spawns two members by name, assigns board tasks,
   receives both labeled reports, marks the tasks done, and deletes the team.
   Expect: team_state chain opening → 2 joins → closing → deleted; task_list
   shows both members `completed`. **Observed**, after one fix. The first
   run found both members completed before the lead's `task_update` landed,
   so the board refused them as owners ("has finished and cannot own a
   task"). The fix lets a finished member own a task the call leaves
   `completed`; the re-run records `counter` and `reverser` as the owners of
   their completed tasks. Both `<teammate>` notifications arrived (inside
   the running Turn in one run, as wake Turns in the other).
2. Lead closes with a member still running. Expect: the member's child_run
   ends `cancelled`/`stop_requested`, its Session closes, the team records
   keep their last revision, and the lead is never revived by the member.
   **Observed.** The close waits until the member's Turn ends, including an
   approval the member is waiting on (H4b decision 13).
3. Kill the Harness between a member's launch and its join (fault hook on the
   `:join` commit), and restart. Expect exactly one child_run and no roster
   entry; repeat with the hook after the join: one child_run and one roster
   entry. **Observed** for the records. The member Session runs in both
   arms, but the lead's Turn fails `managed_runtime_recovery_blocked` (parked
   at `model_output_committed`), every later load of the lead answers
   `hosted_turn_recovery_required`, and the member's result never reaches
   the lead. The control arm (no team, unnamed background launch) ends the
   same way, so this is H4b's recovery limit (design open question 5). The
   channel Turn's interrupted settlement is not covered: the rig has no
   channel adapter.
4. team_delete while a member runs. Expect the refusal naming it, and no
   team_state revision. **Observed.**
5. Approval in `default` mode: task_list runs without a card; team_create,
   task_create and task_update cards show the input preview. **Observed**;
   the agent card shows `name` in its preview, and team_delete's card has
   none.
