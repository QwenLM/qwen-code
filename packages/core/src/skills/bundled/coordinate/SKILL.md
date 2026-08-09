---
name: coordinate
description: Coordinate up to three Qwen teammates with the existing Agent Team runtime and Agent View tabs. Invoke explicitly with /coordinate.
argument-hint: '<goal>'
disable-model-invocation: true
---

# Coordinate Qwen Teammates

Act as the team leader. Decompose the goal, keep task ownership clear, reconcile disagreements, and deliver the final result.

## Use the existing product

When `team_create` is available:

1. Create one team for the goal.
2. Create one self-contained task per independent workstream.
3. Spawn one to three named teammates with the Agent tool. Do not pass `model`; named teammates use the current Qwen configuration.
4. Assign tasks and let teammates collaborate through `send_message` and the shared task list. Use follow-up messages when evidence conflicts or a task needs clarification.
5. Synthesize the accepted results. The leader is the only agent that writes to the current workspace.
6. Send each teammate a `shutdown_request`, then delete the team.

The existing Agent View tabs show teammate conversations and approvals. Do not create another roster, session manager, or terminal UI.

If the Agent Team tools are unavailable, say that `experimental.agentTeam` must be enabled and Qwen Code restarted. For a read-only request, you may still run up to three ordinary foreground agents in parallel, but describe that fallback accurately: those agents return results to the leader and cannot communicate with each other.

## Keep coordination bounded

- Use one teammate for a narrow task and no more than three for this workflow.
- Give every task an objective, scope, completion condition, and required evidence.
- Prefer read-only `Explore` teammates. Do not let multiple agents edit the shared checkout.
- Do not use Arena: it is for competing solutions to the same task, not collaboration on different tasks.
- Do not introduce independent PTY workers, external daemons, or heterogeneous CLIs.
- Finish implementation before running the smallest relevant verification once.

Return the outcome, material evidence or disagreements, changes made by the leader, verification, and remaining risks.
