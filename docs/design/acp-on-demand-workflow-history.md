# Load ACP workflow history on demand

[English](acp-on-demand-workflow-history.md) | [简体中文](acp-on-demand-workflow-history.zh-CN.md)

## Problem and goal

ACP waits for interrupted-run recovery and reads every retained workflow snapshot before constructing a session. This applies to ordinary `qwen serve` session creation, including workspaces where workflow controls are disabled. A plain prompt needs neither the recovery scan nor the snapshot list. Remove both from session admission and keep interrupted runs discoverable and actionable.

## Design

- Start bulk recovery on the first authorized workflow-inclusive tasks request for each session. Concurrent first reads in one ACP agent share an in-progress recovery for the same workflow store directory. A new ACP agent starts with fresh state. Mark the session after the recovery call resolves. A thrown recovery failure is logged and the next request retries.
- Read and merge snapshots with the existing per-session refresh after recovery. Each refresh tracks its own deletion order, including deletions broadcast by sibling sessions. This preserves live and settling runs and prevents a shared stale snapshot result from replaying a deleted entry.
- Keep retry and rerun's existing per-run recovery. Delete requests claim the requested run before taking the existing mutation lock, so a caller can delete a checkpoint-only run before its first history query. The existing live-run guards and snapshot membership checks still decide whether deletion can proceed.
- The workflow-inclusive tasks request keeps its workflow availability and workspace trust gates. The request can come from the Tasks or Workflow Runs views or from polling after background task activity. Plain tasks requests and text-only first prompts need no workflow history.

Production changes are limited to `packages/cli/src/acp-integration/acpAgent.ts`. Daemon routes, request and response schemas, snapshot formats, and TUI startup have the same contracts.

## Tradeoffs and acceptance

The first workflow-inclusive request now pays the recovery cost. This query can trigger the existing maintenance writes, which record an interrupted run as failed, remove its checkpoint, and apply snapshot retention. A session that never requests this history leaves orphaned checkpoints on disk until a workflow-aware request, a targeted action, or another existing recovery entry point processes them. A later session's first workflow-inclusive request can discover checkpoints from a process that exited after an earlier session's scan. The recovery state lives in memory per ACP agent.

Verify zero recovery and snapshot reads during ordinary ACP session creation and a plain tasks request. Exercise concurrent workflow-inclusive requests, retry and deletion by ID before listing, live writer protection, and workspace isolation. Alternate fresh daemon processes from the same source base with zero and 30 snapshots for one and seven workspaces. Time session creation, prompt acceptance, and the mock provider's receipt of the first prompt. Record the cost of the first workflow history request and the host and filesystem conditions.
