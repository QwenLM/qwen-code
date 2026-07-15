# Agent observability & remote drive — design (2026-07-14)

Wire the fork's existing hooks and agent-runtime systems into
rc-gateway so remote clients can observe and drive background agents
and receive hook events. Approved approach: **B — agents-as-sessions**
(chosen over A: daemon-side extension, and C: hybrid; see
Alternatives).

Spec-first: this ships as the 19th OpenSpec change,
`add-agent-observability`, in the qwen-code-remote repo, registering
all new SSE events and audit actions in the authoritative registries
before implementation.

## Scope decisions (user-confirmed)

- **Observe + drive agents**: remote clients can spawn, steer, and
  cancel background agents (scope-gated) and see lifecycle/progress.
- **Hook events are read-only**: mirrored to remote clients; hook
  _configuration_ stays local-only. No remote hook CRUD — remote hook
  editing would grant arbitrary code execution on the workstation.
- **Full notification routing**: agent lifecycle events are routable
  notification kinds through existing routing rules, quiet hours, and
  bridges.

## Architecture

Every background agent **is a daemon session**, tagged with agent
metadata in a gateway-local registry. The gateway drives agents
through the wire protocol it already owns; the Stage 1 daemon remains
unmodified (preserves the Phase G transparent-proxy boundary).

Because an agent is a session, fifteen existing subsystems apply with
zero new per-subsystem code: WAL replay, presence, permission voting
(remote approval of a blocked agent's tool call works out of the box),
cost tracking, FTS5 search, forking, scope enforcement, audit.

### Control plane

| Endpoint                                                           | Scope   | Behavior                                                                                             |
| ------------------------------------------------------------------ | ------- | ---------------------------------------------------------------------------------------------------- |
| `POST /rc/agents` `{ task, agentType?, parentSessionId?, model? }` | `write` | Create daemon session via SDK → register agent → send task prompt. Returns `{ agentId, sessionId }`. |
| `GET /rc/agents?status=&parent=`                                   | `read`  | Registry listing with status, parent link, cost rollup.                                              |
| `GET /rc/agents/:id`                                               | `read`  | Detail view.                                                                                         |
| `POST /rc/agents/:id/message` `{ content }`                        | `write` | Steer: proxies to the agent session's prompt endpoint (runtime injects as `external_message`).       |
| `POST /rc/agents/:id/cancel`                                       | `write` | Proxies to `/session/:id/end`; marks record `cancelled`.                                             |

### Observation

`GET /session/:id/events` on the agent's own session — unchanged.
Lifecycle SSE events (to be registered in the wire-protocol SSE
registry): `agent_spawned`, `agent_completed`, `agent_failed`,
`agent_blocked`, `agent_cancelled`. Emitted on the **parent session's
stream** (when a parent exists) and on the owner events stream.
Payload: `{ agentId, sessionId, parentSessionId, agentType, task,
status, costMicrocents? }`.

### Notifications

The five lifecycle events become routable notification kinds through
existing routing rules and bridges. `agent_blocked` is a candidate
critical kind (quiet-hours bypass).

### Hook event mirror

Core's existing HTTP hook runner is configured — docs plus a generated
config snippet, no daemon code change — to POST hook firings to
`POST /rc/hooks/ingest` (loopback-only, dedicated ingest token). The
gateway mirrors them as read-only `hook_event` frames on the **owner
events stream only** — hook payloads contain tool arguments, too
sensitive for `read`-scope session streams.

## Components

All new code in `packages/rc-gateway/src/agents/` (plus two route
files).

### `agentRegistry.ts`

Persisted registry, JSON file store (same pattern as `tokenStore.ts`).

```ts
interface AgentRecord {
  agentId: string; // uuid
  sessionId: string; // the daemon session backing this agent
  parentSessionId: string | null;
  agentType: string; // 'general' | subagent-manager name
  task: string; // spawning prompt, truncated to 2k chars
  status:
    | 'running'
    | 'blocked'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'orphaned';
  spawnedByTokenId: string;
  subActor?: string; // if spawned via a bridge
  spawnedAt: string;
  finishedAt: string | null;
}
```

Cost is **not** stored — computed at read time from the existing cost
tables keyed by `sessionId` (one source of truth).

### `agentLifecycle.ts`

Subscribes to the agent's session events through the gateway's own
event plumbing (not a second daemon connection). Transitions:

- `session_died` → `failed`
- terminal prompt completion → `completed`
- outstanding `permission_request` → `blocked`; resolved → `running`

Emits the five lifecycle frames and hands each to the notification
pipeline as a routable kind.

### `routes/agents.ts`

The five endpoints. Spawn is a saga: create session → register → send
prompt; if the prompt send fails, the session is ended and the record
marked `failed` — no half-spawned agents.

### `routes/hookIngest.ts`

`POST /rc/hooks/ingest`: loopback-bind check + dedicated ingest token
(minted once on first startup and persisted — regenerating per start
would invalidate existing hook config — written 0600 next to the
bootstrap code; the docs snippet interpolates it into hook config). Validates envelope
`{ event, sessionId?, toolName?, payload }`; mirrors as `hook_event`
owner-stream frames; token-bucket rate limit that **drops** on
overflow (dropped count surfaced in the next mirrored frame) rather
than 429-ing the hook runner.

### Audit actions

Registered in the pairing-auth extension registry: `agent_spawned`,
`agent_message_sent`, `agent_cancelled`, `hook_ingest_rejected`.

### Reconciliation

On gateway startup, records with status `running`/`blocked` are
checked against live daemon sessions; missing ones become `orphaned`
(surfaced in `GET /rc/agents`, never silently dropped).

## Data flow (spawn → notification, happy path)

1. Remote client `POST /rc/agents`.
2. Gateway creates daemon session (SDK), registers `AgentRecord`,
   sends task prompt.
3. `agent_spawned` emitted on parent stream + owner stream; audit row.
4. Agent runs; tool approvals surface as ordinary
   `permission_request` frames on its own session.
5. Terminal completion: `agentLifecycle` marks the record, emits
   `agent_completed` with cost rollup, hands to notification router.
6. Routing rules decide push/bridge delivery per existing config.

## Error handling

| Failure                              | Behavior                                                          |
| ------------------------------------ | ----------------------------------------------------------------- |
| Session create fails at spawn        | 502 `daemon_unavailable`, nothing registered                      |
| Prompt send fails after create       | Session ended, record `failed`, 502 — no zombie sessions          |
| Daemon dies mid-run                  | `session_died` → record `failed`, `agent_failed` emitted + routed |
| Gateway restarts                     | Reconciliation pass; unreachable running agents → `orphaned`      |
| Hook ingest bad token / non-loopback | 401/403, `hook_ingest_rejected` audit row, never mirrored         |
| Hook ingest flood                    | Token-bucket drop; dropped count surfaced in next mirrored frame  |
| Cancel / steer on terminal agent     | 409 `agent_not_running`                                           |

## Threat model

| Attacker                                             | Capability                                       | Mitigation                                                                                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compromised `read` token                             | Wants to spawn/steer agents (act on workstation) | Spawn/steer/cancel require `write`; `read` observes only                                                                                                   |
| Hook-ingest spoofer (LAN process)                    | Inject fake hook frames to mislead owner         | Loopback-only bind check + dedicated ingest token (0600 file); rejects audited                                                                             |
| Compromised `write` token                            | Spawn runaway agents (cost burn)                 | Every spawn audited with tokenId/subActor; cost rollup visible per agent; owner revocation ends it; (per-token spawn quota deferred — record as follow-up) |
| Registry poisoning via crash timing                  | Orphan records masking live agents               | Reconciliation on startup marks unreachable agents `orphaned`, never deletes                                                                               |
| Sensitive hook payloads leaking to low-scope clients | Read tool args via session stream                | `hook_event` mirrored on owner stream only                                                                                                                 |

## Alternatives considered

- **A: Daemon-side extension** — patch core so agent-runtime events
  land on the daemon's SSE and add daemon control endpoints. Rejected:
  breaks the unmodified-Stage-1 boundary the whole gateway topology is
  built on; every upstream merge carries the patches; duplicates
  auth/scope logic.
- **C: Hybrid** — B's control plane plus a minimal daemon patch for
  native agent tagging. Rejected: still breaks the boundary for
  marginal tagging benefit.

## Testing

Vitest, existing stub-daemon pattern:

- **Registry**: persistence round-trip; reconciliation against stub
  session list; orphan marking.
- **Routes**: spawn saga success + both failure legs; scope
  enforcement (`read` cannot spawn); list filtering; cancel/steer 409s.
- **Lifecycle**: stub SSE feed → status transitions → correct frames;
  blocked↔running flapping.
- **Hook ingest**: auth rejection; envelope validation; rate-limit
  drop counting; owner-only mirroring.
- **Integration**: spawn → observe frames → cancel against the stub
  daemon.

## Spec artifacts (qwen-code-remote)

`openspec/changes/add-agent-observability/` with:

- `proposal.md` — why, what changes
- `design.md` — this design, with Alternatives and the threat-model
  table (config.yaml rules)
- `specs/agent-observability/spec.md` — requirements with scenarios;
  spec deltas registering the 5 SSE events in the wire-protocol
  registry and 4 audit actions in the pairing-auth extension registry
- `tasks.md` — phased tasks with Status/Prompt fields per config.yaml

## Follow-ups (out of scope)

- Per-token agent-spawn quota (noted in threat model)
- Deterministic workflow scripting layer over this control plane
- Agent teams / peer messaging
