# Agent Identity Projection (PR 13902 / #13785)

- [中文版](./2026-10-11-agent-team-identity-projection.zh-CN.md)

## Problem

Subagent thought, message and tool frames lack a producer identity on the ACP/daemon wire. Persisted `task_execution` results retain `subagentName`, but replay does not restore it to transcript frames.

## Design

Every projected frame can carry `_meta.agent`; the SDK preserves it as `block.agent`:

```ts
interface AgentIdentity {
  agentName: string;
  depth: number;
  kind: 'root' | 'subagent' | 'teammate';
}
```

This shared shape reserves the teammate kind for the next change. This layer implements the subagent producer and its consumers only.

- Live tracking stamps thought, message, tool-call and update frames with the resolved runtime `start` name, preserving definition casing.
- Replay rebuilds `/root/<type>` with depth 1 from validated `task_execution` display names. Blocked raw names and invalid path segments remain unattributed; admitted failed, cancelled and background results keep their identity.
- The SDK carries identity through normalization and transcript reduction, including results that backfill an initially unattributed tool block. Live journal compaction accepts the agent stamp.
- The Web Shell exposes the path on the subagent panel name's `title` tooltip.

## Decisions and constraints

`agentName` is a readable role path, not a unique execution ID. Concurrent subagents of one type share it; consumers distinguish executions using `parentToolCallId`. Persisted results contain no lineage beyond the type name, so replay reconstructs only root-parented identities. Foreground nested-frame projection and persisted lineage remain separate work.

## Acceptance

Paired tests cover live canonical names, default identity, replay name/status boundaries, SDK normalization and backfill, journal compaction and the tooltip without a visible path chip. Tests, typechecks and builds must be rerun on this split commit; historical PR results do not validate this new candidate.

## Following layers

The next layer adds durable Team reports, roster notices and session-scoped approvals. A third layer adds display-only teammate activity and inter-agent message direction. Neither behavior is delivered by this layer.
