---
name: coordinate
description: Coordinate a small team of Qwen Code teammates with enforced read-only workers, an optional worktree-pinned writer, shared tasks, peer messages, and existing Agent View tabs. Invoke explicitly with /coordinate.
argument-hint: '<goal>'
disable-model-invocation: true
---

# Coordinate Qwen Code Teammates

Act as the team leader. Decompose the goal, keep task ownership clear, reconcile disagreements, and deliver the final result.

## Build one bounded team

When `team_create` is available:

1. Create one team and one self-contained task per current investigation workstream. Do not queue an implementation task while read-only teammates are idle because tasks are auto-assigned.
2. Spawn named investigation teammates with `read_only: true` — one per workstream, and prefer three at most. Never exceed the team's configured cap, which `team_create` reports; spawning past it fails outright. Do not pass `model`; use the session-default model unless the selected agent definition explicitly overrides it.
3. Assign tasks and let teammates collaborate through `send_message` and the shared task list. Send targeted follow-ups when evidence conflicts, a task needs clarification, or a result is incomplete.
4. Accept or reject each result based on its evidence. Reassign rejected work instead of silently using it.

Read-only teammates have a positive execution allowlist. They cannot use shell, edit or write files, save memory, create schedules, invoke arbitrary deferred tools, or spawn agents. This is enforced by the runtime, not only by this prompt.

## Pin the only writer to a worktree

When the goal requires code changes:

1. Finish the parallel investigation first.
2. Call `request_shutdown` for each investigation teammate. Once shutdown is pending, they are excluded from automatic task assignment.
3. Call `enter_worktree` once and keep the returned path.
4. Create the implementation task, then spawn exactly one named writer with `subagent_type: "general-purpose"` and `working_dir: <path>`. Do not set `read_only` for this teammate.
5. Give the writer the accepted investigation evidence and require all changes to stay inside the worktree.
6. Review and verify the worktree result. The leader alone decides whether and how to integrate it into the current branch.
7. Do not remove the worktree until accepted changes have been integrated or deliberately discarded.

If the checkout is not a Git repository or worktree creation fails, keep all teammates read-only and let the leader make the final change in the current checkout.

After synthesis, call `request_shutdown` for each still-active teammate, then delete the team.

The existing Agent View tabs show teammate conversations, messages, status, and approvals. Do not create another roster, session manager, or terminal UI.

If the Agent Team tools are unavailable, say that `experimental.agentTeam` must be enabled and Qwen Code restarted. Ordinary subagents are an acceptable fallback for parallel research, but describe them accurately: they report only to the leader and cannot collaborate as a team.

## Keep coordination bounded

- Use one teammate for a narrow task. Past roughly three, the leader spends more of its turn reconciling reports than doing the work, so add a fourth only when the workstreams are genuinely independent — and never past the configured cap.
- Give every task an objective, scope, completion condition, and required evidence.
- Default every teammate to `read_only: true`; add one worktree writer only when implementation is required.
- Do not use Arena: it is for competing solutions to the same task, not collaboration on different tasks.
- Do not claim that in-process teammates are independent PTY sessions or heterogeneous CLIs.
- Finish implementation before running the smallest relevant verification once.

Return the outcome, material evidence or disagreements, changes made by the leader, verification, and remaining risks.
