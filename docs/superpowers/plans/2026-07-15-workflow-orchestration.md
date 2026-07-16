# Workflow Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship deterministic, sandboxed, journaled multi-agent workflow orchestration for the qwen-code fork — one engine over an injected `AgentSpawner`, exposed both as a local `Workflow` tool (core, offline) and as `POST /rc/workflows` on rc-gateway (agents-as-sessions plane).

**Architecture:** A JS scripting layer runs inside a locked-down `node:vm` context (Approach A of the design doc: one engine, injected spawner). The engine's five units live in `packages/core/src/workflows/`: `sandbox.ts` (the security boundary), `scheduler.ts` (concurrency + lifetime cap), `journal.ts` (JSONL replay), `spawner.ts` (`AgentSpawner` interface + `HeadlessSpawner`), and `scriptRunner.ts` (meta AST check + bridge assembly + execution). The core surface is the `Workflow` tool; the gateway surface is a `SessionSpawner` implementation plus workflow routes. Ships spec-first as the 20th OpenSpec change `add-workflow-orchestration`.

**Design doc (authoritative — do not deviate):** `/home/evan/projects/qwen-code/docs/superpowers/specs/2026-07-15-workflow-orchestration-design.md`

**Tech Stack:** Node 22, TypeScript ESM (`.js` import suffixes), `node:vm`, `acorn` (AST parse), `ajv` + `jsonrepair` (schema validation — already core deps), Express (gateway), vitest.

## Global Constraints

- **Two repos.**
  - Part A (Tasks 1–4) edits `/home/evan/projects/qwen-code-remote` (OpenSpec docs), branch `add-workflow-orchestration` off `main`.
  - Parts B and C (Tasks 5–16) edit `/home/evan/projects/qwen-code` (the fork): Part B in `packages/core`, Part C in `packages/rc-gateway`, both on branch `add-remote-control-spec`.
- **License header.** EVERY new `src/**/*.ts` file in the fork MUST start with exactly:
  ```ts
  /**
   * @license
   * Copyright 2025 Qwen Team
   * SPDX-License-Identifier: Apache-2.0
   */
  ```
- **Node:** v22 (`node --version` → v22.x). ESM only; all relative imports end in `.js`.
- **New runtime dependency.** `acorn` (`^8.15.0`) is present at the workspace root but is NOT declared in `packages/core/package.json` — it is hoisted, so relying on it without declaring it breaks a clean install. Task 10 (scriptRunner, the only acorn consumer) adds `"acorn": "^8.15.0"` to `packages/core/package.json` `dependencies` as an explicit step. `typescript` is a devDep only — do NOT import it at runtime.
- **Test command.**
  - core: `cd /home/evan/projects/qwen-code/packages/core && npx vitest run <file>`
  - rc-gateway (NOT in the root vitest `projects` array — always run from the package dir): `cd /home/evan/projects/qwen-code/packages/rc-gateway && npx vitest run <file>`
- **Branch discipline (fork).** Work directly on `add-remote-control-spec`. The working tree may contain unrelated dirty files: stage ONLY files you created/modified yourself (`git add packages/<pkg>/src/<file>`), NEVER `git add -A`, `git add .`, or `git checkout .`.
- **Branch discipline (spec repo).** Create `add-workflow-orchestration` off `main` before Task 1; commit there.
- **Commit conventions:** `docs(specs): ...` for the spec repo, `feat(core): ...` for `packages/core`, `feat(rc-gateway): ...` for `packages/rc-gateway`.
- **Endpoint prefixes** (spec repo `openspec/conventions.md` §1): session-independent control-plane resources are `/rc/*`. All workflow endpoints live under `/rc/workflows*`.
- **Naming** (conventions.md §2): SSE event types and audit actions are `snake_case` (`workflow_started`); JSON body/response fields are `camelCase` (`runId`); notification kinds follow the existing dot convention (`workflow.completed`).
- **Registry precedent** (conventions.md §"Authoritative registries", commit `496dc3e`): new SSE event types and audit actions are added DIRECTLY to the authoritative tables in `add-remote-control`'s `wire-protocol`/`pairing-auth` spec files. Do NOT ship partial MODIFIED delta spec files inside the new change — that pattern was explicitly reverted as an archive-time data-loss footgun.
- **Never audit or log script content.** Audit rows carry the workflow name and a SHA-256 script hash only, never the script source, prompts, or agent outputs.
- **Known pre-existing `tsc` errors are out of scope.** rc-gateway already has pre-existing type errors in `auth.ts`, `cors.ts`, `pair.ts`, `server.ts:337`, the discord runner, telegram health, and `vapid.ts`. Do NOT fix them; do NOT introduce any NEW `tsc` error in a file you touch.
- **Security ownership rule (user decision).** The sandbox (Task 5) and its escape-attempt test suite are **Opus-only** to author and review. Fable agents (including the session controller) must not author or review sandbox/security code. The task heading carries this marker.

---

## Part A — OpenSpec change authoring (`/home/evan/projects/qwen-code-remote`)

### Task 1: Change skeleton — `proposal.md` and `design.md`

**Files:**

- Create: `openspec/changes/add-workflow-orchestration/proposal.md`
- Create: `openspec/changes/add-workflow-orchestration/design.md`

**Interfaces:**

- Consumes: the approved design doc `/home/evan/projects/qwen-code/docs/superpowers/specs/2026-07-15-workflow-orchestration-design.md` (adapt its content — do not invent new architecture). Structural conventions from the sibling `openspec/changes/add-agent-observability/` change.
- Produces: the change directory that Tasks 2–4 add `specs/` and `tasks.md` into. Downstream tasks cite requirement names defined in Task 2.

- [ ] **Step 1: Create the branch and directory**

```bash
cd /home/evan/projects/qwen-code-remote
git checkout main
git checkout -b add-workflow-orchestration
mkdir -p openspec/changes/add-workflow-orchestration/specs/workflow-orchestration
```

- [ ] **Step 2: Write `proposal.md`**

Follow the section shape of `openspec/changes/add-agent-observability/proposal.md` (`# <change-id>` H1, `## Why`, `## What Changes` with bold lead-ins, `## Capabilities` → `### New Capabilities`, `## User Stories`, `## Impact`). Write in full (this is the required substance, not a template to leave hollow):

```markdown
# add-workflow-orchestration

## Why

The fork can spawn a single background agent (`add-agent-observability`),
but real work is multi-agent: fan a task across dimensions, verify each
finding with a second agent, gather the survivors. Today that means a
human hand-driving agents one prompt at a time, with no determinism, no
resume after a crash, and no way to run the same pattern from a phone.
The agent runtime, the background-task registry, and the agents-as-
sessions gateway plane already exist — what is missing is a deterministic
orchestration layer over them that works both offline (local tool) and
remotely (gateway).

## What Changes

- **A sandboxed JS scripting engine** in `packages/core/src/workflows/`.
  Scripts are plain JavaScript executed in a locked-down `node:vm`
  context with a frozen, allowlisted global surface and injected
  primitives (`agent`, `parallel`, `pipeline`, `phase`, `log`, `args`,
  `budget`). No `require`, `import`, `process`, filesystem, or network.
- **Deterministic, journaled runs.** Every primitive result is journaled
  as JSONL; a re-run replays the unchanged prefix from cache and runs the
  first divergence onward live. `Date.now()`, argless `new Date()`, and
  `Math.random()` throw, because non-determinism would break replay.
- **Two surfaces from day one.** A `Workflow` tool in core (engine runs
  in-process over the headless agent runtime — works offline) AND
  `POST /rc/workflows` on rc-gateway (engine runs in the gateway process,
  each workflow agent spawned as a real, observable, cost-tracked
  session through the agents-as-sessions plane).
- **Five lifecycle SSE events** — `workflow_started`, `workflow_phase`,
  `workflow_completed`, `workflow_failed`, `workflow_cancelled` — on the
  owner events stream, registered in the wire-protocol SSE registry.
- **Two routable notification kinds** — `workflow.completed`,
  `workflow.failed` — through existing routing rules. Neither is
  critical: neither bypasses quiet hours (a finished workflow is not an
  emergency; only a blocked agent is).
- **Two audit actions** — `workflow_started`, `workflow_cancelled` —
  registered in the pairing-auth registry. Script content is never
  audited: rows carry the workflow name and a SHA-256 script hash only.

## Capabilities

### New Capabilities

- `workflow-orchestration` — the script API contract (primitives,
  `meta` literal rules), sandbox guarantees, engine semantics
  (scheduler concurrency + lifetime cap, journal replay, cancellation),
  both surfaces (the `Workflow` tool and the four `/rc/workflows*`
  endpoints with scopes), the five SSE events, the two notification
  kinds, the two audit actions, and the error-code table.

## User Stories

**W1. Review changed files, offline.** From the CLI I run the
`Workflow` tool with a `review-changes` script: it fans a "find issues"
agent across dimensions, verifies each finding with a second agent, and
returns the confirmed set. No gateway, no daemon — pure local.

**W2. Kick off a workflow from my phone.** `POST /rc/workflows` with a
named workflow; I get `202 { runId }`, lock my phone, and a
`workflow.completed` push arrives with the token total. Each workflow
agent shows up as its own session in `GET /rc/agents`.

**W3. Resume after a crash.** The gateway restarts mid-run. I re-POST
with `resumeFromRunId`; the completed prefix replays from the journal in
milliseconds and only the unfinished tail re-spawns agents.

**W4. Kill a runaway.** `GET /rc/workflows` shows one run burning
tokens. `POST /rc/workflows/:runId/cancel` aborts every in-flight agent
and marks the run `cancelled`; the journal stays valid for a later
resume.

## Impact

- **qwen-code fork (core):** new module `packages/core/src/workflows/`
  (sandbox, scheduler, journal, spawner, scriptRunner) plus a `Workflow`
  tool and a `WorkflowEngine`/`AgentSpawner` export from the package
  barrel. New runtime dep: `acorn`.
- **qwen-code fork (rc-gateway):** `SessionSpawner`, a workflow run
  registry, `routes/workflows.ts`, `server.ts`/`cli.ts` wiring; five new
  SSE event types; two notification kinds; two audit actions;
  `AgentRecord` gains an optional `workflowRunId`.
- **Registries amended** (DIRECT edits to add-remote-control, per repo
  precedent): wire-protocol SSE registry (+5 rows), pairing-auth audit
  registry (+2 rows).
- **Out of scope** (deliberately, recorded as follow-ups): nested
  workflows (`workflow()` inside a script); cron-triggered workflows;
  workflow marketplace/sharing; web UI run visualization.
```

- [ ] **Step 3: Write `design.md`**

Adapt the approved design doc into the OpenSpec design format used by `add-agent-observability/design.md` (`# Design — add-workflow-orchestration` H1, `## Context` naming the chosen approach, `## Goals / Non-Goals`, `## Architecture`, decision sections, `## Alternatives considered`, `## Threat model`, `## Error handling`). It MUST contain, per `openspec/config.yaml` design rules (record the alternative considered; threat model enumerates attacker/capability/mitigation):

1. `## Context` — the two-surface, one-engine framing; the spec-first note.
2. `## Architecture` — the five engine units (copy the design doc's "Engine" section), the Script API (primitives + the `meta` pure-literal rule), the surfaces table (the four `/rc/workflows*` endpoints with scopes), and the sandbox section.
3. `## Alternatives considered` — copy verbatim from the design doc:

```markdown
## Alternatives considered

- **B: Always through the gateway plane** — CLI workflows would require
  a running gateway + daemon; breaks offline use; HTTP + token plumbing
  for purely local work. Rejected.
- **C: Two engines** — an in-core engine for the tool plus a separate
  gateway orchestrator; duplicated scheduler/journal/sandbox semantics
  guarantee divergence. Rejected.
- Script format alternatives (declarative YAML DAG; TypeScript child
  processes) were considered and rejected during scoping: YAML grows
  escape hatches into a bad programming language; child processes make
  the OS the sandbox and break determinism guarantees.
```

4. `## Threat model` — copy the design doc's table verbatim, then add the **honesty note** below it (required — `node:vm` is not a jail, and the spec must not overclaim):

```markdown
## Threat model

| Attacker                                     | Capability                              | Mitigation                                                                                                                                                                                             |
| -------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Malicious/buggy workflow script              | Escape the VM, reach fs/network/process | Frozen allowlisted globals, no require/import/process; primitives are context-native wrappers that never expose host intrinsics; Opus-owned sandbox implementation + review; escape-attempt test suite |
| Script author (prompt-injected model)        | Runaway spawn loops burning tokens      | Lifetime agent cap (1000), concurrency cap, budget ceiling, wall-clock ceiling                                                                                                                         |
| Compromised `read` token (gateway)           | Start/cancel workflows                  | `write` scope required for start/cancel; `read` observes only                                                                                                                                          |
| Script exfiltrates secrets via agent prompts | Prompts reach model providers           | Same exposure class as any agent prompt; audit records name + hash, script stored locally per-run for inspection                                                                                       |
| Journal tampering                            | Forged cached results on resume         | Journal is local 0600; resume validates seq + prompt/opts hashes                                                                                                                                       |

> **Honesty note.** Per Node's own documentation, `node:vm` is _not_ a
> security mechanism for running untrusted code. The sandbox here is
> defense-in-depth that raises the bar substantially — it denies the
> obvious escape vectors and prototype-pollution-to-host paths — but the
> design deliberately chose in-process VM over child-process isolation
> (see Alternatives). The residual risks are named: (a) a pure-CPU spin
> _after_ the first `await` runs in a microtask outside the synchronous
> `vm` timeout, backstopped by the agent-count cap, budget ceiling, and
> wall-clock deadline enforced at each `agent()` entry; (b) prototype
> pollution _within_ the context cannot reach host objects (separate
> realm intrinsics) but is frozen anyway to stop the script tampering
> with its own injected primitives.
```

5. `## Error handling` — copy the design doc's error table verbatim (script syntax / non-literal meta → fail before any spawn, `400 invalid_workflow_script` / tool error with line info; agent spawn/exec error → that `agent()` resolves `null` after bounded retries; schema validation exhausted → same `null` path; budget exhausted → `agent()` throws into the script, uncaught → run `failed`; engine crash → journal intact, resume replays prefix; cancel → in-flight agents aborted, run `cancelled`; worktree acquisition fails → that agent errors → `null`, no silent shared-tree fallback).
6. The `AgentSpawner` interface and the `meta` contract exactly as Tasks 8 and 6 define them (the design doc and the plan must agree character-for-character on the exported shapes).

- [ ] **Step 4: Commit**

```bash
cd /home/evan/projects/qwen-code-remote
git add openspec/changes/add-workflow-orchestration/proposal.md openspec/changes/add-workflow-orchestration/design.md
git commit -m "docs(specs): add-workflow-orchestration proposal + design"
```

---

### Task 2: `specs/workflow-orchestration/spec.md`

**Files:**

- Create: `openspec/changes/add-workflow-orchestration/specs/workflow-orchestration/spec.md`

**Interfaces:**

- Consumes: requirement/scenario format of `openspec/changes/add-agent-observability/specs/agent-observability/spec.md`; rules in `openspec/config.yaml` (RFC 2119 keywords; ≥1 scenario per requirement; wire requirements cite method+path or SSE event type).
- Produces: requirement names cited by Task 4's tasks.md acceptance lines: `Script API contract`, `Deterministic sandbox`, `Journaled resume`, `Scheduler limits`, `Workflow tool surface`, `Workflow gateway endpoints`, `Workflow lifecycle SSE events`, `Workflow notification routing`, `Workflow audit actions`, `Workflow error codes`.

- [ ] **Step 1: Write the spec delta**

Write the file with `# workflow-orchestration — spec delta` (H1), `## ADDED Requirements`, and these ten requirements. Every requirement uses MUST/SHALL/SHOULD/MAY; wire requirements cite method+path or event type. Full content:

```markdown
# workflow-orchestration — spec delta

## ADDED Requirements

### Requirement: Script API contract

A workflow script SHALL be plain JavaScript that MAY use top-level
`await` and a top-level `return`. It SHALL export a `meta` binding
(`export const meta = { ... }`) whose initializer is a **pure literal**
— object/array/string/number/boolean/null literals only, no identifiers,
calls, or computed expressions. `meta.name` and `meta.description` are
required strings; `meta.phases` is an optional array of `{ title }`
objects matched to `phase()` calls for progress display. The engine
SHALL verify the pure-literal rule with a static AST check BEFORE any
code executes; a violation SHALL fail the run before any agent spawns.

The engine SHALL inject these primitives and nothing else beyond frozen
JS builtins: `agent(prompt, opts?)`, `parallel(thunks)`,
`pipeline(items, ...stages)`, `phase(title)`, `log(message)`, `args`,
and `budget`. `agent()` SHALL return the model's text, or — when
`opts.schema` is supplied — a schema-validated object, and SHALL resolve
`null` when the agent fails after bounded transient-error retries.
`parallel(thunks)` SHALL settle all thunks (a thrown thunk resolves to
`null` in the result array). `pipeline(items, ...stages)` SHALL flow
each item through the stages with no inter-stage barrier, passing
`(prevResult, originalItem, index)` to each stage; a throwing stage SHALL
drop that item to `null` and skip its remaining stages. `budget` SHALL
expose `{ total, spent(), remaining() }` in tokens; once
`spent() >= total`, further `agent()` calls SHALL throw a catchable
error into the script.

#### Scenario: Non-literal meta fails before spawning

- **GIVEN** a script whose `meta.name` is a computed expression
- **WHEN** the engine runs it
- **THEN** the run fails with an `invalid_workflow_script` error citing
  the offending line
- **AND** no agent is spawned

#### Scenario: Schema opt returns a validated object

- **GIVEN** an `agent(prompt, { schema })` call and a model reply that
  conforms to the schema
- **WHEN** the call resolves
- **THEN** the resolved value is the validated object

#### Scenario: parallel settles all and nulls a thrown thunk

- **GIVEN** `parallel([ok, throws, ok])`
- **WHEN** it resolves
- **THEN** the result array is `[<ok>, null, <ok>]`

### Requirement: Deterministic sandbox

The engine SHALL execute scripts in a `node:vm` context whose global
surface is a frozen allowlist of JS builtins plus the injected
primitives. `require`, `import`, `process`, `fetch`, filesystem, and
network SHALL be absent. `Date.now()`, argless `new Date()`, and
`Math.random()` SHALL throw an error whose message states the
determinism rule. The script source SHALL be capped at 512 KB. Injected
primitives SHALL be context-native wrappers that never expose host
objects, functions, promises, or errors to the script (all data crosses
the boundary as strings). Context intrinsics SHALL be frozen.

#### Scenario: Determinism primitives throw

- **WHEN** a script calls `Date.now()`, `new Date()` with no arguments,
  or `Math.random()`
- **THEN** each call throws an error whose message names the
  determinism rule
- **AND** `new Date(0)` (an argument supplied) still works

#### Scenario: Escape via a primitive's constructor chain is denied

- **WHEN** a script evaluates
  `agent.constructor.constructor('return process')()`
- **THEN** the result is `undefined` (the context global), not the host
  `process` object

#### Scenario: Oversized source is rejected

- **GIVEN** a script source larger than 512 KB
- **WHEN** the engine runs it
- **THEN** the run fails with an `invalid_workflow_script` error and no
  agent is spawned

### Requirement: Journaled resume

Each run SHALL journal one record per primitive call as JSONL at
`~/.qwen/workflows/runs/<runId>/journal.jsonl` — `{ seq, kind,
promptHash, optsHash, result, tokens }` — and SHALL persist `run.json`
with meta, script hash, args, and status. `seq` SHALL be assigned
synchronously at the moment each `agent()` call is entered (before it
queues for a concurrency slot), so a deterministic script always
produces the same `seq`→hash mapping regardless of completion order. On
`resumeFromRunId`, the engine SHALL replay the longest journal prefix
whose `seq`, `promptHash`, and `optsHash` all match, returning cached
results without spawning; the first divergence and everything after it
SHALL run live. Hashes SHALL be computed over canonicalized (sorted-key)
JSON.

#### Scenario: Unchanged script replays 100% from cache

- **GIVEN** a completed run and the identical script and args
- **WHEN** the engine runs with `resumeFromRunId` set to that run
- **THEN** every `agent()` call returns its cached result and no agent
  is spawned

#### Scenario: Mid-script edit replays the prefix and runs the tail live

- **GIVEN** a completed run and a script edited after the third
  `agent()` call
- **WHEN** the engine resumes from that run
- **THEN** the first three calls return cached results
- **AND** the fourth call onward spawns live agents

### Requirement: Scheduler limits

The engine SHALL gate concurrent `agent()` calls at
`max(1, min(16, cpus - 2))` per run, queueing further calls FIFO. It
SHALL enforce a lifetime cap (default 1000) on the total number of
`agent()` calls per run; exceeding it SHALL throw into the script.

#### Scenario: Concurrency cap is honored under load

- **GIVEN** a run whose concurrency cap resolves to N
- **WHEN** the script fires 4N `agent()` calls via `parallel`
- **THEN** at most N spawns are in flight at any instant

#### Scenario: Lifetime cap trips

- **GIVEN** a lifetime cap of 1000
- **WHEN** a script attempts a 1001st `agent()` call
- **THEN** that call throws into the script

### Requirement: Workflow tool surface

The core `Workflow` tool SHALL accept `{ script | scriptPath | name,
args?, resumeFromRunId? }` and SHALL return `{ runId, result }`. A
`name` SHALL resolve from `.qwen/workflows/<name>.js` (project) then
`~/.qwen/workflows/<name>.js` (user). The run SHALL surface through the
background-task registry so the task pill shows the current phase and
agent counts. Per-run artifacts SHALL persist under
`~/.qwen/workflows/runs/<runId>/`.

#### Scenario: Named workflow resolves and runs

- **GIVEN** `~/.qwen/workflows/review.js` exists
- **WHEN** the `Workflow` tool runs with `{ name: "review" }`
- **THEN** it returns `{ runId, result }`
- **AND** the run appears in the background-task registry

### Requirement: Workflow gateway endpoints

`POST /rc/workflows` with body `{ script | name, args?,
resumeFromRunId? }` SHALL require the `write` scope, start a run with the
`SessionSpawner`, and respond `202 { runId }`. `GET /rc/workflows` SHALL
require the `read` scope and list runs (status, name, phase, agent
counts, token totals). `GET /rc/workflows/:runId` SHALL require the
`read` scope and return the run detail including the per-agent map
(agentId ↔ sessionId). `POST /rc/workflows/:runId/cancel` SHALL require
the `write` scope, abort in-flight agents, mark the run `cancelled`, and
respond `202`.

#### Scenario: Start requires write scope

- **WHEN** a token holding only `session:read` sends `POST /rc/workflows`
- **THEN** the response is `403`

#### Scenario: Detail exposes the per-agent session map

- **GIVEN** a running workflow that has spawned two agents
- **WHEN** the client sends `GET /rc/workflows/:runId`
- **THEN** the response maps each agentId to its sessionId

### Requirement: Workflow lifecycle SSE events

The gateway SHALL emit `workflow_started`, `workflow_phase`,
`workflow_completed`, `workflow_failed`, and `workflow_cancelled` on the
owner events stream (`GET /rc/events`). `workflow_started` and the
terminal events carry `{ runId, name, scriptHash, status, agentCount,
tokensSpent }`; `workflow_phase` carries `{ runId, phase, phaseIndex? }`.

#### Scenario: Phase change emits a frame

- **GIVEN** a running workflow
- **WHEN** the script calls `phase('Verify')`
- **THEN** a `workflow_phase` frame with `phase: "Verify"` is emitted on
  the owner events stream

### Requirement: Workflow notification routing

`workflow_completed` and `workflow_failed` SHALL be routable
notification kinds `workflow.completed` and `workflow.failed` through
existing routing rules, quiet hours, and bridges. Neither SHALL be a
critical kind: neither bypasses snooze or quiet hours. The other three
lifecycle events SHALL be stream-only (no notification kind).

#### Scenario: workflow.completed respects quiet hours

- **GIVEN** active quiet hours
- **WHEN** a workflow completes
- **THEN** the push is suppressed by quiet hours (not bypassed)

#### Scenario: workflow_started has no notification kind

- **WHEN** a workflow starts
- **THEN** no push is delivered for `workflow_started`

### Requirement: Workflow audit actions

The gateway SHALL write an audit row `workflow_started` on a successful
start and `workflow_cancelled` on cancel, each carrying the actor token
id, the workflow `name`, and the SHA-256 `scriptHash` — never the script
source, prompts, or agent outputs.

#### Scenario: Start is audited with the hash, not the source

- **WHEN** `POST /rc/workflows` succeeds
- **THEN** an audit row `workflow_started` carries the token id, the
  name, and a `scriptHash`
- **AND** the row does not contain the script source

### Requirement: Workflow error codes

`POST /rc/workflows` SHALL respond `400 invalid_workflow_script` when the
script fails to parse or violates the pure-literal `meta` rule, citing
line information. `POST /rc/workflows/:runId/cancel` SHALL respond
`409 workflow_not_running` when the run is already terminal.

#### Scenario: Invalid script is a 400

- **WHEN** `POST /rc/workflows` is sent a script with a syntax error
- **THEN** the response is `400` with code `invalid_workflow_script`

#### Scenario: Cancel on a terminal run is a 409

- **GIVEN** a `completed` run
- **WHEN** the client sends `POST /rc/workflows/:runId/cancel`
- **THEN** the response is `409` with code `workflow_not_running`
```

- [ ] **Step 2: Commit**

```bash
cd /home/evan/projects/qwen-code-remote
git add openspec/changes/add-workflow-orchestration/specs/workflow-orchestration/spec.md
git commit -m "docs(specs): workflow-orchestration requirements + scenarios"
```

---

### Task 3: Registry deltas — SSE event types and audit actions (DIRECT edits)

**Files:**

- Modify: `openspec/changes/add-remote-control/specs/wire-protocol/spec.md` (authoritative SSE registry table, under `### Requirement: SSE event-type registry`, append after the `hook_event` row at line 117)
- Modify: `openspec/changes/add-remote-control/specs/pairing-auth/spec.md` (authoritative extension registry table, under `### Requirement: Audit record schema (v1)`, append after the `hook_ingest_rejected` row at line 199)

**Interfaces:**

- Consumes: the two authoritative registry tables. Per `openspec/conventions.md` §"Authoritative registries" and commit `496dc3e`, these are the SINGLE source of truth — this change edits them DIRECTLY and ships NO partial MODIFIED delta spec files of its own.
- Produces: 5 SSE registry rows + 2 audit-action rows that Parts B/C implement.

- [ ] **Step 1: Append 5 rows to the authoritative SSE registry table**

In `openspec/changes/add-remote-control/specs/wire-protocol/spec.md`, append to the table under `### Requirement: SSE event-type registry` — immediately after the `hook_event` row (line 117) and before the blank line — exactly:

```markdown
| `workflow_started` | `add-workflow-orchestration` | `{ runId, name, scriptHash, status, agentCount, tokensSpent }` — a workflow run started; emitted on the owner events stream (`GET /rc/events`) |
| `workflow_phase` | `add-workflow-orchestration` | `{ runId, phase, phaseIndex? }` — the running script called `phase(title)`; owner events stream only |
| `workflow_completed` | `add-workflow-orchestration` | same payload as `workflow_started` — the run returned; carries the token total. Notification kind `workflow.completed` |
| `workflow_failed` | `add-workflow-orchestration` | same payload as `workflow_started` — the script threw uncaught or the engine errored. Notification kind `workflow.failed` |
| `workflow_cancelled` | `add-workflow-orchestration` | same payload as `workflow_started` — cancelled via `POST /rc/workflows/:runId/cancel`; the journal remains valid for resume |
```

- [ ] **Step 2: Append 2 rows to the authoritative pairing-auth audit registry table**

In `openspec/changes/add-remote-control/specs/pairing-auth/spec.md`, append to the extension registry table under `### Requirement: Audit record schema (v1)` — immediately after the `hook_ingest_rejected` row (line 199) and before the blank line — exactly:

```markdown
| `workflow_started` (action) | `add-workflow-orchestration` | Audit `action`: remote client started a workflow via `POST /rc/workflows`; row carries the actor token id, the workflow name, and the SHA-256 script hash, never the script source |
| `workflow_cancelled` (action) | `add-workflow-orchestration` | Audit `action`: remote client cancelled a workflow via `POST /rc/workflows/:runId/cancel`; row carries the run id |
```

- [ ] **Step 3: Verify the registry rows exist (grep gate)**

```bash
cd /home/evan/projects/qwen-code-remote
grep -c "add-workflow-orchestration" openspec/changes/add-remote-control/specs/wire-protocol/spec.md
# Expected: 5
grep -c "add-workflow-orchestration" openspec/changes/add-remote-control/specs/pairing-auth/spec.md
# Expected: 2
grep -n "workflow_started\|workflow_phase\|workflow_completed\|workflow_failed\|workflow_cancelled" openspec/changes/add-remote-control/specs/wire-protocol/spec.md
# Expected: 5 hits inside the registry table
```

- [ ] **Step 4: Commit**

```bash
cd /home/evan/projects/qwen-code-remote
git add openspec/changes/add-remote-control/specs/wire-protocol/spec.md \
        openspec/changes/add-remote-control/specs/pairing-auth/spec.md
git commit -m "docs(specs): register workflow SSE events + audit actions in authoritative registries"
```

---

### Task 4: `tasks.md` for the change

**Files:**

- Create: `openspec/changes/add-workflow-orchestration/tasks.md`

**Interfaces:**

- Consumes: tasks rules from `openspec/config.yaml` (Phase N.0 alignment tasks; each task has `Status` and `Prompt` fields; Status values `not-started | started | completed | deferred:<reason> | skipped:<reason> | cancelled:<reason>`); style of `add-agent-observability/tasks.md`.
- Produces: the phased task list mirroring Parts B and C of this plan.

- [ ] **Step 1: Write `tasks.md`**

```markdown
# tasks — add-workflow-orchestration

State machine and alignment pattern: see
`changes/add-remote-control/tasks.md`.

## Phase 0 — Foundation

**Effort:** ~0.5 day.

- [ ] **0.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify `add-agent-observability` is `completed` (agents-as-
    > sessions plane, owner events, audit chain, notification routing).
    > Confirm the five workflow SSE registry rows and two audit-action
    > rows this change relies on are present in the authoritative
    > add-remote-control registries (they were added DIRECTLY there, not
    > shipped as deltas here). Confirm `acorn`, `ajv`, and `jsonrepair`
    > are available to `packages/core`. Record confirmations here.

## Phase 1 — Sandbox + engine core (core)

**Effort:** ~3 days. **SECURITY:** the sandbox unit is Opus-only.

- [ ] **1.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 0 `completed`. Confirm the `node:vm` API and
    > `AgentHeadless.create` signature against the current fork build.
    > Note deviations before implementing.

- [ ] **1.1 sandbox.ts (SECURITY: Opus-only)**
  - **Status:** not-started
  - **Files:** `packages/core/src/workflows/sandbox.ts`
  - **Prompt:**
    > Frozen allowlisted `node:vm` context; context-native primitive
    > wrappers closing over host bridges (no host object/promise/error
    > ever reaches the script); determinism throwers; 512 KB cap;
    > synchronous `vm` timeout for pre-await CPU. Acceptance: scenarios
    > under `Requirement: Deterministic sandbox`, plus the escape-attempt
    > suite. Opus authors AND reviews.

- [ ] **1.2 scheduler.ts**
  - **Status:** not-started
  - **Files:** `packages/core/src/workflows/scheduler.ts`
  - **Prompt:**
    > Concurrency semaphore `max(1, min(16, cpus - 2))`, FIFO queue,
    > lifetime agent-count cap (default 1000). Acceptance: scenarios
    > under `Requirement: Scheduler limits`.

- [ ] **1.3 journal.ts**
  - **Status:** not-started
  - **Files:** `packages/core/src/workflows/journal.ts`
  - **Prompt:**
    > JSONL journal + `run.json`; synchronous seq assignment;
    > sorted-key hash; longest-matching-prefix replay with a divergence
    > latch. Acceptance: scenarios under `Requirement: Journaled resume`.

## Phase 2 — Spawner + runner + tool (core)

**Effort:** ~2.5 days.

- [ ] **2.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 1 `completed`. Confirm `AgentHeadless` has no
    > per-run cwd and no StructuredOutput read-back (capture lives in
    > nonInteractiveCli); confirm the plan's Ajv/jsonrepair + derived-cwd
    > adjustments still hold.

- [ ] **2.1 spawner.ts (AgentSpawner + HeadlessSpawner)**
  - **Status:** not-started
  - **Files:** `packages/core/src/workflows/spawner.ts`
  - **Prompt:**
    > `AgentSpawner` interface + `HeadlessSpawner` over
    > `AgentHeadless.create`; schema via Ajv + jsonrepair with ≤2
    > retries. Acceptance: `Requirement: Script API contract` (schema).

- [ ] **2.2 scriptRunner.ts + WorkflowEngine**
  - **Status:** not-started
  - **Files:** `packages/core/src/workflows/scriptRunner.ts`,
    `packages/core/src/workflows/worktree.ts`,
    `packages/core/src/workflows/index.ts`
  - **Prompt:**
    > acorn pure-literal meta check; assemble the agent bridge over
    > scheduler/journal/spawner/worktree; run via sandbox; export
    > `WorkflowEngine` + `AgentSpawner` from the core barrel. Acceptance:
    > `Requirement: Script API contract`, `Deterministic sandbox`
    > (meta), `Journaled resume`.

- [ ] **2.3 Workflow tool + background-task surfacing**
  - **Status:** not-started
  - **Files:** `packages/core/src/tools/workflow/workflow.ts`,
    `packages/core/src/tools/tool-names.ts`,
    `packages/core/src/config/config.ts`
  - **Prompt:**
    > `Workflow` tool ( `{ script|scriptPath|name, args?,
resumeFromRunId? }` → `{ runId, result }` ); name resolution;
    > register via `registerLazy`; surface through the background-task
    > registry without consuming the background-agent concurrency cap.
    > Acceptance: `Requirement: Workflow tool surface`.

## Phase 3 — Gateway surface (rc-gateway)

**Effort:** ~2.5 days.

- [ ] **3.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 2 `completed`. Confirm the current `AgentRecord`
    > fields, the daemon session-create call shape, `GatewayDeps`, and
    > the owner-event/audit/notification seams against the build.

- [ ] **3.1 SessionSpawner + AgentRecord.workflowRunId**
  - **Status:** not-started
  - **Files:** `packages/rc-gateway/src/workflows/sessionSpawner.ts`,
    `packages/rc-gateway/src/agents/agentRegistry.ts`
  - **Prompt:**
    > `SessionSpawner implements AgentSpawner`, spawning each workflow
    > agent as a real session and tagging the `AgentRecord` with
    > `workflowRunId`. Acceptance: `Requirement: Workflow gateway
endpoints` (per-agent map).

- [ ] **3.2 Workflow run registry + routes**
  - **Status:** not-started
  - **Files:** `packages/rc-gateway/src/workflows/workflowRegistry.ts`,
    `packages/rc-gateway/src/routes/workflows.ts`
  - **Prompt:**
    > Run registry (status/phase/agent map/token total); four routes
    > with write/read scopes; 400 invalid_workflow_script, 409
    > workflow_not_running. Acceptance: `Requirement: Workflow gateway
endpoints`, `Workflow error codes`.

- [ ] **3.3 SSE events + notification kinds + audit + wiring**
  - **Status:** not-started
  - **Files:** `packages/rc-gateway/src/ownerEvents.ts`,
    `packages/rc-gateway/src/auditLog.ts`,
    `packages/rc-gateway/src/webpush/payload.ts`,
    `packages/rc-gateway/src/webpush/notifier.ts`,
    `packages/rc-gateway/src/server.ts`,
    `packages/rc-gateway/src/cli.ts`
  - **Prompt:**
    > Five `OwnerEvent` variants; two audit actions; two notification
    > kinds (NOT snooze-bypass); server/cli wiring. Acceptance:
    > `Requirement: Workflow lifecycle SSE events`, `Workflow
notification routing`, `Workflow audit actions`.

## Phase 4 — Integration

**Effort:** ~1 day.

- [ ] **4.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 3 `completed`. Confirm the stub daemon supports the
    > per-agent session spawn path the integration test needs.

- [ ] **4.1 3-agent pipeline end-to-end**
  - **Status:** not-started
  - **Prompt:**
    > End-to-end vitest: `POST /rc/workflows` with a 3-agent pipeline;
    > observe `workflow_started`/`workflow_phase`/`workflow_completed`;
    > assert three per-agent sessions were created.

- [ ] **4.2 Archive change**
  - **Status:** not-started
  - **Prompt:**
    > Run `openspec archive add-workflow-orchestration` once deployed.

## Effort summary

| Phase     | Description             | Estimate (days) |
| --------- | ----------------------- | --------------- |
| 0         | Foundation              | 0.5             |
| 1         | Sandbox + engine core   | 3               |
| 2         | Spawner + runner + tool | 2.5             |
| 3         | Gateway surface         | 2.5             |
| 4         | Integration             | 1               |
| **Total** |                         | **9.5**         |
```

- [ ] **Step 2: Commit**

```bash
cd /home/evan/projects/qwen-code-remote
git add openspec/changes/add-workflow-orchestration/tasks.md
git commit -m "docs(specs): add-workflow-orchestration phased tasks"
```

---

## Part B — Engine (`/home/evan/projects/qwen-code`, `packages/core`, branch `add-remote-control-spec`)

### Task 5: `workflows/sandbox.ts` — the VM sandbox 🔒 SECURITY: Opus-only implementer and reviewer

> **This task is security-critical. Per the user ownership rule, ONLY Opus may author or review this file and its test suite. A Fable agent (including the session controller) must not implement or review sandbox/security code.** The correctness of every other unit depends on this boundary holding.

**Files:**

- Create: `packages/core/src/workflows/sandbox.ts`
- Test: `packages/core/src/workflows/sandbox.test.ts`

**Interfaces:**

- Consumes: `node:vm` only (no other unit).
- Produces (used by Task 10):
  - `const SOURCE_MAX_BYTES = 512 * 1024`
  - `const SYNC_CPU_TIMEOUT_MS: number`
  - `class WorkflowScriptError extends Error`
  - `interface SandboxBridges` — `agent(promptJson, optsJson, resolve, reject): void`, `log(message): void`, `phase(title): void`, `budgetTotal(): number`, `budgetSpent(): number`
  - `interface RunSandboxOptions` — `argsJson?: string`, `syncTimeoutMs?: number`, `filename?: string`
  - `async function runInSandbox(body: string, bridges: SandboxBridges, opts?: RunSandboxOptions): Promise<unknown>`

**Security design (read before implementing):**

1. **The escape vector we defend.** `node:vm` gives each context its own realm intrinsics, so a _pure_ constructor chain (`({}).constructor.constructor(...)`) reaches the _context's_ `Function`/global, not the host's. The ONLY leak is a **host object reaching the script** — then `hostObj.constructor.constructor('return process')()` reaches the _host_ realm. Therefore no host object, function, promise, or `Error` may ever be exposed to the script.
2. **Primitives are context-native wrappers.** The bootstrap is compiled _into_ the context (`vm.compileFunction(..., { parsingContext })`), so `agent`/`parallel`/etc. are context functions. They close over the host `bridges` as a **parameter** — never a global property — so the script cannot reach `bridges`.
3. **Only strings cross the boundary.** `agent()` is callback-style: the context passes context-native `resolve`/`reject` to the host; the host replies with a JSON _string_ (success) or a message _string_ (failure). The script's return value comes back as a JSON string too. No host Promise/Error is ever `await`ed or `catch`ed by script-reachable code — this closes the caught-rejection leak (`catch(e){ e.constructor.constructor(...) }`).
4. **`vm` timeout ≠ wall-clock.** `runInContext`'s `timeout` bounds ONLY synchronous execution up to the first `await`. It does NOT bound a post-`await` CPU spin. The wall-clock ceiling is enforced separately by the agent bridge's deadline check (Task 10). This file must NOT claim to enforce wall-clock time.
5. **Determinism + freeze.** `Date.now()`, argless `new Date()`, `Math.random()` throw. Intrinsics are frozen (defense-in-depth; prototype pollution within the context can't reach host objects but is denied anyway).

- [ ] **Step 1: Write the failing escape-attempt + determinism test suite**

Create `packages/core/src/workflows/sandbox.test.ts`:

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  runInSandbox,
  WorkflowScriptError,
  type SandboxBridges,
} from './sandbox.js';

/** A bridge whose agent() always resolves a text envelope. */
function okBridges(over: Partial<SandboxBridges> = {}): SandboxBridges {
  return {
    agent: (_p, _o, resolve) =>
      resolve(JSON.stringify({ kind: 'text', text: 'ok' })),
    log: () => {},
    phase: () => {},
    budgetTotal: () => 1000,
    budgetSpent: () => 0,
    ...over,
  };
}

describe('sandbox escape attempts (SECURITY)', () => {
  it('has no require / import / process / Buffer / fetch', async () => {
    const r = await runInSandbox(
      `return {
        req: typeof require,
        proc: typeof process,
        buf: typeof Buffer,
        fetch: typeof fetch,
        gt: typeof globalThis.process,
      };`,
      okBridges(),
    );
    expect(r).toEqual({
      req: 'undefined',
      proc: 'undefined',
      buf: 'undefined',
      fetch: 'undefined',
      gt: 'undefined',
    });
  });

  it('HEADLINE: a primitive constructor chain cannot reach host process', async () => {
    // If someone "simplifies" by injecting the host function directly, this
    // returns the host process and the test fails — that is the point.
    const r = await runInSandbox(
      `return agent.constructor.constructor('return typeof process')();`,
      okBridges(),
    );
    expect(r).toBe('undefined');
  });

  it('this/Function constructor chains stay in-realm', async () => {
    const r = await runInSandbox(
      `const a = (function(){ return this; })();
       const viaThis = ({}).constructor.constructor('return typeof process')();
       const viaFn = (new Function('return typeof process'))();
       return { viaThis, viaFn };`,
      okBridges(),
    );
    expect(r).toEqual({ viaThis: 'undefined', viaFn: 'undefined' });
  });

  it('a caught agent rejection exposes only a context Error', async () => {
    const r = await runInSandbox(
      `try { await agent('x'); return 'no-throw'; }
       catch (e) { return e.constructor.constructor('return typeof process')(); }`,
      okBridges({ agent: (_p, _o, _res, reject) => reject('boom') }),
    );
    expect(r).toBe('undefined');
  });

  it('dynamic import() is unavailable', async () => {
    const r = await runInSandbox(
      `try { await import('node:fs'); return 'imported'; }
       catch (e) { return 'blocked'; }`,
      okBridges(),
    );
    expect(r).toBe('blocked');
  });

  it('prototype pollution inside the context cannot touch host objects', async () => {
    await runInSandbox(
      `try { Object.prototype.polluted = 'x'; } catch (e) {} return 1;`,
      okBridges(),
    );
    // Host Object.prototype is a different realm intrinsic — untouched.
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

describe('sandbox determinism guards', () => {
  it('Date.now(), argless new Date(), Math.random() throw; new Date(arg) works', async () => {
    const r = await runInSandbox(
      `const out = {};
       for (const [k, fn] of [
         ['now', () => Date.now()],
         ['date', () => new Date()],
         ['rand', () => Math.random()],
       ]) { try { fn(); out[k] = 'no-throw'; } catch (e) { out[k] = e.message.includes('deterministic') ? 'threw' : 'wrong-msg'; } }
       out.withArg = new Date(0).getTime();
       return out;`,
      okBridges(),
    );
    expect(r).toEqual({
      now: 'threw',
      date: 'threw',
      rand: 'threw',
      withArg: 0,
    });
  });
});

describe('sandbox primitives + result marshalling', () => {
  it('agent() returns the envelope value; args parse in-context', async () => {
    const r = await runInSandbox(
      `const t = await agent('hi'); return { t, a: args.n + 1 };`,
      okBridges(),
      { argsJson: JSON.stringify({ n: 41 }) },
    );
    expect(r).toEqual({ t: 'ok', a: 42 });
  });

  it('parallel settles all and nulls a thrown thunk', async () => {
    const r = await runInSandbox(
      `return await parallel([
         () => agent('a'),
         () => { throw new Error('nope'); },
         () => agent('c'),
       ]);`,
      okBridges(),
    );
    expect(r).toEqual(['ok', null, 'ok']);
  });

  it('an uncaught throw becomes a WorkflowScriptError', async () => {
    await expect(
      runInSandbox(`throw new Error('kaboom'); `, okBridges()),
    ).rejects.toBeInstanceOf(WorkflowScriptError);
  });
});
```

- [ ] **Step 2: Run the suite to verify it fails**

Run: `cd /home/evan/projects/qwen-code/packages/core && npx vitest run src/workflows/sandbox.test.ts`
Expected: FAIL — cannot resolve `./sandbox.js`.

- [ ] **Step 3: Write `sandbox.ts` (Opus authors this exact code)**

Create `packages/core/src/workflows/sandbox.ts`:

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import vm from 'node:vm';

/** Hard cap on script source size (design: "Script source capped at 512 KB"). */
export const SOURCE_MAX_BYTES = 512 * 1024;

/**
 * Default ceiling passed to vm.runInContext's `timeout`. NOTE: this bounds ONLY
 * synchronous execution up to the first `await`. It is NOT the wall-clock
 * ceiling — that is enforced by the agent bridge's deadline check
 * (scriptRunner.ts). See the design doc's threat-model honesty note.
 */
export const SYNC_CPU_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Host-side callbacks the sandbox bridges out to. CRITICAL: every value crossing
 * the boundary in EITHER direction is a primitive string. The host MUST NOT
 * return, resolve, or throw a host object/array/promise/Error to the sandbox —
 * doing so exposes host intrinsics via `.constructor.constructor` and defeats the
 * sandbox. `agent` is callback-style (not promise-returning) so no host Promise
 * ever reaches the context.
 */
export interface SandboxBridges {
  agent(
    promptJson: string,
    optsJson: string,
    resolve: (envelopeJson: string) => void,
    reject: (message: string) => void,
  ): void;
  log(message: string): void;
  phase(title: string): void;
  budgetTotal(): number;
  budgetSpent(): number;
}

export interface RunSandboxOptions {
  /** JSON string of the caller-supplied `args` value (or undefined). */
  argsJson?: string;
  /** Synchronous-CPU timeout (ms). Default SYNC_CPU_TIMEOUT_MS. */
  syncTimeoutMs?: number;
  /** Filename for stack traces. */
  filename?: string;
}

/** Thrown when the sandboxed script rejects or throws uncaught. */
export class WorkflowScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowScriptError';
  }
}

/**
 * In-context bootstrap: installs determinism guards + the allowlisted primitive
 * surface, then freezes intrinsics. Compiled WITH the context so its
 * Promise/JSON/Object/Error/Reflect are context intrinsics, and closes over the
 * host bridges via parameters (never global properties) so the script cannot
 * reach them.
 */
const BOOTSTRAP_SRC = String.raw`
'use strict';
const g = globalThis;

function determinismMessage(api) {
  return api + ' is disabled: workflow scripts must be deterministic so a ' +
    'journaled run can be replayed on resume. Derive values from agent ' +
    'results or the injected args instead.';
}

Math.random = function random() {
  throw new Error(determinismMessage('Math.random()'));
};

const RealDate = Date;
function GuardedDate(...a) {
  if (a.length === 0) {
    throw new Error(determinismMessage('new Date() with no arguments'));
  }
  return Reflect.construct(RealDate, a, new.target || GuardedDate);
}
GuardedDate.prototype = RealDate.prototype;
GuardedDate.now = function now() {
  throw new Error(determinismMessage('Date.now()'));
};
GuardedDate.parse = RealDate.parse;
GuardedDate.UTC = RealDate.UTC;
g.Date = GuardedDate;

const args = __argsJson === undefined ? undefined : JSON.parse(__argsJson);

const budget = Object.freeze({
  get total() { return __bridges.budgetTotal(); },
  spent() { return __bridges.budgetSpent(); },
  remaining() { return __bridges.budgetTotal() - __bridges.budgetSpent(); },
});

function agent(prompt, opts) {
  return new Promise(function (resolve, reject) {
    let settled = false;
    const ok = function (envelopeJson) {
      if (settled) return; settled = true;
      let env;
      try { env = JSON.parse(envelopeJson); }
      catch (e) { reject(new Error('workflow: malformed agent envelope')); return; }
      if (!env || env.kind === 'null') resolve(null);
      else if (env.kind === 'text') resolve(env.text);
      else resolve(env.value);
    };
    const fail = function (message) {
      if (settled) return; settled = true;
      reject(new Error(String(message)));
    };
    __bridges.agent(
      JSON.stringify(prompt === undefined ? null : prompt),
      JSON.stringify(opts === undefined ? {} : opts),
      ok,
      fail,
    );
  });
}

function parallel(thunks) {
  const arr = Array.from(thunks);
  return Promise.all(arr.map(function (t) {
    let p;
    try { p = t(); } catch (e) { return null; }
    return Promise.resolve(p).then(function (v) { return v; }, function () { return null; });
  }));
}

function pipeline(items) {
  const stages = Array.prototype.slice.call(arguments, 1);
  const arr = Array.from(items);
  return Promise.all(arr.map(async function (item, index) {
    let prev = item;
    for (let s = 0; s < stages.length; s++) {
      try { prev = await stages[s](prev, item, index); }
      catch (e) { return null; }
    }
    return prev;
  }));
}

function phase(title) { __bridges.phase(String(title)); }
function log(message) { __bridges.log(String(message)); }

g.agent = agent;
g.parallel = parallel;
g.pipeline = pipeline;
g.phase = phase;
g.log = log;
g.budget = budget;
Object.defineProperty(g, 'args', {
  value: args, writable: false, configurable: false, enumerable: true,
});

// Freeze intrinsics + primitives (defense-in-depth; stops the script tampering
// with its own primitives). Pollution within this realm cannot reach host
// objects (separate intrinsics) but is denied anyway.
Object.freeze(Object.prototype);
Object.freeze(Array.prototype);
Object.freeze(Function.prototype);
Object.freeze(Object);
Object.freeze(Math);
Object.freeze(JSON);
Object.freeze(agent);
Object.freeze(parallel);
Object.freeze(pipeline);
Object.freeze(phase);
Object.freeze(log);
`;

/**
 * Execute a meta-stripped script body inside a locked-down vm context. The
 * body may use top-level `await` and `return`. Returns the script's return
 * value (marshalled to the host as a JSON string — no context object crosses).
 */
export async function runInSandbox(
  body: string,
  bridges: SandboxBridges,
  opts: RunSandboxOptions = {},
): Promise<unknown> {
  const context = vm.createContext(Object.create(null), {
    // Allow in-context codegen so the HEADLINE escape test proves the wrapper
    // holds even when Function() executes (returns the CONTEXT global, not host).
    codeGeneration: { strings: true, wasm: false },
  });

  const bootstrap = vm.compileFunction(
    BOOTSTRAP_SRC,
    ['__bridges', '__argsJson'],
    {
      parsingContext: context,
    },
  );
  bootstrap(bridges, opts.argsJson);

  // Marshal the result back as a JSON string; never reject across the boundary.
  const runner =
    'Promise.resolve((async () => {\n"use strict";\n' +
    body +
    '\n})()).then(' +
    '__v => JSON.stringify({ ok: true, value: __v === undefined ? null : __v }),' +
    '__e => JSON.stringify({ ok: false, error: String((__e && __e.message) || __e) })' +
    ')';

  let resultJson: string;
  try {
    const resultPromise = vm.runInContext(runner, context, {
      timeout: opts.syncTimeoutMs ?? SYNC_CPU_TIMEOUT_MS,
      filename: opts.filename ?? 'workflow-script.js',
    }) as Promise<string>;
    resultJson = await resultPromise;
  } catch (err) {
    // Synchronous-CPU timeout, or a throw in the synchronous prologue.
    throw new WorkflowScriptError(
      err instanceof Error ? err.message : String(err),
    );
  }

  const parsed = JSON.parse(resultJson) as
    | { ok: true; value: unknown }
    | { ok: false; error: string };
  if (!parsed.ok) throw new WorkflowScriptError(parsed.error);
  return parsed.value;
}
```

- [ ] **Step 4: Run the suite to verify it passes**

Run: `cd /home/evan/projects/qwen-code/packages/core && npx vitest run src/workflows/sandbox.test.ts`
Expected: PASS (all escape/determinism/primitive cases).

- [ ] **Step 5: Opus review gate**

Before committing, Opus re-reads the diff against the five security-design points above (no host object crosses; primitives context-native; strings only; timeout ≠ wall-clock; determinism + freeze). Record the review in the commit body.

- [ ] **Step 6: Commit**

```bash
cd /home/evan/projects/qwen-code
git add packages/core/src/workflows/sandbox.ts packages/core/src/workflows/sandbox.test.ts
git commit -m "feat(core): workflow vm sandbox with escape-proof primitive bridges

SECURITY: authored and reviewed by Opus per the sandbox ownership rule."
```

---

### Task 6: `workflows/scheduler.ts` — concurrency gate + lifetime cap

**Files:**

- Create: `packages/core/src/workflows/scheduler.ts`
- Test: `packages/core/src/workflows/scheduler.test.ts`

**Interfaces:**

- Consumes: `node:os` (`cpus`).
- Produces (used by Task 10):
  - `class Scheduler`:
    - `constructor(concurrency?: number, lifetimeCap?: number)` — default concurrency `Math.max(1, Math.min(16, cpus().length - 2))`, default cap 1000
    - `readonly concurrency: number`
    - `tryCountAgent(): boolean` — increments the lifetime counter; returns false once the cap is hit
    - `get counted(): number`, `get active(): number`
    - `acquire(): Promise<() => void>` — resolves with a one-shot release when a slot is free (FIFO beyond the cap)

> **Deviation from the design doc (intentional):** the design lists `scheduler.ts` as owning `parallel`/`pipeline` semantics. For sandbox safety those combinators are context-native (defined in the bootstrap, Task 5) — a host-side combinator would rebuild the leak by creating host result arrays. So `scheduler.ts` owns ONLY the concurrency semaphore + lifetime cap that the agent bridge (Task 10) consults; barrier-vs-no-barrier semantics live in the sandbox bootstrap.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/workflows/scheduler.test.ts`:

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { Scheduler } from './scheduler.js';

describe('Scheduler', () => {
  it('caps concurrency and queues FIFO beyond it', async () => {
    const sched = new Scheduler(2, 1000);
    let active = 0;
    let peak = 0;
    const run = async () => {
      const release = await sched.acquire();
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      release();
    };
    await Promise.all(Array.from({ length: 8 }, run));
    expect(peak).toBe(2);
  });

  it('release is one-shot (double release does not over-grant)', async () => {
    const sched = new Scheduler(1, 1000);
    const r1 = await sched.acquire();
    r1();
    r1(); // no-op
    const r2 = await sched.acquire();
    expect(sched.active).toBe(1);
    r2();
  });

  it('lifetime cap trips after N counts', () => {
    const sched = new Scheduler(4, 3);
    expect(sched.tryCountAgent()).toBe(true);
    expect(sched.tryCountAgent()).toBe(true);
    expect(sched.tryCountAgent()).toBe(true);
    expect(sched.tryCountAgent()).toBe(false);
    expect(sched.counted).toBe(3);
  });

  it('default concurrency is at least 1', () => {
    expect(new Scheduler().concurrency).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/evan/projects/qwen-code/packages/core && npx vitest run src/workflows/scheduler.test.ts`
Expected: FAIL — cannot resolve `./scheduler.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/workflows/scheduler.ts`:

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { cpus } from 'node:os';

/** Default per-run concurrency: min(16, cpus-2), floored at 1. */
function defaultConcurrency(): number {
  return Math.max(1, Math.min(16, cpus().length - 2));
}

/**
 * Per-run gate for `agent()` calls (design: "scheduler.ts"). Owns the
 * concurrency semaphore (FIFO queue beyond the cap) and the lifetime agent-count
 * cap. Combinator semantics (parallel/pipeline) live in the sandbox bootstrap.
 */
export class Scheduler {
  private inFlight = 0;
  private readonly queue: Array<() => void> = [];
  private agentCount = 0;

  constructor(
    readonly concurrency: number = defaultConcurrency(),
    private readonly lifetimeCap: number = 1000,
  ) {}

  /** Increment the lifetime counter. Returns false once the cap is reached. */
  tryCountAgent(): boolean {
    if (this.agentCount >= this.lifetimeCap) return false;
    this.agentCount += 1;
    return true;
  }

  get counted(): number {
    return this.agentCount;
  }

  get active(): number {
    return this.inFlight;
  }

  /** Acquire a concurrency slot; resolves with a one-shot release. */
  acquire(): Promise<() => void> {
    const grant = (): (() => void) => {
      this.inFlight += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.release();
      };
    };
    if (this.inFlight < this.concurrency) {
      return Promise.resolve(grant());
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => resolve(grant()));
    });
  }

  private release(): void {
    this.inFlight -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/evan/projects/qwen-code/packages/core && npx vitest run src/workflows/scheduler.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/evan/projects/qwen-code
git add packages/core/src/workflows/scheduler.ts packages/core/src/workflows/scheduler.test.ts
git commit -m "feat(core): workflow scheduler (concurrency gate + lifetime agent cap)"
```

---

### Task 7: `workflows/journal.ts` — JSONL journal + resume replay

**Files:**

- Create: `packages/core/src/workflows/journal.ts`
- Test: `packages/core/src/workflows/journal.test.ts`

**Interfaces:**

- Consumes: `node:fs/promises`, `node:path`, `node:crypto`.
- Produces (used by Task 10):
  - `interface JournalRecord { seq: number; kind: 'agent'; promptHash: string; optsHash: string; result: unknown; tokens: number; error?: string }`
  - `function canonicalHash(value: unknown): string` — SHA-256 (hex) of sorted-key JSON
  - `class Journal`:
    - `static async open(dir: string, init: { meta: unknown; scriptHash: string; args: unknown; resumeDir?: string }): Promise<Journal>`
    - `nextSeq(): number` — synchronous, monotonic (assigned at `agent()` entry)
    - `lookup(seq: number, kind: 'agent', promptHash: string, optsHash: string): JournalRecord | undefined` — prefix cache with a divergence latch
    - `async append(rec: JournalRecord): Promise<void>`
    - `async setStatus(status: 'running' | 'completed' | 'failed' | 'cancelled', tokensSpent: number): Promise<void>`
    - `log(message: string): void`, `phase(title: string, index: number): void` (best-effort activity, no-throw)

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/workflows/journal.test.ts`:

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal, canonicalHash } from './journal.js';

async function tmpRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'wf-journal-'));
}

describe('canonicalHash', () => {
  it('is stable across key order', () => {
    expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ b: 2, a: 1 }));
    expect(canonicalHash({ a: 1 })).not.toBe(canonicalHash({ a: 2 }));
  });
});

describe('Journal', () => {
  it('assigns seq synchronously and persists records + run.json', async () => {
    const root = await tmpRoot();
    const dir = join(root, 'run-1');
    const j = await Journal.open(dir, {
      meta: { name: 'x' },
      scriptHash: 'h',
      args: null,
    });
    expect(j.nextSeq()).toBe(0);
    expect(j.nextSeq()).toBe(1);
    await j.append({
      seq: 0,
      kind: 'agent',
      promptHash: 'p0',
      optsHash: 'o0',
      result: { kind: 'text', text: 'a' },
      tokens: 5,
    });
    await j.setStatus('completed', 5);
    const run = JSON.parse(await readFile(join(dir, 'run.json'), 'utf8'));
    expect(run.status).toBe('completed');
    expect(run.scriptHash).toBe('h');
    const jl = await readFile(join(dir, 'journal.jsonl'), 'utf8');
    expect(jl.trim().split('\n')).toHaveLength(1);
  });

  it('replays the matching prefix and latches divergence', async () => {
    const root = await tmpRoot();
    const dir1 = join(root, 'run-1');
    const j1 = await Journal.open(dir1, {
      meta: {},
      scriptHash: 'h',
      args: null,
    });
    for (let seq = 0; seq < 3; seq++) {
      expect(j1.nextSeq()).toBe(seq);
      await j1.append({
        seq,
        kind: 'agent',
        promptHash: `p${seq}`,
        optsHash: 'o',
        result: { kind: 'text', text: `r${seq}` },
        tokens: 1,
      });
    }
    await j1.setStatus('completed', 3);

    // Resume: first two match, third diverges (different prompt), latch holds.
    const dir2 = join(root, 'run-2');
    const j2 = await Journal.open(dir2, {
      meta: {},
      scriptHash: 'h',
      args: null,
      resumeDir: dir1,
    });
    expect(j2.lookup(j2.nextSeq(), 'agent', 'p0', 'o')?.result).toEqual({
      kind: 'text',
      text: 'r0',
    });
    expect(j2.lookup(j2.nextSeq(), 'agent', 'p1', 'o')?.result).toEqual({
      kind: 'text',
      text: 'r1',
    });
    // Divergence at seq 2.
    expect(j2.lookup(j2.nextSeq(), 'agent', 'CHANGED', 'o')).toBeUndefined();
    // Even a later coincidental match returns undefined (latch).
    expect(j2.lookup(j2.nextSeq(), 'agent', 'p3', 'o')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/evan/projects/qwen-code/packages/core && npx vitest run src/workflows/journal.test.ts`
Expected: FAIL — cannot resolve `./journal.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/workflows/journal.ts`:

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface JournalRecord {
  seq: number;
  kind: 'agent';
  promptHash: string;
  optsHash: string;
  result: unknown; // the agent envelope { kind: 'text'|'structured'|'null', ... }
  tokens: number;
  error?: string;
}

interface RunFile {
  meta: unknown;
  scriptHash: string;
  args: unknown;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt: string | null;
  tokensSpent: number;
}

/** Sort object keys recursively so the hash is order-independent. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** SHA-256 (hex) of canonicalized JSON. */
export function canonicalHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

/**
 * Per-run journal (design: "journal.ts"). JSONL at `<dir>/journal.jsonl`, run
 * metadata at `<dir>/run.json`. On resume, replays the longest prefix whose
 * seq + prompt/opts hashes match; the first divergence LATCHES so nothing after
 * it is served from cache even if it happens to match.
 */
export class Journal {
  private seqCounter = 0;
  private diverged = false;
  private readonly cached = new Map<number, JournalRecord>();
  private runFile: RunFile;

  private constructor(
    private readonly dir: string,
    init: { meta: unknown; scriptHash: string; args: unknown },
  ) {
    this.runFile = {
      meta: init.meta,
      scriptHash: init.scriptHash,
      args: init.args,
      status: 'running',
      startedAt: new Date(0).toISOString(),
      finishedAt: null,
      tokensSpent: 0,
    };
  }

  static async open(
    dir: string,
    init: {
      meta: unknown;
      scriptHash: string;
      args: unknown;
      resumeDir?: string;
    },
  ): Promise<Journal> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const j = new Journal(dir, init);
    // startedAt uses a real wall clock host-side (NOT inside the sandbox).
    j.runFile.startedAt = new Date().toISOString();
    if (init.resumeDir) {
      try {
        const raw = await readFile(
          join(init.resumeDir, 'journal.jsonl'),
          'utf8',
        );
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue;
          const rec = JSON.parse(line) as JournalRecord;
          j.cached.set(rec.seq, rec);
        }
      } catch {
        // No prior journal → nothing cached; every call runs live.
      }
    }
    await j.persistRun();
    return j;
  }

  /** Synchronous, monotonic seq assignment at agent() entry (deterministic). */
  nextSeq(): number {
    return this.seqCounter++;
  }

  lookup(
    seq: number,
    kind: 'agent',
    promptHash: string,
    optsHash: string,
  ): JournalRecord | undefined {
    if (this.diverged) return undefined;
    const rec = this.cached.get(seq);
    if (
      rec &&
      rec.kind === kind &&
      rec.promptHash === promptHash &&
      rec.optsHash === optsHash
    ) {
      // Re-journal the replayed record so the resumed run stays self-contained.
      void this.append(rec);
      return rec;
    }
    this.diverged = true;
    return undefined;
  }

  async append(rec: JournalRecord): Promise<void> {
    await appendFile(
      join(this.dir, 'journal.jsonl'),
      JSON.stringify(rec) + '\n',
      {
        mode: 0o600,
      },
    );
  }

  async setStatus(
    status: RunFile['status'],
    tokensSpent: number,
  ): Promise<void> {
    this.runFile.status = status;
    this.runFile.tokensSpent = tokensSpent;
    this.runFile.finishedAt =
      status === 'running' ? null : new Date().toISOString();
    await this.persistRun();
  }

  log(_message: string): void {
    // Best-effort sink; intentionally a no-op here (surfaced via the tool's
    // background-task activity in Task 11). Never throws into the sandbox.
  }

  phase(_title: string, _index: number): void {
    // Handled by the caller's onPhase; no-op journal side (never throws).
  }

  private async persistRun(): Promise<void> {
    await writeFile(
      join(this.dir, 'run.json'),
      JSON.stringify(this.runFile, null, 2),
      {
        mode: 0o600,
      },
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/evan/projects/qwen-code/packages/core && npx vitest run src/workflows/journal.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/evan/projects/qwen-code
git add packages/core/src/workflows/journal.ts packages/core/src/workflows/journal.test.ts
git commit -m "feat(core): workflow journal with prefix-replay resume + sorted-key hashing"
```

---

### Task 8: `workflows/spawner.ts` — `AgentSpawner` interface + `HeadlessSpawner`

**Files:**

- Create: `packages/core/src/workflows/spawner.ts`
- Test: `packages/core/src/workflows/spawner.test.ts`

**Interfaces:**

- Consumes: `AgentHeadless`, `ContextState` from `../agents/runtime/agent-headless.js`; `Config` type from `../config/config.js`; `ajv` and `jsonrepair` (existing core deps).
- Produces (used by Task 10, and by Part C's `SessionSpawner`):
  - `interface AgentSpawnRequest { prompt: string; systemContext: string; model?: string; agentType?: string; schema?: Record<string, unknown>; cwd?: string; signal?: AbortSignal }`
  - `interface AgentSpawnResult { text?: string; structured?: unknown; tokens: number }`
  - `interface AgentSpawner { spawn(req: AgentSpawnRequest): Promise<AgentSpawnResult> }`
  - `class HeadlessSpawner implements AgentSpawner` — `constructor(config: Config)`

> **Deviation from the design doc (real-API forced).** The design says schema enforcement uses "a forced StructuredOutput tool, validated return". `AgentHeadless` exposes NO read-back for a StructuredOutput tool call — that capture lives in `nonInteractiveCli`, not in the runtime. So `HeadlessSpawner` instead instructs the model (system prompt) to emit schema-conforming JSON, then validates `getFinalText()` with **Ajv** (a core dep) after a **jsonrepair** pass, with up to 2 retries. Same guarantee (validated object or `null`), implementable against the real runtime.
>
> **Deviation from the design doc (real-API forced).** `AgentHeadless` has no per-run `cwd`; it uses `Config.getWorkingDir()`. So `HeadlessSpawner` accepts `req.cwd` but can only honor it by deriving a Config bound to that dir — deferred here (worktree isolation is naturally SessionSpawner-first, Part C). `req.cwd` is threaded through the interface so `SessionSpawner` (which spawns a real session with its own `workspaceCwd`) can honor it.

- [ ] **Step 1: Write the failing test (against a stub subclass — no live model)**

Create `packages/core/src/workflows/spawner.test.ts`:

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  validateAgainstSchema,
  type AgentSpawner,
  type AgentSpawnRequest,
  type AgentSpawnResult,
} from './spawner.js';

/** A stub spawner proving the AgentSpawner contract without a live model. */
class StubSpawner implements AgentSpawner {
  constructor(private readonly reply: AgentSpawnResult) {}
  async spawn(_req: AgentSpawnRequest): Promise<AgentSpawnResult> {
    return this.reply;
  }
}

describe('AgentSpawner contract', () => {
  it('a stub spawner returns text + tokens', async () => {
    const s = new StubSpawner({ text: 'hello', tokens: 12 });
    const r = await s.spawn({ prompt: 'hi', systemContext: '' });
    expect(r).toEqual({ text: 'hello', tokens: 12 });
  });
});

describe('validateAgainstSchema (schema helper used by HeadlessSpawner)', () => {
  const schema = {
    type: 'object',
    properties: { title: { type: 'string' } },
    required: ['title'],
    additionalProperties: false,
  };

  it('accepts clean JSON', () => {
    expect(validateAgainstSchema('{"title":"ok"}', schema)).toEqual({
      valid: true,
      value: { title: 'ok' },
    });
  });

  it('repairs then accepts loose JSON', () => {
    // Trailing comma + prose wrapper — jsonrepair + extraction recover it.
    const res = validateAgainstSchema('Here: {"title":"ok",}', schema);
    expect(res.valid).toBe(true);
  });

  it('rejects schema-violating JSON with an error string', () => {
    const res = validateAgainstSchema('{"nope":1}', schema);
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.error).toMatch(/title/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/evan/projects/qwen-code/packages/core && npx vitest run src/workflows/spawner.test.ts`
Expected: FAIL — cannot resolve `./spawner.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/workflows/spawner.ts`:

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import Ajv from 'ajv';
import { jsonrepair } from 'jsonrepair';
import type { Config } from '../config/config.js';
import {
  AgentHeadless,
  ContextState,
} from '../agents/runtime/agent-headless.js';

/** Max schema-validation retries after the first attempt. */
const SCHEMA_RETRIES = 2;

export interface AgentSpawnRequest {
  prompt: string;
  systemContext: string;
  model?: string;
  agentType?: string;
  /** JSON Schema. When present, the result MUST validate or the spawn fails. */
  schema?: Record<string, unknown>;
  /** Honored by spawners that can bind a working dir (SessionSpawner). */
  cwd?: string;
  signal?: AbortSignal;
}

export interface AgentSpawnResult {
  text?: string;
  structured?: unknown;
  tokens: number;
}

export interface AgentSpawner {
  spawn(req: AgentSpawnRequest): Promise<AgentSpawnResult>;
}

const ajv = new Ajv({ allErrors: true, strict: false });

/** Extract the first balanced JSON object/array substring from model prose. */
function extractJson(text: string): string {
  const start = text.search(/[[{]/);
  if (start < 0) return text;
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  return end > start ? text.slice(start, end + 1) : text.slice(start);
}

export type SchemaCheck =
  | { valid: true; value: unknown }
  | { valid: false; error: string };

/** Parse (repairing if needed) then validate model output against a JSON Schema. */
export function validateAgainstSchema(
  text: string,
  schema: Record<string, unknown>,
): SchemaCheck {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    try {
      parsed = JSON.parse(jsonrepair(extractJson(text)));
    } catch {
      return { valid: false, error: 'reply was not JSON' };
    }
  }
  const validate = ajv.compile(schema);
  if (validate(parsed)) return { valid: true, value: parsed };
  return { valid: false, error: ajv.errorsText(validate.errors) };
}

/**
 * Core spawner: wraps the headless agent runtime (design: "HeadlessSpawner").
 * Works offline. Schema enforcement is Ajv-over-final-text with bounded retries
 * (see the spawner.ts deviation note — the runtime has no StructuredOutput
 * read-back).
 */
export class HeadlessSpawner implements AgentSpawner {
  constructor(private readonly config: Config) {}

  async spawn(req: AgentSpawnRequest): Promise<AgentSpawnResult> {
    let tokens = 0;
    let lastError = '';
    const attempts = req.schema ? SCHEMA_RETRIES + 1 : 1;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const systemPrompt = req.schema
        ? `${req.systemContext}\n\nReply with ONLY a JSON value conforming to this JSON Schema:\n${JSON.stringify(req.schema)}` +
          (lastError
            ? `\n\nYour previous reply was invalid (${lastError}). Return corrected JSON only.`
            : '')
        : req.systemContext;

      const agent = await AgentHeadless.create(
        req.agentType ?? 'workflow-agent',
        this.config,
        { systemPrompt },
        req.model ? { model: req.model } : {},
        {},
      );
      const ctx = new ContextState();
      ctx.set('task_prompt', req.prompt);
      await agent.execute(ctx, req.signal);

      tokens += agent.getStatistics().totalTokens ?? 0;
      const text = agent.getFinalText();

      if (!req.schema) return { text, tokens };

      const check = validateAgainstSchema(text, req.schema);
      if (check.valid) return { structured: check.value, tokens };
      lastError = check.error;
    }
    // Exhausted retries → the bridge (Task 10) maps a throw to a null result.
    throw new Error(
      `schema validation failed after ${attempts} attempts: ${lastError}`,
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/evan/projects/qwen-code/packages/core && npx vitest run src/workflows/spawner.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/evan/projects/qwen-code
git add packages/core/src/workflows/spawner.ts packages/core/src/workflows/spawner.test.ts
git commit -m "feat(core): AgentSpawner interface + HeadlessSpawner (Ajv schema enforcement)"
```

---

### Task 9: `workflows/worktree.ts` — `isolation: 'worktree'` provider

**Files:**

- Create: `packages/core/src/workflows/worktree.ts`
- Test: `packages/core/src/workflows/worktree.test.ts`

**Interfaces:**

- Consumes: `GitWorktreeService` from `../services/gitWorktreeService.js` (`new GitWorktreeService(sourceRepoPath, customBaseDir?)`; `setupWorktrees({ sessionId, sourceRepoPath, worktreeNames })` → `{ worktreesByName: Record<string, { path }>; errors: Array<{ name; error }> }`; `getWorktreeDiff(path)`; `removeWorktree(path)`; `cleanupSession(sessionId)`), the same service `ArenaManager` constructs.
- Produces (used by Task 10):
  - `interface WorktreeProvider { acquire(runId: string, seq: number): Promise<string>; cleanup(runId: string): Promise<void> }`
  - `class GitWorktreeProvider implements WorktreeProvider` — `constructor(sourceRepoPath: string, baseDir?: string)`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/workflows/worktree.test.ts`:

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
import { simpleGit } from 'simple-git';
import { GitWorktreeProvider } from './worktree.js';

async function tmpGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wf-wt-'));
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('user.name', 'Test');
  await git.raw(['commit', '--allow-empty', '-m', 'init']);
  return dir;
}

describe('GitWorktreeProvider', () => {
  it('acquires a worktree and returns its path', async () => {
    const repo = await tmpGitRepo();
    const base = await mkdtemp(join(tmpdir(), 'wf-wt-base-'));
    const provider = new GitWorktreeProvider(repo, base);
    const cwd = await provider.acquire('run-1', 0);
    expect(cwd).toContain(base);
    await provider.cleanup('run-1');
  });

  it('throws when acquisition fails (not a git repo) — no silent fallback', async () => {
    const notRepo = await mkdtemp(join(tmpdir(), 'wf-not-repo-'));
    const provider = new GitWorktreeProvider(notRepo, notRepo);
    await expect(provider.acquire('run-2', 0)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/evan/projects/qwen-code/packages/core && npx vitest run src/workflows/worktree.test.ts`
Expected: FAIL — cannot resolve `./worktree.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/workflows/worktree.ts`:

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { GitWorktreeService } from '../services/gitWorktreeService.js';

/** Acquires per-agent isolated working trees for `isolation: 'worktree'`. */
export interface WorktreeProvider {
  /** Returns the cwd path for one agent; throws on failure (never falls back). */
  acquire(runId: string, seq: number): Promise<string>;
  /** Remove the run's worktrees (auto-removes those left unchanged). */
  cleanup(runId: string): Promise<void>;
}

/**
 * Backs `isolation: 'worktree'` with the same `GitWorktreeService` ArenaManager
 * uses (design: "worktree.ts"). Acquisition failure ERRORS that agent (the
 * bridge maps it to a null result) — there is deliberately NO silent fallback
 * to the shared tree.
 */
export class GitWorktreeProvider implements WorktreeProvider {
  private readonly service: GitWorktreeService;

  constructor(
    private readonly sourceRepoPath: string,
    baseDir?: string,
  ) {
    this.service = new GitWorktreeService(sourceRepoPath, baseDir);
  }

  async acquire(runId: string, seq: number): Promise<string> {
    const name = `agent-${seq}`;
    const result = await this.service.setupWorktrees({
      sessionId: runId,
      sourceRepoPath: this.sourceRepoPath,
      worktreeNames: [name],
    });
    const wt = result.worktreesByName[name];
    if (!wt) {
      const why = result.errors.map((e) => `${e.name}: ${e.error}`).join('; ');
      throw new Error(
        `worktree acquisition failed for ${name}: ${why || 'unknown'}`,
      );
    }
    return wt.path;
  }

  async cleanup(runId: string): Promise<void> {
    // cleanupSession removes the session's worktrees + branches. Worktrees left
    // unchanged carry no commits, so removal loses nothing (design:
    // "auto-removes if unchanged"). Best-effort — never throws into a run.
    try {
      await this.service.cleanupSession(runId);
    } catch {
      // Leave residue for manual cleanup rather than failing the run.
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/evan/projects/qwen-code/packages/core && npx vitest run src/workflows/worktree.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/evan/projects/qwen-code
git add packages/core/src/workflows/worktree.ts packages/core/src/workflows/worktree.test.ts
git commit -m "feat(core): worktree isolation provider over GitWorktreeService"
```

---

### Task 10: `workflows/scriptRunner.ts` + `WorkflowEngine` + barrel export

**Files:**

- Modify: `packages/core/package.json` (add `"acorn": "^8.15.0"` to `dependencies`)
- Create: `packages/core/src/workflows/scriptRunner.ts`
- Create: `packages/core/src/workflows/index.ts`
- Modify: `packages/core/src/index.ts` (re-export the workflows barrel so Part C can import the engine)
- Test: `packages/core/src/workflows/scriptRunner.test.ts`

**Interfaces:**

- Consumes: Task 5 `runInSandbox`/`SOURCE_MAX_BYTES`/`WorkflowScriptError`/`SandboxBridges`; Task 6 `Scheduler`; Task 7 `Journal`/`canonicalHash`/`JournalRecord`; Task 8 `AgentSpawner`; Task 9 `WorktreeProvider`; `acorn`; `node:crypto` (`createHash`, `randomUUID`); `node:os` (`homedir`), `node:path`.
- Produces (used by Task 11 and Part C):
  - `interface WorkflowMeta { name: string; description: string; phases?: Array<{ title: string }> }`
  - `interface ParsedScript { meta: WorkflowMeta; body: string; scriptHash: string }`
  - `function parseWorkflowScript(source: string): ParsedScript` (throws `WorkflowScriptError` with line info)
  - `interface WorkflowRunOptions { runId?: string; args?: unknown; resumeFromRunId?: string; budgetTotal?: number; wallClockMs?: number; lifetimeAgentCap?: number; signal?: AbortSignal; onPhase?: (title: string, index: number) => void; onAgentCount?: (counted: number) => void }`
  - `interface WorkflowRunResult { runId: string; result: unknown; status: 'completed' | 'failed' | 'cancelled'; tokensSpent: number }`
  - `class WorkflowEngine` — `constructor(spawner: AgentSpawner, opts?: { runsDir?: string; worktree?: WorktreeProvider; systemContext?: string })`; `async run(source: string, runOpts?: WorkflowRunOptions): Promise<WorkflowRunResult>`
  - The `workflows/index.ts` barrel re-exports all public symbols from `sandbox`, `scheduler`, `journal`, `spawner`, `worktree`, and `scriptRunner`.

- [ ] **Step 1: Add the acorn dependency**

In `packages/core/package.json`, add to `dependencies` (alphabetical, before `ajv`):

```json
    "acorn": "^8.15.0",
```

Then `cd /home/evan/projects/qwen-code && npm install` (or the repo's package manager) to lock it.

- [ ] **Step 2: Write the failing test**

Create `packages/core/src/workflows/scriptRunner.test.ts`:

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
import { parseWorkflowScript, WorkflowEngine } from './scriptRunner.js';
import { WorkflowScriptError } from './sandbox.js';
import type {
  AgentSpawner,
  AgentSpawnRequest,
  AgentSpawnResult,
} from './spawner.js';

class RecordingSpawner implements AgentSpawner {
  readonly prompts: string[] = [];
  constructor(private readonly reply: (p: string) => AgentSpawnResult) {}
  async spawn(req: AgentSpawnRequest): Promise<AgentSpawnResult> {
    this.prompts.push(req.prompt);
    return this.reply(req.prompt);
  }
}

async function runsDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'wf-runs-'));
}

const META_HEADER = `export const meta = { name: 'demo', description: 'd', phases: [{ title: 'A' }] };\n`;

describe('parseWorkflowScript', () => {
  it('accepts a pure-literal meta and strips the export', () => {
    const parsed = parseWorkflowScript(`${META_HEADER}return 1;`);
    expect(parsed.meta).toEqual({
      name: 'demo',
      description: 'd',
      phases: [{ title: 'A' }],
    });
    expect(parsed.body).not.toContain('export');
    expect(parsed.scriptHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a computed meta value with line info', () => {
    expect(() =>
      parseWorkflowScript(
        `export const meta = { name: 'x'.toUpperCase(), description: 'd' };\n`,
      ),
    ).toThrow(WorkflowScriptError);
  });

  it('rejects a source over the 512 KB cap', () => {
    const big =
      META_HEADER + `const s = '${'x'.repeat(520 * 1024)}';\nreturn 1;`;
    expect(() => parseWorkflowScript(big)).toThrow(/512 KB/);
  });
});

describe('WorkflowEngine.run', () => {
  it('runs a pipeline and returns the script value', async () => {
    const spawner = new RecordingSpawner((p) => ({
      text: `did:${p}`,
      tokens: 3,
    }));
    const engine = new WorkflowEngine(spawner, { runsDir: await runsDir() });
    const script = `${META_HEADER}
      phase('A');
      const out = await pipeline(['x', 'y'],
        (item) => agent('find ' + item),
        (prev) => agent('verify ' + prev),
      );
      return out;`;
    const res = await engine.run(script, {});
    expect(res.status).toBe('completed');
    expect(res.tokensSpent).toBe(12); // 2 items * 2 stages * 3 tokens
    expect(res.result).toEqual([
      'did:verify did:find x',
      'did:verify did:find y',
    ]);
  });

  it('resumes an unchanged script 100% from cache (no re-spawn)', async () => {
    const dir = await runsDir();
    const first = new RecordingSpawner((p) => ({ text: `r:${p}`, tokens: 1 }));
    const engine1 = new WorkflowEngine(first, { runsDir: dir });
    const script = `${META_HEADER}
      const a = await agent('one');
      const b = await agent('two');
      return [a, b];`;
    const r1 = await engine1.run(script, {});
    expect(first.prompts).toHaveLength(2);

    const second = new RecordingSpawner(() => ({
      text: 'SHOULD-NOT-RUN',
      tokens: 99,
    }));
    const engine2 = new WorkflowEngine(second, { runsDir: dir });
    const r2 = await engine2.run(script, { resumeFromRunId: r1.runId });
    expect(second.prompts).toHaveLength(0); // fully cached
    expect(r2.result).toEqual(r1.result);
    expect(r2.tokensSpent).toBe(0);
  });

  it('budget exhaustion throws into the script → run failed', async () => {
    const spawner = new RecordingSpawner((p) => ({ text: p, tokens: 100 }));
    const engine = new WorkflowEngine(spawner, { runsDir: await runsDir() });
    const script = `${META_HEADER}
      await agent('first');   // spends 100
      await agent('second');  // budget already exhausted → throws
      return 'unreached';`;
    await expect(
      engine.run(script, { budgetTotal: 100 }),
    ).rejects.toBeInstanceOf(WorkflowScriptError);
  });
});
```

- [ ] **Step 3: Write `scriptRunner.ts`**

Create `packages/core/src/workflows/scriptRunner.ts`:

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as acorn from 'acorn';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  runInSandbox,
  SOURCE_MAX_BYTES,
  SYNC_CPU_TIMEOUT_MS,
  WorkflowScriptError,
  type SandboxBridges,
} from './sandbox.js';
import { Scheduler } from './scheduler.js';
import { canonicalHash, Journal } from './journal.js';
import type { AgentSpawner } from './spawner.js';
import type { WorktreeProvider } from './worktree.js';

export interface WorkflowMeta {
  name: string;
  description: string;
  phases?: Array<{ title: string }>;
}

export interface ParsedScript {
  meta: WorkflowMeta;
  body: string;
  scriptHash: string;
}

/** The opts object a script passes to agent(); only these keys are honored. */
interface AgentOpts {
  label?: string;
  phase?: string;
  schema?: Record<string, unknown>;
  model?: string;
  agentType?: string;
  isolation?: 'worktree';
  timeoutMs?: number;
}

/** Walk a verified-literal AST node into a JS value (no eval). */
function evalLiteral(node: acorn.Node, source: string): unknown {
  const n = node as unknown as {
    type: string;
    value?: unknown;
    elements?: acorn.Node[];
    properties?: Array<{
      type: string;
      computed: boolean;
      kind: string;
      key: { type: string; name?: string; value?: unknown };
      value: acorn.Node;
    }>;
    quasis?: Array<{ value: { cooked: string } }>;
    expressions?: acorn.Node[];
    operator?: string;
    argument?: acorn.Node;
    start: number;
    loc?: { start: { line: number; column: number } };
  };
  const fail = (): never => {
    const line = n.loc ? ` at line ${n.loc.start.line}` : '';
    throw new WorkflowScriptError(
      `workflow meta must be a pure literal (no computed values)${line}`,
    );
  };
  switch (n.type) {
    case 'Literal':
      return n.value;
    case 'TemplateLiteral':
      if ((n.expressions?.length ?? 0) !== 0) return fail();
      return n.quasis?.[0]?.value.cooked ?? '';
    case 'UnaryExpression':
      if ((n.operator === '-' || n.operator === '+') && n.argument) {
        const v = evalLiteral(n.argument, source);
        if (typeof v === 'number') return n.operator === '-' ? -v : v;
      }
      return fail();
    case 'ArrayExpression':
      return (n.elements ?? []).map((el) => {
        if (!el) return fail();
        return evalLiteral(el, source);
      });
    case 'ObjectExpression': {
      const out: Record<string, unknown> = {};
      for (const prop of n.properties ?? []) {
        if (prop.type !== 'Property' || prop.computed || prop.kind !== 'init')
          return fail();
        const key =
          prop.key.type === 'Identifier'
            ? prop.key.name
            : prop.key.type === 'Literal'
              ? String(prop.key.value)
              : undefined;
        if (key === undefined) return fail();
        out[key] = evalLiteral(prop.value, source);
      }
      return out;
    }
    default:
      return fail();
  }
}

/**
 * Static meta parse + pure-literal AST check (design: "static meta parse").
 * Verifies the 512 KB cap, that exactly one `export const meta = <literal>`
 * exists, evaluates it, and strips the `export` keyword so the body runs inside
 * the sandbox's async IIFE. Throws WorkflowScriptError (with line info) before
 * any code executes.
 */
export function parseWorkflowScript(source: string): ParsedScript {
  if (Buffer.byteLength(source, 'utf8') > SOURCE_MAX_BYTES) {
    throw new WorkflowScriptError('workflow script exceeds 512 KB source cap');
  }
  let program: acorn.Node;
  try {
    program = acorn.parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      locations: true,
    });
  } catch (e) {
    const loc = (e as { loc?: { line: number; column: number } }).loc;
    throw new WorkflowScriptError(
      `workflow script parse error${loc ? ` at line ${loc.line}:${loc.column}` : ''}: ${(e as Error).message}`,
    );
  }

  const body = (program as unknown as { body: acorn.Node[] }).body;
  let metaExport:
    | {
        node: acorn.Node & {
          start: number;
          declaration: acorn.Node & { start: number };
        };
        init: acorn.Node;
      }
    | undefined;

  for (const stmt of body) {
    const s = stmt as unknown as {
      type: string;
      start: number;
      declaration?: unknown;
    };
    if (
      s.type === 'ExportDefaultDeclaration' ||
      s.type === 'ExportAllDeclaration'
    ) {
      throw new WorkflowScriptError('workflow scripts may only export `meta`');
    }
    if (s.type !== 'ExportNamedDeclaration') continue;
    const decl = s.declaration as unknown as {
      type: string;
      declarations?: Array<{
        id: { type: string; name?: string };
        init: acorn.Node;
      }>;
      start: number;
    } | null;
    if (!decl || decl.type !== 'VariableDeclaration') {
      throw new WorkflowScriptError('workflow scripts may only export `meta`');
    }
    const d = decl.declarations?.[0];
    if (!d || d.id.type !== 'Identifier' || d.id.name !== 'meta' || !d.init) {
      throw new WorkflowScriptError('workflow scripts may only export `meta`');
    }
    metaExport = {
      node: stmt as acorn.Node & {
        start: number;
        declaration: acorn.Node & { start: number };
      },
      init: d.init,
    };
  }

  if (!metaExport) {
    throw new WorkflowScriptError(
      'workflow script must `export const meta = { ... }`',
    );
  }

  const metaValue = evalLiteral(
    metaExport.init,
    source,
  ) as Partial<WorkflowMeta>;
  if (
    typeof metaValue.name !== 'string' ||
    typeof metaValue.description !== 'string'
  ) {
    throw new WorkflowScriptError(
      'workflow meta requires string `name` and `description`',
    );
  }
  if (
    metaValue.phases !== undefined &&
    (!Array.isArray(metaValue.phases) ||
      metaValue.phases.some(
        (p) => typeof (p as { title?: unknown })?.title !== 'string',
      ))
  ) {
    throw new WorkflowScriptError(
      'workflow meta.phases must be an array of { title: string }',
    );
  }

  // Blank out just the `export ` keyword span so line/column numbers are
  // preserved for stack traces; the remaining `const meta = {...}` is a
  // harmless local inside the IIFE.
  const exportStart = metaExport.node.start;
  const declStart = metaExport.node.declaration.start;
  const stripped =
    source.slice(0, exportStart) +
    ' '.repeat(declStart - exportStart) +
    source.slice(declStart);

  return {
    meta: metaValue as WorkflowMeta,
    body: stripped,
    scriptHash: createHash('sha256').update(source).digest('hex'),
  };
}

export interface WorkflowRunOptions {
  runId?: string;
  args?: unknown;
  resumeFromRunId?: string;
  budgetTotal?: number;
  wallClockMs?: number;
  lifetimeAgentCap?: number;
  signal?: AbortSignal;
  onPhase?: (title: string, index: number) => void;
  onAgentCount?: (counted: number) => void;
}

export interface WorkflowRunResult {
  runId: string;
  result: unknown;
  status: 'completed' | 'failed' | 'cancelled';
  tokensSpent: number;
}

function defaultRunsDir(): string {
  return join(homedir(), '.qwen', 'workflows', 'runs');
}

/**
 * The one engine (design: Approach A). Assembles the agent bridge over
 * scheduler + journal + spawner + optional worktree, and runs the script in the
 * sandbox. Works with ANY AgentSpawner (HeadlessSpawner in core; SessionSpawner
 * in the gateway).
 */
export class WorkflowEngine {
  constructor(
    private readonly spawner: AgentSpawner,
    private readonly opts: {
      runsDir?: string;
      worktree?: WorktreeProvider;
      systemContext?: string;
    } = {},
  ) {}

  async run(
    source: string,
    runOpts: WorkflowRunOptions = {},
  ): Promise<WorkflowRunResult> {
    const parsed = parseWorkflowScript(source);
    const runId = runOpts.runId ?? randomUUID();
    const runsDir = this.opts.runsDir ?? defaultRunsDir();
    const journal = await Journal.open(join(runsDir, runId), {
      meta: parsed.meta,
      scriptHash: parsed.scriptHash,
      args: runOpts.args ?? null,
      resumeDir: runOpts.resumeFromRunId
        ? join(runsDir, runOpts.resumeFromRunId)
        : undefined,
    });
    const scheduler = new Scheduler(
      undefined,
      runOpts.lifetimeAgentCap ?? 1000,
    );
    const budgetTotal = runOpts.budgetTotal ?? Number.POSITIVE_INFINITY;
    let tokensSpent = 0;

    // Wall-clock watchdog (distinct from the vm sync timeout — see sandbox.ts).
    const controller = new AbortController();
    if (runOpts.signal) {
      runOpts.signal.addEventListener('abort', () => controller.abort(), {
        once: true,
      });
    }
    const wallMs = runOpts.wallClockMs ?? SYNC_CPU_TIMEOUT_MS;
    const deadline = Date.now() + wallMs;
    const timer = setTimeout(() => controller.abort(), wallMs);
    timer.unref?.();

    let phaseIndex = -1;
    const bridges: SandboxBridges = {
      budgetTotal: () => budgetTotal,
      budgetSpent: () => tokensSpent,
      log: (m) => journal.log(m),
      phase: (title) => {
        phaseIndex += 1;
        journal.phase(title, phaseIndex);
        runOpts.onPhase?.(title, phaseIndex);
      },
      agent: (promptJson, optsJson, resolve, reject) => {
        const seq = journal.nextSeq(); // SYNC seq at entry — deterministic
        let prompt: unknown;
        let opts: AgentOpts;
        try {
          prompt = JSON.parse(promptJson);
          opts = JSON.parse(optsJson) as AgentOpts;
        } catch {
          reject('workflow: malformed agent arguments');
          return;
        }
        const promptHash = canonicalHash(prompt);
        const optsHash = canonicalHash(opts);

        const cached = journal.lookup(seq, 'agent', promptHash, optsHash);
        if (cached) {
          resolve(JSON.stringify(cached.result));
          return;
        }
        if (tokensSpent >= budgetTotal) {
          reject('workflow budget exhausted');
          return;
        }
        if (controller.signal.aborted || Date.now() > deadline) {
          reject('workflow cancelled or wall-clock ceiling exceeded');
          return;
        }
        if (!scheduler.tryCountAgent()) {
          reject('workflow lifetime agent cap exceeded');
          return;
        }
        runOpts.onAgentCount?.(scheduler.counted);

        void (async () => {
          const release = await scheduler.acquire();
          let cwd: string | undefined;
          try {
            if (opts.isolation === 'worktree' && this.opts.worktree) {
              cwd = await this.opts.worktree.acquire(runId, seq);
            }
            const out = await this.spawner.spawn({
              prompt:
                typeof prompt === 'string' ? prompt : JSON.stringify(prompt),
              systemContext: this.opts.systemContext ?? '',
              model: opts.model,
              agentType: opts.agentType,
              schema: opts.schema,
              cwd,
              signal: controller.signal,
            });
            tokensSpent += out.tokens;
            const env =
              out.structured !== undefined
                ? { kind: 'structured' as const, value: out.structured }
                : out.text !== undefined
                  ? { kind: 'text' as const, text: out.text }
                  : { kind: 'null' as const };
            await journal.append({
              seq,
              kind: 'agent',
              promptHash,
              optsHash,
              result: env,
              tokens: out.tokens,
            });
            resolve(JSON.stringify(env));
          } catch (e) {
            // Spawn/exec/schema/worktree failure → agent() resolves null (design).
            const env = { kind: 'null' as const };
            await journal.append({
              seq,
              kind: 'agent',
              promptHash,
              optsHash,
              result: env,
              tokens: 0,
              error: String((e as Error)?.message ?? e),
            });
            resolve(JSON.stringify(env));
          } finally {
            release();
          }
        })();
      },
    };

    try {
      const result = await runInSandbox(parsed.body, bridges, {
        argsJson:
          runOpts.args === undefined ? undefined : JSON.stringify(runOpts.args),
        syncTimeoutMs: wallMs,
        filename: `${parsed.meta.name}.js`,
      });
      clearTimeout(timer);
      await journal.setStatus('completed', tokensSpent);
      if (this.opts.worktree) await this.opts.worktree.cleanup(runId);
      return { runId, result, status: 'completed', tokensSpent };
    } catch (e) {
      clearTimeout(timer);
      const status = controller.signal.aborted ? 'cancelled' : 'failed';
      await journal.setStatus(status, tokensSpent);
      if (this.opts.worktree) await this.opts.worktree.cleanup(runId);
      if (status === 'cancelled') {
        return { runId, result: undefined, status, tokensSpent };
      }
      throw e instanceof WorkflowScriptError
        ? e
        : new WorkflowScriptError(String((e as Error)?.message ?? e));
    }
  }
}
```

- [ ] **Step 4: Write the barrel `workflows/index.ts` and re-export from the core barrel**

Create `packages/core/src/workflows/index.ts`:

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export * from './sandbox.js';
export * from './scheduler.js';
export * from './journal.js';
export * from './spawner.js';
export * from './worktree.js';
export * from './scriptRunner.js';
```

In `packages/core/src/index.ts`, add (next to the other `export *` lines) so the gateway (Part C) can import `WorkflowEngine`, `AgentSpawner`, etc. from `@qwen-code/qwen-code-core`:

```ts
export * from './workflows/index.js';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /home/evan/projects/qwen-code/packages/core && npx vitest run src/workflows/scriptRunner.test.ts`
Expected: PASS (parse cases + engine run/resume/budget cases).

- [ ] **Step 6: Typecheck the workflows module**

Run: `cd /home/evan/projects/qwen-code/packages/core && npx tsc --noEmit -p . 2>&1 | grep -i "workflows/" || echo "no workflows tsc errors"`
Expected: `no workflows tsc errors`.

- [ ] **Step 7: Commit**

```bash
cd /home/evan/projects/qwen-code
git add packages/core/package.json packages/core/src/workflows/ packages/core/src/index.ts
git commit -m "feat(core): WorkflowEngine + scriptRunner (acorn meta check, journaled resume)"
```

---

### Task 11: `Workflow` tool + background-task surfacing

**Files:**

- Create: `packages/core/src/tools/workflow/workflow.ts`
- Modify: `packages/core/src/tools/tool-names.ts` (add `WORKFLOW` name + display name)
- Modify: `packages/core/src/config/config.ts` (register the tool via `registerLazy`)
- Test: `packages/core/src/tools/workflow/workflow.test.ts`

**Interfaces:**

- Consumes: Task 8 `HeadlessSpawner`; Task 10 `WorkflowEngine`, `WorkflowScriptError`; `BaseDeclarativeTool`, `BaseToolInvocation`, `Kind`, `ToolResult`, `ToolInvocation` from `../tools.js`; `ToolNames`, `ToolDisplayNames` from `../tool-names.js`; `Config` from `../../config/config.js`; `config.getBackgroundTaskRegistry()` → `register`/`appendActivity`/`complete`/`fail`/`unregisterForeground`.
- Produces: a registered built-in `Workflow` tool; no exported types beyond the tool class.

> **Real-API note (background-task surfacing is a shim).** `BackgroundTaskRegistry` has no `workflow` task kind (`TaskKind` is `'agent' | 'shell' | 'monitor'`), so the run registers as an `agent` task with `agentId = runId`, `subagentType = 'workflow:<name>'`, and **`isBackgrounded: false`** (a foreground task). Foreground registration deliberately does NOT call `assertCanStartBackgroundAgent()`, so a workflow never consumes the background-agent concurrency cap. Phase changes and agent counts are surfaced via `appendActivity`.

- [ ] **Step 1: Add the tool name constants**

In `packages/core/src/tools/tool-names.ts`, add to `ToolNames`:

```ts
  WORKFLOW: 'Workflow',
```

and to `ToolDisplayNames`:

```ts
  WORKFLOW: 'Workflow',
```

- [ ] **Step 2: Write the failing test**

Create `packages/core/src/tools/workflow/workflow.test.ts`:

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { WorkflowTool } from './workflow.js';
import type { Config } from '../../config/config.js';
import type {
  AgentSpawner,
  AgentSpawnResult,
} from '../../workflows/spawner.js';

/** A Config test double exposing only what the tool touches. */
function fakeConfig(spawner: AgentSpawner, runsDir: string) {
  const activities: Array<{ name: string; description: string }> = [];
  const registry = {
    register: vi.fn(() => ({ id: 't1' })),
    appendActivity: vi.fn(
      (_id: string, a: { name: string; description: string }) =>
        activities.push(a),
    ),
    complete: vi.fn(),
    fail: vi.fn(),
    unregisterForeground: vi.fn(),
    assertCanStartBackgroundAgent: vi.fn(() => {
      throw new Error('MUST NOT be called for a workflow');
    }),
  };
  const config = {
    getBackgroundTaskRegistry: () => registry,
    getWorkingDir: () => runsDir,
    // Injected seam the tool uses to build its engine (see Step 3).
    __workflowSpawner: spawner,
    __workflowRunsDir: runsDir,
  } as unknown as Config;
  return { config, registry, activities };
}

describe('WorkflowTool', () => {
  it('runs an inline script, surfaces phases, returns { runId, result }', async () => {
    const spawner: AgentSpawner = {
      spawn: async () => ({ text: 'done', tokens: 2 }) as AgentSpawnResult,
    };
    const { config, registry, activities } = fakeConfig(
      spawner,
      '/tmp/wf-test-runs',
    );
    const tool = new WorkflowTool(config);
    const inv = tool.build({
      script: `export const meta = { name: 'demo', description: 'd' };\nphase('Go');\nreturn await agent('hi');`,
    });
    const res = await inv.execute(new AbortController().signal);
    const payload = JSON.parse(res.llmContent as string) as {
      runId: string;
      result: unknown;
    };
    expect(payload.result).toBe('done');
    expect(payload.runId).toMatch(/[0-9a-f-]{36}/);
    expect(registry.register).toHaveBeenCalledTimes(1);
    expect(registry.assertCanStartBackgroundAgent).not.toHaveBeenCalled();
    expect(activities.some((a) => a.description.includes('Go'))).toBe(true);
    expect(registry.complete).toHaveBeenCalled();
  });

  it('surfaces an invalid script as a tool error', async () => {
    const spawner: AgentSpawner = {
      spawn: async () => ({ text: '', tokens: 0 }),
    };
    const { config, registry } = fakeConfig(spawner, '/tmp/wf-test-runs');
    const tool = new WorkflowTool(config);
    const inv = tool.build({ script: `const broken = (;` });
    const res = await inv.execute(new AbortController().signal);
    expect(res.error?.type).toBeDefined();
    expect(registry.fail).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Write the tool**

Create `packages/core/src/tools/workflow/workflow.ts`:

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../../config/config.js';
import type { ToolInvocation, ToolResult } from '../tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from '../tools.js';
import { ToolDisplayNames, ToolNames } from '../tool-names.js';
import { ToolErrorType } from '../tool-error.js';
import { HeadlessSpawner } from '../../workflows/spawner.js';
import { WorkflowEngine, WorkflowScriptError } from '../../workflows/index.js';

export interface WorkflowToolParams {
  script?: string;
  scriptPath?: string;
  name?: string;
  args?: unknown;
  resumeFromRunId?: string;
}

/** Test seam: a Config may carry a pre-built spawner/runsDir override. */
interface WorkflowConfigSeam {
  __workflowSpawner?: { spawn: HeadlessSpawner['spawn'] };
  __workflowRunsDir?: string;
}

async function resolveSource(
  params: WorkflowToolParams,
  workingDir: string,
): Promise<string> {
  if (typeof params.script === 'string') return params.script;
  if (typeof params.scriptPath === 'string')
    return readFile(params.scriptPath, 'utf8');
  if (typeof params.name === 'string') {
    const candidates = [
      join(workingDir, '.qwen', 'workflows', `${params.name}.js`),
      join(homedir(), '.qwen', 'workflows', `${params.name}.js`),
    ];
    for (const path of candidates) {
      try {
        return await readFile(path, 'utf8');
      } catch {
        // try next
      }
    }
    throw new WorkflowScriptError(
      `workflow "${params.name}" not found in .qwen/workflows`,
    );
  }
  throw new WorkflowScriptError(
    'Workflow requires one of: script, scriptPath, name',
  );
}

class WorkflowToolInvocation extends BaseToolInvocation<
  WorkflowToolParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: WorkflowToolParams,
  ) {
    super(params);
  }

  getDescription(): string {
    if (this.params.name) return `workflow: ${this.params.name}`;
    if (this.params.scriptPath) return `workflow: ${this.params.scriptPath}`;
    return 'workflow: inline script';
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    const registry = this.config.getBackgroundTaskRegistry();
    const seam = this.config as unknown as WorkflowConfigSeam;
    const spawner = seam.__workflowSpawner ?? new HeadlessSpawner(this.config);
    const runsDir = seam.__workflowRunsDir; // undefined → engine default (~/.qwen/...)
    const engine = new WorkflowEngine(spawner as HeadlessSpawner, { runsDir });

    let source: string;
    try {
      source = await resolveSource(this.params, this.config.getWorkingDir());
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        llmContent: `Workflow error: ${message}`,
        returnDisplay: `Error: ${message}`,
        error: { message, type: ToolErrorType.INVALID_TOOL_PARAMS },
      };
    }

    // Foreground task (isBackgrounded: false) → never consumes the
    // background-agent concurrency cap. agentId = runId keeps the pill stable.
    const runId = crypto.randomUUID();
    registry.register({
      agentId: runId,
      subagentType: 'workflow',
      description: this.getDescription(),
      status: 'running',
      startTime: Date.now(),
      outputFile: join(
        homedir(),
        '.qwen',
        'workflows',
        'runs',
        runId,
        'run.json',
      ),
      isBackgrounded: false,
      abortController: new AbortController(),
      prompt: this.params.name ?? this.params.scriptPath ?? 'inline',
    } as never);

    try {
      const result = await engine.run(source, {
        runId,
        args: this.params.args,
        resumeFromRunId: this.params.resumeFromRunId,
        signal,
        onPhase: (title, index) =>
          registry.appendActivity(runId, {
            name: 'phase',
            description: `Phase ${index}: ${title}`,
            at: Date.now(),
          }),
        onAgentCount: (counted) =>
          registry.appendActivity(runId, {
            name: 'agents',
            description: `${counted} agent(s) spawned`,
            at: Date.now(),
          }),
      });
      registry.complete(
        runId,
        JSON.stringify({ runId, tokensSpent: result.tokensSpent }),
        {
          totalTokens: result.tokensSpent,
          toolUses: 0,
          durationMs: 0,
        },
      );
      const payload = JSON.stringify({
        runId: result.runId,
        result: result.result,
      });
      return {
        llmContent: payload,
        returnDisplay: `Workflow ${result.status} (run ${result.runId}).`,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      registry.fail(runId, message);
      const type =
        e instanceof WorkflowScriptError
          ? ToolErrorType.INVALID_TOOL_PARAMS
          : ToolErrorType.EXECUTION_FAILED;
      return {
        llmContent: `Workflow failed: ${message}`,
        returnDisplay: `Error: ${message}`,
        error: { message, type },
      };
    }
  }
}

/**
 * The `Workflow` tool (design: "CLI tool"). Runs a sandboxed workflow script
 * over the headless agent runtime and surfaces the run through the
 * background-task registry.
 */
export class WorkflowTool extends BaseDeclarativeTool<
  WorkflowToolParams,
  ToolResult
> {
  static readonly Name = ToolNames.WORKFLOW;

  constructor(private readonly config: Config) {
    super(
      WorkflowTool.Name,
      ToolDisplayNames.WORKFLOW,
      'Run a deterministic, sandboxed multi-agent workflow script. Provide one of `script` (inline JS), `scriptPath` (a .js file), or `name` (resolved from .qwen/workflows). Returns { runId, result }.',
      Kind.Think,
      {
        type: 'object',
        properties: {
          script: {
            type: 'string',
            description: 'Inline workflow script source.',
          },
          scriptPath: {
            type: 'string',
            description: 'Absolute path to a workflow .js file.',
          },
          name: {
            type: 'string',
            description: 'Named workflow in .qwen/workflows/<name>.js.',
          },
          args: {
            description: 'Optional value exposed to the script as `args`.',
          },
          resumeFromRunId: {
            type: 'string',
            description:
              'Resume from a prior run id (replays the cached prefix).',
          },
        },
      },
    );
  }

  protected override validateToolParamValues(
    params: WorkflowToolParams,
  ): string | null {
    if (!params.script && !params.scriptPath && !params.name) {
      return 'Provide one of: script, scriptPath, name.';
    }
    return null;
  }

  protected createInvocation(
    params: WorkflowToolParams,
  ): ToolInvocation<WorkflowToolParams, ToolResult> {
    return new WorkflowToolInvocation(this.config, params);
  }
}
```

> **Note on `crypto.randomUUID()`:** Node 22 exposes `crypto` as a global, so
> `crypto.randomUUID()` works without import. If the repo's lint config forbids
> the global, add `import { randomUUID } from 'node:crypto';` and call
> `randomUUID()`.

- [ ] **Step 4: Register the tool**

In `packages/core/src/config/config.ts` `createToolRegistry`, alongside the other `registerLazy` calls, add:

```ts
await registerLazy(ToolNames.WORKFLOW, async () => {
  const { WorkflowTool } = await import('../tools/workflow/workflow.js');
  return new WorkflowTool(this);
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /home/evan/projects/qwen-code/packages/core && npx vitest run src/tools/workflow/workflow.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
cd /home/evan/projects/qwen-code
git add packages/core/src/tools/workflow/ packages/core/src/tools/tool-names.ts packages/core/src/config/config.ts
git commit -m "feat(core): Workflow tool with background-task surfacing (no bg concurrency cap)"
```

---

## Part C — Gateway surface (`/home/evan/projects/qwen-code`, `packages/rc-gateway`, branch `add-remote-control-spec`)

### Task 12: `SessionSpawner` + `AgentRecord.workflowRunId`

**Files:**

- Modify: `packages/rc-gateway/package.json` (add the `@qwen-code/qwen-code-core` dependency — Part C runs the engine in-process)
- Modify: `packages/rc-gateway/src/agents/agentRegistry.ts` (add optional `workflowRunId`)
- Create: `packages/rc-gateway/src/workflows/sessionSpawner.ts`
- Test: `packages/rc-gateway/src/agents/agentRegistry.workflow.test.ts` (append-style new file)
- Test: `packages/rc-gateway/src/workflows/sessionSpawner.test.ts`

> **New package edge (blocker if skipped).** rc-gateway currently depends only on `@qwen-code/sdk` (declared `"@qwen-code/sdk": "*"`) — it has NO dependency on core. Approach A runs the engine in the gateway process, so Part C imports `WorkflowEngine`/`parseWorkflowScript`/`validateAgainstSchema`/`AgentSpawner` from core. This edge is one-directional (core never imports gateway → no cycle). Core's package name is `@qwen-code/qwen-code-core` (verified — NOT `@qwen-code/core`).

**Interfaces:**

- Consumes: `AgentSpawner`, `AgentSpawnRequest`, `AgentSpawnResult`, `validateAgainstSchema` from `@qwen-code/qwen-code-core` (exported by Task 10); `DaemonClient` from `@qwen-code/sdk` (`createOrAttachSession({ sessionScope, modelServiceId? })` → `{ sessionId }`; `prompt(sessionId, { prompt: [{ type:'text', text }] })`; `endSession(sessionId)`); `AgentRegistry` from `../agents/agentRegistry.js`.
- Produces (used by Tasks 13, 16):
  - `AgentRecord` gains `workflowRunId?: string`; `AgentRegistry.register` input gains optional `workflowRunId`; `list()` filter gains optional `workflowRunId`.
  - `interface SessionSpawnerDeps { daemon: DaemonClient; registry: AgentRegistry; runId: string; spawnedByTokenId: string; onAgentSpawned?: (agentId: string, sessionId: string) => void }`
  - `class SessionSpawner implements AgentSpawner` — `constructor(deps: SessionSpawnerDeps)`

> **Real-API note (confirm at Phase 3.0 alignment).** `daemon.prompt()` resolves when the turn ends; its exact return shape (text + usage) is not pinned in this plan. `SessionSpawner` uses defensive `extractText`/`extractTokens` and MUST be reconciled against the real `DaemonClient.prompt` return type during 3.0. Schema enforcement reuses core's `validateAgainstSchema` with a bounded re-prompt.

- [ ] **Step 0: Declare the core dependency**

In `packages/rc-gateway/package.json`, add to `dependencies` (mirroring the existing `@qwen-code/sdk` entry's version spec):

```json
    "@qwen-code/qwen-code-core": "*",
```

Then `cd /home/evan/projects/qwen-code && npm install` (or the repo's package manager) so the workspace symlink resolves. Verify: `node -e "require.resolve('@qwen-code/qwen-code-core')"` from `packages/rc-gateway` succeeds.

- [ ] **Step 1: Extend `AgentRecord` (failing test first)**

Create `packages/rc-gateway/src/agents/agentRegistry.workflow.test.ts`:

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

describe('AgentRegistry workflowRunId', () => {
  it('stores and filters by workflowRunId', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wf-reg-'));
    const reg = await AgentRegistry.open(join(dir, 'agents.json'));
    const a = await reg.register({
      sessionId: 's1',
      parentSessionId: null,
      agentType: 'general',
      task: 't',
      spawnedByTokenId: 'tk',
      workflowRunId: 'run-1',
    });
    await reg.register({
      sessionId: 's2',
      parentSessionId: null,
      agentType: 'general',
      task: 't',
      spawnedByTokenId: 'tk',
    });
    expect(reg.get(a.agentId)?.workflowRunId).toBe('run-1');
    expect(reg.list({ workflowRunId: 'run-1' }).map((r) => r.agentId)).toEqual([
      a.agentId,
    ]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/evan/projects/qwen-code/packages/rc-gateway && npx vitest run src/agents/agentRegistry.workflow.test.ts`
Expected: FAIL — `workflowRunId` not accepted / not filterable.

- [ ] **Step 3: Edit `agentRegistry.ts`**

Add `workflowRunId?: string;` to the `AgentRecord` interface (after `finishedAt: string | null;`):

```ts
  finishedAt: string | null;
  workflowRunId?: string; // set when this agent backs a workflow run
```

Add `workflowRunId?: string;` to the `register` input type, and conditionally spread it into the created record (mirror the existing `subActor` spread):

```ts
      ...(input.workflowRunId !== undefined ? { workflowRunId: input.workflowRunId } : {}),
```

Extend the `list` filter signature and predicate:

```ts
  list(
    filter: { status?: AgentStatus; parent?: string; workflowRunId?: string } = {},
  ): AgentRecord[] {
    return this.records
      .filter(
        (r) =>
          (filter.status === undefined || r.status === filter.status) &&
          (filter.parent === undefined || r.parentSessionId === filter.parent) &&
          (filter.workflowRunId === undefined || r.workflowRunId === filter.workflowRunId),
      )
      .map((r) => ({ ...r }));
  }
```

- [ ] **Step 4: Write the `SessionSpawner` test (against the stub daemon)**

Create `packages/rc-gateway/src/workflows/sessionSpawner.test.ts`:

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonClient } from '@qwen-code/sdk';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import { AgentRegistry } from '../agents/agentRegistry.js';
import { SessionSpawner } from './sessionSpawner.js';

let stub: StubDaemon | undefined;
afterEach(async () => {
  if (stub) await stub.close();
  stub = undefined;
});

describe('SessionSpawner', () => {
  it('spawns a real session per agent and tags workflowRunId', async () => {
    stub = await startStubDaemon({});
    const dir = await mkdtemp(join(tmpdir(), 'wf-spawner-'));
    const registry = await AgentRegistry.open(join(dir, 'agents.json'));
    const map: Array<{ agentId: string; sessionId: string }> = [];
    const spawner = new SessionSpawner({
      daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
      registry,
      runId: 'run-1',
      spawnedByTokenId: 'tk',
      onAgentSpawned: (agentId, sessionId) => map.push({ agentId, sessionId }),
    });
    const out = await spawner.spawn({
      prompt: 'do a thing',
      systemContext: '',
    });
    expect(typeof out.tokens).toBe('number');
    expect(map).toHaveLength(1);
    expect(registry.list({ workflowRunId: 'run-1' })).toHaveLength(1);
    expect(stub!.createdSessionCount).toBe(1);
  });
});
```

- [ ] **Step 5: Write `sessionSpawner.ts`**

Create `packages/rc-gateway/src/workflows/sessionSpawner.ts`:

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonClient } from '@qwen-code/sdk';
import type {
  AgentSpawner,
  AgentSpawnRequest,
  AgentSpawnResult,
} from '@qwen-code/qwen-code-core';
import { validateAgainstSchema } from '@qwen-code/qwen-code-core';
import type { AgentRegistry } from '../agents/agentRegistry.js';

const SCHEMA_RETRIES = 2;

export interface SessionSpawnerDeps {
  daemon: DaemonClient;
  registry: AgentRegistry;
  runId: string;
  spawnedByTokenId: string;
  /** Called with (agentId, sessionId) as each workflow agent is registered. */
  onAgentSpawned?: (agentId: string, sessionId: string) => void;
}

/** Defensive extractors — reconcile against DaemonClient.prompt at Phase 3.0. */
function extractText(turn: unknown): string {
  if (typeof turn === 'string') return turn;
  const t = turn as { text?: unknown; result?: unknown } | null;
  if (typeof t?.text === 'string') return t.text;
  if (typeof t?.result === 'string') return t.result;
  return '';
}
function extractTokens(turn: unknown): number {
  const t = turn as {
    tokens?: unknown;
    usage?: { totalTokens?: unknown };
  } | null;
  if (typeof t?.tokens === 'number') return t.tokens;
  if (typeof t?.usage?.totalTokens === 'number') return t.usage.totalTokens;
  return 0;
}

/**
 * Gateway spawner (design: "SessionSpawner"). Each workflow agent IS a real
 * daemon session — observable, cost-tracked, searchable — tagged with the
 * workflow's runId on its AgentRecord. On abort (workflow cancel) the session
 * is ended.
 */
export class SessionSpawner implements AgentSpawner {
  constructor(private readonly deps: SessionSpawnerDeps) {}

  async spawn(req: AgentSpawnRequest): Promise<AgentSpawnResult> {
    const session = await this.deps.daemon.createOrAttachSession({
      sessionScope: 'thread',
      ...(req.model !== undefined ? { modelServiceId: req.model } : {}),
    });
    const sessionId = session.sessionId;
    const record = await this.deps.registry.register({
      sessionId,
      parentSessionId: null,
      agentType: req.agentType ?? 'general',
      task: req.prompt,
      spawnedByTokenId: this.deps.spawnedByTokenId,
      workflowRunId: this.deps.runId,
    });
    this.deps.onAgentSpawned?.(record.agentId, sessionId);

    // Cancel → end the session.
    const onAbort = () =>
      void this.deps.daemon.endSession(sessionId).catch(() => {});
    req.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      let tokens = 0;
      const attempts = req.schema ? SCHEMA_RETRIES + 1 : 1;
      let promptText = req.schema
        ? `${req.prompt}\n\nReply with ONLY JSON conforming to:\n${JSON.stringify(req.schema)}`
        : req.prompt;
      let lastError = '';
      for (let attempt = 0; attempt < attempts; attempt++) {
        const turn = await this.deps.daemon.prompt(sessionId, {
          prompt: [{ type: 'text', text: promptText }],
        });
        tokens += extractTokens(turn);
        const text = extractText(turn);
        if (!req.schema) return { text, tokens };
        const check = validateAgainstSchema(text, req.schema);
        if (check.valid) return { structured: check.value, tokens };
        lastError = check.error;
        promptText = `Your reply was invalid (${lastError}). Return corrected JSON only.`;
      }
      throw new Error(
        `schema validation failed after ${attempts} attempts: ${lastError}`,
      );
    } finally {
      req.signal?.removeEventListener('abort', onAbort);
    }
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd /home/evan/projects/qwen-code/packages/rc-gateway && npx vitest run src/agents/agentRegistry.workflow.test.ts src/workflows/sessionSpawner.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /home/evan/projects/qwen-code
git add packages/rc-gateway/src/agents/agentRegistry.ts packages/rc-gateway/src/agents/agentRegistry.workflow.test.ts packages/rc-gateway/src/workflows/sessionSpawner.ts packages/rc-gateway/src/workflows/sessionSpawner.test.ts
git commit -m "feat(rc-gateway): SessionSpawner (agents-as-sessions) + AgentRecord.workflowRunId"
```

---

### Task 13: Event vocabulary — `OwnerEvent` variants, audit actions, notification kinds

**Files:**

- Modify: `packages/rc-gateway/src/ownerEvents.ts`
- Modify: `packages/rc-gateway/src/auditLog.ts`
- Modify: `packages/rc-gateway/src/webpush/payload.ts`
- Modify: `packages/rc-gateway/src/webpush/notifier.ts`
- Test: `packages/rc-gateway/src/workflows/workflowVocab.test.ts` (new)

**Interfaces:**

- Consumes: existing `OwnerEvent` union + `OwnerEventBus`; `AuditAction`/`AUDIT_ACTIONS`; `buildPayload`/`AGENT_EVENT_KINDS`; `KIND_SCOPE`/`SNOOZE_BYPASS_KINDS`; `SESSION_READ`.
- Produces (used by Tasks 14, 15, 16):
  - `type WorkflowLifecycleEventType = 'workflow_started' | 'workflow_completed' | 'workflow_failed' | 'workflow_cancelled'` (from `ownerEvents.ts`)
  - `interface WorkflowEventPayload { runId: string; name: string; scriptHash: string; status: string; agentCount: number; tokensSpent: number }` (from `ownerEvents.ts`)
  - New `OwnerEvent` variants: `{ type: WorkflowLifecycleEventType; workflow: WorkflowEventPayload }` and `{ type: 'workflow_phase'; runId: string; phase: string; phaseIndex?: number }`
  - New `AuditAction` members: `'workflow_started' | 'workflow_cancelled'`
  - `WORKFLOW_EVENT_KINDS: Record<string, string>` (from `payload.ts`) mapping ONLY `workflow_completed → workflow.completed` and `workflow_failed → workflow.failed`
  - `KIND_SCOPE` gains `workflow.completed`/`workflow.failed` at `SESSION_READ`; `SNOOZE_BYPASS_KINDS` is UNCHANGED

- [ ] **Step 1: Write the failing vocabulary test**

Create `packages/rc-gateway/src/workflows/workflowVocab.test.ts`:

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  OwnerEventBus,
  type OwnerEvent,
  type WorkflowEventPayload,
} from '../ownerEvents.js';
import { AUDIT_ACTIONS } from '../auditLog.js';
import { buildPayload, WORKFLOW_EVENT_KINDS } from '../webpush/payload.js';
import { KIND_SCOPE, SNOOZE_BYPASS_KINDS } from '../webpush/notifier.js';
import { SESSION_READ } from '../scopes.js';

describe('workflow OwnerEvent variants', () => {
  it('fans workflow lifecycle + phase frames', () => {
    const bus = new OwnerEventBus();
    const seen: OwnerEvent[] = [];
    bus.subscribe((e) => seen.push(e));
    const workflow: WorkflowEventPayload = {
      runId: 'r1',
      name: 'demo',
      scriptHash: 'h',
      status: 'completed',
      agentCount: 3,
      tokensSpent: 42,
    };
    bus.publish({
      type: 'workflow_started',
      workflow: { ...workflow, status: 'running' },
    });
    bus.publish({
      type: 'workflow_phase',
      runId: 'r1',
      phase: 'Verify',
      phaseIndex: 1,
    });
    bus.publish({ type: 'workflow_completed', workflow });
    expect(seen.map((e) => e.type)).toEqual([
      'workflow_started',
      'workflow_phase',
      'workflow_completed',
    ]);
  });
});

describe('workflow audit actions', () => {
  it('registers the two new actions', () => {
    expect(AUDIT_ACTIONS).toContain('workflow_started');
    expect(AUDIT_ACTIONS).toContain('workflow_cancelled');
  });
});

describe('workflow notification kinds', () => {
  it('maps only completed/failed to kinds; metadata only, no script', () => {
    expect(WORKFLOW_EVENT_KINDS).toEqual({
      workflow_completed: 'workflow.completed',
      workflow_failed: 'workflow.failed',
    });
    const p = buildPayload(
      {
        type: 'workflow_completed',
        data: {
          runId: 'r1',
          name: 'demo',
          status: 'completed',
          scriptHash: 'h',
        },
      },
      { sessionId: 'r1', sessionName: 'demo' },
    );
    expect(p?.kind).toBe('workflow.completed');
    expect(JSON.stringify(p)).not.toContain('scriptHash');
    // workflow_started has no kind → no payload.
    expect(
      buildPayload({ type: 'workflow_started', data: {} }, { sessionId: 'r1' }),
    ).toBeNull();
  });

  it('scope-gates both kinds at session:read and does NOT bypass snooze', () => {
    expect(KIND_SCOPE['workflow.completed']).toBe(SESSION_READ);
    expect(KIND_SCOPE['workflow.failed']).toBe(SESSION_READ);
    expect(SNOOZE_BYPASS_KINDS.has('workflow.completed')).toBe(false);
    expect(SNOOZE_BYPASS_KINDS.has('workflow.failed')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/evan/projects/qwen-code/packages/rc-gateway && npx vitest run src/workflows/workflowVocab.test.ts`
Expected: FAIL — new types/exports missing.

- [ ] **Step 3: Extend `ownerEvents.ts`**

Add above the `OwnerEvent` union (next to `AgentLifecycleEventType`):

```ts
/** The four workflow lifecycle SSE event types (wire-protocol registry rows). */
export type WorkflowLifecycleEventType =
  | 'workflow_started'
  | 'workflow_completed'
  | 'workflow_failed'
  | 'workflow_cancelled';

/** Payload of a workflow lifecycle frame (design: `{ runId, name, scriptHash,
 * status, agentCount, tokensSpent }`). Never carries the script source. */
export interface WorkflowEventPayload {
  runId: string;
  name: string;
  scriptHash: string;
  status: string;
  agentCount: number;
  tokensSpent: number;
}
```

Extend the `OwnerEvent` union (after the `hook_event` variant):

```ts
  | {
      /** Workflow lifecycle frame (add-workflow-orchestration). */
      type: WorkflowLifecycleEventType;
      workflow: WorkflowEventPayload;
    }
  | {
      /** The running workflow called `phase(title)`. Owner stream only. */
      type: 'workflow_phase';
      runId: string;
      phase: string;
      phaseIndex?: number;
    };
```

- [ ] **Step 4: Extend `auditLog.ts`**

Append to the `AuditAction` union (after `'hook_ingest_rejected'`):

```ts
  | 'workflow_started'
  | 'workflow_cancelled';
```

and append the two strings to the end of the `AUDIT_ACTIONS` array:

```ts
  'workflow_started',
  'workflow_cancelled',
```

- [ ] **Step 5: Extend `webpush/payload.ts`**

Add after `AGENT_EVENT_KINDS`:

```ts
/**
 * Workflow SSE event type → notification kind. ONLY the two terminal-of-note
 * events map; started/phase/cancelled are stream-only (design: two kinds).
 */
export const WORKFLOW_EVENT_KINDS: Record<string, string> = {
  workflow_completed: 'workflow.completed',
  workflow_failed: 'workflow.failed',
};
```

Inside `buildPayload`, add a guard next to the `AGENT_EVENT_KINDS` lookup (metadata only — the script hash/source NEVER reaches a push):

```ts
const workflowKind = WORKFLOW_EVENT_KINDS[event.type];
if (workflowKind !== undefined) {
  const name =
    typeof data.name === 'string' && data.name.length > 0
      ? data.name
      : 'workflow';
  const status =
    typeof data.status === 'string' ? data.status : event.type.slice(9);
  return {
    v: 1,
    kind: workflowKind,
    sessionId: ctx.sessionId,
    ...(ctx.sessionName ? { sessionName: ctx.sessionName } : {}),
    summary: truncate(`Workflow ${status}: ${name}`),
    url: sessionUrl(ctx.sessionId),
  };
}
```

- [ ] **Step 6: Extend `webpush/notifier.ts`**

In `KIND_SCOPE`, add (do NOT touch `SNOOZE_BYPASS_KINDS` — a finished workflow is not an emergency):

```ts
  'workflow.completed': SESSION_READ,
  'workflow.failed': SESSION_READ,
```

- [ ] **Step 7: Run tests + full webpush suite**

Run: `cd /home/evan/projects/qwen-code/packages/rc-gateway && npx vitest run src/workflows/workflowVocab.test.ts src/webpush/`
Expected: PASS with zero regressions.

- [ ] **Step 8: Commit**

```bash
cd /home/evan/projects/qwen-code
git add packages/rc-gateway/src/ownerEvents.ts packages/rc-gateway/src/auditLog.ts packages/rc-gateway/src/webpush/payload.ts packages/rc-gateway/src/webpush/notifier.ts packages/rc-gateway/src/workflows/workflowVocab.test.ts
git commit -m "feat(rc-gateway): workflow owner frames, audit actions, notification kinds"
```

---

### Task 14: Workflow run registry + `routes/workflows.ts`

**Files:**

- Create: `packages/rc-gateway/src/workflows/workflowRegistry.ts`
- Create: `packages/rc-gateway/src/routes/workflows.ts`
- Test: `packages/rc-gateway/src/routes/workflows.test.ts`

**Interfaces:**

- Consumes: Task 12 `SessionSpawner`, `AgentRegistry`; Task 13 `OwnerEventBus`, `WorkflowEventPayload`, `AuditRecorder`; `WorkflowEngine`, `parseWorkflowScript`, `WorkflowScriptError` from `@qwen-code/qwen-code-core`; `DaemonClient`; `RequestHandler` from `express`; an `AgentNotifySink` (structurally `PushNotifier`).
- Produces (used by Task 15):
  - `interface WorkflowRun { runId; name; scriptHash; status; phase?; phaseIndex?; agents: Array<{ agentId; sessionId }>; tokensSpent; startedAt; finishedAt: string | null; controller: AbortController }`
  - `class WorkflowRunRegistry` — `create`, `get`, `list`, `setPhase`, `addAgent`, `setStatus`, `setTokens`
  - `interface WorkflowRoutesDeps { daemon: DaemonClient; agentRegistry: AgentRegistry; runRegistry: WorkflowRunRegistry; ownerEvents: OwnerEventBus; audit?: AuditRecorder; notifier?: AgentNotifySink; runsDir?: string; resolveNamed?: (name: string) => Promise<string | undefined> }`
  - `createStartWorkflowRoute`, `createListWorkflowsRoute`, `createGetWorkflowRoute`, `createCancelWorkflowRoute` — each `(deps) => RequestHandler`

- [ ] **Step 1: Write the failing route tests**

Create `packages/rc-gateway/src/routes/workflows.test.ts`:

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
import { OwnerEventBus, type OwnerEvent } from '../ownerEvents.js';
import { WorkflowRunRegistry } from '../workflows/workflowRegistry.js';
import {
  createStartWorkflowRoute,
  createListWorkflowsRoute,
  createGetWorkflowRoute,
  createCancelWorkflowRoute,
  type WorkflowRoutesDeps,
} from './workflows.js';

let gateway: Server | undefined;
let stub: StubDaemon | undefined;
afterEach(async () => {
  if (gateway) await new Promise<void>((r) => gateway!.close(() => r()));
  if (stub) await stub.close();
  gateway = undefined;
  stub = undefined;
});

async function setup() {
  stub = await startStubDaemon({ promptDelayMs: 50 });
  const dir = await mkdtemp(join(tmpdir(), 'wf-routes-'));
  const agentRegistry = await AgentRegistry.open(join(dir, 'agents.json'));
  const runRegistry = new WorkflowRunRegistry();
  const ownerEvents = new OwnerEventBus();
  const seen: OwnerEvent[] = [];
  ownerEvents.subscribe((e) => seen.push(e));
  const deps: WorkflowRoutesDeps = {
    daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
    agentRegistry,
    runRegistry,
    ownerEvents,
    runsDir: join(dir, 'runs'),
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { rcClient?: unknown }).rcClient = {
      id: 'tk',
      scopes: ['write', 'session:read'],
    };
    next();
  });
  app.post('/rc/workflows', createStartWorkflowRoute(deps));
  app.get('/rc/workflows', createListWorkflowsRoute(deps));
  app.get('/rc/workflows/:runId', createGetWorkflowRoute(deps));
  app.post('/rc/workflows/:runId/cancel', createCancelWorkflowRoute(deps));
  gateway = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = gateway.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen, runRegistry };
}

const SCRIPT = `export const meta = { name: 'demo', description: 'd' };\nphase('Go');\nreturn await agent('hi');`;

describe('POST /rc/workflows', () => {
  it('202 { runId } + workflow_started frame + audit', async () => {
    const audited: string[] = [];
    const { url, seen } = await setup();
    // (audit sink omitted here; server.test covers audit rows)
    const res = await fetch(`${url}/rc/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: SCRIPT }),
    });
    expect(res.status).toBe(202);
    const { runId } = (await res.json()) as { runId: string };
    expect(runId).toMatch(/[0-9a-f-]{36}/);
    expect(seen.some((e) => e.type === 'workflow_started')).toBe(true);
    void audited;
  });

  it('400 invalid_workflow_script on a parse error', async () => {
    const { url } = await setup();
    const res = await fetch(`${url}/rc/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: 'const broken = (;' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe(
      'invalid_workflow_script',
    );
  });
});

describe('cancel', () => {
  it('409 workflow_not_running on a terminal run', async () => {
    const { url, runRegistry } = await setup();
    const run = runRegistry.create({
      runId: 'r-term',
      name: 'x',
      scriptHash: 'h',
    });
    runRegistry.setStatus(run.runId, 'completed');
    const res = await fetch(`${url}/rc/workflows/${run.runId}/cancel`, {
      method: 'POST',
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe(
      'workflow_not_running',
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/evan/projects/qwen-code/packages/rc-gateway && npx vitest run src/routes/workflows.test.ts`
Expected: FAIL — modules unresolved.

- [ ] **Step 3: Write `workflowRegistry.ts`**

Create `packages/rc-gateway/src/workflows/workflowRegistry.ts`:

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export type WorkflowStatus = 'running' | 'completed' | 'failed' | 'cancelled';

const TERMINAL: ReadonlySet<WorkflowStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

export interface WorkflowRun {
  runId: string;
  name: string;
  scriptHash: string;
  status: WorkflowStatus;
  phase?: string;
  phaseIndex?: number;
  agents: Array<{ agentId: string; sessionId: string }>;
  tokensSpent: number;
  startedAt: string;
  finishedAt: string | null;
  controller: AbortController;
}

/** In-memory registry of live/terminal workflow runs (journal on disk backs
 * resume; this tracks the observable run state for the gateway endpoints). */
export class WorkflowRunRegistry {
  private readonly runs = new Map<string, WorkflowRun>();

  create(input: {
    runId: string;
    name: string;
    scriptHash: string;
  }): WorkflowRun {
    const run: WorkflowRun = {
      runId: input.runId,
      name: input.name,
      scriptHash: input.scriptHash,
      status: 'running',
      agents: [],
      tokensSpent: 0,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      controller: new AbortController(),
    };
    this.runs.set(run.runId, run);
    return run;
  }

  get(runId: string): WorkflowRun | undefined {
    return this.runs.get(runId);
  }

  list(): WorkflowRun[] {
    return [...this.runs.values()];
  }

  setPhase(runId: string, phase: string, phaseIndex: number): void {
    const run = this.runs.get(runId);
    if (run) {
      run.phase = phase;
      run.phaseIndex = phaseIndex;
    }
  }

  addAgent(runId: string, agentId: string, sessionId: string): void {
    this.runs.get(runId)?.agents.push({ agentId, sessionId });
  }

  setTokens(runId: string, tokensSpent: number): void {
    const run = this.runs.get(runId);
    if (run) run.tokensSpent = tokensSpent;
  }

  setStatus(runId: string, status: WorkflowStatus): boolean {
    const run = this.runs.get(runId);
    if (!run || TERMINAL.has(run.status)) return false;
    run.status = status;
    if (TERMINAL.has(status)) run.finishedAt = new Date().toISOString();
    return true;
  }

  isTerminal(runId: string): boolean {
    const run = this.runs.get(runId);
    return !run || TERMINAL.has(run.status);
  }
}
```

- [ ] **Step 4: Write `routes/workflows.ts`**

Create `packages/rc-gateway/src/routes/workflows.ts`:

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { DaemonClient } from '@qwen-code/sdk';
import {
  WorkflowEngine,
  parseWorkflowScript,
  WorkflowScriptError,
} from '@qwen-code/qwen-code-core';
import type { AgentRegistry } from '../agents/agentRegistry.js';
import type { OwnerEventBus, WorkflowEventPayload } from '../ownerEvents.js';
import type { AuditRecorder } from '../auditLog.js';
import type { AgentNotifySink } from '../agents/agentLifecycle.js';
import { SessionSpawner } from '../workflows/sessionSpawner.js';
import type {
  WorkflowRun,
  WorkflowRunRegistry,
} from '../workflows/workflowRegistry.js';

export interface WorkflowRoutesDeps {
  daemon: DaemonClient;
  agentRegistry: AgentRegistry;
  runRegistry: WorkflowRunRegistry;
  ownerEvents: OwnerEventBus;
  audit?: AuditRecorder;
  notifier?: AgentNotifySink;
  runsDir?: string;
  /** Resolve a named workflow to source (project/user .qwen/workflows). */
  resolveNamed?: (name: string) => Promise<string | undefined>;
}

function payloadOf(run: WorkflowRun): WorkflowEventPayload {
  return {
    runId: run.runId,
    name: run.name,
    scriptHash: run.scriptHash,
    status: run.status,
    agentCount: run.agents.length,
    tokensSpent: run.tokensSpent,
  };
}

/** POST /rc/workflows — start a run (WRITE scope at the mount). */
export function createStartWorkflowRoute(
  deps: WorkflowRoutesDeps,
): RequestHandler {
  return async (req, res) => {
    const body = (req.body ?? {}) as {
      script?: unknown;
      name?: unknown;
      args?: unknown;
      resumeFromRunId?: unknown;
    };

    // Resolve source: inline script or named workflow.
    let source: string | undefined;
    if (typeof body.script === 'string') source = body.script;
    else if (typeof body.name === 'string' && deps.resolveNamed) {
      source = await deps.resolveNamed(body.name);
    }
    if (source === undefined) {
      res
        .status(400)
        .json({
          error: 'Provide script or a known name',
          code: 'invalid_workflow_script',
        });
      return;
    }

    // Parse + pure-literal meta check BEFORE any spawn.
    let parsed;
    try {
      parsed = parseWorkflowScript(source);
    } catch (e) {
      const message = e instanceof WorkflowScriptError ? e.message : String(e);
      res.status(400).json({ error: message, code: 'invalid_workflow_script' });
      return;
    }

    // Register the run and respond 202 immediately.
    const run = deps.runRegistry.create({
      runId: crypto.randomUUID(),
      name: parsed.meta.name,
      scriptHash: parsed.scriptHash,
    });
    const spawner = new SessionSpawner({
      daemon: deps.daemon,
      registry: deps.agentRegistry,
      runId: run.runId,
      spawnedByTokenId: req.rcClient?.id ?? '',
      onAgentSpawned: (agentId, sessionId) =>
        deps.runRegistry.addAgent(run.runId, agentId, sessionId),
    });
    const runEngine = new WorkflowEngine(spawner, { runsDir: deps.runsDir });

    deps.ownerEvents.publish({
      type: 'workflow_started',
      workflow: payloadOf(run),
    });
    void deps.audit?.record({
      action: 'workflow_started',
      actorTokenId: req.rcClient?.id,
      subActor: req.rcClient?.subActor,
      target: run.runId,
      // name + hash only — NEVER the script source.
      detail: { name: parsed.meta.name, scriptHash: parsed.scriptHash },
    });

    // Fire the engine in the background; drive frames off its callbacks.
    void (async () => {
      try {
        const result = await runEngine.run(source, {
          runId: run.runId,
          args: body.args,
          resumeFromRunId:
            typeof body.resumeFromRunId === 'string'
              ? body.resumeFromRunId
              : undefined,
          signal: run.controller.signal,
          onPhase: (phase, phaseIndex) => {
            deps.runRegistry.setPhase(run.runId, phase, phaseIndex);
            deps.ownerEvents.publish({
              type: 'workflow_phase',
              runId: run.runId,
              phase,
              phaseIndex,
            });
          },
        });
        deps.runRegistry.setTokens(run.runId, result.tokensSpent);
        if (result.status === 'cancelled') {
          finish(deps, run, 'cancelled', 'workflow_cancelled');
        } else {
          finish(deps, run, 'completed', 'workflow_completed');
        }
      } catch {
        finish(deps, run, 'failed', 'workflow_failed');
      }
    })();

    res.status(202).json({ runId: run.runId });
  };
}

function finish(
  deps: WorkflowRoutesDeps,
  run: WorkflowRun,
  status: WorkflowRun['status'],
  eventType: 'workflow_completed' | 'workflow_failed' | 'workflow_cancelled',
): void {
  if (!deps.runRegistry.setStatus(run.runId, status)) return;
  const payload = payloadOf(deps.runRegistry.get(run.runId)!);
  deps.ownerEvents.publish({ type: eventType, workflow: payload });
  if (eventType !== 'workflow_cancelled') {
    void deps.notifier
      ?.notify(
        { type: eventType, data: payload },
        { sessionId: run.runId, sessionName: run.name },
      )
      .catch(() => {});
  }
}

/** GET /rc/workflows — list (SESSION_READ scope). */
export function createListWorkflowsRoute(
  deps: WorkflowRoutesDeps,
): RequestHandler {
  return (_req, res) => {
    const workflows = deps.runRegistry.list().map((run) => ({
      runId: run.runId,
      name: run.name,
      status: run.status,
      phase: run.phase,
      agentCount: run.agents.length,
      tokensSpent: run.tokensSpent,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    }));
    res.status(200).json({ workflows });
  };
}

/** GET /rc/workflows/:runId — detail incl. the per-agent session map. */
export function createGetWorkflowRoute(
  deps: WorkflowRoutesDeps,
): RequestHandler {
  return (req, res) => {
    const run = deps.runRegistry.get(req.params.runId);
    if (!run) {
      res
        .status(404)
        .json({ error: 'Unknown run', code: 'workflow_not_found' });
      return;
    }
    res.status(200).json({
      runId: run.runId,
      name: run.name,
      scriptHash: run.scriptHash,
      status: run.status,
      phase: run.phase,
      phaseIndex: run.phaseIndex,
      agents: run.agents,
      tokensSpent: run.tokensSpent,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    });
  };
}

/** POST /rc/workflows/:runId/cancel — abort (WRITE scope). */
export function createCancelWorkflowRoute(
  deps: WorkflowRoutesDeps,
): RequestHandler {
  return (req, res) => {
    const run = deps.runRegistry.get(req.params.runId);
    if (!run || deps.runRegistry.isTerminal(req.params.runId)) {
      res
        .status(409)
        .json({ error: 'Workflow not running', code: 'workflow_not_running' });
      return;
    }
    // Abort fans to every in-flight spawn (SessionSpawner ends their sessions);
    // the engine resolves `cancelled` and the background runner emits the frame.
    run.controller.abort();
    void deps.audit?.record({
      action: 'workflow_cancelled',
      actorTokenId: req.rcClient?.id,
      subActor: req.rcClient?.subActor,
      target: run.runId,
      detail: { name: run.name },
    });
    res.status(202).json({ runId: run.runId, status: 'cancelling' });
  };
}
```

> **Implementation note:** replace `crypto.randomUUID()` with an imported `randomUUID` from `node:crypto` if the repo's lint config forbids the global (Node 22 provides `crypto` globally, but rc-gateway's other files use the import form — match them).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /home/evan/projects/qwen-code/packages/rc-gateway && npx vitest run src/routes/workflows.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /home/evan/projects/qwen-code
git add packages/rc-gateway/src/workflows/workflowRegistry.ts packages/rc-gateway/src/routes/workflows.ts packages/rc-gateway/src/routes/workflows.test.ts
git commit -m "feat(rc-gateway): workflow run registry + /rc/workflows routes (400/409)"
```

---

### Task 15: `server.ts` + `cli.ts` wiring

**Files:**

- Modify: `packages/rc-gateway/src/server.ts`
- Modify: `packages/rc-gateway/src/cli.ts`
- Test: `packages/rc-gateway/src/server.workflows.test.ts` (new, self-contained)

**Interfaces:**

- Consumes: Tasks 12–14 exports; existing `createGatewayApp(deps: GatewayDeps): GatewayApp`, `requireScope`, `WRITE`, `SESSION_READ`, `recordActivity`, `workingDevice`, the internal `ownerEvents`, `audit`, `notifier`, and `deps.agents.registry`.
- Produces (used by Task 16):
  - `GatewayDeps` gains:
    ```ts
    /** Workflow orchestration (add-workflow-orchestration). Routes mount only when set. */
    workflows?: {
      runsDir?: string;
      resolveNamed?: (name: string) => Promise<string | undefined>;
    };
    ```
  - `GatewayApp` gains `workflowRuns?: WorkflowRunRegistry` (present only when `deps.workflows` AND `deps.agents` are supplied — the workflow plane requires the agent registry for per-agent sessions).

- [ ] **Step 1: Write the failing test**

Create `packages/rc-gateway/src/server.workflows.test.ts`:

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
import { createGatewayApp } from './server.js';
import { TokenStore } from './tokenStore.js';
import { PairingService } from './pairing.js';
import { AgentRegistry } from './agents/agentRegistry.js';
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

describe('workflow wiring', () => {
  it('mounts /rc/workflows with scope gates', async () => {
    stub = await startStubDaemon({ promptDelayMs: 50 });
    const dir = await mkdtemp(join(tmpdir(), 'srv-wf-'));
    const store = await TokenStore.open(join(dir, 'tokens.json'));
    const writeTok = (await store.issue(['write', 'session:read'], 'w')).token;
    const readTok = (await store.issue(['session:read'], 'r')).token;
    const registry = await AgentRegistry.open(join(dir, 'agents.json'));
    const gw = createGatewayApp({
      daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
      store,
      pairing: new PairingService(),
      auditPath: join(dir, 'audit.log'),
      agents: { registry },
      workflows: { runsDir: join(dir, 'runs') },
    });
    const frames: OwnerEvent[] = [];
    gw.ownerEvents.subscribe((e) => frames.push(e));
    server = await new Promise((resolve) => {
      const s = gw.app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = server!.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;

    // read scope cannot start.
    const denied = await fetch(`${url}/rc/workflows`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${readTok}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        script: `export const meta = { name: 'd', description: 'd' };\nreturn 1;`,
      }),
    });
    expect(denied.status).toBe(403);

    // write scope starts → 202.
    const started = await fetch(`${url}/rc/workflows`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${writeTok}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        script: `export const meta = { name: 'd', description: 'd' };\nreturn 1;`,
      }),
    });
    expect(started.status).toBe(202);
    expect(gw.workflowRuns).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/evan/projects/qwen-code/packages/rc-gateway && npx vitest run src/server.workflows.test.ts`
Expected: FAIL — `workflows` not in `GatewayDeps`; `workflowRuns` not on `GatewayApp`.

- [ ] **Step 3: Wire `server.ts`**

1. Add imports:

```ts
import { WorkflowRunRegistry } from './workflows/workflowRegistry.js';
import {
  createStartWorkflowRoute,
  createListWorkflowsRoute,
  createGetWorkflowRoute,
  createCancelWorkflowRoute,
} from './routes/workflows.js';
```

2. Add the `workflows?` field to `GatewayDeps` and `workflowRuns?: WorkflowRunRegistry` to `GatewayApp`, exactly as in this task's Interfaces block.

3. Immediately AFTER the existing `if (deps.agents) { ... }` agent-routes block (so `deps.agents.registry` and `notifier` are in scope), add:

```ts
// Workflow orchestration control plane (add-workflow-orchestration). Requires
// the agent registry (each workflow agent is a real session).
let workflowRuns: WorkflowRunRegistry | undefined;
if (deps.workflows && deps.agents) {
  workflowRuns = new WorkflowRunRegistry();
  const workflowDeps = {
    daemon: deps.daemon,
    agentRegistry: deps.agents.registry,
    runRegistry: workflowRuns,
    ownerEvents,
    audit,
    notifier,
    runsDir: deps.workflows.runsDir,
    resolveNamed: deps.workflows.resolveNamed,
  };
  app.post(
    '/rc/workflows',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    createStartWorkflowRoute(workflowDeps),
  );
  app.get(
    '/rc/workflows',
    requireScope(SESSION_READ, audit),
    createListWorkflowsRoute(workflowDeps),
  );
  app.get(
    '/rc/workflows/:runId',
    requireScope(SESSION_READ, audit),
    createGetWorkflowRoute(workflowDeps),
  );
  app.post(
    '/rc/workflows/:runId/cancel',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    createCancelWorkflowRoute(workflowDeps),
  );
}
```

4. Add `workflowRuns` to the returned object:

```ts
    workflowRuns,
```

- [ ] **Step 4: Wire `cli.ts`**

In `runServe`, in the `createGatewayApp({ ... })` call (next to `agents: { ... }`), add:

```ts
      workflows: {
        runsDir: join(homedir(), '.qwen', 'workflows', 'runs'),
      },
```

(The `agentRegistry` already opened for `agents:` is reused — no new store needed. `join`/`homedir` are already imported in cli.ts.)

- [ ] **Step 5: Run the new test + full suite**

Run: `cd /home/evan/projects/qwen-code/packages/rc-gateway && npx vitest run src/server.workflows.test.ts && npx vitest run`
Expected: PASS — new test green, zero regressions.

- [ ] **Step 6: Typecheck touched files only (no NEW tsc errors)**

Run: `cd /home/evan/projects/qwen-code/packages/rc-gateway && npx tsc --noEmit -p . 2>&1 | grep -E "workflows/|routes/workflows|server.workflows" || echo "no new tsc errors in workflow files"`
Expected: `no new tsc errors in workflow files` (pre-existing errors in auth.ts/cors.ts/etc. are out of scope).

- [ ] **Step 7: Commit**

```bash
cd /home/evan/projects/qwen-code
git add packages/rc-gateway/src/server.ts packages/rc-gateway/src/cli.ts packages/rc-gateway/src/server.workflows.test.ts
git commit -m "feat(rc-gateway): wire workflow run registry + /rc/workflows routes into gateway"
```

---

### Task 16: Integration test — 3-agent pipeline end-to-end

**Files:**

- Test: `packages/rc-gateway/src/workflows/workflows.integration.test.ts`

**Interfaces:**

- Consumes: everything through PUBLIC surfaces only — `createGatewayApp`, `TokenStore.open`/`issue`, `startStubDaemon` (with `POST /session` + `createdSessionCount` from `add-agent-observability`), `GatewayApp.ownerEvents`, HTTP endpoints.
- Produces: nothing — the end-to-end acceptance gate.

- [ ] **Step 1: Write the integration test**

Create `packages/rc-gateway/src/workflows/workflows.integration.test.ts`:

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
import { AgentRegistry } from '../agents/agentRegistry.js';
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

async function waitFor(cond: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 15));
}

// A pipeline that fans one stage over three items → exactly three agents.
const THREE_AGENT_PIPELINE = `
export const meta = { name: 'triage', description: 'fan across three items', phases: [{ title: 'Scan' }] };
phase('Scan');
const out = await pipeline(['alpha', 'beta', 'gamma'], (item) => agent('scan ' + item));
return { scanned: out };
`;

describe('workflow orchestration end-to-end (3-agent pipeline)', () => {
  it('POST /rc/workflows spawns three per-agent sessions and completes', async () => {
    stub = await startStubDaemon({ promptDelayMs: 30 });
    const dir = await mkdtemp(join(tmpdir(), 'wf-e2e-'));
    const store = await TokenStore.open(join(dir, 'tokens.json'));
    const { token } = await store.issue(['owner'], 'e2e');
    const registry = await AgentRegistry.open(join(dir, 'agents.json'));

    const gw = createGatewayApp({
      daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
      store,
      pairing: new PairingService(),
      auditPath: join(dir, 'audit.log'),
      agents: { registry },
      workflows: { runsDir: join(dir, 'runs') },
    });
    const frames: OwnerEvent[] = [];
    gw.ownerEvents.subscribe((e) => frames.push(e));
    server = await new Promise((resolve) => {
      const s = gw.app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = server!.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;
    const auth = { Authorization: `Bearer ${token}` };

    // 1. Start.
    const started = await fetch(`${url}/rc/workflows`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: THREE_AGENT_PIPELINE }),
    });
    expect(started.status).toBe(202);
    const { runId } = (await started.json()) as { runId: string };

    // 2. Observe: started + phase, then completed.
    expect(frames.some((f) => f.type === 'workflow_started')).toBe(true);
    await waitFor(() => frames.some((f) => f.type === 'workflow_phase'));
    await waitFor(() => frames.some((f) => f.type === 'workflow_completed'));

    // 3. Three per-agent daemon sessions were created and tagged to the run.
    expect(stub!.createdSessionCount).toBe(3);
    expect(registry.list({ workflowRunId: runId })).toHaveLength(3);

    // 4. Detail exposes the per-agent (agentId ↔ sessionId) map.
    const detail = await fetch(`${url}/rc/workflows/${runId}`, {
      headers: auth,
    });
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as {
      status: string;
      agents: Array<{ agentId: string; sessionId: string }>;
    };
    expect(body.status).toBe('completed');
    expect(body.agents).toHaveLength(3);
    expect(new Set(body.agents.map((a) => a.sessionId)).size).toBe(3);

    // 5. Cancel on a terminal run → 409.
    const late = await fetch(`${url}/rc/workflows/${runId}/cancel`, {
      method: 'POST',
      headers: auth,
    });
    expect(late.status).toBe(409);

    // 6. List shows the completed run.
    const list = await fetch(`${url}/rc/workflows`, { headers: auth });
    const listBody = (await list.json()) as {
      workflows: Array<{ runId: string; status: string }>;
    };
    expect(listBody.workflows.find((w) => w.runId === runId)?.status).toBe(
      'completed',
    );
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `cd /home/evan/projects/qwen-code/packages/rc-gateway && npx vitest run src/workflows/workflows.integration.test.ts`
Expected: PASS.

> **If `stub.createdSessionCount` or the result-text extraction disagrees with
> the real `DaemonClient.prompt` shape** (flagged in Task 12), reconcile
> `SessionSpawner`'s `extractText`/`extractTokens` here — the pipeline structure
> (three sessions, one per item) is the load-bearing assertion; exact result
> text is secondary.

- [ ] **Step 3: Run the full suite one last time**

Run: `cd /home/evan/projects/qwen-code/packages/rc-gateway && npx vitest run`
Expected: PASS — no regressions anywhere.

- [ ] **Step 4: Commit**

```bash
cd /home/evan/projects/qwen-code
git add packages/rc-gateway/src/workflows/workflows.integration.test.ts
git commit -m "feat(rc-gateway): workflow orchestration end-to-end integration test"
```

---

## Self-review checklist (run after all tasks)

1. **Spec coverage vs the design doc.** Script API + `meta` literal rule → Tasks 5 (primitives) + 10 (parse); sandbox guarantees (frozen allowlist, determinism, no host leak, 512 KB) → Task 5; scheduler concurrency + lifetime cap → Task 6; journal + resume → Task 7; `AgentSpawner` + `HeadlessSpawner` (schema via Ajv) → Task 8; worktree isolation → Task 9; engine assembly + cancellation → Task 10; `Workflow` tool + background-task pill → Task 11; `SessionSpawner` + `workflowRunId` → Task 12; SSE events + audit + two notification kinds (no snooze bypass) → Task 13; run registry + four endpoints + 400/409 → Task 14; server/cli wiring → Task 15; 3-agent pipeline e2e → Task 16; spec artifacts + registry edits → Tasks 1–4.
2. **Placeholder scan.** No TBD/TODO/"similar to Task N". All code blocks are final (the earlier throwaway `require('node:crypto')` in Task 10 and placeholder `engine` in Task 14 have been removed; only real code remains). The one residual judgment call — `crypto.randomUUID()` global vs `node:crypto` import — is flagged with the resolution.
3. **Type consistency.** `AgentSpawner`/`AgentSpawnRequest`/`AgentSpawnResult` defined once (Task 8), consumed identically by Tasks 10/12/14; `SandboxBridges.agent` is callback-style `(promptJson, optsJson, resolve, reject)` in Tasks 5 and 10; `WorkflowEventPayload`/`WorkflowLifecycleEventType` defined once (Task 13) and used by Task 14; `canonicalHash` (Task 7) is the single hashing surface used by Task 10; `WORKFLOW_EVENT_KINDS` has exactly two entries in both Task 13's definition and its test.

### Real-API adjustments (design-doc assumptions the code had to change)

- **Sandbox `parallel`/`pipeline` are context-native, not `scheduler.ts`-owned.** The design lists the scheduler as owning combinator semantics; host-side combinators would rebuild the host-object leak, so they live in the sandbox bootstrap (Task 5) and `scheduler.ts` owns only the semaphore + lifetime cap (Task 6).
- **`vm` timeout ≠ wall-clock ceiling.** Node's `runInContext` timeout bounds only synchronous CPU up to the first `await`; the wall-clock ceiling is enforced by the agent-bridge deadline + an `AbortController` timer (Task 10). The threat model carries an explicit honesty note (Task 1) — `node:vm` is not a jail.
- **`acorn` is not a declared core dependency.** Present only via hoisting; Task 10 adds it to `packages/core/package.json` explicitly (Global Constraints).
- **StructuredOutput has no headless read-back.** `AgentHeadless` exposes no capture for the StructuredOutput tool (that lives in `nonInteractiveCli`), so `HeadlessSpawner` validates `getFinalText()` with Ajv + jsonrepair and bounded retries (Task 8).
- **`AgentHeadless` has no per-run cwd.** It uses `Config.getWorkingDir()`, so `isolation: 'worktree'` is naturally SessionSpawner-first; `req.cwd` is threaded but the headless path defers worktree binding (Task 8 note).
- **Background-task surfacing is a shim.** No `workflow` `TaskKind`; the run registers as a foreground `agent` task (`isBackgrounded: false`) so it never consumes the background-agent concurrency cap (`assertCanStartBackgroundAgent` is not called) — Task 11.
- **`DaemonClient.prompt` result shape is unpinned.** `SessionSpawner` uses defensive `extractText`/`extractTokens` to be reconciled at Phase 3.0 (Task 12); the integration test leans on the three-sessions structural assertion rather than exact result text (Task 16).
- **Engine must be exported from the core barrel.** The gateway runs the engine in-process, so `packages/core/src/index.ts` re-exports `workflows/index.js` (Task 10) — without it Part C would not compile.
- **New rc-gateway → core package edge.** rc-gateway declared only `@qwen-code/sdk` and had NO core dependency (the gateway is otherwise decoupled from core, talking to the daemon via the SDK). Approach A forces the engine into the gateway process, so Task 12 Step 0 adds `@qwen-code/qwen-code-core` (core's real package name — NOT `@qwen-code/core`) to `packages/rc-gateway/package.json`. One-directional edge, no cycle.
- **`routes/*.ts` export handler factories, not a mount function.** Matching `routes/agents.ts`, `routes/workflows.ts` exports `create*Route(deps)` factories; mounting with `requireScope` happens in `server.ts` (Tasks 14–15).
