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

The first layer establishes this shared shape and the subagent producer. This second layer adds the teammate producer for reports, roster notices and approvals.

- Live tracking stamps thought, message, tool-call and update frames with the resolved runtime `start` name, preserving definition casing.
- Replay rebuilds `/root/<type>` with depth 1 from validated `task_execution` display names. Blocked raw names and invalid path segments remain unattributed; admitted failed, cancelled and background results keep their identity.
- The SDK carries identity through normalization and transcript reduction, including results that backfill an initially unattributed tool block. Live journal compaction accepts the agent stamp.
- The Web Shell exposes the path on the subagent panel name's `title` tooltip.

## Decisions and constraints

`agentName` is a readable role path, not a unique execution ID. Concurrent subagents of one type share it; consumers distinguish executions using `parentToolCallId`. Persisted results contain no lineage beyond the type name, so replay reconstructs only root-parented identities. Foreground nested-frame projection and persisted lineage remain separate work.

## Acceptance

Paired tests cover live canonical names, default identity, replay name/status boundaries, SDK normalization and backfill, journal compaction and the tooltip without a visible path chip. Tests, typechecks and builds must be rerun on this split commit; historical PR results do not validate this new candidate.

## Team coordination

This second layer consumes the shared identity contract. The ACP Team sink attaches to the current TeamManager and forwards durable reports and roster joins/exits through the existing peer notification queue. Sender attribution uses canonical names, validated identities survive recording and replay, and the Web Shell names the teammate on report, roster and correlated turn-start rows. Membership notices share the same delivery and durability path as reports; status/idle pulses do not enter the sink.

Teammate approval requests reach the host directly, independently of the leader permission queue. Each request has a UUID and session scope; session lifetime, binding epochs, manager replacement and teammate exit retire stale requests. Host request failure is distinguished from a failed post-answer teammate response, and bridge ownership policy controls the session boundary.

Peer reports keep work pending while undrained. Reversible close, queue overflow and shutdown flushing preserve undelivered reports, and repeated flushing does not record duplicates. Cold recording and warm notification envelopes retain peer semantics, XML escaping, rewind and recovery behavior. Team deletion emits remaining member exits.

## Decisions and constraints

The Team sink depends on the shared identity shape, not the subagent runtime. This layer registers approval, joined and exited listeners; re-notifying the same manager must not duplicate them. Reports and roster notices may wake the leader and are persisted; per-tool progress is excluded from this layer.

## Acceptance additions

Included tests cover delivery, persistence, reversible close, overflow, flush idempotence, roster, canonical sender attribution, approval policy and lifecycle, host ownership, rewind/recovery and UI attribution. The new split still requires test, typecheck and build execution; none is claimed by this design document.

## Following layer

The third layer adds display-only teammate tool activity and inter-agent message direction. It will add two listeners and keep those ephemeral frames outside the durable peer queue.
