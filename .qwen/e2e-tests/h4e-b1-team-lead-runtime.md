# E2E plan: H4e-b1 lead-side team runtime

Scope: the Hosted lead's team tools (team_create, team_delete, task_create,
task_update, task_list), the agent tool's `name`, the `<teammate>` label and
the lead close cascade. The team domains ship disabled, so every run below
needs a build with `team_state` and `team_task` added to
`MANAGED_SESSION_ENABLED_DOMAINS` (the enablement step), on a real Hosted
stack (managed-agent-server + qwen serve Harness + Runtime Broker).

## Baseline (domains disabled, as shipped)

1. Create a Hosted Session on `hosted-workspace-shell/1`; list the declared
   tools of its first turn. Expect `agent` without `name`, and no team tool.
2. Ask the model to launch an agent with `name`. Expect the tool error
   "unsupported argument "name"" and no child_run record.

## Physical acceptance (domains enabled)

1. Lead creates a team, spawns two members by name, assigns board tasks,
   receives both labeled reports (`<teammate>` in each notification), marks
   the tasks done, and deletes the team. Expect: team_state chain opening →
   2 joins → closing → deleted; task_list shows both members `completed`.
2. Lead closes with a member still running. Expect: the member's child_run
   ends `cancelled`/`stop_requested`, its Session closes, the team records
   keep their last revision, and the lead is never revived by the member.
3. Kill the Harness between a member's launch and its join (fault hook on the
   `:join` commit) on a channel Turn, and restart. Expect exactly one
   child_run, no roster entry, the child running on as an ordinary background
   child, and the interrupted settlement answering the call as started. Repeat
   with the hook after the join: expect the answer to say it joined.
4. team_delete while a member runs. Expect the refusal naming it, and no
   team_state revision.
5. Approval in `default` mode: task_list runs without a card; team_create,
   task_create and task_update cards show the input preview.
