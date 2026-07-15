# Agent Observability & Remote Drive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let remote clients spawn, observe, steer, and cancel background agents through rc-gateway (agents-as-sessions, approach B of the design doc), mirror local hook firings as read-only owner-stream frames, and route the five agent lifecycle events through the existing notification pipeline — shipped spec-first as OpenSpec change `add-agent-observability`.

**Architecture:** Every background agent IS a daemon session created via the SDK (`sessionScope: 'thread'`), tagged in a gateway-local JSON-file `AgentRegistry`. An `AgentLifecycle` component subscribes to the gateway's existing `SessionEventPump` plumbing (no second daemon connection) and drives status transitions, emitting lifecycle frames on the parent session's SSE stream (`PromptEventBroadcaster`), the owner events stream (`OwnerEventBus`), and the push notification pipeline (`PushNotifier`). Hook events arrive via a loopback-only `POST /rc/hooks/ingest` guarded by a persistent ingest token and a drop-on-overflow token bucket.

**Design doc (authoritative — do not deviate):** `/home/evan/projects/qwen-code/docs/superpowers/specs/2026-07-14-agent-observability-design.md`

**Tech Stack:** Node 22, TypeScript ESM (`.js` import suffixes), Express, vitest, `@qwen-code/sdk` `DaemonClient`.

## Global Constraints

- **Two repos.** Part A (Tasks 1–4) edits `/home/evan/projects/qwen-code-remote` (OpenSpec docs). Part B (Tasks 5–13) edits `/home/evan/projects/qwen-code` (the fork), package `packages/rc-gateway`, branch `add-remote-control-spec`.
- **License header.** EVERY new `src/**/*.ts` file in the fork MUST start with exactly:
  ```ts
  /**
   * @license
   * Copyright 2025 Qwen Team
   * SPDX-License-Identifier: Apache-2.0
   */
  ```
- **Node:** v22 (`node --version` → v22.x). ESM only; all relative imports end in `.js`.
- **Test command** (rc-gateway is NOT in the root vitest `projects` array — always run from the package dir):
  ```
  cd /home/evan/projects/qwen-code/packages/rc-gateway && npx vitest run
  ```
  Single file: `cd /home/evan/projects/qwen-code/packages/rc-gateway && npx vitest run src/<path>.test.ts`
- **Branch discipline (fork).** Work directly on `add-remote-control-spec` (`git -C /home/evan/projects/qwen-code checkout add-remote-control-spec`). The working tree may contain unrelated dirty files: stage ONLY files you created/modified yourself (`git add packages/rc-gateway/src/<file>`), NEVER `git add -A`, `git add .`, or `git checkout .`.
- **Branch discipline (spec repo).** In `/home/evan/projects/qwen-code-remote`, create branch `add-agent-observability` off `main` before Task 1; commit there.
- **Commit conventions:** `feat(rc-gateway): ...` for fork code, `docs(specs): ...` for the spec repo.
- **Endpoint prefixes** (spec repo `openspec/conventions.md`): session-independent control-plane resources are `/rc/*`. All five agent endpoints and the hook ingest endpoint live under `/rc/*`.
- **Naming** (conventions.md §2): SSE event types and audit actions are `snake_case` (`agent_spawned`); JSON body/response fields are `camelCase` (`agentId`); notification-routing kinds follow the existing dot convention in `KIND_SCOPE` (`agent.spawned`, matching `permission.required`).
- **Scopes:** spawn/steer/cancel require `write` (`WRITE` constant), listing/detail require `read` (`SESSION_READ` constant `'session:read'`). `requireScope` resolves implications transitively (`owner ⊃ write ⊃ session:read`).
- **Never audit or log** task/prompt/message content or hook payloads. Audit rows carry ids and metadata only (mirror `prompt_sent`, which audits `blocks: blocks.length`, never text).

---

## Part A — OpenSpec change authoring (`/home/evan/projects/qwen-code-remote`)

### Task 1: Change skeleton — `proposal.md` and `design.md`

**Files:**

- Create: `openspec/changes/add-agent-observability/proposal.md`
- Create: `openspec/changes/add-agent-observability/design.md`

**Interfaces:**

- Consumes: the approved design doc `/home/evan/projects/qwen-code/docs/superpowers/specs/2026-07-14-agent-observability-design.md` (copy/adapt its content — do not invent new architecture).
- Produces: the change directory that Tasks 2–4 add `specs/` and `tasks.md` into. Downstream tasks cite requirement names defined in Task 2.

- [ ] **Step 1: Create the branch**

```bash
cd /home/evan/projects/qwen-code-remote
git checkout main
git checkout -b add-agent-observability
mkdir -p openspec/changes/add-agent-observability/specs/agent-observability
```

- [ ] **Step 2: Write `proposal.md`**

Follow the section shape of `openspec/changes/add-idle-suggestions/proposal.md` (`## Why`, `## What Changes`, `## Capabilities`, `## User Stories`, `## Impact`). Content (write in full, adapting the design doc — this is the required substance, not a template to leave hollow):

```markdown
# add-agent-observability

## Why

qwen-code's fork already runs background agents and local hooks, but a
remote client attached through rc-gateway is blind to them: it cannot
see that an agent is running, cannot approve a blocked agent's tool
call from a phone, cannot cancel a runaway agent, and never learns
that a hook fired. The gateway already owns sessions, permission
voting, cost tracking, audit, and notification routing — agents and
hooks are the two subsystems that never crossed the wire.

## What Changes

- **Agents-as-sessions control plane.** Five new `/rc/agents*`
  endpoints (spawn / list / detail / steer / cancel). Every background
  agent is an ordinary daemon session created via the SDK and tagged
  in a gateway-local registry, so WAL replay, presence, permission
  voting, cost tracking, search, scope enforcement, and audit all
  apply with zero per-subsystem code. The Stage 1 daemon stays
  unmodified (transparent-proxy boundary preserved).
- **Five lifecycle SSE events** — `agent_spawned`, `agent_completed`,
  `agent_failed`, `agent_blocked`, `agent_cancelled` — emitted on the
  parent session's stream (when a parent exists) and on the owner
  events stream, and registered in the wire-protocol SSE registry.
- **Full notification routing.** The five lifecycle events become
  routable notification kinds (`agent.spawned` … `agent.cancelled`)
  through existing routing rules, quiet hours, and bridges;
  `agent.blocked` is a critical kind (quiet-hours bypass).
- **Read-only hook mirror.** Core's existing HTTP hook runner is
  configured (docs + generated config snippet, no daemon code change)
  to POST hook firings to `POST /rc/hooks/ingest` (loopback-only,
  persistent dedicated ingest token). The gateway mirrors them as
  `hook_event` frames on the owner events stream ONLY. Hook
  configuration stays local-only: no remote hook CRUD, ever — remote
  hook editing would grant arbitrary code execution on the
  workstation.
- **Four new audit actions**: `agent_spawned`, `agent_message_sent`,
  `agent_cancelled`, `hook_ingest_rejected`, registered in the
  pairing-auth registry.

## Capabilities

### New Capabilities

- `agent-observability` — agent registry semantics, the five
  `/rc/agents*` endpoints and their scopes, the spawn saga and
  rollback, lifecycle status machine and SSE events, startup
  reconciliation (orphan marking), hook ingest endpoint (auth,
  envelope, rate limit), notification-kind routing, audit actions.

## User Stories

**A1. Fire and forget from the phone.** I spawn "run the test suite
and fix trivial failures" from my phone (`POST /rc/agents`), lock the
screen, and get a push when the agent completes — with its cost.

**A2. Unblock a stuck agent.** An agent hits a permission prompt. My
phone gets an `agent.blocked` push (bypassing quiet hours), I open the
agent's own session stream, and vote approve — the existing
first-responder permission flow, no new UI contract.

**A3. Kill a runaway.** The cost rollup in `GET /rc/agents` shows one
agent burning tokens. `POST /rc/agents/:id/cancel` ends its session
and the record reads `cancelled`.

**A4. Hook visibility.** My pre-commit hook fires on the workstation;
my owner-scoped dashboard shows the `hook_event` frame in real time.
A `read`-scope share guest never sees it (hook payloads carry tool
arguments).

**A5. Crash honesty.** The gateway restarts while two agents run.
On boot, reconciliation finds their sessions gone and lists both as
`orphaned` — never silently dropped.

## Impact

- **qwen-code fork**: new module `packages/rc-gateway/src/agents/`
  (registry, lifecycle) plus `routes/agents.ts` and
  `routes/hookIngest.ts`; wiring in `server.ts` and `cli.ts`;
  five new SSE event types plus `hook_event`; four new audit actions;
  five new notification kinds.
- **Registries amended** (spec deltas in this change):
  wire-protocol SSE event-type registry (+6 rows), pairing-auth
  audit registry (+4 action rows).
- **Out of scope** (deliberately): remote hook CRUD; per-token
  agent-spawn quota (recorded as follow-up in the threat model);
  deterministic workflow scripting; agent teams / peer messaging.
```

- [ ] **Step 3: Write `design.md`**

Copy the approved design doc's content into the OpenSpec design format used by `add-idle-suggestions/design.md` (`## Context`, `## Goals / Non-Goals`, `## Architecture`, decision sections, `## Threat model`, `## Risks`). It MUST contain, per `openspec/config.yaml` design rules:

1. `## Architecture` — the agents-as-sessions description, the control-plane endpoint table, observation, notifications, and hook-mirror sections copied from the design doc (lines "## Architecture" through "### Reconciliation").
2. `## Alternatives considered` — copy verbatim from the design doc:

```markdown
## Alternatives considered

- **A: Daemon-side extension** — patch core so agent-runtime events
  land on the daemon's SSE and add daemon control endpoints. Rejected:
  breaks the unmodified-Stage-1 boundary the whole gateway topology is
  built on; every upstream merge carries the patches; duplicates
  auth/scope logic.
- **C: Hybrid** — B's control plane plus a minimal daemon patch for
  native agent tagging. Rejected: still breaks the boundary for
  marginal tagging benefit.
```

3. `## Threat model` — copy the design doc's table verbatim (attacker / capability / mitigation columns):

```markdown
## Threat model

| Attacker                                             | Capability                                       | Mitigation                                                                                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compromised `read` token                             | Wants to spawn/steer agents (act on workstation) | Spawn/steer/cancel require `write`; `read` observes only                                                                                                   |
| Hook-ingest spoofer (LAN process)                    | Inject fake hook frames to mislead owner         | Loopback-only bind check + dedicated ingest token (0600 file); rejects audited                                                                             |
| Compromised `write` token                            | Spawn runaway agents (cost burn)                 | Every spawn audited with tokenId/subActor; cost rollup visible per agent; owner revocation ends it; (per-token spawn quota deferred — record as follow-up) |
| Registry poisoning via crash timing                  | Orphan records masking live agents               | Reconciliation on startup marks unreachable agents `orphaned`, never deletes                                                                               |
| Sensitive hook payloads leaking to low-scope clients | Read tool args via session stream                | `hook_event` mirrored on owner stream only                                                                                                                 |
```

4. `## Error handling` — copy the design doc's error table verbatim (Session create fails → 502 `daemon_unavailable`; prompt send fails → session ended + record `failed` + 502; daemon dies → `failed` + `agent_failed`; gateway restart → reconciliation/orphaned; hook bad token/non-loopback → 401/403 + `hook_ingest_rejected`; hook flood → token-bucket drop with dropped count in next frame; cancel/steer on terminal agent → 409 `agent_not_running`).
5. The `AgentRecord` interface exactly as in the design doc (see Task 5 Step 3 of this plan for the canonical TypeScript — the two must be character-identical).

- [ ] **Step 4: Commit**

```bash
cd /home/evan/projects/qwen-code-remote
git add openspec/changes/add-agent-observability/proposal.md openspec/changes/add-agent-observability/design.md
git commit -m "docs(specs): add-agent-observability proposal + design"
```

---

### Task 2: `specs/agent-observability/spec.md`

**Files:**

- Create: `openspec/changes/add-agent-observability/specs/agent-observability/spec.md`

**Interfaces:**

- Consumes: requirement/scenario format of `openspec/changes/add-idle-suggestions/specs/idle-suggestions/spec.md`; rules in `openspec/config.yaml` (RFC 2119 keywords; ≥1 scenario per requirement; wire requirements cite method+path or SSE event type).
- Produces: requirement names cited by Task 4's tasks.md acceptance lines: `Agent spawn`, `Agent listing and detail`, `Agent steer`, `Agent cancel`, `Agent lifecycle SSE events`, `Agent notification routing`, `Hook event mirror`, `Startup reconciliation`, `Agent audit actions`.

- [ ] **Step 1: Write the spec delta**

Write the file with `# agent-observability — spec delta`, `## ADDED Requirements`, and these nine requirements. Every requirement uses MUST/SHALL/SHOULD/MAY and cites method+path or event type. Full content:

```markdown
# agent-observability — spec delta

## ADDED Requirements

### Requirement: Agent spawn

`POST /rc/agents` with body `{ task, agentType?, parentSessionId?,
model? }` SHALL require the `write` scope. The gateway SHALL execute
a saga: (1) create a dedicated daemon session via the SDK
(`sessionScope: 'thread'`), (2) register an agent record with status
`running`, (3) send `task` as the session's first prompt. On success
it SHALL respond `201 { agentId, sessionId }`.

If session creation fails, the gateway SHALL respond
`502 daemon_unavailable` and SHALL NOT register anything. If the
prompt send fails after creation, the gateway SHALL end the session,
mark the record `failed`, and respond `502 prompt_send_failed` — no
half-spawned agents. The stored `task` SHALL be truncated to 2000
characters. `model` maps to the SDK's `modelServiceId`.

#### Scenario: Happy path returns ids and registers running agent

- **GIVEN** a `write`-scope token and a reachable daemon
- **WHEN** the client sends `POST /rc/agents { "task": "run tests" }`
- **THEN** the response is `201` with `agentId` and `sessionId`
- **AND** `GET /rc/agents/:id` shows `status: "running"`

#### Scenario: Session create failure registers nothing

- **GIVEN** the daemon rejects `POST /session`
- **WHEN** the client sends `POST /rc/agents`
- **THEN** the response is `502` with code `daemon_unavailable`
- **AND** `GET /rc/agents` lists no new record

#### Scenario: Prompt-send failure rolls back

- **GIVEN** the daemon accepts session creation but rejects the
  first `POST /session/:id/prompt`
- **WHEN** the client sends `POST /rc/agents`
- **THEN** the gateway ends the created session
- **AND** the record is marked `failed`
- **AND** the response is `502` with code `prompt_send_failed`

#### Scenario: read scope cannot spawn

- **WHEN** a token holding only `session:read` sends `POST /rc/agents`
- **THEN** the response is `403` with code `scope_required`

### Requirement: Agent listing and detail

`GET /rc/agents` SHALL require the `read` scope and return the
registry with optional exact-match filters `?status=` and `?parent=`
(parent session id). `GET /rc/agents/:id` SHALL require the `read`
scope and return one record or `404 agent_not_found`. Both SHALL
include `costMicrocents` computed AT READ TIME from the existing cost
tables keyed by the agent's `sessionId` (one source of truth; cost is
never stored in the registry). When cost tracking is disabled the
field SHALL be absent.

#### Scenario: Status filter

- **GIVEN** one `running` and one `completed` agent
- **WHEN** the client sends `GET /rc/agents?status=running`
- **THEN** only the running agent is returned

#### Scenario: Cost rollup reflects the live cost tables

- **GIVEN** cost tracking is enabled and the agent's session has
  priced usage rows totalling N microcents
- **WHEN** the client sends `GET /rc/agents/:id`
- **THEN** the response carries `costMicrocents: N`

#### Scenario: Unknown agent

- **WHEN** the client sends `GET /rc/agents/nope`
- **THEN** the response is `404` with code `agent_not_found`

### Requirement: Agent steer

`POST /rc/agents/:id/message` with body `{ content }` SHALL require
the `write` scope and proxy `content` as a prompt to the agent's own
session. On a terminal agent (`completed`, `failed`, `cancelled`,
`orphaned`) it SHALL respond `409 agent_not_running`. The message
content SHALL never be audited or logged.

#### Scenario: Steer accepted

- **GIVEN** a `running` agent
- **WHEN** the client sends `POST /rc/agents/:id/message
{ "content": "also update the changelog" }`
- **THEN** the response is `202`
- **AND** the agent's session receives the prompt

#### Scenario: Steer on terminal agent

- **GIVEN** a `cancelled` agent
- **WHEN** the client sends `POST /rc/agents/:id/message`
- **THEN** the response is `409` with code `agent_not_running`

### Requirement: Agent cancel

`POST /rc/agents/:id/cancel` SHALL require the `write` scope, proxy
to the agent session's end route (`POST /session/:id/end` semantics),
and mark the record `cancelled`. On a terminal agent it SHALL respond
`409 agent_not_running`.

#### Scenario: Cancel ends the session

- **GIVEN** a `running` agent backed by session `S`
- **WHEN** the client sends `POST /rc/agents/:id/cancel`
- **THEN** the daemon receives an end request for `S`
- **AND** the record status becomes `cancelled`
- **AND** an `agent_cancelled` SSE event is emitted

#### Scenario: Cancel on terminal agent

- **GIVEN** a `completed` agent
- **WHEN** the client sends `POST /rc/agents/:id/cancel`
- **THEN** the response is `409` with code `agent_not_running`

### Requirement: Agent lifecycle SSE events

The gateway SHALL emit SSE events `agent_spawned`, `agent_completed`,
`agent_failed`, `agent_blocked`, and `agent_cancelled`, each with
payload `{ agentId, sessionId, parentSessionId, agentType, task,
status, costMicrocents? }`, on the parent session's event stream
(`GET /session/:parentId/events`, when `parentSessionId` is non-null)
AND on the owner events stream (`GET /rc/events`).

Transitions: daemon `session_died` on the agent's session → `failed`
(+ `agent_failed`); terminal prompt completion → `completed`
(+ `agent_completed`); an outstanding `permission_request` →
`blocked` (+ `agent_blocked`); a subsequent `session_update` on a
blocked agent's session → `running` (no dedicated frame — the
resumption is visible via `GET /rc/agents`). A record already in a
terminal status SHALL never transition again (a cancelled agent's
subsequent `session_died` emits nothing).

#### Scenario: session_died marks failed

- **GIVEN** a `running` agent
- **WHEN** the daemon emits `session_died` on the agent's session
- **THEN** the record becomes `failed`
- **AND** `agent_failed` is emitted on the owner events stream

#### Scenario: Permission request blocks

- **GIVEN** a `running` agent
- **WHEN** a `permission_request` is emitted on the agent's session
- **THEN** the record becomes `blocked`
- **AND** `agent_blocked` is emitted

#### Scenario: Terminal frames carry cost

- **GIVEN** cost tracking is enabled
- **WHEN** `agent_completed` is emitted
- **THEN** its payload carries `costMicrocents` computed from the
  cost tables at emission time

### Requirement: Agent notification routing

The five lifecycle events SHALL be routable notification kinds
`agent.spawned`, `agent.completed`, `agent.failed`, `agent.blocked`,
`agent.cancelled` through existing routing rules, quiet hours, and
bridges. `agent.blocked` SHALL be a critical kind that bypasses the
snooze/quiet-hours floor (a blocked agent needs a human).

#### Scenario: Routing rule drops a lifecycle kind

- **GIVEN** a routing rule `match: { kind: agent.completed }` with
  `route: { drop: true }`
- **WHEN** an agent completes
- **THEN** no push is delivered for that event

#### Scenario: agent.blocked bypasses snooze

- **GIVEN** an active snooze on `agent.blocked`
- **WHEN** an agent blocks on a permission request
- **THEN** the push is still delivered

### Requirement: Hook event mirror

`POST /rc/hooks/ingest` SHALL accept hook firings from the local hook
runner and mirror each as a `hook_event` frame on the owner events
stream ONLY (hook payloads contain tool arguments — too sensitive for
`read`-scope session streams). The endpoint SHALL:

- reject non-loopback callers with `403` and audit
  `hook_ingest_rejected`;
- require a dedicated ingest token (Bearer), minted once on first
  startup, persisted mode 0600, and NOT a pairing token — a missing
  or wrong token yields `401` and an audit `hook_ingest_rejected`;
  rejected requests SHALL never be mirrored;
- validate the envelope `{ event, sessionId?, toolName?, payload }`
  (`event` a non-empty string; `sessionId`/`toolName` strings when
  present) and reject otherwise with `400 invalid_hook_envelope`;
- apply a token-bucket rate limit that DROPS on overflow (never 429s
  the hook runner into retry loops); the dropped count SHALL be
  surfaced as `dropped: n` on the next mirrored frame.

Hook configuration remains local-only: this change adds NO remote
hook CRUD endpoints.

#### Scenario: Valid ingest mirrors owner-only

- **GIVEN** a loopback caller with the ingest token
- **WHEN** it POSTs `{ "event": "PreToolUse", "sessionId": "s1",
"toolName": "Bash", "payload": { } }` to `/rc/hooks/ingest`
- **THEN** owner-stream subscribers receive a `hook_event` frame
- **AND** no frame appears on any `/session/:id/events` stream

#### Scenario: Bad token audited, never mirrored

- **WHEN** a loopback caller POSTs with a wrong token
- **THEN** the response is `401`
- **AND** an audit row `hook_ingest_rejected` is written
- **AND** no `hook_event` frame is emitted

#### Scenario: Flood drops with count surfaced

- **GIVEN** the token bucket is exhausted
- **WHEN** two more hook firings arrive and then the bucket refills
- **THEN** the two are dropped (not mirrored, not 429'd)
- **AND** the next mirrored `hook_event` frame carries `dropped: 2`

### Requirement: Startup reconciliation

On gateway startup, agent records with status `running` or `blocked`
SHALL be checked against the daemon's live session list; records
whose session is missing SHALL be marked `orphaned`. Orphaned records
SHALL remain visible in `GET /rc/agents` — never silently deleted.

#### Scenario: Dead session orphans the record

- **GIVEN** a registry with a `running` record whose session no
  longer exists on the daemon
- **WHEN** the gateway starts and reconciles
- **THEN** the record's status becomes `orphaned`
- **AND** it still appears in `GET /rc/agents`

### Requirement: Agent audit actions

The gateway SHALL write audit rows: `agent_spawned` on successful
spawn (with actor token id, sub-actor when bridge-asserted, and the
agent id — never the task text), `agent_message_sent` on steer (never
the content), `agent_cancelled` on cancel, and `hook_ingest_rejected`
on every rejected hook ingest.

#### Scenario: Spawn is audited

- **WHEN** `POST /rc/agents` succeeds
- **THEN** an audit row with `action: "agent_spawned"` exists,
  carrying the caller's token id and the new agent id
- **AND** the row does not contain the task text
```

- [ ] **Step 2: Commit**

```bash
cd /home/evan/projects/qwen-code-remote
git add openspec/changes/add-agent-observability/specs/agent-observability/spec.md
git commit -m "docs(specs): agent-observability requirements + scenarios"
```

---

### Task 3: Registry deltas — SSE event types and audit actions

**Files:**

- Create: `openspec/changes/add-agent-observability/specs/wire-protocol/spec.md`
- Create: `openspec/changes/add-agent-observability/specs/pairing-auth/spec.md`
- Modify: `openspec/changes/add-remote-control/specs/wire-protocol/spec.md` (the authoritative SSE registry table, under `### Requirement: SSE event-type registry`)
- Modify: `openspec/changes/add-remote-control/specs/pairing-auth/spec.md` (the authoritative extension registry table, under `### Requirement: Audit record schema (v1)`)

**Interfaces:**

- Consumes: the registry tables cited above. Per `openspec/conventions.md` §2 these are the AUTHORITATIVE registries — prior changes (e.g. `idle_suggestions`, `session_forked`) appended their rows directly to those tables; this change does the same AND records the delta in its own change directory.
- Produces: 6 SSE registry rows + 4 audit-action rows that Part B implements.

- [ ] **Step 1: Append 6 rows to the authoritative SSE registry table**

In `openspec/changes/add-remote-control/specs/wire-protocol/spec.md`, append to the table under `### Requirement: SSE event-type registry` (after the `replay_truncated` row) exactly:

```markdown
| `agent_spawned` | `add-agent-observability` | `{ agentId, sessionId, parentSessionId, agentType, task, status, costMicrocents? }` — background agent registered and task prompt accepted; emitted on the parent session's stream and the owner events stream |
| `agent_completed` | `add-agent-observability` | same payload as `agent_spawned` — the agent's terminal prompt completed; carries the cost rollup |
| `agent_failed` | `add-agent-observability` | same payload as `agent_spawned` — the agent's session died or its prompt errored |
| `agent_blocked` | `add-agent-observability` | same payload as `agent_spawned` — a `permission_request` is outstanding on the agent's session |
| `agent_cancelled` | `add-agent-observability` | same payload as `agent_spawned` — a client cancelled the agent via `POST /rc/agents/:id/cancel` |
| `hook_event` | `add-agent-observability` | `{ event, sessionId?, toolName?, payload, dropped? }` — read-only mirror of a local hook firing; emitted on the OWNER events stream (`GET /rc/events`) only, never on session streams |
```

- [ ] **Step 2: Append 4 rows to the authoritative pairing-auth audit registry table**

In `openspec/changes/add-remote-control/specs/pairing-auth/spec.md`, append to the extension registry table under `### Requirement: Audit record schema (v1)` (after the `share_id, share_label` row) exactly:

```markdown
| `agent_spawned` (action) | `add-agent-observability` | Audit `action`: remote client spawned a background agent via `POST /rc/agents`; row carries the actor token id and agent id, never the task text |
| `agent_message_sent` (action) | `add-agent-observability` | Audit `action`: remote client steered an agent via `POST /rc/agents/:id/message`; content is never audited |
| `agent_cancelled` (action) | `add-agent-observability` | Audit `action`: remote client cancelled an agent via `POST /rc/agents/:id/cancel` |
| `hook_ingest_rejected` (action) | `add-agent-observability` | Audit `action`: a `POST /rc/hooks/ingest` request failed the loopback or ingest-token check and was rejected without mirroring |
```

- [ ] **Step 3: Record the deltas inside the new change**

Create `openspec/changes/add-agent-observability/specs/wire-protocol/spec.md`:

```markdown
# wire-protocol — spec delta (add-agent-observability)

## MODIFIED Requirements

### Requirement: SSE event-type registry

Six rows are ADDED to the authoritative registry table in
`openspec/changes/add-remote-control/specs/wire-protocol/spec.md`
for the event types `agent_spawned`, `agent_completed`,
`agent_failed`, `agent_blocked`, `agent_cancelled` (payload
`{ agentId, sessionId, parentSessionId, agentType, task, status,
costMicrocents? }`) and `hook_event` (payload `{ event, sessionId?,
toolName?, payload, dropped? }`; OWNER events stream only). The rows
appended there are the normative text; this delta records the change
of ownership.

#### Scenario: Lifecycle events are registered before shipping

- **WHEN** `add-agent-observability` ships
- **THEN** all six event types above appear in the SSE event-type
  registry table with owning change `add-agent-observability`
```

Create `openspec/changes/add-agent-observability/specs/pairing-auth/spec.md`:

```markdown
# pairing-auth — spec delta (add-agent-observability)

## MODIFIED Requirements

### Requirement: Audit record schema (v1)

Four action rows are ADDED to the authoritative extension registry
table in
`openspec/changes/add-remote-control/specs/pairing-auth/spec.md`:
`agent_spawned`, `agent_message_sent`, `agent_cancelled`, and
`hook_ingest_rejected` (all audit `action` values; no new extension
fields). The rows appended there are the normative text.

#### Scenario: Agent audit actions are registered

- **WHEN** `add-agent-observability` ships
- **THEN** the four actions above appear in the registry table with
  owning change `add-agent-observability`
```

- [ ] **Step 4: Verify the registry rows exist (grep gate)**

```bash
cd /home/evan/projects/qwen-code-remote
grep -c "add-agent-observability" openspec/changes/add-remote-control/specs/wire-protocol/spec.md
# Expected: 6
grep -c "add-agent-observability" openspec/changes/add-remote-control/specs/pairing-auth/spec.md
# Expected: 4
grep -n "agent_spawned\|agent_completed\|agent_failed\|agent_blocked\|agent_cancelled\|hook_event" openspec/changes/add-remote-control/specs/wire-protocol/spec.md
# Expected: 6 hits inside the registry table
```

- [ ] **Step 5: Commit**

```bash
cd /home/evan/projects/qwen-code-remote
git add openspec/changes/add-remote-control/specs/wire-protocol/spec.md \
        openspec/changes/add-remote-control/specs/pairing-auth/spec.md \
        openspec/changes/add-agent-observability/specs/wire-protocol/spec.md \
        openspec/changes/add-agent-observability/specs/pairing-auth/spec.md
git commit -m "docs(specs): register agent SSE events + audit actions in authoritative registries"
```

---

### Task 4: `tasks.md` for the change

**Files:**

- Create: `openspec/changes/add-agent-observability/tasks.md`

**Interfaces:**

- Consumes: tasks rules from `openspec/config.yaml` (Phase N.0 alignment tasks; each task has `Status` and `Prompt` fields; Status values `not-started | started | completed | deferred:<reason> | skipped:<reason> | cancelled:<reason>`); style of `add-idle-suggestions/tasks.md`.
- Produces: the phased task list mirroring Part B of this plan.

- [ ] **Step 1: Write `tasks.md`**

```markdown
# tasks — add-agent-observability

State machine and alignment pattern: see
`changes/add-remote-control/tasks.md`.

## Phase 0 — Foundation

**Effort:** ~0.5 day.

- [ ] **0.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify `add-remote-control` Phase 6 `completed` (gateway,
    > scopes, owner events, audit chain). Verify `add-cost-tracking`
    > implemented (UsageStore.sessionTotals exists) and
    > `add-notification-routing` implemented (KIND_SCOPE / routing
    > rules). Confirm the six SSE registry rows and four audit-action
    > rows from this change's registry deltas are present in the
    > authoritative tables. Record confirmations here.

## Phase 1 — Registry + lifecycle

**Effort:** ~1.5 days.

- [ ] **1.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 0 `completed`. Confirm the daemon emits
    > `session_died` on the session stream when a session ends and
    > `permission_request` when a tool call needs approval, in the
    > current fork build. Note deviations before implementing.

- [ ] **1.1 AgentRegistry (JSON file store)**
  - **Status:** not-started
  - **Files:** `packages/rc-gateway/src/agents/agentRegistry.ts`
  - **Prompt:**
    > Persisted registry following the tokenStore.ts JSON pattern:
    > AgentRecord per design.md, 0600 file, register/get/list/
    > setStatus (terminal statuses immutable) /findBySessionId/
    > reconcile(liveSessionIds) → orphan marking. Acceptance:
    > scenarios under `Requirement: Startup reconciliation`.

- [ ] **1.2 AgentLifecycle transitions + frame emission**
  - **Status:** not-started
  - **Files:** `packages/rc-gateway/src/agents/agentLifecycle.ts`
  - **Prompt:**
    > session_died→failed, prompt settle→completed/failed,
    > permission_request→blocked, session_update while
    > blocked→running (no frame). Emits the five frames on parent
    > stream + owner stream and hands each to the notifier.
    > Acceptance: scenarios under `Requirement: Agent lifecycle SSE
events`.

## Phase 2 — Control plane

**Effort:** ~1.5 days.

- [ ] **2.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 1 `completed`. Confirm scope constants and 409/404
    > error-code names against auth.ts/scopes.ts.

- [ ] **2.1 /rc/agents routes (spawn saga, list, detail, steer, cancel)**
  - **Status:** not-started
  - **Files:** `packages/rc-gateway/src/routes/agents.ts`
  - **Prompt:**
    > Five endpoints with write/read scopes, spawn saga + rollback,
    > 409 agent_not_running on terminal steer/cancel, audit rows
    > agent_spawned/agent_message_sent/agent_cancelled. Acceptance:
    > scenarios under `Requirement: Agent spawn`, `Agent listing and
detail`, `Agent steer`, `Agent cancel`, `Agent audit actions`.

## Phase 3 — Hook mirror + notifications

**Effort:** ~1 day.

- [ ] **3.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 2 `completed`. Confirm the hook runner's outbound
    > POST shape against core's HTTP hook runner docs; adjust the
    > envelope validator only if the field names differ (then update
    > the spec delta first).

- [ ] **3.1 POST /rc/hooks/ingest + persistent ingest token**
  - **Status:** not-started
  - **Files:** `packages/rc-gateway/src/routes/hookIngest.ts`,
    `packages/rc-gateway/src/agents/hookIngestToken.ts`
  - **Prompt:**
    > Loopback check, 0600 persisted token, envelope validation,
    > token-bucket drop with dropped-count surfacing, owner-only
    > mirroring, hook_ingest_rejected audit. Acceptance: scenarios
    > under `Requirement: Hook event mirror`.

- [ ] **3.2 Notification kinds agent.\***
  - **Status:** not-started
  - **Files:** `packages/rc-gateway/src/webpush/payload.ts`,
    `packages/rc-gateway/src/webpush/notifier.ts`
  - **Prompt:**
    > Map the five lifecycle event types to kinds, scope-gate at
    > session:read, add agent.blocked to the snooze-bypass critical
    > set. Acceptance: scenarios under `Requirement: Agent
notification routing`.

## Phase 4 — Wiring + integration

**Effort:** ~1 day.

- [ ] **4.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 3 `completed`. Confirm GatewayDeps additions
    > compile against server.ts and that the pump's onEvent seam is
    > still the single event-plumbing entry point.

- [ ] **4.1 server.ts + cli.ts wiring, cost rollup, startup reconciliation**
  - **Status:** not-started
  - **Prompt:**
    > Inject registry/lifecycle/hook token via GatewayDeps; cost
    > rollup closure over UsageStore.sessionTotals; reconcile on
    > serve boot; compose pump onEvent. Acceptance: scenarios under
    > `Requirement: Agent listing and detail` (cost) and
    > `Requirement: Startup reconciliation`.

- [ ] **4.2 Integration: spawn → observe frames → cancel**
  - **Status:** not-started
  - **Prompt:**
    > End-to-end vitest against the stub daemon: spawn via HTTP,
    > observe agent_spawned/agent_cancelled on the owner bus, cancel,
    > assert the daemon saw the session end.

- [ ] **4.3 Archive change**
  - **Status:** not-started
  - **Prompt:**
    > Run `openspec archive add-agent-observability` once deployed.

## Effort summary

| Phase     | Description                 | Estimate (days) |
| --------- | --------------------------- | --------------- |
| 0         | Foundation                  | 0.5             |
| 1         | Registry + lifecycle        | 1.5             |
| 2         | Control plane               | 1.5             |
| 3         | Hook mirror + notifications | 1               |
| 4         | Wiring + integration        | 1               |
| **Total** |                             | **5.5**         |
```

- [ ] **Step 2: Commit**

```bash
cd /home/evan/projects/qwen-code-remote
git add openspec/changes/add-agent-observability/tasks.md
git commit -m "docs(specs): add-agent-observability phased tasks"
```

---

## Part B — rc-gateway implementation (`/home/evan/projects/qwen-code`, branch `add-remote-control-spec`)

### Task 5: `agents/agentRegistry.ts` — persisted agent registry

**Files:**

- Create: `packages/rc-gateway/src/agents/agentRegistry.ts`
- Test: `packages/rc-gateway/src/agents/agentRegistry.test.ts`

**Interfaces:**

- Consumes: nothing from other tasks (Node stdlib only). Persistence pattern copied from `src/tokenStore.ts` (`static async open`, in-memory array, `persist()` → `writeFile(path, JSON, { mode: 0o600 })` after `mkdir(dirname(path), { recursive: true })`).
- Produces (used by Tasks 7, 8, 11, 12, 13):
  - `type AgentStatus = 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled' | 'orphaned'`
  - `const TERMINAL_AGENT_STATUSES: ReadonlySet<AgentStatus>` — `completed`, `failed`, `cancelled`, `orphaned`
  - `interface AgentRecord` — exactly the design doc's shape (below)
  - `class AgentRegistry` with:
    - `static async open(filePath: string, nowFn?: () => number): Promise<AgentRegistry>`
    - `async register(input: { sessionId: string; parentSessionId: string | null; agentType: string; task: string; spawnedByTokenId: string; subActor?: string }): Promise<AgentRecord>`
    - `get(agentId: string): AgentRecord | undefined`
    - `findBySessionId(sessionId: string): AgentRecord | undefined`
    - `list(filter?: { status?: AgentStatus; parent?: string }): AgentRecord[]`
    - `async setStatus(agentId: string, status: AgentStatus): Promise<boolean>`
    - `async reconcile(liveSessionIds: readonly string[]): Promise<string[]>`

- [ ] **Step 1: Write the failing test**

Create `packages/rc-gateway/src/agents/agentRegistry.test.ts` (license header first, as in every file):

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRegistry, TERMINAL_AGENT_STATUSES } from './agentRegistry.js';

async function tmpStorePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agents-'));
  return join(dir, 'agents.json');
}

describe('AgentRegistry', () => {
  it('registers a running agent with a uuid and truncated task', async () => {
    const reg = await AgentRegistry.open(await tmpStorePath());
    const rec = await reg.register({
      sessionId: 's1',
      parentSessionId: null,
      agentType: 'general',
      task: 'x'.repeat(3000),
      spawnedByTokenId: 'tkn1',
    });
    expect(rec.agentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(rec.status).toBe('running');
    expect(rec.task.length).toBe(2000);
    expect(rec.finishedAt).toBeNull();
    expect(reg.get(rec.agentId)).toEqual(rec);
  });

  it('persists across reopen', async () => {
    const path = await tmpStorePath();
    const reg = await AgentRegistry.open(path);
    const rec = await reg.register({
      sessionId: 's1',
      parentSessionId: 'p1',
      agentType: 'general',
      task: 'do a thing',
      spawnedByTokenId: 'tkn1',
    });
    const reopened = await AgentRegistry.open(path);
    expect(reopened.get(rec.agentId)?.sessionId).toBe('s1');
    expect(reopened.get(rec.agentId)?.parentSessionId).toBe('p1');
  });

  it('setStatus stamps finishedAt on terminal and refuses re-transition', async () => {
    const reg = await AgentRegistry.open(await tmpStorePath());
    const rec = await reg.register({
      sessionId: 's1',
      parentSessionId: null,
      agentType: 'general',
      task: 't',
      spawnedByTokenId: 'tkn1',
    });
    expect(await reg.setStatus(rec.agentId, 'blocked')).toBe(true);
    expect(reg.get(rec.agentId)?.finishedAt).toBeNull();
    expect(await reg.setStatus(rec.agentId, 'cancelled')).toBe(true);
    expect(reg.get(rec.agentId)?.finishedAt).not.toBeNull();
    // Terminal → any further transition is a no-op.
    expect(await reg.setStatus(rec.agentId, 'failed')).toBe(false);
    expect(reg.get(rec.agentId)?.status).toBe('cancelled');
    expect(TERMINAL_AGENT_STATUSES.has('cancelled')).toBe(true);
  });

  it('list filters by status and parent', async () => {
    const reg = await AgentRegistry.open(await tmpStorePath());
    const a = await reg.register({
      sessionId: 's1',
      parentSessionId: 'p1',
      agentType: 'general',
      task: 'a',
      spawnedByTokenId: 'tkn1',
    });
    await reg.register({
      sessionId: 's2',
      parentSessionId: null,
      agentType: 'general',
      task: 'b',
      spawnedByTokenId: 'tkn1',
    });
    await reg.setStatus(a.agentId, 'completed');
    expect(reg.list({ status: 'completed' }).map((r) => r.agentId)).toEqual([
      a.agentId,
    ]);
    expect(reg.list({ parent: 'p1' })).toHaveLength(1);
    expect(reg.list()).toHaveLength(2);
  });

  it('reconcile orphans running/blocked records whose session is gone', async () => {
    const reg = await AgentRegistry.open(await tmpStorePath());
    const gone = await reg.register({
      sessionId: 's-gone',
      parentSessionId: null,
      agentType: 'general',
      task: 't',
      spawnedByTokenId: 'tkn1',
    });
    const live = await reg.register({
      sessionId: 's-live',
      parentSessionId: null,
      agentType: 'general',
      task: 't',
      spawnedByTokenId: 'tkn1',
    });
    const done = await reg.register({
      sessionId: 's-done',
      parentSessionId: null,
      agentType: 'general',
      task: 't',
      spawnedByTokenId: 'tkn1',
    });
    await reg.setStatus(done.agentId, 'completed');

    const orphaned = await reg.reconcile(['s-live']);
    expect(orphaned).toEqual([gone.agentId]);
    expect(reg.get(gone.agentId)?.status).toBe('orphaned');
    expect(reg.get(live.agentId)?.status).toBe('running');
    // Terminal records are untouched even though their session is gone.
    expect(reg.get(done.agentId)?.status).toBe('completed');
  });

  it('findBySessionId prefers the non-terminal record', async () => {
    const reg = await AgentRegistry.open(await tmpStorePath());
    const old = await reg.register({
      sessionId: 's1',
      parentSessionId: null,
      agentType: 'general',
      task: 't',
      spawnedByTokenId: 'tkn1',
    });
    await reg.setStatus(old.agentId, 'failed');
    const fresh = await reg.register({
      sessionId: 's1',
      parentSessionId: null,
      agentType: 'general',
      task: 't2',
      spawnedByTokenId: 'tkn1',
    });
    expect(reg.findBySessionId('s1')?.agentId).toBe(fresh.agentId);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/evan/projects/qwen-code/packages/rc-gateway && npx vitest run src/agents/agentRegistry.test.ts`
Expected: FAIL — cannot resolve `./agentRegistry.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/rc-gateway/src/agents/agentRegistry.ts`:

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Max stored task length (design: "spawning prompt, truncated to 2k chars"). */
const TASK_MAX_CHARS = 2000;

export type AgentStatus =
  | 'running'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'orphaned';

/** Statuses a record can never leave. `setStatus` refuses transitions out. */
export const TERMINAL_AGENT_STATUSES: ReadonlySet<AgentStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
  'orphaned',
]);

/**
 * One background agent, backed 1:1 by a daemon session (design: approach B,
 * agents-as-sessions). Shape mirrors the approved design doc exactly.
 */
export interface AgentRecord {
  agentId: string; // uuid
  sessionId: string; // the daemon session backing this agent
  parentSessionId: string | null;
  agentType: string; // 'general' | subagent-manager name
  task: string; // spawning prompt, truncated to 2k chars
  status: AgentStatus;
  spawnedByTokenId: string;
  subActor?: string; // if spawned via a bridge
  spawnedAt: string;
  finishedAt: string | null;
}

interface PersistShape {
  agents: AgentRecord[];
}

/**
 * Persisted agent registry — JSON file store, same pattern as TokenStore
 * (tokenStore.ts): private constructor, `open()` reads-or-starts-empty,
 * every mutation awaits `persist()` (0600 file inside an ensured dir).
 * Cost is deliberately NOT stored here — it is computed at read time from
 * the cost tables keyed by sessionId (one source of truth).
 */
export class AgentRegistry {
  private constructor(
    private readonly filePath: string,
    private records: AgentRecord[],
    private readonly nowFn: () => number,
  ) {}

  static async open(
    filePath: string,
    nowFn: () => number = Date.now,
  ): Promise<AgentRegistry> {
    let records: AgentRecord[] = [];
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as PersistShape;
      if (Array.isArray(parsed.agents)) records = parsed.agents;
    } catch {
      // Missing/corrupt file → start empty. First register() persists it.
    }
    return new AgentRegistry(filePath, records, nowFn);
  }

  async register(input: {
    sessionId: string;
    parentSessionId: string | null;
    agentType: string;
    task: string;
    spawnedByTokenId: string;
    subActor?: string;
  }): Promise<AgentRecord> {
    const rec: AgentRecord = {
      agentId: randomUUID(),
      sessionId: input.sessionId,
      parentSessionId: input.parentSessionId,
      agentType: input.agentType,
      task: input.task.slice(0, TASK_MAX_CHARS),
      status: 'running',
      spawnedByTokenId: input.spawnedByTokenId,
      ...(input.subActor !== undefined ? { subActor: input.subActor } : {}),
      spawnedAt: new Date(this.nowFn()).toISOString(),
      finishedAt: null,
    };
    this.records.push(rec);
    await this.persist();
    return { ...rec };
  }

  get(agentId: string): AgentRecord | undefined {
    const rec = this.records.find((r) => r.agentId === agentId);
    return rec ? { ...rec } : undefined;
  }

  /**
   * The record backing `sessionId`. When a session id was reused (an earlier
   * agent on it already terminal), the non-terminal record wins so lifecycle
   * events land on the live agent.
   */
  findBySessionId(sessionId: string): AgentRecord | undefined {
    const matches = this.records.filter((r) => r.sessionId === sessionId);
    const live = matches.find((r) => !TERMINAL_AGENT_STATUSES.has(r.status));
    const rec = live ?? matches[matches.length - 1];
    return rec ? { ...rec } : undefined;
  }

  list(filter: { status?: AgentStatus; parent?: string } = {}): AgentRecord[] {
    return this.records
      .filter(
        (r) =>
          (filter.status === undefined || r.status === filter.status) &&
          (filter.parent === undefined || r.parentSessionId === filter.parent),
      )
      .map((r) => ({ ...r }));
  }

  /**
   * Transition a record's status. Returns false (and changes nothing) when
   * the id is unknown OR the record is already terminal — so a cancelled
   * agent's late `session_died` can never flip it to `failed`, and callers
   * can gate frame emission on the return value. Stamps `finishedAt` when
   * entering a terminal status.
   */
  async setStatus(agentId: string, status: AgentStatus): Promise<boolean> {
    const rec = this.records.find((r) => r.agentId === agentId);
    if (!rec || TERMINAL_AGENT_STATUSES.has(rec.status)) return false;
    rec.status = status;
    if (TERMINAL_AGENT_STATUSES.has(status)) {
      rec.finishedAt = new Date(this.nowFn()).toISOString();
    }
    await this.persist();
    return true;
  }

  /**
   * Startup reconciliation (design: "Reconciliation"): every `running` or
   * `blocked` record whose session is NOT in `liveSessionIds` becomes
   * `orphaned` (surfaced in GET /rc/agents, never silently dropped).
   * Returns the orphaned agent ids. Single persist after all stamps.
   */
  async reconcile(liveSessionIds: readonly string[]): Promise<string[]> {
    const live = new Set(liveSessionIds);
    const orphaned: string[] = [];
    const finishedAt = new Date(this.nowFn()).toISOString();
    for (const rec of this.records) {
      if (TERMINAL_AGENT_STATUSES.has(rec.status)) continue;
      if (live.has(rec.sessionId)) continue;
      rec.status = 'orphaned';
      rec.finishedAt = finishedAt;
      orphaned.push(rec.agentId);
    }
    if (orphaned.length > 0) await this.persist();
    return orphaned;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const body: PersistShape = { agents: this.records };
    await writeFile(this.filePath, JSON.stringify(body, null, 2), {
      mode: 0o600,
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/evan/projects/qwen-code/packages/rc-gateway && npx vitest run src/agents/agentRegistry.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/evan/projects/qwen-code
git add packages/rc-gateway/src/agents/agentRegistry.ts packages/rc-gateway/src/agents/agentRegistry.test.ts
git commit -m "feat(rc-gateway): persisted agent registry with reconciliation"
```

---

### Task 6: Event vocabulary — `OwnerEvent` variants + audit actions

**Files:**

- Modify: `packages/rc-gateway/src/ownerEvents.ts` (extend the `OwnerEvent` union; add payload types)
- Modify: `packages/rc-gateway/src/auditLog.ts` (extend `AuditAction` union + `AUDIT_ACTIONS` array)
- Test: `packages/rc-gateway/src/ownerEvents.test.ts` (append), `packages/rc-gateway/src/auditLog.test.ts` (append)

**Interfaces:**

- Consumes: existing `OwnerEvent` discriminated union and `OwnerEventBus` in `ownerEvents.ts`; existing `AuditAction`/`AUDIT_ACTIONS` in `auditLog.ts`.
- Produces (used by Tasks 7, 9, 11, 13):
  - `type AgentLifecycleEventType = 'agent_spawned' | 'agent_completed' | 'agent_failed' | 'agent_blocked' | 'agent_cancelled'` (exported from `ownerEvents.ts`)
  - `interface AgentLifecyclePayload { agentId: string; sessionId: string; parentSessionId: string | null; agentType: string; task: string; status: string; costMicrocents?: number }` (exported from `ownerEvents.ts`)
  - New `OwnerEvent` variants: `{ type: AgentLifecycleEventType; agent: AgentLifecyclePayload }` and `{ type: 'hook_event'; event: string; sessionId?: string; toolName?: string; payload: unknown; dropped?: number }`
  - New `AuditAction` members: `'agent_spawned' | 'agent_message_sent' | 'agent_cancelled' | 'hook_ingest_rejected'`

- [ ] **Step 1: Write the failing tests**

Append to `packages/rc-gateway/src/ownerEvents.test.ts`:

```ts
import type { AgentLifecyclePayload, OwnerEvent } from './ownerEvents.js';

describe('agent + hook OwnerEvent variants', () => {
  it('fans agent lifecycle and hook_event frames to subscribers', () => {
    const bus = new OwnerEventBus();
    const seen: OwnerEvent[] = [];
    bus.subscribe((e) => seen.push(e));
    const agent: AgentLifecyclePayload = {
      agentId: 'a1',
      sessionId: 's1',
      parentSessionId: null,
      agentType: 'general',
      task: 't',
      status: 'running',
    };
    bus.publish({ type: 'agent_spawned', agent });
    bus.publish({
      type: 'hook_event',
      event: 'PreToolUse',
      sessionId: 's1',
      toolName: 'Bash',
      payload: { command: 'ls' },
      dropped: 2,
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ type: 'agent_spawned' });
    expect(seen[1]).toMatchObject({ type: 'hook_event', dropped: 2 });
  });
});
```

(Reuse the file's existing imports of `describe/it/expect` and `OwnerEventBus`; add only what's missing.)

Append to `packages/rc-gateway/src/auditLog.test.ts`:

```ts
describe('agent-observability audit actions', () => {
  it('registers the four new actions in AUDIT_ACTIONS', () => {
    for (const a of [
      'agent_spawned',
      'agent_message_sent',
      'agent_cancelled',
      'hook_ingest_rejected',
    ] as const) {
      expect(AUDIT_ACTIONS).toContain(a);
    }
  });
});
```

(`AUDIT_ACTIONS` is already exported; add it to the test file's import from `./auditLog.js` if not present.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/evan/projects/qwen-code/packages/rc-gateway && npx vitest run src/ownerEvents.test.ts src/auditLog.test.ts`
Expected: FAIL — TS errors: `agent_spawned` not assignable to `OwnerEvent['type']`; `AUDIT_ACTIONS` missing the actions.

- [ ] **Step 3: Extend `ownerEvents.ts`**

Add above the `OwnerEvent` type in `packages/rc-gateway/src/ownerEvents.ts`:

```ts
/** The five lifecycle SSE event types (wire-protocol SSE registry rows). */
export type AgentLifecycleEventType =
  | 'agent_spawned'
  | 'agent_completed'
  | 'agent_failed'
  | 'agent_blocked'
  | 'agent_cancelled';

/**
 * Payload of a lifecycle frame (design: `{ agentId, sessionId,
 * parentSessionId, agentType, task, status, costMicrocents? }`). Also the
 * `data` of the same frames on the parent session's stream.
 */
export interface AgentLifecyclePayload {
  agentId: string;
  sessionId: string;
  parentSessionId: string | null;
  agentType: string;
  task: string;
  status: string;
  costMicrocents?: number;
}
```

Extend the `OwnerEvent` union with two variants (after the `session_event` variant):

```ts
  | {
      /** Agent lifecycle frame (add-agent-observability). */
      type: AgentLifecycleEventType;
      agent: AgentLifecyclePayload;
    }
  | {
      /**
       * Read-only mirror of a local hook firing (POST /rc/hooks/ingest).
       * OWNER stream only — hook payloads carry tool arguments. `dropped`
       * surfaces how many frames the ingest rate limiter dropped since the
       * previously mirrored frame.
       */
      type: 'hook_event';
      event: string;
      sessionId?: string;
      toolName?: string;
      payload: unknown;
      dropped?: number;
    };
```

- [ ] **Step 4: Extend `auditLog.ts`**

In `packages/rc-gateway/src/auditLog.ts`, append to the `AuditAction` union after `| 'session_ended'`:

```ts
  | 'agent_spawned'
  | 'agent_message_sent'
  | 'agent_cancelled'
  | 'hook_ingest_rejected';
```

and append the same four strings at the end of the `AUDIT_ACTIONS` array:

```ts
  'agent_spawned',
  'agent_message_sent',
  'agent_cancelled',
  'hook_ingest_rejected',
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /home/evan/projects/qwen-code/packages/rc-gateway && npx vitest run src/ownerEvents.test.ts src/auditLog.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /home/evan/projects/qwen-code
git add packages/rc-gateway/src/ownerEvents.ts packages/rc-gateway/src/ownerEvents.test.ts packages/rc-gateway/src/auditLog.ts packages/rc-gateway/src/auditLog.test.ts
git commit -m "feat(rc-gateway): agent lifecycle + hook_event owner frames, agent audit actions"
```

---

### Task 7: `agents/agentLifecycle.ts` — status transitions + frame emission

**Files:**

- Create: `packages/rc-gateway/src/agents/agentLifecycle.ts`
- Test: `packages/rc-gateway/src/agents/agentLifecycle.test.ts`

**Interfaces:**

- Consumes:
  - Task 5: `AgentRegistry` (`get`, `findBySessionId`, `setStatus`), `AgentRecord`
  - Task 6: `OwnerEventBus.publish`, `AgentLifecycleEventType`, `AgentLifecyclePayload` from `../ownerEvents.js`
  - Existing: `PromptEventBroadcaster.emit(sessionId, { type, data })` from `../routes/promptEventBroadcaster.js` (parent-stream fan-out — the same mechanism `stream_error` uses)
- Produces (used by Tasks 8, 11, 12, 13):
  - `interface AgentNotifySink { notify(event: { type: string; data: unknown }, ctx: { sessionId: string; sessionName?: string }): Promise<void> }` (structurally satisfied by `PushNotifier`)
  - `class AgentLifecycle`:
    - `constructor(registry: AgentRegistry, ownerEvents: OwnerEventBus, promptEvents?: PromptEventBroadcaster, notifier?: AgentNotifySink, costFor?: (sessionId: string) => number | undefined)`
    - `emit(type: AgentLifecycleEventType, record: AgentRecord): void`
    - `async handleSessionEvent(sessionId: string, ev: { type: string; data: unknown }): Promise<void>`
    - `async onPromptSettled(agentId: string, outcome: 'completed' | 'failed'): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `packages/rc-gateway/src/agents/agentLifecycle.test.ts`:

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRegistry } from './agentRegistry.js';
import { AgentLifecycle } from './agentLifecycle.js';
import { OwnerEventBus, type OwnerEvent } from '../ownerEvents.js';
import {
  PromptEventBroadcaster,
  type GatewayEvent,
} from '../routes/promptEventBroadcaster.js';

async function setup(costFor?: (sid: string) => number | undefined) {
  const dir = await mkdtemp(join(tmpdir(), 'lifecycle-'));
  const registry = await AgentRegistry.open(join(dir, 'agents.json'));
  const ownerEvents = new OwnerEventBus();
  const ownerSeen: OwnerEvent[] = [];
  ownerEvents.subscribe((e) => ownerSeen.push(e));
  const promptEvents = new PromptEventBroadcaster();
  const notified: Array<{ type: string; sessionId: string }> = [];
  const notifier = {
    notify: async (
      ev: { type: string; data: unknown },
      ctx: { sessionId: string },
    ) => {
      notified.push({ type: ev.type, sessionId: ctx.sessionId });
    },
  };
  const lifecycle = new AgentLifecycle(
    registry,
    ownerEvents,
    promptEvents,
    notifier,
    costFor,
  );
  return { registry, lifecycle, ownerSeen, promptEvents, notified };
}

describe('AgentLifecycle', () => {
  it('session_died marks failed and emits agent_failed everywhere', async () => {
    const { registry, lifecycle, ownerSeen, promptEvents, notified } =
      await setup(() => 1234);
    const parentSeen: GatewayEvent[] = [];
    promptEvents.register('parent-1', (e) => parentSeen.push(e));
    const rec = await registry.register({
      sessionId: 's1',
      parentSessionId: 'parent-1',
      agentType: 'general',
      task: 't',
      spawnedByTokenId: 'tkn1',
    });

    await lifecycle.handleSessionEvent('s1', {
      type: 'session_died',
      data: { reason: 'crashed' },
    });

    expect(registry.get(rec.agentId)?.status).toBe('failed');
    expect(ownerSeen.map((e) => e.type)).toContain('agent_failed');
    expect(parentSeen.map((e) => e.type)).toContain('agent_failed');
    expect(notified.map((n) => n.type)).toContain('agent_failed');
    const frame = ownerSeen.find((e) => e.type === 'agent_failed') as Extract<
      OwnerEvent,
      { type: 'agent_failed' }
    >;
    expect(frame.agent.costMicrocents).toBe(1234);
  });

  it('permission_request blocks; a later session_update resumes without a frame', async () => {
    const { registry, lifecycle, ownerSeen } = await setup();
    const rec = await registry.register({
      sessionId: 's1',
      parentSessionId: null,
      agentType: 'general',
      task: 't',
      spawnedByTokenId: 'tkn1',
    });

    await lifecycle.handleSessionEvent('s1', {
      type: 'permission_request',
      data: { requestId: 'r1' },
    });
    expect(registry.get(rec.agentId)?.status).toBe('blocked');
    expect(ownerSeen.map((e) => e.type)).toContain('agent_blocked');

    const framesBefore = ownerSeen.length;
    await lifecycle.handleSessionEvent('s1', {
      type: 'session_update',
      data: { text: 'tool ran' },
    });
    expect(registry.get(rec.agentId)?.status).toBe('running');
    // Resumption emits NO dedicated frame (spec: only the five events).
    expect(ownerSeen.length).toBe(framesBefore);
  });

  it('onPromptSettled completes the agent; a cancelled agent never re-transitions', async () => {
    const { registry, lifecycle, ownerSeen } = await setup();
    const rec = await registry.register({
      sessionId: 's1',
      parentSessionId: null,
      agentType: 'general',
      task: 't',
      spawnedByTokenId: 'tkn1',
    });
    await lifecycle.onPromptSettled(rec.agentId, 'completed');
    expect(registry.get(rec.agentId)?.status).toBe('completed');
    expect(ownerSeen.map((e) => e.type)).toContain('agent_completed');

    // Terminal: a late session_died must emit nothing new.
    const before = ownerSeen.length;
    await lifecycle.handleSessionEvent('s1', {
      type: 'session_died',
      data: {},
    });
    expect(ownerSeen.length).toBe(before);
    expect(registry.get(rec.agentId)?.status).toBe('completed');
  });

  it('ignores events for sessions that back no agent', async () => {
    const { lifecycle, ownerSeen } = await setup();
    await lifecycle.handleSessionEvent('not-an-agent', {
      type: 'session_died',
      data: {},
    });
    expect(ownerSeen).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/evan/projects/qwen-code/packages/rc-gateway && npx vitest run src/agents/agentLifecycle.test.ts`
Expected: FAIL — cannot resolve `./agentLifecycle.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/rc-gateway/src/agents/agentLifecycle.ts`:

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AgentLifecycleEventType,
  AgentLifecyclePayload,
  OwnerEventBus,
} from '../ownerEvents.js';
import type { PromptEventBroadcaster } from '../routes/promptEventBroadcaster.js';
import type { AgentRegistry, AgentRecord } from './agentRegistry.js';

/**
 * The notification sink the lifecycle hands frames to. Structurally satisfied
 * by PushNotifier.notify (webpush/notifier.ts) — kept structural so tests can
 * pass a collector and so the lifecycle never imports webpush.
 */
export interface AgentNotifySink {
  notify(
    event: { type: string; data: unknown },
    ctx: { sessionId: string; sessionName?: string },
  ): Promise<void>;
}

/**
 * Drives agent status transitions off the gateway's OWN event plumbing (the
 * SessionEventPump's onEvent seam — no second daemon connection) and emits
 * the five lifecycle frames (design: "agentLifecycle.ts"):
 *
 *  - `session_died` on the agent's session      → `failed`   + agent_failed
 *  - terminal prompt completion (onPromptSettled)→ `completed`+ agent_completed
 *  - outstanding `permission_request`           → `blocked`  + agent_blocked
 *  - `session_update` while blocked             → `running`  (no frame; the
 *    spec registers exactly five event types — resumption is visible via
 *    GET /rc/agents)
 *
 * Every frame goes to: the parent session's SSE stream (when a parent
 * exists), the owner events stream, and the notification pipeline.
 * `setStatus` returning false (unknown id / already terminal) suppresses
 * emission, so a cancelled agent's late session_died is silent.
 */
export class AgentLifecycle {
  constructor(
    private readonly registry: AgentRegistry,
    private readonly ownerEvents: OwnerEventBus,
    private readonly promptEvents?: PromptEventBroadcaster,
    private readonly notifier?: AgentNotifySink,
    /** Read-time cost rollup keyed by sessionId (one source of truth). */
    private readonly costFor?: (sessionId: string) => number | undefined,
  ) {}

  /** Build the wire payload for a record, attaching the live cost rollup. */
  private payloadFor(record: AgentRecord): AgentLifecyclePayload {
    const cost = this.costFor?.(record.sessionId);
    return {
      agentId: record.agentId,
      sessionId: record.sessionId,
      parentSessionId: record.parentSessionId,
      agentType: record.agentType,
      task: record.task,
      status: record.status,
      ...(cost !== undefined ? { costMicrocents: cost } : {}),
    };
  }

  /**
   * Emit one lifecycle frame on all three surfaces. Total: a throwing
   * notifier must never break the caller (notify is best-effort by contract;
   * the void + catch keeps rejections contained).
   */
  emit(type: AgentLifecycleEventType, record: AgentRecord): void {
    const agent = this.payloadFor(record);
    this.ownerEvents.publish({ type, agent });
    if (record.parentSessionId !== null) {
      this.promptEvents?.emit(record.parentSessionId, { type, data: agent });
    }
    void this.notifier
      ?.notify({ type, data: agent }, { sessionId: record.sessionId })
      .catch(() => {});
  }

  /**
   * Feed one daemon session event through the transition table. Wired into
   * SessionEventPump's `onEvent` by the boot wiring (cli.ts). No-op for
   * sessions that back no agent.
   */
  async handleSessionEvent(
    sessionId: string,
    ev: { type: string; data: unknown },
  ): Promise<void> {
    const rec = this.registry.findBySessionId(sessionId);
    if (!rec) return;

    if (ev.type === 'session_died') {
      if (await this.registry.setStatus(rec.agentId, 'failed')) {
        this.emit('agent_failed', this.registry.get(rec.agentId)!);
      }
      return;
    }
    if (ev.type === 'permission_request' && rec.status === 'running') {
      if (await this.registry.setStatus(rec.agentId, 'blocked')) {
        this.emit('agent_blocked', this.registry.get(rec.agentId)!);
      }
      return;
    }
    if (ev.type === 'session_update' && rec.status === 'blocked') {
      // Permission resolved (tool output flowing again) → back to running.
      // Deliberately NO frame: the spec registers exactly five event types.
      await this.registry.setStatus(rec.agentId, 'running');
    }
  }

  /**
   * Called by routes/agents.ts when the agent's daemon prompt settles:
   * resolve → completed, reject (after the spawn accept window) → failed.
   */
  async onPromptSettled(
    agentId: string,
    outcome: 'completed' | 'failed',
  ): Promise<void> {
    if (await this.registry.setStatus(agentId, outcome)) {
      this.emit(
        outcome === 'completed' ? 'agent_completed' : 'agent_failed',
        this.registry.get(agentId)!,
      );
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/evan/projects/qwen-code/packages/rc-gateway && npx vitest run src/agents/agentLifecycle.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/evan/projects/qwen-code
git add packages/rc-gateway/src/agents/agentLifecycle.ts packages/rc-gateway/src/agents/agentLifecycle.test.ts
git commit -m "feat(rc-gateway): agent lifecycle transitions + three-surface frame emission"
```

---

### Task 8: `routes/agents.ts` — the five endpoints (+ stub daemon `POST /session`)

**Files:**

- Modify: `packages/rc-gateway/src/testing/stubDaemon.ts` (add `POST /session` support — the stub currently has NO session-create route, and the SDK's `createOrAttachSession` would 404)
- Create: `packages/rc-gateway/src/routes/agents.ts`
- Test: `packages/rc-gateway/src/routes/agents.test.ts`

**Interfaces:**

- Consumes:
  - Task 5: `AgentRegistry` (`register`, `get`, `list`, `setStatus`), `TERMINAL_AGENT_STATUSES`, `AgentStatus`
  - Task 7: `AgentLifecycle` (`emit`, `onPromptSettled`)
  - Existing: `DaemonClient.createOrAttachSession(req, clientId?)` → `DaemonSession { sessionId, workspaceCwd, attached }`; `DaemonClient.prompt(sessionId, { prompt: PromptContentBlock[] })`; `DaemonClient.endSession(sessionId)`; `AuditRecorder.record(entry)`; `req.rcClient` (`id`, `subActor`) set by `bearerResolve`/`resolveSubActor`
- Produces (used by Task 11):
  - `interface AgentRoutesDeps { daemon: DaemonClient; registry: AgentRegistry; lifecycle: AgentLifecycle; audit?: AuditRecorder; costFor?: (sessionId: string) => number | undefined; promptAcceptWindowMs?: number }`
  - `createSpawnAgentRoute(deps: AgentRoutesDeps): RequestHandler` — `POST /rc/agents`
  - `createListAgentsRoute(deps: AgentRoutesDeps): RequestHandler` — `GET /rc/agents`
  - `createGetAgentRoute(deps: AgentRoutesDeps): RequestHandler` — `GET /rc/agents/:id`
  - `createAgentMessageRoute(deps: AgentRoutesDeps): RequestHandler` — `POST /rc/agents/:id/message`
  - `createAgentCancelRoute(deps: AgentRoutesDeps): RequestHandler` — `POST /rc/agents/:id/cancel`

**Design note (prompt-send failure detection):** `daemon.prompt()` is long-lived — it resolves only when the whole turn ends. The spawn saga therefore races the prompt promise against a short accept window (`promptAcceptWindowMs`, default 1000 ms, injectable to 10–50 ms in tests): an early rejection inside the window is a SEND failure → rollback (end session, mark `failed`, `502 prompt_send_failed`); survival past the window (or early resolution) is a successful spawn → `201`, and the promise's eventual settlement drives `lifecycle.onPromptSettled`.

- [ ] **Step 1: Extend the stub daemon with `POST /session`**

In `packages/rc-gateway/src/testing/stubDaemon.ts`:

1. Add to `StubDaemonOptions`:

```ts
  /** Status for POST /session (default 200). Non-200 → { error }. */
  createSessionStatus?: number;
```

2. Add to the `StubDaemon` interface:

```ts
/** Number of POST /session calls the stub has served. */
createdSessionCount: number;
/** Body of the most recent POST /session request. */
lastCreateSessionBody: unknown;
```

3. Add to the `state` object literal:

```ts
    createdSessionCount: 0,
    lastCreateSessionBody: undefined as unknown,
```

4. Add the route (next to the other `app.post` handlers):

```ts
app.post('/session', (req, res) => {
  const status = opts.createSessionStatus ?? 200;
  state.lastCreateSessionBody = req.body;
  if (status !== 200) {
    res.status(status).json({ error: 'stub error' });
    return;
  }
  state.createdSessionCount += 1;
  res.status(200).json({
    sessionId: `stub-agent-${state.createdSessionCount}`,
    workspaceCwd: opts.workspaceCwd ?? '/stub/workspace',
    attached: false,
  });
});
```

5. Add the getters to the returned object:

```ts
    get createdSessionCount() {
      return state.createdSessionCount;
    },
    get lastCreateSessionBody() {
      return state.lastCreateSessionBody;
    },
```

- [ ] **Step 2: Write the failing route tests**

Create `packages/rc-gateway/src/routes/agents.test.ts` (mirrors the mount pattern of `sessionEnd.test.ts`: express app + fake `rcClient` middleware + `DaemonClient` against the stub):

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonClient } from '@qwen-code/sdk';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import { AgentRegistry } from '../agents/agentRegistry.js';
import { AgentLifecycle } from '../agents/agentLifecycle.js';
import { OwnerEventBus, type OwnerEvent } from '../ownerEvents.js';
import type { AuditEntry, AuditRecorder } from '../auditLog.js';
import {
  createSpawnAgentRoute,
  createListAgentsRoute,
  createGetAgentRoute,
  createAgentMessageRoute,
  createAgentCancelRoute,
  type AgentRoutesDeps,
} from './agents.js';

let gateway: Server | undefined;
let stub: StubDaemon | undefined;

afterEach(async () => {
  if (gateway) await new Promise<void>((r) => gateway!.close(() => r()));
  if (stub) await stub.close();
  gateway = undefined;
  stub = undefined;
});

function fakeAudit(): AuditRecorder & { calls: AuditEntry[] } {
  const calls: AuditEntry[] = [];
  return { calls, record: async (e: AuditEntry) => void calls.push(e) };
}

async function setup(stubOpts: Parameters<typeof startStubDaemon>[0] = {}) {
  stub = await startStubDaemon(stubOpts);
  const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
  const dir = await mkdtemp(join(tmpdir(), 'agents-route-'));
  const registry = await AgentRegistry.open(join(dir, 'agents.json'));
  const ownerEvents = new OwnerEventBus();
  const ownerSeen: OwnerEvent[] = [];
  ownerEvents.subscribe((e) => ownerSeen.push(e));
  const lifecycle = new AgentLifecycle(registry, ownerEvents);
  const audit = fakeAudit();
  const deps: AgentRoutesDeps = {
    daemon,
    registry,
    lifecycle,
    audit,
    costFor: (sid) => (sid.startsWith('stub-agent') ? 5000 : undefined),
    promptAcceptWindowMs: 25,
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { rcClient?: unknown }).rcClient = {
      id: 'tkn-owner',
      scopes: ['write', 'session:read'],
    };
    next();
  });
  app.post('/rc/agents', createSpawnAgentRoute(deps));
  app.get('/rc/agents', createListAgentsRoute(deps));
  app.get('/rc/agents/:id', createGetAgentRoute(deps));
  app.post('/rc/agents/:id/message', createAgentMessageRoute(deps));
  app.post('/rc/agents/:id/cancel', createAgentCancelRoute(deps));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  gateway = server;
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, registry, audit, ownerSeen };
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('POST /rc/agents (spawn saga)', () => {
  it('creates a thread session, registers, prompts, audits, 201', async () => {
    // promptDelayMs keeps the agent running past the accept window.
    const { url, registry, audit, ownerSeen } = await setup({
      promptDelayMs: 500,
    });
    const res = await fetch(`${url}/rc/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'run the tests', agentType: 'general' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { agentId: string; sessionId: string };
    expect(body.sessionId).toBe('stub-agent-1');
    expect(registry.get(body.agentId)?.status).toBe('running');
    expect(stub!.lastCreateSessionBody).toMatchObject({
      sessionScope: 'thread',
    });
    expect(ownerSeen.map((e) => e.type)).toContain('agent_spawned');
    await waitFor(() => audit.calls.some((c) => c.action === 'agent_spawned'));
    const row = audit.calls.find((c) => c.action === 'agent_spawned')!;
    expect(row.actorTokenId).toBe('tkn-owner');
    expect(row.target).toBe(body.agentId);
    expect(JSON.stringify(row)).not.toContain('run the tests');
  });

  it('502 daemon_unavailable when session create fails; nothing registered', async () => {
    const { url, registry } = await setup({ createSessionStatus: 500 });
    const res = await fetch(`${url}/rc/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 't' }),
    });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe(
      'daemon_unavailable',
    );
    expect(registry.list()).toHaveLength(0);
  });

  it('rolls back on prompt-send failure: session ended, record failed, 502', async () => {
    const { url, registry } = await setup({ promptStatus: 500 });
    const res = await fetch(`${url}/rc/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 't' }),
    });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe(
      'prompt_send_failed',
    );
    expect(stub!.lastEndedSessionId).toBe('stub-agent-1');
    expect(registry.list({ status: 'failed' })).toHaveLength(1);
  });

  it('400 invalid_task on a missing/empty task', async () => {
    const { url } = await setup();
    const res = await fetch(`${url}/rc/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /rc/agents + /rc/agents/:id', () => {
  it('lists with filters and read-time cost rollup', async () => {
    const { url, registry } = await setup({ promptDelayMs: 500 });
    const spawn = await fetch(`${url}/rc/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 't', parentSessionId: 'p1' }),
    });
    const { agentId } = (await spawn.json()) as { agentId: string };

    const list = await fetch(`${url}/rc/agents?status=running&parent=p1`);
    const listBody = (await list.json()) as {
      agents: Array<{ agentId: string; costMicrocents?: number }>;
    };
    expect(listBody.agents.map((a) => a.agentId)).toEqual([agentId]);
    expect(listBody.agents[0].costMicrocents).toBe(5000);

    const detail = await fetch(`${url}/rc/agents/${agentId}`);
    expect(detail.status).toBe(200);
    expect(
      ((await detail.json()) as { costMicrocents?: number }).costMicrocents,
    ).toBe(5000);

    const missing = await fetch(`${url}/rc/agents/nope`);
    expect(missing.status).toBe(404);
    expect(registry.get(agentId)?.parentSessionId).toBe('p1');
  });

  it('400 invalid_status on an unknown status filter', async () => {
    const { url } = await setup();
    const res = await fetch(`${url}/rc/agents?status=zombie`);
    expect(res.status).toBe(400);
  });
});

describe('steer + cancel', () => {
  it('message: 202 + agent_message_sent audit; content never audited', async () => {
    const { url, audit } = await setup({ promptDelayMs: 500 });
    const spawn = await fetch(`${url}/rc/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 't' }),
    });
    const { agentId } = (await spawn.json()) as { agentId: string };
    const res = await fetch(`${url}/rc/agents/${agentId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'sekrit-steer-text' }),
    });
    expect(res.status).toBe(202);
    await waitFor(() =>
      audit.calls.some((c) => c.action === 'agent_message_sent'),
    );
    const row = audit.calls.find((c) => c.action === 'agent_message_sent')!;
    expect(JSON.stringify(row)).not.toContain('sekrit-steer-text');
  });

  it('cancel: ends session, marks cancelled, emits agent_cancelled; second cancel 409', async () => {
    const { url, registry, ownerSeen } = await setup({ promptDelayMs: 500 });
    const spawn = await fetch(`${url}/rc/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 't' }),
    });
    const { agentId, sessionId } = (await spawn.json()) as {
      agentId: string;
      sessionId: string;
    };
    const res = await fetch(`${url}/rc/agents/${agentId}/cancel`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(stub!.lastEndedSessionId).toBe(sessionId);
    expect(registry.get(agentId)?.status).toBe('cancelled');
    expect(ownerSeen.map((e) => e.type)).toContain('agent_cancelled');

    const again = await fetch(`${url}/rc/agents/${agentId}/cancel`, {
      method: 'POST',
    });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe(
      'agent_not_running',
    );
  });

  it('message on a terminal agent → 409 agent_not_running', async () => {
    const { url, registry } = await setup({ promptDelayMs: 500 });
    const spawn = await fetch(`${url}/rc/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 't' }),
    });
    const { agentId } = (await spawn.json()) as { agentId: string };
    await registry.setStatus(agentId, 'completed');
    const res = await fetch(`${url}/rc/agents/${agentId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'x' }),
    });
    expect(res.status).toBe(409);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd /home/evan/projects/qwen-code/packages/rc-gateway && npx vitest run src/routes/agents.test.ts`
Expected: FAIL — cannot resolve `./agents.js`.

- [ ] **Step 4: Write the implementation**

Create `packages/rc-gateway/src/routes/agents.ts`:

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { DaemonClient } from '@qwen-code/sdk';
import type { AuditRecorder } from '../auditLog.js';
import {
  TERMINAL_AGENT_STATUSES,
  type AgentRecord,
  type AgentRegistry,
  type AgentStatus,
} from '../agents/agentRegistry.js';
import type { AgentLifecycle } from '../agents/agentLifecycle.js';

const AGENT_STATUSES: readonly AgentStatus[] = [
  'running',
  'blocked',
  'completed',
  'failed',
  'cancelled',
  'orphaned',
];

export interface AgentRoutesDeps {
  daemon: DaemonClient;
  registry: AgentRegistry;
  lifecycle: AgentLifecycle;
  audit?: AuditRecorder;
  /** Read-time cost rollup keyed by sessionId; absent → no costMicrocents. */
  costFor?: (sessionId: string) => number | undefined;
  /**
   * ms to wait for an EARLY prompt rejection before accepting the spawn.
   * daemon.prompt() is long-lived (resolves at end of turn), so a bounded
   * race is how "prompt SEND failed" is distinguished from "turn running".
   * Default 1000; tests inject 10–50 ms.
   */
  promptAcceptWindowMs?: number;
}

/** A record plus its read-time cost rollup (design: one source of truth). */
function withCost(
  rec: AgentRecord,
  costFor?: (sessionId: string) => number | undefined,
): AgentRecord & { costMicrocents?: number } {
  const cost = costFor?.(rec.sessionId);
  return cost !== undefined ? { ...rec, costMicrocents: cost } : { ...rec };
}

/**
 * POST /rc/agents — spawn saga (design: create session → register → send
 * prompt; a prompt-send failure ends the session and marks the record
 * failed — no half-spawned agents). WRITE scope enforced at the mount.
 */
export function createSpawnAgentRoute(deps: AgentRoutesDeps): RequestHandler {
  const acceptMs = deps.promptAcceptWindowMs ?? 1000;
  return async (req, res) => {
    const body = (req.body ?? {}) as {
      task?: unknown;
      agentType?: unknown;
      parentSessionId?: unknown;
      model?: unknown;
    };
    if (typeof body.task !== 'string' || body.task.length === 0) {
      res.status(400).json({ error: 'Invalid task', code: 'invalid_task' });
      return;
    }
    const task = body.task;
    const agentType =
      typeof body.agentType === 'string' && body.agentType.length > 0
        ? body.agentType
        : 'general';
    const parentSessionId =
      typeof body.parentSessionId === 'string' ? body.parentSessionId : null;
    const model = typeof body.model === 'string' ? body.model : undefined;

    // Saga leg 1: create a DEDICATED daemon session. sessionScope 'thread'
    // forces a distinct session (the daemon default 'single' would coalesce
    // the agent onto an existing session).
    let sessionId: string;
    try {
      const session = await deps.daemon.createOrAttachSession({
        sessionScope: 'thread',
        ...(model !== undefined ? { modelServiceId: model } : {}),
      });
      sessionId = session.sessionId;
    } catch {
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
      return;
    }

    // Saga leg 2: register.
    const record = await deps.registry.register({
      sessionId,
      parentSessionId,
      agentType,
      task,
      spawnedByTokenId: req.rcClient?.id ?? '',
      ...(req.rcClient?.subActor !== undefined
        ? { subActor: req.rcClient.subActor }
        : {}),
    });

    // Saga leg 3: send the task prompt. Race an early rejection against the
    // accept window; survival (or early resolution) accepts the spawn.
    const promptPromise = deps.daemon.prompt(sessionId, {
      prompt: [{ type: 'text', text: task }],
    });
    let acceptTimer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      promptPromise.then(
        () => 'settled' as const,
        () => 'send_failed' as const,
      ),
      new Promise<'accepted'>((resolve) => {
        acceptTimer = setTimeout(() => resolve('accepted'), acceptMs);
        acceptTimer.unref?.();
      }),
    ]);
    clearTimeout(acceptTimer);

    if (outcome === 'send_failed') {
      // Rollback: no zombie sessions, no half-spawned agents.
      try {
        await deps.daemon.endSession(sessionId);
      } catch {
        // Best-effort — the daemon may already have dropped the session.
      }
      await deps.registry.setStatus(record.agentId, 'failed');
      res
        .status(502)
        .json({ error: 'Prompt send failed', code: 'prompt_send_failed' });
      return;
    }

    // Spawned. The prompt's eventual settlement drives completed/failed.
    // (If it already resolved — 'settled' — these handlers fire immediately.)
    void promptPromise.then(
      () => deps.lifecycle.onPromptSettled(record.agentId, 'completed'),
      () => deps.lifecycle.onPromptSettled(record.agentId, 'failed'),
    );

    deps.lifecycle.emit('agent_spawned', deps.registry.get(record.agentId)!);
    void deps.audit?.record({
      action: 'agent_spawned',
      actorTokenId: req.rcClient?.id,
      subActor: req.rcClient?.subActor,
      target: record.agentId,
      // NEVER the task text — ids and metadata only.
      detail: { sessionId, agentType, parentSessionId },
    });

    res.status(201).json({ agentId: record.agentId, sessionId });
  };
}

/** GET /rc/agents?status=&parent= — SESSION_READ scope at the mount. */
export function createListAgentsRoute(deps: AgentRoutesDeps): RequestHandler {
  return (req, res) => {
    const statusRaw = req.query['status'];
    let status: AgentStatus | undefined;
    if (typeof statusRaw === 'string' && statusRaw.length > 0) {
      if (!AGENT_STATUSES.includes(statusRaw as AgentStatus)) {
        res
          .status(400)
          .json({ error: 'Invalid status', code: 'invalid_status' });
        return;
      }
      status = statusRaw as AgentStatus;
    }
    const parentRaw = req.query['parent'];
    const parent = typeof parentRaw === 'string' ? parentRaw : undefined;
    const agents = deps.registry
      .list({ status, parent })
      .map((r) => withCost(r, deps.costFor));
    res.status(200).json({ agents });
  };
}

/** GET /rc/agents/:id — SESSION_READ scope at the mount. */
export function createGetAgentRoute(deps: AgentRoutesDeps): RequestHandler {
  return (req, res) => {
    const rec = deps.registry.get(req.params.id);
    if (!rec) {
      res.status(404).json({ error: 'Unknown agent', code: 'agent_not_found' });
      return;
    }
    res.status(200).json(withCost(rec, deps.costFor));
  };
}

/**
 * POST /rc/agents/:id/message { content } — steer. Proxies content as a
 * prompt to the agent's own session. WRITE scope at the mount. Content is
 * NEVER audited (mirror prompt_sent).
 */
export function createAgentMessageRoute(deps: AgentRoutesDeps): RequestHandler {
  return async (req, res) => {
    const rec = deps.registry.get(req.params.id);
    if (!rec) {
      res.status(404).json({ error: 'Unknown agent', code: 'agent_not_found' });
      return;
    }
    if (TERMINAL_AGENT_STATUSES.has(rec.status)) {
      res
        .status(409)
        .json({ error: 'Agent not running', code: 'agent_not_running' });
      return;
    }
    const body = (req.body ?? {}) as { content?: unknown };
    if (typeof body.content !== 'string' || body.content.length === 0) {
      res
        .status(400)
        .json({ error: 'Invalid content', code: 'invalid_content' });
      return;
    }
    // Long-lived turn: fire, and let settlement drive the lifecycle.
    void deps.daemon
      .prompt(rec.sessionId, { prompt: [{ type: 'text', text: body.content }] })
      .then(
        () => deps.lifecycle.onPromptSettled(rec.agentId, 'completed'),
        () => deps.lifecycle.onPromptSettled(rec.agentId, 'failed'),
      );
    void deps.audit?.record({
      action: 'agent_message_sent',
      actorTokenId: req.rcClient?.id,
      subActor: req.rcClient?.subActor,
      target: rec.agentId,
      detail: { sessionId: rec.sessionId, contentLength: body.content.length },
    });
    res.status(202).json({ agentId: rec.agentId, accepted: true });
  };
}

/**
 * POST /rc/agents/:id/cancel — proxies to the daemon's session end (the
 * same call sessionEnd.ts makes) and marks the record cancelled. WRITE
 * scope at the mount. 409 agent_not_running on terminal records.
 */
export function createAgentCancelRoute(deps: AgentRoutesDeps): RequestHandler {
  return async (req, res) => {
    const rec = deps.registry.get(req.params.id);
    if (!rec) {
      res.status(404).json({ error: 'Unknown agent', code: 'agent_not_found' });
      return;
    }
    if (TERMINAL_AGENT_STATUSES.has(rec.status)) {
      res
        .status(409)
        .json({ error: 'Agent not running', code: 'agent_not_running' });
      return;
    }
    try {
      await deps.daemon.endSession(rec.sessionId);
    } catch {
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
      return;
    }
    await deps.registry.setStatus(rec.agentId, 'cancelled');
    deps.lifecycle.emit('agent_cancelled', deps.registry.get(rec.agentId)!);
    void deps.audit?.record({
      action: 'agent_cancelled',
      actorTokenId: req.rcClient?.id,
      subActor: req.rcClient?.subActor,
      target: rec.agentId,
      detail: { sessionId: rec.sessionId },
    });
    res.status(200).json({ agentId: rec.agentId, status: 'cancelled' });
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /home/evan/projects/qwen-code/packages/rc-gateway && npx vitest run src/routes/agents.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
cd /home/evan/projects/qwen-code
git add packages/rc-gateway/src/routes/agents.ts packages/rc-gateway/src/routes/agents.test.ts packages/rc-gateway/src/testing/stubDaemon.ts
git commit -m "feat(rc-gateway): /rc/agents control plane with spawn saga + rollback"
```

---

### Task 9: Hook ingest — persistent token + `routes/hookIngest.ts`

**Files:**

- Create: `packages/rc-gateway/src/agents/hookIngestToken.ts`
- Create: `packages/rc-gateway/src/routes/hookIngest.ts`
- Test: `packages/rc-gateway/src/routes/hookIngest.test.ts`

**Interfaces:**

- Consumes: Task 6's `OwnerEvent` `hook_event` variant; `OwnerEventBus.publish`; `AuditRecorder`.
- Produces (used by Tasks 11, 12):
  - `async function loadOrCreateHookIngestToken(filePath: string): Promise<string>` (from `agents/hookIngestToken.ts`) — mints once (`randomBytes(32).toString('base64url')`, file mode 0600), returns the existing token on subsequent calls (regenerating per start would invalidate existing hook config).
  - `interface HookIngestDeps { ownerEvents: OwnerEventBus; ingestToken: string; audit?: AuditRecorder; bucketCapacity?: number; bucketRefillPerSec?: number; now?: () => number }`
  - `createHookIngestRoute(deps: HookIngestDeps): RequestHandler` — `POST /rc/hooks/ingest`. MUST be mounted BEFORE the gateway's `bearerResolve` middleware (the ingest token is not a `TokenStore` token; `bearerResolve` would 401 it — same reason `POST /rc/pair/redeem` mounts early).

- [ ] **Step 1: Write the failing tests**

Create `packages/rc-gateway/src/routes/hookIngest.test.ts`:

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnerEventBus, type OwnerEvent } from '../ownerEvents.js';
import type { AuditEntry, AuditRecorder } from '../auditLog.js';
import { loadOrCreateHookIngestToken } from '../agents/hookIngestToken.js';
import { createHookIngestRoute, type HookIngestDeps } from './hookIngest.js';

let gateway: Server | undefined;

afterEach(async () => {
  if (gateway) await new Promise<void>((r) => gateway!.close(() => r()));
  gateway = undefined;
});

function fakeAudit(): AuditRecorder & { calls: AuditEntry[] } {
  const calls: AuditEntry[] = [];
  return { calls, record: async (e: AuditEntry) => void calls.push(e) };
}

async function mount(over: Partial<HookIngestDeps> = {}) {
  const ownerEvents = new OwnerEventBus();
  const seen: OwnerEvent[] = [];
  ownerEvents.subscribe((e) => seen.push(e));
  const audit = fakeAudit();
  const deps: HookIngestDeps = {
    ownerEvents,
    ingestToken: 'hook-token-1',
    audit,
    ...over,
  };
  const app = express();
  app.use(express.json());
  app.post('/rc/hooks/ingest', createHookIngestRoute(deps));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  gateway = server;
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen, audit };
}

function post(url: string, body: unknown, token = 'hook-token-1') {
  return fetch(`${url}/rc/hooks/ingest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

describe('loadOrCreateHookIngestToken', () => {
  it('mints once at 0600 and returns the same token on reload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hook-token-'));
    const path = join(dir, 'hook-ingest-token');
    const t1 = await loadOrCreateHookIngestToken(path);
    const t2 = await loadOrCreateHookIngestToken(path);
    expect(t1).toBe(t2);
    expect(t1.length).toBeGreaterThanOrEqual(32);
    expect((await readFile(path, 'utf8')).trim()).toBe(t1);
    expect(((await stat(path)).mode & 0o777).toString(8)).toBe('600');
  });
});

describe('POST /rc/hooks/ingest', () => {
  it('mirrors a valid envelope as hook_event on the owner stream', async () => {
    const { url, seen } = await mount();
    const res = await post(url, {
      event: 'PreToolUse',
      sessionId: 's1',
      toolName: 'Bash',
      payload: { command: 'ls' },
    });
    expect(res.status).toBe(202);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      type: 'hook_event',
      event: 'PreToolUse',
      toolName: 'Bash',
    });
    // No drops so far → no dropped field on the frame.
    expect(
      (seen[0] as Extract<OwnerEvent, { type: 'hook_event' }>).dropped,
    ).toBeUndefined();
  });

  it('401s a wrong token, audits hook_ingest_rejected, mirrors nothing', async () => {
    const { url, seen, audit } = await mount();
    const res = await post(url, { event: 'PreToolUse', payload: {} }, 'nope');
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
    expect(audit.calls.some((c) => c.action === 'hook_ingest_rejected')).toBe(
      true,
    );
  });

  it('400s an invalid envelope', async () => {
    const { url, seen } = await mount();
    const res = await post(url, { notAnEvent: true });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe(
      'invalid_hook_envelope',
    );
    expect(seen).toHaveLength(0);
  });

  it('drops on bucket overflow and surfaces the count on the next frame', async () => {
    let nowMs = 1_000_000;
    const { url, seen } = await mount({
      bucketCapacity: 2,
      bucketRefillPerSec: 1,
      now: () => nowMs,
    });
    // Two pass, third and fourth drop (bucket empty, clock frozen).
    expect((await post(url, { event: 'e1', payload: {} })).status).toBe(202);
    expect((await post(url, { event: 'e2', payload: {} })).status).toBe(202);
    expect((await post(url, { event: 'e3', payload: {} })).status).toBe(202);
    expect((await post(url, { event: 'e4', payload: {} })).status).toBe(202);
    expect(seen).toHaveLength(2);
    // Refill one token; the next mirrored frame carries dropped: 2.
    nowMs += 1000;
    expect((await post(url, { event: 'e5', payload: {} })).status).toBe(202);
    expect(seen).toHaveLength(3);
    expect(seen[2]).toMatchObject({ type: 'hook_event', dropped: 2 });
    // Counter resets after being surfaced.
    nowMs += 1000;
    await post(url, { event: 'e6', payload: {} });
    expect(
      (seen[3] as Extract<OwnerEvent, { type: 'hook_event' }>).dropped,
    ).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/evan/projects/qwen-code/packages/rc-gateway && npx vitest run src/routes/hookIngest.test.ts`
Expected: FAIL — cannot resolve `../agents/hookIngestToken.js` / `./hookIngest.js`.

- [ ] **Step 3: Write `agents/hookIngestToken.ts`**

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Load (or mint exactly once) the dedicated hook-ingest token (design:
 * "minted once on first startup and persisted — regenerating per start
 * would invalidate existing hook config — written 0600"). The docs snippet
 * that configures core's HTTP hook runner interpolates this value; it is
 * NOT a TokenStore token and grants nothing beyond POST /rc/hooks/ingest.
 */
export async function loadOrCreateHookIngestToken(
  filePath: string,
): Promise<string> {
  try {
    const existing = (await readFile(filePath, 'utf8')).trim();
    if (existing.length > 0) return existing;
  } catch {
    // Missing file → mint below.
  }
  const token = randomBytes(32).toString('base64url');
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, token + '\n', { mode: 0o600 });
  return token;
}
```

- [ ] **Step 4: Write `routes/hookIngest.ts`**

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { OwnerEventBus } from '../ownerEvents.js';
import type { AuditRecorder } from '../auditLog.js';

/** Default token-bucket sizing: 50 burst, 10/s sustained. */
const DEFAULT_BUCKET_CAPACITY = 50;
const DEFAULT_REFILL_PER_SEC = 10;

export interface HookIngestDeps {
  ownerEvents: OwnerEventBus;
  /** The persistent ingest token (agents/hookIngestToken.ts). */
  ingestToken: string;
  audit?: AuditRecorder;
  bucketCapacity?: number;
  bucketRefillPerSec?: number;
  /** Injectable clock for deterministic rate-limit tests. */
  now?: () => number;
}

/** Continuous-refill token bucket. Pure arithmetic; no timers. */
class TokenBucket {
  private tokens: number;
  private lastMs: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    nowMs: number,
  ) {
    this.tokens = capacity;
    this.lastMs = nowMs;
  }

  tryTake(nowMs: number): boolean {
    const elapsedSec = Math.max(0, nowMs - this.lastMs) / 1000;
    this.tokens = Math.min(
      this.capacity,
      this.tokens + elapsedSec * this.refillPerSec,
    );
    this.lastMs = nowMs;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/** Loopback remote addresses (the gateway may bind loopback OR LAN+TLS). */
function isLoopbackRemote(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

/** Constant-time bearer comparison against the ingest token. */
function tokenMatches(header: string | undefined, expected: string): boolean {
  if (!header || !header.startsWith('Bearer ')) return false;
  const got = Buffer.from(header.slice(7).trim(), 'utf8');
  const want = Buffer.from(expected, 'utf8');
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * POST /rc/hooks/ingest — read-only hook mirror (design: "Hook event
 * mirror"). MUST be mounted BEFORE bearerResolve: the ingest token is not
 * a TokenStore token (same early-mount reason as POST /rc/pair/redeem).
 *
 * Order of gates: loopback (403) → ingest token (401) → envelope (400) →
 * token bucket (drop, 202 { accepted: false }). Rejections are audited
 * (`hook_ingest_rejected`) and NEVER mirrored. Overflow DROPS instead of
 * 429-ing (a hook runner must never enter a retry loop); the dropped count
 * is surfaced as `dropped: n` on the NEXT mirrored frame. Frames go to the
 * OWNER events stream only — hook payloads carry tool arguments, too
 * sensitive for read-scope session streams.
 */
export function createHookIngestRoute(deps: HookIngestDeps): RequestHandler {
  const now = deps.now ?? Date.now;
  const bucket = new TokenBucket(
    deps.bucketCapacity ?? DEFAULT_BUCKET_CAPACITY,
    deps.bucketRefillPerSec ?? DEFAULT_REFILL_PER_SEC,
    now(),
  );
  let droppedSinceLastMirror = 0;

  return (req, res) => {
    if (!isLoopbackRemote(req.socket.remoteAddress ?? undefined)) {
      void deps.audit?.record({
        action: 'hook_ingest_rejected',
        detail: { reason: 'non_loopback' },
      });
      res.status(403).json({ error: 'Loopback only', code: 'loopback_only' });
      return;
    }
    if (!tokenMatches(req.headers.authorization, deps.ingestToken)) {
      void deps.audit?.record({
        action: 'hook_ingest_rejected',
        detail: { reason: 'bad_token' },
      });
      res.status(401).json({ error: 'Unauthorized', code: 'unauthorized' });
      return;
    }

    const body = (req.body ?? {}) as {
      event?: unknown;
      sessionId?: unknown;
      toolName?: unknown;
      payload?: unknown;
    };
    const validOptional = (v: unknown): v is string | undefined =>
      v === undefined || typeof v === 'string';
    if (
      typeof body.event !== 'string' ||
      body.event.length === 0 ||
      !validOptional(body.sessionId) ||
      !validOptional(body.toolName)
    ) {
      res.status(400).json({
        error: 'Invalid hook envelope',
        code: 'invalid_hook_envelope',
      });
      return;
    }

    if (!bucket.tryTake(now())) {
      droppedSinceLastMirror += 1;
      // Drop, never 429: the hook runner must not retry-loop. 202 keeps the
      // runner's fire-and-forget POST happy.
      res.status(202).json({ accepted: false, dropped: true });
      return;
    }

    const dropped = droppedSinceLastMirror;
    droppedSinceLastMirror = 0;
    deps.ownerEvents.publish({
      type: 'hook_event',
      event: body.event,
      ...(body.sessionId !== undefined ? { sessionId: body.sessionId } : {}),
      ...(body.toolName !== undefined ? { toolName: body.toolName } : {}),
      payload: body.payload,
      ...(dropped > 0 ? { dropped } : {}),
    });
    res.status(202).json({ accepted: true });
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /home/evan/projects/qwen-code/packages/rc-gateway && npx vitest run src/routes/hookIngest.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
cd /home/evan/projects/qwen-code
git add packages/rc-gateway/src/agents/hookIngestToken.ts packages/rc-gateway/src/routes/hookIngest.ts packages/rc-gateway/src/routes/hookIngest.test.ts
git commit -m "feat(rc-gateway): loopback hook ingest with persistent token + drop-on-overflow bucket"
```

---

### Task 10: Notification kinds — `agent.*` routable, `agent.blocked` critical

**Files:**

- Modify: `packages/rc-gateway/src/webpush/payload.ts` (`buildPayload` gains the five agent event types)
- Modify: `packages/rc-gateway/src/webpush/notifier.ts` (`KIND_SCOPE` + `SNOOZE_BYPASS_KINDS`)
- Test: `packages/rc-gateway/src/webpush/payload.test.ts` (append)

**Interfaces:**

- Consumes: Task 6 event-type names (`agent_spawned` … `agent_cancelled`); existing `buildPayload(event, ctx): PushPayload | null`, `KIND_SCOPE: Record<string, RcScope>`, `SNOOZE_BYPASS_KINDS: Set<string>`, `SESSION_READ`.
- Produces: kinds `agent.spawned`, `agent.completed`, `agent.failed`, `agent.blocked`, `agent.cancelled` — flowing through `PushNotifier.notify` (which Task 7's `AgentLifecycle.emit` already calls), and therefore through routing rules (`RoutingMatcher.firstDrop({ kind, sessionName })`), quiet hours, snooze, and bridges with ZERO notifier-code changes beyond these two maps. Exports `AGENT_EVENT_KINDS` from `payload.ts` for reuse.

- [ ] **Step 1: Write the failing tests**

Append to `packages/rc-gateway/src/webpush/payload.test.ts` (reuse its existing imports; add `AGENT_EVENT_KINDS` to the import from `./payload.js`):

```ts
describe('agent lifecycle payloads', () => {
  it('maps each lifecycle event type to its dot-kind with a metadata-only summary', () => {
    const data = {
      agentId: 'a1',
      sessionId: 's1',
      parentSessionId: null,
      agentType: 'general',
      task: 'sekrit task text',
      status: 'completed',
      costMicrocents: 5000,
    };
    const p = buildPayload(
      { type: 'agent_completed', data },
      { sessionId: 's1', sessionName: 'agent run' },
    );
    expect(p).not.toBeNull();
    expect(p!.kind).toBe('agent.completed');
    expect(p!.sessionId).toBe('s1');
    // Metadata only — the task text must NEVER reach a push payload.
    expect(JSON.stringify(p)).not.toContain('sekrit task text');
    expect(AGENT_EVENT_KINDS['agent_blocked']).toBe('agent.blocked');
    for (const t of [
      'agent_spawned',
      'agent_failed',
      'agent_blocked',
      'agent_cancelled',
    ]) {
      const built = buildPayload(
        { type: t, data: { ...data, status: t.slice(6) } },
        { sessionId: 's1' },
      );
      expect(built?.kind).toBe(AGENT_EVENT_KINDS[t]);
    }
  });
});
```

Create `packages/rc-gateway/src/webpush/notifierAgentKinds.test.ts`:

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { KIND_SCOPE, SNOOZE_BYPASS_KINDS } from './notifier.js';
import { SESSION_READ } from '../scopes.js';

describe('agent notification kinds', () => {
  it('scope-gates all five agent kinds at session:read', () => {
    for (const kind of [
      'agent.spawned',
      'agent.completed',
      'agent.failed',
      'agent.blocked',
      'agent.cancelled',
    ]) {
      expect(KIND_SCOPE[kind]).toBe(SESSION_READ);
    }
  });

  it('agent.blocked is a critical (snooze-bypass) kind; the others are not', () => {
    expect(SNOOZE_BYPASS_KINDS.has('agent.blocked')).toBe(true);
    expect(SNOOZE_BYPASS_KINDS.has('agent.completed')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/evan/projects/qwen-code/packages/rc-gateway && npx vitest run src/webpush/payload.test.ts src/webpush/notifierAgentKinds.test.ts`
Expected: FAIL — `AGENT_EVENT_KINDS`/`KIND_SCOPE`/`SNOOZE_BYPASS_KINDS` not exported; `buildPayload` returns null for agent types.

- [ ] **Step 3: Extend `payload.ts`**

In `packages/rc-gateway/src/webpush/payload.ts`, add after `sessionUrl`:

```ts
/**
 * Lifecycle SSE event type → routable notification kind (dot convention,
 * matching 'permission.required'). Exported so wiring/tests share one map.
 */
export const AGENT_EVENT_KINDS: Record<string, string> = {
  agent_spawned: 'agent.spawned',
  agent_completed: 'agent.completed',
  agent_failed: 'agent.failed',
  agent_blocked: 'agent.blocked',
  agent_cancelled: 'agent.cancelled',
};
```

Inside `buildPayload`, add a pre-`switch` guard (the keys are dynamic, so this lives after the `const data = ...` line and BEFORE the `switch`, not as a `case`):

```ts
// Agent lifecycle events (add-agent-observability). Metadata only: the
// agent's TASK TEXT never reaches a push payload — only type + status.
const agentKind = AGENT_EVENT_KINDS[event.type];
if (agentKind !== undefined) {
  const agentType =
    typeof data.agentType === 'string' && data.agentType.length > 0
      ? data.agentType
      : 'agent';
  const status =
    typeof data.status === 'string' ? data.status : event.type.slice(6);
  return {
    v: 1,
    kind: agentKind,
    sessionId: ctx.sessionId,
    ...(ctx.sessionName ? { sessionName: ctx.sessionName } : {}),
    summary: truncate(`Agent ${status}: ${agentType}`),
    url: sessionUrl(ctx.sessionId),
  };
}
```

- [ ] **Step 4: Extend `notifier.ts`**

In `packages/rc-gateway/src/webpush/notifier.ts`:

1. Export and extend the bypass set (was `const SNOOZE_BYPASS_KINDS = new Set(['session.died', 'policy.deny']);`):

```ts
export const SNOOZE_BYPASS_KINDS = new Set([
  'session.died',
  'policy.deny',
  // A blocked agent needs a human — quiet-hours/snooze bypass (design:
  // "agent_blocked is a candidate critical kind").
  'agent.blocked',
]);
```

2. Export and extend `KIND_SCOPE` (was `const KIND_SCOPE: Record<string, RcScope> = { ... }`):

```ts
export const KIND_SCOPE: Record<string, RcScope> = {
  'permission.required': APPROVE,
  'task.completed': SESSION_READ,
  'agent.spawned': SESSION_READ,
  'agent.completed': SESSION_READ,
  'agent.failed': SESSION_READ,
  'agent.blocked': SESSION_READ,
  'agent.cancelled': SESSION_READ,
};
```

- [ ] **Step 5: Run tests to verify they pass, then the full suite**

Run: `cd /home/evan/projects/qwen-code/packages/rc-gateway && npx vitest run src/webpush/`
Expected: PASS, including all pre-existing webpush tests (the quiet-hours digest and routing tests key off kinds generically).

- [ ] **Step 6: Commit**

```bash
cd /home/evan/projects/qwen-code
git add packages/rc-gateway/src/webpush/payload.ts packages/rc-gateway/src/webpush/payload.test.ts packages/rc-gateway/src/webpush/notifier.ts packages/rc-gateway/src/webpush/notifierAgentKinds.test.ts
git commit -m "feat(rc-gateway): agent.* notification kinds; agent.blocked bypasses snooze"
```

---

### Task 11: `server.ts` wiring — deps, mounts, cost rollup

**Files:**

- Modify: `packages/rc-gateway/src/server.ts`
- Test: `packages/rc-gateway/src/server.agents.test.ts` (new, self-contained — do NOT entangle with server.test.ts's helpers)

**Interfaces:**

- Consumes: Tasks 5–10 exports; existing `createGatewayApp(deps: GatewayDeps): GatewayApp`, `requireScope`, `WRITE`, `SESSION_READ`, the internal `promptEventBroadcaster` and `ownerEvents` instances, and the `notifier` built in the vapid/pushStore block.
- Produces (used by Tasks 12, 13):
  - `GatewayDeps` gains:
    ```ts
    /** Agent observability (add-agent-observability). Routes mount only when set. */
    agents?: {
      registry: AgentRegistry;
      /** Read-time cost rollup keyed by sessionId (UsageStore.sessionTotals). */
      costFor?: (sessionId: string) => number | undefined;
      /** Spawn accept window override (tests). */
      promptAcceptWindowMs?: number;
    };
    /** Persistent hook-ingest token. POST /rc/hooks/ingest mounts only when set. */
    hookIngestToken?: string;
    ```
  - `GatewayApp` gains:
    ```ts
    /** Per-session gateway-event fan-out (exposed for the agent lifecycle). */
    promptEvents: PromptEventBroadcaster;
    /** Present only when deps.agents is supplied. */
    agentLifecycle?: AgentLifecycle;
    ```

- [ ] **Step 1: Write the failing test**

Create `packages/rc-gateway/src/server.agents.test.ts` (self-contained; real tokens so `bearerResolve` + `requireScope` run for real):

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonClient } from '@qwen-code/sdk';
import { createGatewayApp, type GatewayApp } from './server.js';
import { TokenStore } from './tokenStore.js';
import { PairingService } from './pairing.js';
import { AgentRegistry } from './agents/agentRegistry.js';
import { PromptEventBroadcaster } from './routes/promptEventBroadcaster.js';
import { startStubDaemon, type StubDaemon } from './testing/stubDaemon.js';
import type { OwnerEvent } from './ownerEvents.js';

let server: Server | undefined;
let stub: StubDaemon | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  if (stub) await stub.close();
  server = undefined;
  stub = undefined;
});

async function setup() {
  stub = await startStubDaemon({ promptDelayMs: 2000 });
  const dir = await mkdtemp(join(tmpdir(), 'srv-agents-'));
  const store = await TokenStore.open(join(dir, 'tokens.json'));
  const writeTok = (await store.issue(['write', 'session:read'], 'w')).token;
  const readTok = (await store.issue(['session:read'], 'r')).token;
  const registry = await AgentRegistry.open(join(dir, 'agents.json'));
  const gw: GatewayApp = createGatewayApp({
    daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
    store,
    pairing: new PairingService(),
    auditPath: join(dir, 'audit.log'),
    agents: { registry, costFor: () => 7777, promptAcceptWindowMs: 25 },
    hookIngestToken: 'hook-token-1',
  });
  const frames: OwnerEvent[] = [];
  gw.ownerEvents.subscribe((e) => frames.push(e));
  server = await new Promise((resolve) => {
    const s = gw.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server!.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    gw,
    registry,
    frames,
    writeTok,
    readTok,
  };
}

describe('agent observability wiring', () => {
  it('mounts the /rc/agents routes with scope gates and cost rollup', async () => {
    const { url, registry, writeTok, readTok } = await setup();

    // No token → 401 from bearerResolve.
    expect((await fetch(`${url}/rc/agents`)).status).toBe(401);

    // read-scope token cannot spawn → 403 scope_required.
    const denied = await fetch(`${url}/rc/agents`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${readTok}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ task: 't' }),
    });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { code: string }).code).toBe(
      'scope_required',
    );

    // write-scope spawn → 201, registered.
    const spawn = await fetch(`${url}/rc/agents`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${writeTok}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ task: 't' }),
    });
    expect(spawn.status).toBe(201);
    const { agentId } = (await spawn.json()) as { agentId: string };
    expect(registry.get(agentId)?.status).toBe('running');

    // read-scope list → 200 with the read-time cost rollup.
    const list = await fetch(`${url}/rc/agents`, {
      headers: { Authorization: `Bearer ${readTok}` },
    });
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      agents: Array<{ costMicrocents?: number }>;
    };
    expect(body.agents[0].costMicrocents).toBe(7777);
  });

  it('serves POST /rc/hooks/ingest without a TokenStore bearer (pre-auth mount)', async () => {
    const { url, frames } = await setup();
    const res = await fetch(`${url}/rc/hooks/ingest`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer hook-token-1', // NOT a TokenStore token
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ event: 'PreToolUse', payload: {} }),
    });
    expect(res.status).toBe(202);
    expect(frames.some((f) => f.type === 'hook_event')).toBe(true);
  });

  it('returns promptEvents and agentLifecycle on the GatewayApp handle', async () => {
    const { gw } = await setup();
    expect(gw.promptEvents).toBeInstanceOf(PromptEventBroadcaster);
    expect(gw.agentLifecycle).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/evan/projects/qwen-code/packages/rc-gateway && npx vitest run src/server.agents.test.ts`
Expected: FAIL — `agents`/`hookIngestToken` not in `GatewayDeps`; `promptEvents` not on `GatewayApp`.

- [ ] **Step 3: Wire `server.ts`**

1. Add imports:

```ts
import type { AgentRegistry } from './agents/agentRegistry.js';
import { AgentLifecycle } from './agents/agentLifecycle.js';
import {
  createSpawnAgentRoute,
  createListAgentsRoute,
  createGetAgentRoute,
  createAgentMessageRoute,
  createAgentCancelRoute,
} from './routes/agents.js';
import { createHookIngestRoute } from './routes/hookIngest.js';
```

2. Add the two `GatewayDeps` fields and two `GatewayApp` fields exactly as in this task's Interfaces block.

3. Mount the hook ingest route EARLY — immediately after the `app.post('/rc/pair/redeem', ...)` mount and before `app.use(bearerResolve(...))`:

```ts
// Hook-event mirror (add-agent-observability). Mounted BEFORE bearerResolve:
// the ingest token is a dedicated secret, not a TokenStore token — the
// bearer middleware would 401 it (same early-mount reason as pair/redeem).
if (deps.hookIngestToken) {
  app.post(
    '/rc/hooks/ingest',
    createHookIngestRoute({
      ownerEvents,
      ingestToken: deps.hookIngestToken,
      audit,
    }),
  );
}
```

4. After the `notifier` block (the `if (deps.vapid && deps.pushStore) { ... }` section), create the lifecycle and mount the agent routes:

```ts
// Agent observability control plane (add-agent-observability).
let agentLifecycle: AgentLifecycle | undefined;
if (deps.agents) {
  agentLifecycle = new AgentLifecycle(
    deps.agents.registry,
    ownerEvents,
    promptEventBroadcaster,
    notifier,
    deps.agents.costFor,
  );
  const agentDeps = {
    daemon: deps.daemon,
    registry: deps.agents.registry,
    lifecycle: agentLifecycle,
    audit,
    costFor: deps.agents.costFor,
    promptAcceptWindowMs: deps.agents.promptAcceptWindowMs,
  };
  app.post(
    '/rc/agents',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    createSpawnAgentRoute(agentDeps),
  );
  app.get(
    '/rc/agents',
    requireScope(SESSION_READ, audit),
    createListAgentsRoute(agentDeps),
  );
  app.get(
    '/rc/agents/:id',
    requireScope(SESSION_READ, audit),
    createGetAgentRoute(agentDeps),
  );
  app.post(
    '/rc/agents/:id/message',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    createAgentMessageRoute(agentDeps),
  );
  app.post(
    '/rc/agents/:id/cancel',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    createAgentCancelRoute(agentDeps),
  );
}
```

5. Extend the return:

```ts
return {
  app,
  notifier,
  audit,
  ownerEvents,
  idleToggles,
  bridgeRegistry,
  promptEvents: promptEventBroadcaster,
  agentLifecycle,
};
```

- [ ] **Step 4: Run the full suite**

Run: `cd /home/evan/projects/qwen-code/packages/rc-gateway && npx vitest run`
Expected: PASS — new server tests green, zero regressions.

- [ ] **Step 5: Commit**

```bash
cd /home/evan/projects/qwen-code
git add packages/rc-gateway/src/server.ts packages/rc-gateway/src/server.agents.test.ts
git commit -m "feat(rc-gateway): wire agent registry/lifecycle/routes + hook ingest into gateway app"
```

---

### Task 12: `cli.ts` serve wiring — boot, cost closure, pump feed, startup reconciliation

**Files:**

- Modify: `packages/rc-gateway/src/cli.ts` (the `runServe` path)

**Interfaces:**

- Consumes: Task 5 `AgentRegistry.open`/`reconcile`; Task 9 `loadOrCreateHookIngestToken`; Task 11 `GatewayDeps.agents`/`hookIngestToken` and `GatewayApp.agentLifecycle`; existing `openUsageStore()` (returns `UsageStore | undefined`; `UsageStore.sessionTotals(sessionId).costMicrocentsSesTotal` is the cost rollup), `SessionEventPump` construction (`new SessionEventPump(handle.daemon, notifier, { onEvent, ... })`), `handle.daemon.capabilities()` / `listWorkspaceSessions(cwd)`.
- Produces: a running `qwen rc serve` with agents enabled by default. No new exports.

- [ ] **Step 1: Open the stores before `createGatewayApp`**

In `runServe`, next to `const usageStore = await openUsageStore();` (cli.ts ~line 414), add:

```ts
// Agent observability (add-agent-observability): persisted registry +
// once-minted hook-ingest token (regenerating would break hook config).
const agentRegistry = await AgentRegistry.open(
  join(homedir(), '.qwen', 'rc', 'agents.json'),
);
const hookIngestToken = await loadOrCreateHookIngestToken(
  join(homedir(), '.qwen', 'rc', 'hook-ingest-token'),
);
```

with imports added at the top of cli.ts:

```ts
import { AgentRegistry } from './agents/agentRegistry.js';
import { loadOrCreateHookIngestToken } from './agents/hookIngestToken.js';
```

- [ ] **Step 2: Pass the deps into `createGatewayApp`**

In the `createGatewayApp({ ... })` call (~line 432), add:

```ts
      agents: {
        registry: agentRegistry,
        costFor: usageStore
          ? (sid) => usageStore.sessionTotals(sid).costMicrocentsSesTotal
          : undefined,
      },
      hookIngestToken,
```

and destructure `agentLifecycle` from the result:

```ts
  const { app, notifier, audit, ownerEvents, bridgeRegistry, agentLifecycle } =
    createGatewayApp({
```

- [ ] **Step 3: Startup reconciliation**

Immediately after the `createGatewayApp` call returns (before the pump section), add:

```ts
// Startup reconciliation (design: "Reconciliation"): running/blocked agent
// records whose daemon session is gone become `orphaned` — surfaced in
// GET /rc/agents, never silently dropped. Best-effort: an unreachable
// daemon at boot leaves records untouched for the next start.
try {
  const caps = await handle.daemon.capabilities();
  const live = caps.workspaceCwd
    ? await handle.daemon.listWorkspaceSessions(caps.workspaceCwd)
    : [];
  const orphaned = await agentRegistry.reconcile(live.map((s) => s.sessionId));
  if (orphaned.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(`agents: marked ${orphaned.length} record(s) orphaned`);
  }
} catch {
  // Daemon unreachable at boot → reconcile on the next start.
}
```

- [ ] **Step 4: Feed the pump into the lifecycle**

The pump is the gateway's single event-plumbing entry point (design: "not a second daemon connection"). Change the pump construction (~line 926):

1. Condition: `if (notifier || usageIngester)` → `if (notifier || usageIngester || agentLifecycle)`.
2. Replace the `onEvent` option so BOTH consumers see every event:

```ts
      ...(usageIngester || agentLifecycle
        ? {
            onEvent: (sid: string, ev: { type: string; data: unknown }) => {
              usageIngester?.ingest(sid, ev.data, sessionAttribution.get(sid));
              // Fire-and-forget: lifecycle transitions must never block or
              // break the pump's subscribe loop.
              void agentLifecycle?.handleSessionEvent(sid, {
                type: ev.type,
                data: ev.data,
              });
            },
          }
        : {}),
```

- [ ] **Step 5: Typecheck + full suite**

```bash
cd /home/evan/projects/qwen-code/packages/rc-gateway && npx tsc --noEmit -p . && npx vitest run
```

Expected: clean typecheck, all tests PASS.

- [ ] **Step 6: Commit**

```bash
cd /home/evan/projects/qwen-code
git add packages/rc-gateway/src/cli.ts
git commit -m "feat(rc-gateway): boot agent registry, hook token, reconciliation, pump feed"
```

---

### Task 13: Integration test — spawn → observe frames → cancel

**Files:**

- Test: `packages/rc-gateway/src/agents/agents.integration.test.ts`

**Interfaces:**

- Consumes: everything above through the PUBLIC surfaces only: `createGatewayApp`, `TokenStore.open`/`issue`, `startStubDaemon` (with Task 8's `POST /session`), `GatewayApp.ownerEvents`, HTTP endpoints. Mirrors the wiring cli.ts does, minus the pump (frame flow is driven by the routes + lifecycle here; pump feeding is covered by Task 7's unit tests + Task 12's manual wiring).
- Produces: nothing — the end-to-end acceptance gate.

- [ ] **Step 1: Write the integration test**

Create `packages/rc-gateway/src/agents/agents.integration.test.ts`:

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonClient } from '@qwen-code/sdk';
import { createGatewayApp } from '../server.js';
import { TokenStore } from '../tokenStore.js';
import { PairingService } from '../pairing.js';
import { AgentRegistry } from './agentRegistry.js';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import type { OwnerEvent } from '../ownerEvents.js';

let server: Server | undefined;
let stub: StubDaemon | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  if (stub) await stub.close();
  server = undefined;
  stub = undefined;
});

describe('agent observability end-to-end (spawn → frames → cancel)', () => {
  it('drives the full lifecycle against the stub daemon', async () => {
    stub = await startStubDaemon({ promptDelayMs: 2000 });
    const dir = await mkdtemp(join(tmpdir(), 'agents-e2e-'));
    const store = await TokenStore.open(join(dir, 'tokens.json'));
    const { token } = await store.issue(['owner'], 'e2e-owner');
    const registry = await AgentRegistry.open(join(dir, 'agents.json'));

    const gw = createGatewayApp({
      daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
      store,
      pairing: new PairingService(),
      auditPath: join(dir, 'audit.log'),
      agents: {
        registry,
        costFor: () => 4242,
        promptAcceptWindowMs: 25,
      },
      hookIngestToken: 'hook-token-e2e',
    });
    const frames: OwnerEvent[] = [];
    gw.ownerEvents.subscribe((e) => frames.push(e));

    server = await new Promise((resolve) => {
      const s = gw.app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = server!.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;
    const auth = { Authorization: `Bearer ${token}` };

    // 1. Spawn.
    const spawn = await fetch(`${url}/rc/agents`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'run tests', parentSessionId: 'parent-1' }),
    });
    expect(spawn.status).toBe(201);
    const { agentId, sessionId } = (await spawn.json()) as {
      agentId: string;
      sessionId: string;
    };
    expect(sessionId).toBe('stub-agent-1');
    expect(stub.createdSessionCount).toBe(1);

    // 2. Observe: agent_spawned on the owner stream with the cost rollup.
    const spawned = frames.find((f) => f.type === 'agent_spawned') as Extract<
      OwnerEvent,
      { type: 'agent_spawned' }
    >;
    expect(spawned).toBeDefined();
    expect(spawned.agent).toMatchObject({
      agentId,
      sessionId,
      parentSessionId: 'parent-1',
      status: 'running',
      costMicrocents: 4242,
    });

    // 3. Listing shows it running.
    const list = await fetch(`${url}/rc/agents?status=running`, {
      headers: auth,
    });
    expect(
      ((await list.json()) as { agents: Array<{ agentId: string }> }).agents,
    ).toHaveLength(1);

    // 4. Cancel: daemon session ended, record cancelled, frame emitted.
    const cancel = await fetch(`${url}/rc/agents/${agentId}/cancel`, {
      method: 'POST',
      headers: auth,
    });
    expect(cancel.status).toBe(200);
    expect(stub.lastEndedSessionId).toBe(sessionId);
    expect(registry.get(agentId)?.status).toBe('cancelled');
    const cancelled = frames.find((f) => f.type === 'agent_cancelled');
    expect(cancelled).toBeDefined();

    // 5. Terminal: steer + re-cancel both 409.
    const steer = await fetch(`${url}/rc/agents/${agentId}/message`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'x' }),
    });
    expect(steer.status).toBe(409);

    // 6. Audit trail: agent_spawned + agent_cancelled rows on the owner bus
    //    (the audit sink publishes every durable row as an `audit` frame).
    //    audit.record is fire-and-forget on the routes — poll briefly.
    const auditActions = () =>
      frames
        .filter((f) => f.type === 'audit')
        .map(
          (f) => (f as Extract<OwnerEvent, { type: 'audit' }>).record.action,
        );
    const deadline = Date.now() + 2000;
    while (
      !(
        auditActions().includes('agent_spawned') &&
        auditActions().includes('agent_cancelled')
      ) &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(auditActions()).toContain('agent_spawned');
    expect(auditActions()).toContain('agent_cancelled');
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `cd /home/evan/projects/qwen-code/packages/rc-gateway && npx vitest run src/agents/agents.integration.test.ts`
Expected: PASS.

- [ ] **Step 3: Run the full suite one last time**

Run: `cd /home/evan/projects/qwen-code/packages/rc-gateway && npx vitest run`
Expected: PASS — no regressions anywhere.

- [ ] **Step 4: Commit**

```bash
cd /home/evan/projects/qwen-code
git add packages/rc-gateway/src/agents/agents.integration.test.ts
git commit -m "feat(rc-gateway): agent observability end-to-end integration test"
```

---

## Self-review checklist (run after all tasks)

1. **Spec coverage vs the design doc:** control-plane table (5 endpoints + scopes) → Task 8/11; observation + 5 lifecycle events on parent+owner streams → Tasks 6/7; notifications incl. `agent.blocked` critical → Task 10; hook mirror (loopback, persistent 0600 token, envelope, drop-on-overflow with surfaced count, owner-only) → Task 9; `agentRegistry.ts` AgentRecord + JSON store + no stored cost → Task 5; spawn saga + rollback + error table codes → Task 8; audit actions → Tasks 6/8/9; reconciliation on startup → Tasks 5/12; spec artifacts (proposal/design/spec/tasks + registries) → Tasks 1–4.
2. **Placeholder scan:** no TBD/TODO/"similar to Task N"; every code step carries complete code with real imports (`createGatewayApp`, `TokenStore.open`, `new PairingService()`, `DaemonClient`, `startStubDaemon` are all verified real signatures).
3. **Type consistency:** `AgentRecord`/`AgentStatus`/`TERMINAL_AGENT_STATUSES` (Task 5) used identically in Tasks 7/8/11; `AgentLifecyclePayload`/`AgentLifecycleEventType` defined once in `ownerEvents.ts` (Task 6) and consumed by Tasks 7/9/13; `AgentNotifySink` matches `PushNotifier.notify`'s `(event, ctx)` signature; `costFor: (sessionId: string) => number | undefined` has the same shape in Tasks 7/8/11/12.
