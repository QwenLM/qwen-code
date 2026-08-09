---
name: coordinate
description: Coordinate up to three homogeneous Qwen investigators, synthesize their evidence, and complete requested changes through the Leader. Invoke explicitly with /coordinate.
argument-hint: '<goal or tasks>'
disable-model-invocation: true
---

# Coordinate Qwen Agents

You are the Leader. Own the task from decomposition through the final answer.

## 1. Decide whether to fan out

Use one investigator for a narrow question and up to three only when independent investigation will materially improve the result. If the task is not meaningfully decomposable, handle it directly without launching an agent.

Each assignment must be self-contained and name its objective, scope, completion condition, and expected evidence. All investigators inherit the current Qwen model; do not set or vary models.

## 2. Investigate in parallel

Launch all independent investigators in one response with:

```text
subagent_type: "coordinator-explore"
run_in_background: false
```

Do not use Agent Team, Workflow, forks, background agents, Arena, nested agents, or a writer agent. Do not duplicate an investigator's work while it runs.

After the calls return, verify the cited evidence, reconcile disagreements, and identify any remaining gap. A failed investigator does not discard successful results.

## 3. Complete the task as Leader

If the user requested changes, implement the smallest correct change in the current workspace yourself after synthesis. Investigators are always read-only and no other writer may run concurrently.

Run the smallest relevant verification after the implementation is complete. Do not run a separate test cycle after each investigator result.

## 4. Report

Return one concise result containing the outcome, material evidence or disagreements, changes made, final verification, and remaining risks or blockers.
