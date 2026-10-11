# Agent Identity & Team Coordination Projection (PR 13902 / #13785)

- [中文版](./2026-10-11-agent-team-identity-projection.zh-CN.md)

## Problem

A multi-agent session's output was unattributable on the ACP/daemon wire. Two distinct collaboration columns existed in the runtime with no identity dimension:

1. **Subagent delegation** (parent spawns child): the runtime already projected thought/tool/message frames, but nothing named which agent produced them. After a reload the `task_execution` tool result carried `subagentName`, yet the transcript frames did not.
2. **Agent Teams** (peer teammates): teammate reports and roster changes entered the leader's background notification queue as flat text. Persistence dropped the producer entirely, replay had no identity to restore, and the Web Shell rendered anonymous rows.

## Design

### Single identity shape, two kinds

Every projected frame can carry `_meta.agent` (SDK transcript block: `block.agent`):

```ts
interface AgentIdentity {
  agentName: string; // path-style: /root, /root/security
  depth: number; // 0 root, 1 direct child/teammate
  kind: 'root' | 'subagent' | 'teammate';
}
```

The shape mirrors OpenAI's Responses multi-agent contract (per-item `agent: { agent_name }` with path names) under the repo's borrow-shape-not-spelling rule — camelCase field names, native `_meta` placement. `kind` distinguishes the two columns: subagent identity derives from the `task_execution` display (replay) or the live spawn (wire); teammate identity is minted at the enqueue site from the report sender or roster member.

### Subagent column

- **Live**: the ACP bridge stamps `_meta.agent` on every subagent-projected frame (thought, message, tool call, tool call update).
- **Reload**: `transcript-replay.ts` rebuilds identity from the persisted `task_execution` display (`subagentName` → `/root/<type>`, `kind: 'subagent'`). Root-parented only — the persisted record carries no lineage beyond its type name.

### Teammate column

- **Reports & roster changes** enqueue as `kind: 'peer'` background notifications with `agent` (producer) and `label` (sender name, rendered on the turn marker). Persistence keeps them inside `backgroundTask.agent`; replay hoists that to frame-level `_meta.agent`, so live and reloaded frames share one shape and the SDK reducer's `block.agent` path works identically.
- **Activity & inter-agent messages** are a separate, display-only projection (new in this PR):
  - The `TeamManager` event bridge already observed every teammate tool call/result — and discarded them as activity heartbeats. A new `TEAMMATE_ACTIVITY` event forwards `{name, toolName, phase, description, success}`.
  - The team sink also subscribes to `MESSAGE_SENT` (`{from, to, message}`) — both directions, including teammate→teammate.
  - The session publishes both as `agent_message_chunk` frames with `_meta.source = 'teammate_activity'`, **without entering the notification queue and without persistence**. Rationale: activity is observational — every queued peer item wakes the leader into an automatic turn (one model round per event), and 20+ tool events per teammate turn would drown the queue. The report a teammate eventually sends is what the transcript must keep; per-tool activity is ephemeral by the same logic the PR already applied to status/idle events.
  - Direction follows OpenAI's `agent_message`: the frame's `agent` names the **recipient** (`/root` when addressed to the leader), and the structured `backgroundTask.author` carries the sender (`/root`, depth 0, `kind: 'root'` for the leader). `toolName`/`phase`/`success` ride the same structured payload.

### Web Shell

- Peer notices render as system bubbles with a `@name` chip derived from `block.agent` (teammate kind only).
- `teammate_activity` frames classify as attributed notices rather than leader text; direction reads from the prose (`writer → researcher: …`), the recipient chip carries attribution, and the wire's `author` field serves programmatic consumers. (A `from @x` sender chip was tried and removed — it restated the prose.)

## Decisions

1. **`block.agent` is the single source of truth** for peer attribution — not text parsing, not a parallel `data.agent` key (an earlier local variant was dropped in favor of the remote prop design).
2. **Activity never wakes the leader and never persists.** Both are deliberate: queue semantics make every peer item an automatic-turn trigger, and the transcript's job is durable reports, not per-tool noise.
3. **Ephemerality is documented, not hidden** — reload keeps reports/roster rows attributed; activity rows vanish. The follow-up list records a persisted per-teammate summary as a candidate refinement.
4. **Same-instance manager re-notification is a no-op** in the sink: `Config.setTeamManager` fires change callbacks even for the identical object, and re-registering the five listeners would double approvals and leak on detach (review finding, fixed with a regression test).

## Known gaps (follow-ups, not this PR)

- CJK teammate names collapse in `sanitizeName` (pre-existing main behavior): `研究员` sanitizes to empty and the model retries with ASCII. Identity projection itself handles non-ASCII paths fine (verified with pinyin names + Chinese message content).
- Per-teammate persisted activity summary; teammate color usage; collapsed activity grouping (industry survey: Claude Code folds idle rows, LangGraph density slider, ChatGPT Active/Done panels — nobody streams flat tool rows into the main view).

## Acceptance

- Unit: cli Session (1215) / team-sink (11); web-shell adapter (233) + SystemMessage (71); sdk agent-identity (13); acp-bridge transcript-replay (153); core team (356).
- E2E: `.qwen/e2e-tests/pr13902-teammate-activity-projection.md` — live daemon runs covering multi-teammate attribution, activity without leader wake, structured direction (recipient+author), Chinese content, reload attribution.
