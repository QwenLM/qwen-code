# Managed workflow child kind and child launch budget (H4c)

[English](2026-10-09-managed-workflow-child-kind.md) | [简体中文](2026-10-09-managed-workflow-child-kind.zh-CN.md)

Status: implemented in this change. Landed: the `workflow` body kind of `managed-child_run` and the cumulative child launch budget refused with `budget_exhausted`, with submission enabled by the [workflow runtime design](2026-10-10-managed-workflow-child-runtime.md) (delivered in the same tree: the gate lists both kinds). Still design only the Workspace isolation policies (Follow-up work). This is slice **H4c** of [#12827](https://github.com/QwenLM/qwen-code/issues/12827), stage H of the Managed Agent proposal [#12380](https://github.com/QwenLM/qwen-code/issues/12380), tracked by [#13743](https://github.com/QwenLM/qwen-code/issues/13743). It follows H4a ([record contract](2026-10-06-managed-child-agent-runtime.md), #13505) and H4b ([child Session runtime](2026-10-07-managed-child-session-runtime.md), #13550). The earlier [H4 problem framing](2026-10-04-managed-child-agents.md) remains background; where it disagrees with H4a, H4b or this document, these govern.

## Problem and scope

Issue #13743 asked for three things under the H4c name: the `workflow` child kind (C1), the Workspace isolation policies `independent_worktree` and `shared_serialized` (C2), and depth/concurrency/budget quotas on children (C3). It also recorded a documentation drift: the 2026-10-04 framing gives H4c a different scope from the six-slice map that H4a published. The maintainer settled the scope on 2026-10-09:

- **C1 lands here** as a record contract: the body kind, its validators and fixed-field rules, shared fixtures replayed in TypeScript and Java, and admission behind the existing kind gate, disabled.
- **C3 lands here, narrowed to what was actually missing.** H4b already refuses depth beyond 1 and more than 4 active children per scope at launch. What no rule bounded was the cumulative number of launches: a model could launch 4 children, wait, and launch 4 more without end. The budget closes that gap.
- **C2 moves to its own slice.** No Workspace provider in `managed-agent-server` or `runtime-broker` can create a worktree for a child or merge one back. Both policies need that capability before any record change makes sense (decision 11).

### Where the 2026-10-04 H4c row went

| Item in the 2026-10-04 H4c row                                  | Where it landed                                                       |
| --------------------------------------------------------------- | --------------------------------------------------------------------- |
| Background child notification                                   | H4b (`"sent"` completion: notification input plus generated wake)     |
| Close cascade: cancel by default, orphaned results              | H4b (cascade in the close coordinator; relay `orphaned` ledger state) |
| Detach with a durable owner                                     | The "Detach" follow-up of H4a/H4b                                     |
| Child task cancel through the planned cancel route              | H4f (public task cancel)                                              |
| Depth and concurrency quotas                                    | H4b (`depth_limit`, `count_limit` at launch)                          |
| Budget quota                                                    | **This slice** (`budget_exhausted` at launch)                         |
| `workflow` kind (listed under "Later H4 slices")                | **This slice**, as a disabled record contract                         |
| `independent_worktree`, `shared_serialized` ("Later H4 slices") | The isolation slice (decision 11)                                     |

## Current state

The facts below are from `main` at `15c11bb898`.

- **Body dispatch.** `parseChildRun` (`managed-child-run-record.ts`) dispatches exactly two kinds: `shell` and `child_agent`. `ManagedExtensionRecords.requireChildRun` mirrors it in Java. The shared fixtures use `kind: "workflow"` as their unknown-kind witness (`kind-unknown`, `agent-kind-workflow`).
- **Kind gate.** `MANAGED_SESSION_ENABLED_CHILD_RUN_KINDS` is `['child_agent']`. Two production sites check it: the authority's commit path and the hosted tool turn's Agent tool admission.
- **Isolation vocabulary.** The `child_agent` body carries `workspaceMode` with the closed values `shared`, `snapshot` and `worktree` (H4a). `MANAGED_CHILD_ADMITTED_WORKSPACE_MODES` admits `shared` only, and the launch admission refuses the others with `workspace_mode`. The framing's names `read_only_snapshot`, `independent_worktree` and `shared_serialized` appear nowhere in code.
- **Quotas.** `admitChildLaunch` refuses at launch time, before anything commits: `closing`, `workspace_mode`, `definition_scope`, `depth_limit` (depth above 1), `count_limit` (4 active children per owner scope) and `byte_limit` (32 KiB launch envelope). Depth is bounded in practice as well: a child Session's own turn never advertises the Agent tool (`childDepth === 0` in the hosted tool turn). No rule bounds the total number of launches.
- **Java runtime paths.** The relay's discovery page (`ChildResultRelayStore.PENDING_SQL`) and the close cascade (`findLiveScopes`) select every `child_run` row with a delivery line. Today only `child_agent` rows have one, and the relay's comment says so.
- **Readers.** The hosted workspace restore enumeration skips `child_agent` records explicitly. The child agent funnel (`HostedChildAgentSession`) reads `child_agent` records only.

## Decisions

1. **`workflow` is a third body kind of `managed-child_run` schema version 1.** The body's own `kind` field dispatches it; the envelope and `recordRef.schemaVersion` do not change (H4a decision 1). An older reader refuses a `workflow` body, which is the fail-stop stance H3 and H4a already took. No Session can hold one yet, because the kind gate refuses every commit, so there is no mixed-version window.
2. **One shape for both child Session kinds.** `workflow` and `child_agent` share the closed key set, the fixed keys, the stop reasons and every run, delivery and acceptance rule. A workflow child is a child Session whose launch input runs a workflow instead of a prompt. Every fact the pipeline commits is the same for both: launch identities, dispatch, attach, result copies, acceptance, consumption and cascade cancellation. What a workflow launch needs beyond a prompt (the workflow to run and its arguments) travels in the launch input that `inputRef` names. The workflow runtime slice defines that envelope, exactly as H4b defined the child agent's.
3. **The kinds differ in three places.**
   - Task kind: a `workflow` run projects task kind `workflow`. The public `TaskKind` enum already lists it (`partial`), so the OpenAPI contract does not change.
   - Enablement: _(Superseded by the runtime slice)_ at this slice's commit the kind gate admitted `child_agent` and not `workflow`; the [workflow runtime slice](2026-10-10-managed-workflow-child-runtime.md) admits both (decision 5).
   - The definition pin: a `workflow` run must carry `run.definition` on every revision, the opening one included. The pin names the workflow it runs: `definitionId` is the workflow's stable identity, `definitionRevision` its revision, and `definitionDigest` the digest of the definition that runs. The workflow is the subject of the launch, so a launch without it is refused with "Workflow run must pin its workflow definition from launch." A child agent may still open without its pin and must carry it by its dispatch (H4a).
4. **Cross-record rules apply per child Session, not per kind.** The TypeScript authority and the Java store apply the same three rules to both kinds:
   - A first-level run's `rootSessionId` must be the Session that owns the journal.
   - A `child_acceptance` may name a run of either kind. The refusal text becomes "Child acceptance must name a child Session run of this Session."
   - The reverse acceptance check of H4b decision 7.

   Each of these rules, the successor and start rules, the restore skip and the launch quotas ask one classifier that names both kinds, never "not a Shell": `isChildSessionRun` in `managed-child-run-record.ts` and `ManagedExtensionRecords.isChildSessionRun` in Java. The TypeScript classifier and the task-kind projection switch over every kind of `AnyChildRun`, so a kind added later fails to compile until it is classified. In Java an unlisted kind is no child Session, and `childRunTaskKind` refuses it instead of projecting it as a child agent.

5. **`workflow` stays gated in this slice, opened with its runtime sibling.** `MANAGED_SESSION_ENABLED_CHILD_RUN_KINDS` stays `['child_agent']` here — and the [workflow runtime slice](2026-10-10-managed-workflow-child-runtime.md), delivered in the same tree, lands it as `['child_agent', 'workflow']` (with H3's `shell` enabled by #13856, the shipped constant is `['child_agent', 'shell', 'workflow']`), so the authority refuses only a kind it does not list with "domain child_run kind `<kind>` is registered but not enabled for submission." on every revision commitment. The Java store validates and materializes `workflow` bodies ahead of any writer (the server-first order H1–H4b kept) and projects their task kind.
6. **The Java runtime paths stay with `child_agent` here, widened by the same runtime slice.** At this slice's commit, the relay's discovery page and the close cascade's live-scope query require `task_kind = 'child_agent'`, and the relay drives a prompt-driven child Session through the child agent funnel; the [workflow runtime slice](2026-10-10-managed-workflow-child-runtime.md) widens both to `IN ('child_agent', 'workflow')`, so a `workflow` row is visible to exactly the machinery that creates, settles and cancels it. Acting on a `workflow` row without those widenings would mint a prompt-driven child from a workflow launch, and the close would wedge on a cancel the funnel refuses — the gate entry needs the managed admission, the launch envelope and the two widenings together.
7. **Readers tolerate the new kind.** The workspace restore enumeration skips every child Session kind, because neither owns an output manifest. _(Superseded by the runtime slice)_ At this slice's commit the child agent funnel read `child_agent` records only, so its record lookups never returned a `workflow` run as a child agent; the runtime slice makes the funnel kind-parametric (its decision 7).
8. **Depth and concurrency stay as H4b shipped them.** Depth 1, at most 4 active children per owner scope, each refused at launch with `depth_limit` or `count_limit`, and nothing commits.
9. **The launch budget.** An owner scope may launch at most `MANAGED_CHILD_LIMITS.maxLaunchesPerScope` = 64 child Session runs over the Session's lifetime.
   - What counts: every committed child Session run of the scope, of either kind and in any state. Failed and cancelled launches count, because each one cost a creation attempt and a chain the rebuild replays (H0c open question 1).
   - The refusal: `admitChildLaunch` answers `budget_exhausted`, an H0b quota reason, and the Agent tool answers the call with the tool error "Hosted child agent refused this launch (budget_exhausted)." Nothing commits but the call's tool result.
   - The order: the budget is checked after depth and before `count_limit`. A spent budget never recovers, while the concurrency cap may clear for a later launch, so the permanent reason is reported first.
   - Replay safety: both counts read committed records only, so a replay re-derives the same answer. A re-driven launch whose record already exists skips the admission (H4b's rule), so a child never counts against its own replay.
   - The value: 64 is 16 full rounds of the concurrency cap. At the 64 KiB result-copy bound it also limits result copies to about 4 MiB per Session.
10. **The quotas count child Sessions, not kinds.** Concurrency and the budget both count `child_agent` and `workflow` runs together, so enabling workflows later cannot double a scope's allowance.
11. **Isolation is its own slice, and its vocabulary is settled now.** The vocabulary H4a shipped governs: `shared`, `snapshot`, `worktree`. The framing's `read_only_snapshot` and `independent_worktree` are `snapshot` and `worktree`. `shared_serialized` gets no name of its own here: `shared` children already serialize through the Workspace lease discipline (H4b decision 3). Whether a per-child generation and barrier needs its own value is for the isolation slice to decide. That slice starts with a Workspace capability, because no provider can create a worktree for a child or merge one back. Record changes come only after that capability exists. The slice is tracked in [#13753](https://github.com/QwenLM/qwen-code/issues/13753).

## Records

### `managed-child_run`, kind `workflow`

Schema version 1. The chain is keyed by `childRunId`, as for `child_agent`. Every key and rule of the [`child_agent` table](2026-10-06-managed-child-agent-runtime.md#managed-child_run-kind-child_agent) applies unchanged, except:

| Key              | Rule                                                                                                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`           | `"workflow"`. A chain never changes kind: `kind` is a fixed key.                                                                                                 |
| `run.definition` | Required on every revision, from the opening one: the workflow's identity, revision and digest. The shared run rules then make it set-once, so it never changes. |

The task projection maps a `workflow` run to task kind `workflow`. `child_acceptance` is unchanged: it now may name a `workflow` run as well as a `child_agent` one.

## Non-goals

- _(Delivered by the runtime slice)_ **The workflow runtime**: the Workflow tool's managed admission, the launch envelope, a child Session that executes a workflow, widening the relay and the cascade, and enabling the kind — a non-goal of this slice only; the [workflow runtime design](2026-10-10-managed-workflow-child-runtime.md) delivers all of it in the same tree.
- **Workspace isolation policies** (decision 11).
- **Depth beyond 1**, and a per-root budget for nested trees.
- **Model, token and duration budgets.** `budget_exhausted` here bounds launches, not tokens; `duration_limit` stays unused.
- **Any public contract change.** The OpenAPI contract, routes and Flyway migrations stay as they are.

## Files affected

- `packages/core/src/managed-runtime/managed-child-run-record.ts`: the `workflow` kind (`WorkflowRun`, `ChildSessionRun`), the shared child Session parser and the launch-time pin rule.
- `packages/core/src/managed-runtime/managed-extension-projection.ts`: `workflow` task kind.
- `packages/core/src/managed-runtime/managed-session-authority.ts`: the root, acceptance and reverse checks apply to every child Session kind.
- `packages/core/src/managed-runtime/managed-child-operations.ts`: `maxLaunchesPerScope`, `launchedInScope` and the `budget_exhausted` refusal.
- `packages/core/src/managed-runtime/contracts/managed-child-run-record-v1.fixtures.json`: the `workflow` template, 15 cases and 9 successor pairs, the agent counterpart `agent-start-without-definition`, and the unknown-kind witnesses repointed to `kind: "unregistered"`. `managed-extension-projection-v1.fixtures.json`: `child_run.workflow → workflow`.
- `packages/cli/src/serve/hosted-child-agent-session.ts` (`launchedChildRunsOf`; `activeChildRunsOf` counts both kinds), `hosted-workspace-tool-turn.ts` (passes the launch count) and `hosted-harness-session.ts` (the restore skips every child Session kind).
- `packages/managed-agent-server`: `ManagedExtensionRecords` (dispatch, `requireChildSession`, the pin rule, the task kind), `ManagedExtensionRecordStore` (the three cross-record rules per child Session), `ChildResultRelayStore` (the relay page and the cascade scoped to `child_agent`).
- Tests beside each file in both languages; this design in both languages, plus a scope note in the H4 framing, H4a and H4b designs.

## Validation

- **Fixture parity.** The `workflow` cases and successors replay in both languages through `managed-child-run-record.test.ts` and `ManagedChildRunRecordContractTest`. Both validators refuse every invalid case on the clause that the fixture names, and Java also pins each valid case's task kind.
- **Authority.** _(At this slice's commit; the runtime slice rewrote these refusal witnesses to assert admission.)_ The real kind gate refuses a `workflow` launch and nothing publishes. With the gate lifted for planting only, a `workflow` chain commits through acceptance and consumption, rebuilds on reopen with no gate (the gate refuses submission, never a reader), projects task kind `workflow` with the pinned `definitionRevision`, and obeys the root, acceptance and reverse rules.
- **Java store and relay.** A `workflow` chain commits under the same rules and projects `workflow`. _(At this slice's commit; the runtime slice widens both queries.)_ A `workflow` row with a pending delivery appears neither on the relay's page nor among the cascade's live scopes.
- **Budget.** The admission matrix covers the boundary and the order. The tool-turn suite launches the 64th child, then refuses the 65th twice with `budget_exhausted` while no child is active. No record commits for either refusal, and the second refusal shows the replay re-deriving the first.
- **Readers.** The workspace restore succeeds with a `child_agent` or a `workflow` record beside a detached Shell lineage. The quota counts include a planted `workflow` run, and the funnel's own record lookup does not return it.
- **Mutation checks.** Each new guard was disabled in turn and its witness went red: 11 in TypeScript and 8 in Java. One more mutant, the restore skip narrowed back to `child_agent`, behaves identically to the change, because the enumeration's fall-through stores `undefined`, which the lineage check already treats as absent. `tsc` refuses that mutant instead, because a `workflow` run has no `outputRef`.

## Acceptance criteria

- TypeScript and Java produce and refuse identical `workflow` chains from the shared fixtures, and every H3, H4a and H4b case replays unchanged except the two repointed unknown-kind witnesses.
- _(Flipped by the runtime slice)_ At this slice's commit `MANAGED_SESSION_ENABLED_CHILD_RUN_KINDS` was `['child_agent']` and a `workflow` commit was refused with "registered but not enabled"; the runtime slice flips both deliberately — the shipped constant is `['child_agent', 'shell', 'workflow']` (H3's `shell` by #13856) and a `workflow` commit succeeds.
- A launch beyond the budget is refused with `budget_exhausted` and commits no child, and a replay answers the same.
- No public API or migration changes, and every existing child agent suite stays green.

## Open questions

1. _(Settled by the runtime slice)_ **The workflow launch envelope**: inline script source, `{ definition, script, args }` with closed keys and a 32 KiB `maxEnvelopeBytes` bound — [the runtime design's](2026-10-10-managed-workflow-child-runtime.md) decisions 1 and 3.
2. _(Settled by the runtime slice)_ **Where a workflow's own agents run**: inside the workflow child as in-process subagents; nested child Sessions and the depth-2 runtime are the named follow-up — the runtime design's decision 5.
3. **The budget value**: whether 64 needs tuning, and a per-root budget once nesting lands.

## Follow-up work

| Slice            | Scope                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow runtime | Delivered by the [workflow runtime design](2026-10-10-managed-workflow-child-runtime.md): the Workflow tool's managed admission (inline source, decision 1 there — settling open question 1 here), the launch envelope, child Session execution of a workflow (agents in-process, settling open question 2), the relay and cascade widened to `workflow`, and the kind gate entry. |
| Isolation        | [#13753](https://github.com/QwenLM/qwen-code/issues/13753): a Workspace capability for child worktrees and their merge back; then `worktree` (lifecycle, merge policy) and `snapshot`, and a decision on whether serialized sharing needs its own value.                                                                                                                           |
| H4d–H4f, Detach  | Unchanged from the H4a/H4b delivery map.                                                                                                                                                                                                                                                                                                                                           |
