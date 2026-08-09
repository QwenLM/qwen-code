---
name: coordinate
description: Coordinate up to three homogeneous Qwen agents, synthesize their evidence, and complete requested changes through one Leader. Invoke explicitly with /coordinate.
argument-hint: '<goal or tasks>'
disable-model-invocation: true
---

# Coordinate Qwen Agents

You are the Leader. Own decomposition, admission, evidence review, source-workspace writes, verification, and the final answer.

## 1. Choose the smallest execution path

Use the foreground path for ordinary parallel investigation. Use durable Agent View coordination only when the user asks for background/reconnectable work, reassignment, or an isolated writer. If the task is not meaningfully decomposable, handle it directly.

All agents must use the current Qwen model. Use one agent for a narrow question and at most three agents total. Never use Agent Team, Workflow, Arena, heterogeneous models, or nested delegation.

## 2. Foreground investigation

Give every investigator a self-contained objective, scope, completion condition, and expected evidence. Launch all independent investigators in one response with:

```text
subagent_type: "coordinator-explore"
run_in_background: false
```

Investigators are read-only. After they return, verify cited evidence, reconcile disagreements, and identify any gap. Do not duplicate their work while they run. A failed investigator does not discard successful results.

If changes are requested, implement the smallest correct change in the current workspace yourself. The Leader remains the only writer.

## 3. Durable Agent View coordination

Create one concise task file per assignment under `.qwen/coordination-tasks/`. Do not put secrets in a task file. Each file must state the objective, allowed scope, completion condition, and required evidence.

Dispatch one to three tasks atomically. Use `--task` for read-only investigators and at most one `--writer` for an isolated implementation attempt:

```bash
qwen agent-view dispatch --task <absolute-task-file> --task <absolute-task-file> --json
qwen agent-view dispatch --task <absolute-task-file> --writer <absolute-task-file> --json
```

Preserve the full IDs from the acknowledgement. Collect only with the full coordination ID:

```bash
qwen agent-view collect <full-coordination-id> --json
```

Managed coordination attempts are one-shot. Inspect state or retained output with:

```bash
qwen agent-view peek <session-id>
qwen agent-view logs <session-id>
```

Do not use `send`, `answer`, `attach`, or generic `respawn` for a managed attempt; those commands fail closed because a headless attempt has no interactive continuation consumer. If the latest attempt is `handback`, failed, or stale, reassign the same task instead of erasing its lineage:

```bash
qwen agent-view reassign <full-coordination-id> <full-task-id> --task <absolute-task-file> --json
```

Never treat `checkout_changed` as current evidence. A writer result is an ownership receipt, not an automatic merge. Review the returned worktree diff and base commit, then apply only the accepted changes to the source workspace as Leader. Never delete a preserved dirty worktree on the user's behalf.

## 4. Finish once

Verify the accepted evidence and the complete final diff. Run the smallest relevant verification after implementation is complete, not after every agent result.

Return one concise result containing the outcome, material evidence or disagreements, source changes, verification, preserved writer receipts, and remaining risks or blockers.
