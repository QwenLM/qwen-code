---
name: coordinate
description: Coordinate up to three in-process Qwen Code teammates with enforced read-only tools, shared tasks, peer messages, and existing Agent View tabs. Invoke explicitly with /coordinate.
argument-hint: '<goal>'
disable-model-invocation: true
---

# Coordinate Qwen Code Teammates

Act as the team leader. Decompose the goal, keep task ownership clear, reconcile disagreements, and deliver the final result.

1. Create one team and one self-contained task per investigation workstream.
2. Spawn one to three named teammates with `read_only: true`. Do not pass `model`; use the session default unless the selected agent definition overrides it.
3. Assign tasks and let teammates collaborate through `send_message` and the shared task list. Send targeted follow-ups when evidence conflicts, a task needs clarification, or a result is incomplete.
4. Accept or reject each result based on its evidence. Reassign rejected work instead of silently using it.
5. After synthesis, send each teammate a `shutdown_request`, then delete the team.

Read-only teammates have a positive execution allowlist. They can inspect the checkout and coordinate, but cannot run shell commands, edit files, save memory, create schedules, invoke arbitrary deferred tools, or spawn agents. This is enforced by the runtime, not only by this prompt.

Keep the run bounded: use one teammate for a narrow task and no more than three for this preview. Give every task an objective, scope, completion condition, and required evidence. If changes are needed, the leader makes them after accepting the investigation results.

The existing Agent View tabs show teammate conversations, messages, status, and approvals. Do not create another roster or session UI. These teammates run inside the leader process; do not describe them as independent processes, persistent sessions, PTY workers, or heterogeneous CLIs.

Return the outcome, material evidence or disagreements, changes made by the leader, verification, and remaining risks.
