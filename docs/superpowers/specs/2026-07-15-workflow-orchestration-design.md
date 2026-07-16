# Workflow orchestration — design (2026-07-15)

Deterministic multi-agent workflow orchestration for the qwen-code
fork: a sandboxed JS scripting layer over the agent runtime, invocable
both as a local model tool and via rc-gateway. Approved approach:
**A — one engine over an injected spawner interface** (chosen over B:
always-through-gateway, and C: two engines; see Alternatives).

Spec-first: ships as the 20th OpenSpec change,
`add-workflow-orchestration`, in qwen-code-remote, registering all new
SSE events and audit actions in the authoritative registries.

## Scope decisions (user-confirmed)

- **Both surfaces from day one**: a `Workflow` tool in core (engine
  in-process over the headless agent runtime — works offline) AND
  `POST /rc/workflows` on rc-gateway (engine in the gateway process,
  spawning through the agents-as-sessions plane).
- **Sandboxed JS scripts**: plain JavaScript in a restricted `node:vm`
  with injected primitives; no declarative DAG, no child processes.
- **Journaled resume**: every primitive result journaled; re-runs
  replay the unchanged prefix from cache. Determinism rules enforced
  (`Date.now()`, argless `new Date()`, `Math.random()` throw).

## Script API

```js
export const meta = {
  name: 'review-changes',
  description: 'Review changed files across dimensions',
  phases: [{ title: 'Find' }, { title: 'Verify' }],
};
phase('Find');
const results = await pipeline(
  DIMENSIONS,
  (d) => agent(d.prompt, { schema: FINDINGS, label: `find:${d.key}` }),
  (r) =>
    parallel(
      r.findings.map(
        (f) => () =>
          agent(`Verify: ${f.title}`, { schema: VERDICT, phase: 'Verify' }),
      ),
    ),
);
return { confirmed: results.flat().filter(Boolean) };
```

Injected primitives:

- `agent(prompt, opts)` — opts: `label`, `phase`, `schema` (JSON
  Schema → forced StructuredOutput tool, validated return, bounded
  retries), `model`, `agentType`, `isolation: 'worktree'`,
  `timeoutMs`. Returns text or validated object; resolves `null` on
  agent failure after bounded transient-error retries.
- `parallel(thunks)` — barrier; settles all; a thrown thunk resolves
  to `null` in the result array.
- `pipeline(items, ...stages)` — per-item flow through stages with NO
  inter-stage barrier; stage callbacks receive
  `(prevResult, originalItem, index)`; a throwing stage drops that
  item to `null` and skips its remaining stages.
- `phase(title)`, `log(message)`, `args` (caller-supplied value),
  `budget` — `{ total, spent(), remaining() }` in tokens; once
  `spent() >= total`, further `agent()` calls throw (catchable).

`meta` MUST be a pure literal (no computed values), verified by static
AST check before execution; `name` and `description` required;
`phases` optional and matched to `phase()` titles for progress
display.

## Sandbox (security-critical component)

Scripts execute in `node:vm` with a frozen, allowlisted global
surface: JS builtins (JSON, Math minus `random`, Array, Object,
String, etc.) plus the injected primitives — nothing else. No
`require`, `import`, `process`, `fetch`, filesystem, or network.
`Date.now()`, argless `new Date()`, and `Math.random()` throw with a
message explaining the determinism rule. Script source capped at
512 KB. A wall-clock ceiling and a lifetime agent-count cap (default 1000) backstop runaway loops. Intrinsics frozen to prevent prototype-
pollution escapes.

**Ownership rule (user decision): the sandbox implementation and its
review are Opus-only work. Fable agents (including the session
controller) must not author or review sandbox/security code.**

## Engine (`packages/core/src/workflows/`)

Five units:

1. **`scriptRunner.ts`** — static meta parse (pure-literal AST
   check), sandbox construction, async execution of the script body,
   returns the script's return value.
2. **`scheduler.ts`** — concurrency gate `min(16, cpus - 2)`
   concurrent `agent()` calls per run, FIFO queueing beyond; barrier
   semantics for `parallel`, per-item no-barrier flow for `pipeline`;
   lifetime agent-count cap enforced here.
3. **`journal.ts`** — JSONL at
   `~/.qwen/workflows/runs/<runId>/journal.jsonl`; one record per
   primitive call `{ seq, kind, promptHash, optsHash, result,
tokens }`; `run.json` holds meta, script hash, args, status. On
   `resumeFromRunId`, the longest prefix matching by sequence + hashes
   returns cached results synchronously; first divergence onward runs
   live.
4. **`spawner.ts`** — `AgentSpawner` interface:
   `spawn({ prompt, systemContext, model?, agentType?, schema?, cwd,
signal }) → Promise<{ text | structured, tokens }>`.
   Implementations:
   - `HeadlessSpawner` (core): wraps the existing headless agent
     runtime; schema enforcement via forced StructuredOutput tool,
     up to 2 validation retries.
   - `SessionSpawner` (rc-gateway): spawns through the
     agents-as-sessions plane; each workflow agent is a real session
     (observable, cost-tracked, searchable); `AgentRecord` gains an
     optional `workflowRunId` linkage field.
5. **`worktree.ts`** — `isolation: 'worktree'` acquires a temp
   worktree via the existing `GitWorktreeService` (the service
   ArenaManager uses), passes its path as the agent's cwd,
   auto-removes if unchanged. Acquisition failure errors that agent
   (`null`); never silently falls back to the shared tree.

Cancellation: one `AbortController` per run fanned to every in-flight
spawn; cancel marks the run `cancelled`; the journal remains valid for
resume.

## Surfaces

### CLI tool (core)

`Workflow` tool: `{ script | scriptPath | name, args?,
resumeFromRunId? }`. Named workflows resolve from
`.qwen/workflows/*.js` (project) then `~/.qwen/workflows/*.js`
(user). Returns `{ runId, result }`. Runs surface through the existing
background-task registry so the task pill/panel shows phase + agent
counts. Per-run artifacts persist under
`~/.qwen/workflows/runs/<runId>/`.

### Gateway API (rc-gateway)

| Endpoint                                                           | Scope   | Behavior                                                                                         |
| ------------------------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------ |
| `POST /rc/workflows` `{ script \| name, args?, resumeFromRunId? }` | `write` | Start run with `SessionSpawner`; `202 { runId }`; `400 invalid_workflow_script` on parse failure |
| `GET /rc/workflows`                                                | `read`  | List runs: status, name, phase, agent counts, token totals                                       |
| `GET /rc/workflows/:runId`                                         | `read`  | Detail incl. per-agent map (agentId ↔ sessionId)                                                |
| `POST /rc/workflows/:runId/cancel`                                 | `write` | `202`; `409 workflow_not_running` if terminal                                                    |

SSE (owner stream; to be registered in the wire-protocol registry):
`workflow_started`, `workflow_phase`, `workflow_completed`,
`workflow_failed`, `workflow_cancelled`. Notification kinds
`workflow.completed`, `workflow.failed` routable through routing
rules; neither bypasses quiet hours.

Audit actions (pairing-auth extension registry): `workflow_started`,
`workflow_cancelled`. Script content is never audited — name + script
hash only.

## Error handling

| Failure                                | Behavior                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Script syntax error / non-literal meta | Fail before any spawn: `400 invalid_workflow_script` (gateway) / tool error (CLI), with line info   |
| Agent spawn/exec error                 | That `agent()` resolves `null` after bounded transient retries; journal records the failure         |
| Schema validation exhausted            | Same `null` path, reason recorded                                                                   |
| Budget exhausted                       | Further `agent()` throws into the script (catchable); uncaught → run `failed`, partial journal kept |
| Engine crash / process death           | Journal intact; resume replays the completed prefix                                                 |
| Cancel                                 | In-flight agents aborted (gateway: sessions ended); run `cancelled`                                 |
| Worktree acquisition fails             | That agent errors → `null`; no silent shared-tree fallback                                          |

## Threat model

| Attacker                                     | Capability                              | Mitigation                                                                                                                   |
| -------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Malicious/buggy workflow script              | Escape the VM, reach fs/network/process | Frozen allowlisted globals, no require/import/process; Opus-owned sandbox implementation + review; escape-attempt test suite |
| Script author (prompt-injected model)        | Runaway spawn loops burning tokens      | Lifetime agent cap (1000), concurrency cap, budget ceiling, wall-clock ceiling                                               |
| Compromised `read` token (gateway)           | Start/cancel workflows                  | `write` scope required for start/cancel; `read` observes only                                                                |
| Script exfiltrates secrets via agent prompts | Prompts reach model providers           | Same exposure class as any agent prompt; audit records name+hash, script stored locally per-run for inspection               |
| Journal tampering                            | Forged cached results on resume         | Journal is local 0600; resume validates seq + prompt/opts hashes                                                             |

## Alternatives considered

- **B: Always through the gateway plane** — CLI workflows would
  require a running gateway + daemon; breaks offline use; HTTP + token
  plumbing for purely local work. Rejected.
- **C: Two engines** — in-core engine for the tool plus a separate
  gateway orchestrator; duplicated scheduler/journal/sandbox semantics
  guarantee divergence. Rejected.
- Script format alternatives (declarative YAML DAG; TypeScript child
  processes) were considered and rejected during scoping: YAML grows
  escape hatches into a bad programming language; child processes make
  the OS the sandbox and break determinism guarantees.

## Testing

- Sandbox: escape attempts (require/import/process/fetch/fs,
  prototype pollution, constructor chains), determinism throws
  (Date.now/Math.random), source-size cap — **authored and reviewed
  by Opus**.
- Scheduler: concurrency cap honored under load; parallel barrier vs
  pipeline no-barrier semantics with a stub spawner; agent-count cap.
- Journal: round-trip; resume with unchanged script (100% cache);
  resume after mid-script edit (prefix cached, divergence live);
  hash-mismatch safety.
- Budget: throw at ceiling; catchable inside script.
- Worktree: acquisition, cwd passing, auto-removal, failure → null.
- Gateway: route tests against stub daemon (scopes, 400/409, SSE
  frames, audit rows).
- Integration: 3-agent pipeline workflow end-to-end through
  `POST /rc/workflows` with per-agent sessions observable.

## Spec artifacts (qwen-code-remote)

`openspec/changes/add-workflow-orchestration/` with proposal.md,
design.md (alternatives + threat model per config.yaml rules),
specs/workflow-orchestration/spec.md (RFC 2119 requirements with
scenarios; endpoints cited method+path), tasks.md (phased, Status/
Prompt fields). Registry edits made directly in
add-remote-control's wire-protocol (5 SSE rows) and pairing-auth
(2 audit rows) specs, per repo precedent.

## Follow-ups (out of scope)

- Nested workflows (`workflow()` inside a script)
- Remote-triggered scheduled workflows (cron)
- Workflow marketplace/sharing; arena-style judge tournaments as
  library patterns
- Web UI visualization of run progress (gateway already exposes the
  data)
