# Native Multi-Agent Coordination

## Motivation

Qwen Code already supports one-shot subagents, but users who want several
independent investigations must manually split the work and combine the
results. The first product entry should make that path direct without requiring
the experimental persistent Agent Team runtime.

## Design

`/coordinate <goal>` is an explicit bundled workflow. The current session is
the Leader. It launches one to three independent investigators in one tool
round, waits for their results, reconciles their evidence, and completes any
requested edits itself.

Every investigator uses the reserved `coordinator-explore` profile. The profile
inherits the Leader's current model and exposes only the canonical repository
read tools: file read, grep, glob, and directory listing. Agent validation
requires these launches to be top-level and foreground, and rejects model
overrides, Team names, plan-required teammates, and alternate workspaces.

The bundled workflow grants no session permissions. Normal permission policy
therefore remains authoritative, including for reads outside the workspace.
Both skill and slash-command resolution reserve `coordinate`, and subagent
resolution reserves `coordinator-explore`, so project, user, extension, or
session configuration cannot replace the trusted definitions.

## Boundaries

The Leader remains the only writer. This version does not add persistent teams,
background investigators, inter-agent messaging, transcript sharing,
heterogeneous model selection, worktree merging, or automatic fan-out for
ordinary prompts. Those capabilities require separate product evidence.

## Verification

Focused tests cover the canonical read-only tool set, reserved resolution,
forbidden launch parameters, bundled workflow contract, and slash-command
collision handling. Core and CLI typechecks and builds provide the final
integration check.
