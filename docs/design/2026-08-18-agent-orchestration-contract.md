# Agent orchestration contract

## Direct verdict

The agent orchestration surface has no single authoritative description of what a
launch resolved to. Advertisement and execution use different resolvers, capability
is projected flatly across six structurally different adapters, and execute-time
failures escape without a structured error. The fix is a small, code-derived,
route-discriminated **projection** of decisions the runtime already makes — not a
policy DSL, not a second runtime.

- **Status:** `Draft — written-spec review blocked; revision under review`
- **Date:** 2026-08-18
- **Base:** `78f7926962b42d309f5a35edb80f775cf0a6ed9d`
- **Evidence:** audit ledger over 52 project chat journals, 2026-07-31 through
  2026-08-18, zero JSON parse failures

### Authority direction is one-way, and pinned

Existing route and runtime predicates remain the only authority. They select the
route, validate the request, and resolve capability, model, limits, lifecycle, and
workspace **first**. Only then does the runtime emit the projection — a read-only
record of what was already decided. The projection never selects a route, recomputes
a policy, re-derives a permission, or is consulted to make a decision. Any proposal
that would make a route branch _ask_ the projection what to do is out of contract.

### Projection timing is per-route, not one global boundary

There is no single pre-spawn boundary, because the facts worth projecting do not all
exist at the same instant on every route. One invariant replaces it:

> **Each route emits its successful snapshot after that route's authoritative
> preparation completes and before its first model request or native external run.**

| Route      | Authoritative preparation that must complete first               |
| ---------- | ---------------------------------------------------------------- |
| in-process | `prepareTools()` returns the prepared tool set                   |
| fork       | fork tool/profile restriction and inherited-turn window resolved |
| teammate   | teammate tool surface, model, and workspace pin resolved         |
| workflow   | workflow tool additions and effective deny floor resolved        |
| cursor-sdk | custom-tool bridge constructed                                   |
| cursor-cli | argv, workspace, and limits prepared                             |

Failures **before** a route's preparation completes use the rejection envelope and
never require a success snapshot; a rejection is not a degraded success. Preparation
order is never reordered to make a projection field available — if a fact is not yet
computed at the route's boundary, it is absent from that route's variant.

### Goals

1. Give all five consumers of definition resolution one shared, **unnormalized**
   source inventory with zero change to what any of them lists or executes (S1a);
   make advertised and executed sets equal only afterwards, as explicit policy
   (S1b, blocked by O1).
2. Emit one immutable success projection per launch at the route boundary above
   (S_projection, gate G12), and freeze it as a route-total exported V1 shape only in
   S_v1 (gate G14).
3. Give every launch failure — validation or execution — the same serializable
   rejection carrier end to end, so telemetry cannot record a failed launch as a
   success (S2, gates G5 and G6).
4. Represent capability as observed adapter facts, per route, instead of one flat
   record pretending to describe six adapters (S5; Cursor depth finalized in
   S_cursor, gate G13).
5. Keep background-agent continuation and Agent Team coordination as two separate
   control planes, in runtime and in every prose surface (S6a–S6c, gate G9).
6. Stop loop detection from terminating the one evidenced legitimate stateful
   coordination read, without weakening deterministic-duplicate protection or caps
   (S7, gate G11).

### Non-goals

- No policy DSL, rule engine, or declarative permission language.
- No second runtime, no re-dispatch layer, no rewrite of route branches.
- No re-implementation or simulation of `AgentCore.prepareTools()`.
- No lineage, self, or subtree identifiers, and no broad observability work.
- No redesign of the TeamManager coordination protocol.
- No change to model provider selection, billing, or quota behavior.

## Vocabulary

Three pairs of distinct concepts share an overloaded word. Each collision is a
source fact, and each has produced observed misuse. Every downstream artifact —
tool descriptions, documentation, and skills — must use these terms as defined
here.

| Term                           | Carried by              | Selects                                                                     | Supplies the model?                        |
| ------------------------------ | ----------------------- | --------------------------------------------------------------------------- | ------------------------------------------ |
| Agent definition, "agent type" | `subagent_type`         | a definition file, resolved session → project → user → extension → built-in | **Yes**, from frontmatter `model:`         |
| Teammate identity              | `name`                  | nothing; a label and message-routing handle                                 | No                                         |
| Fork                           | `subagent_type: "fork"` | a pseudo-type, never loaded from disk                                       | No — shares the parent                     |
| Grade override                 | `model`                 | a grade, not a definition; advertised only when user-defined grades exist   | Yes, and **rejected** for a named teammate |

Resulting launch shapes:

| Passed                                | Result                             | Model source       |
| ------------------------------------- | ---------------------------------- | ------------------ |
| `subagent_type` only                  | ordinary one-shot subagent         | the definition     |
| `subagent_type` + `name`, team active | named teammate                     | the definition     |
| `name` only, team active              | teammate with no definition loaded | the leader's model |
| `name` only, no team                  | ordinary subagent at default type  | the default        |
| an unknown `subagent_type`            | rejected, definition not found     | n/a                |

**Collision 1 — "named" describes both parameters.** `subagent_type` is
documented as "the **named** agent type" and `name` as "spawn as a **named**
teammate", so a caller wanting a specific agent has two plausible parameters and
picks the one called `name`. Only `subagent_type` reaches `loadSubagent`. The
asymmetry is what makes this costly: an unknown `subagent_type` throws a clean
not-found error, while a `name` that was meant as a type fails **silently** and
the run completes on the wrong model.

**Collision 2 — "task" names two unrelated things.** An agent _run_ is a task:
the background registry, `task_id`, `task_stop`, and the `task_id` returned by
`list_agents`. A team _work item_ is also a task: `task_create`, `task_list`,
`task_update`. Holding a `task_id` and reaching for `task_list` is a category
error the naming invites. The registry also tracks foreground runs despite its
name, so "is a foreground agent a task?" has a non-obvious answer: yes, tracked,
but filtered out of `list_agents` by `isBackgrounded`.

**Collision 3 — `subagentName` carries the type.** The display field named
`subagentName` holds the requested type on the ordinary path, the loaded
definition's `name` on others, and the teammate identity on the team path.
Ordinary subagents have no name at all and register no view tab, so concurrent
same-type subagents are distinguishable only by their `description`.

**Unrecognized frontmatter keys are dropped without a diagnostic.** A _recognized_
key with an invalid value warns; an unrecognized key produces nothing. A
definition written with an unsupported limit spelling therefore silently has no
limit, and the author has no signal. This is the same fail-open family as the
capability findings, and is why the diagnostics snapshot exists.

## Evidence categories

A **source fact** is current code behavior; a **confirmed defect** is a source fact
contradicting a documented contract; a **source-backed design gap** is a real hole
with no single contradicted contract; a **design decision** is a choice made here; an
**open product decision** is unresolved and blocks its scope.

### Source facts

- Execution resolves definitions case-insensitively in the order
  session → project → user → extension → built-in.
- Normal advertisement lists project → user → built-in → extension, omits session,
  and deduplicates case-sensitively. The two orders and the two dedup rules differ;
  neither is "the" canonical order today.
- `safeMode` and `sdkMode` are **independent booleans**. Listing checks SDK before
  safe, so with both set the SDK-only listing wins. Both listings execute through the
  unrestricted loader.
- Supported limit forms are top-level `maxTurns` plus nested `runConfig.max_turns`
  and `runConfig.max_time_minutes`.
- In-process regular agents dynamically regain the `agent` tool within
  `maxSubagentDepth`; explicit `tools`/`disallowedTools` may narrow that.
- TeamManager and workflow contexts **transform** the selected tool surface: they add
  coordination or workflow tools and clear those names from denies. Workflow contexts
  additionally apply a mandatory deny floor and add `structured_output` only when the
  context requests it. The read-only teammate path replaces the surface with an
  inspection allowlist.
- `ask_user_question` is denied on **every** launch the headless agent path builds, not
  only workflow ones: that path unions the name into `disallowedTools` unconditionally,
  whatever the definition asked for. The workflow deny floor lists it as well, so any
  statement attributing the deny to workflow contexts is narrower than the runtime
  rather than false.
- Forks keep parent tool declarations model-visible for prompt-cache sharing while
  restricting what is executable via `fork_tools`/`fork_profile`.
- The Cursor SDK route bypasses `prepareTools()`. Its custom-tool bridge iterates the
  parent registry — including `agent` — without ordinary agent-depth ALS context.
- The Cursor CLI route advertises no Qwen bridge; its native capability is opaque, and
  its auto-review option has no supported Qwen-side implementation.
- Cursor isolation uses a **tool-managed temporary directory** (`isolatedCwd`),
  created and removed by the tool at completion.
- Cursor SDK and CLI dispatch run in the background **only** on an explicit
  `run_in_background: true`; they do not inherit the ordinary top-level
  default-background behavior.
- Dirty-parent detection and the "resolved cwd already inside `.qwen/worktrees`"
  predicate run on the **ordinary in-process isolation branch only**. Teammate and
  Cursor requests that would reach them are rejected earlier by role, lifecycle, or
  tool-owned-isolation validation, so those routes never execute either check.
- `BackgroundTaskRegistry` tracks ordinary agents in **both** foreground and
  background execution; `list_agents` filters its output by `isBackgrounded`.
- Team routing returns before ordinary foreground/background resolution.
- `LoopDetectionService` derives duplicates from tool name plus canonicalized
  arguments **before** the tool executes, across always-on consecutive detection,
  heuristic global duplicate and action-stagnation detection, and adaptive/explicit/
  hard caps, with separate main-loop and subagent integrations and a reduced ACP path.

### Confirmed defects

1. **Advertisement/execution divergence.** Safe and SDK listings can execute local
   definitions they never advertised.
2. **Silently ignored limits.** Top-level `max_turns` and `timeout_mins` are dropped
   with no surfaced diagnostic.
3. **Malformed tools fail open.** A `tools` array of only non-string entries passes
   the `Array.isArray` check and then loses every entry to the string filter, so it
   reaches runtime-config conversion as `[]` — **not** `undefined`. An empty array is
   truthy, so the `['*']` arm _inside_ that conversion is unreachable on this path.
   It makes no difference to the outcome: the empty list reaches `prepareTools()`,
   whose inherit test is satisfied by an empty tool list exactly as it is by `['*']`,
   so the agent inherits every registry declaration **except the subagent exclusion
   set** (the AgentTool being re-admitted when nesting depth permits), and
   `disallowedTools` is subtracted afterwards. The fail-open is a genuinely inherited surface, and an
   all-non-string `tools` array behaves exactly like an explicit `tools: []` — under
   an empty _and_ under a non-empty sibling `disallowedTools`. Neither input is
   deny-all today. See _Frontmatter, model, and limits_ for the four-link chain.
4. **Grade outcome invisible.** Fixed non-built-in models shadow Agent-tool grades;
   Cursor built-ins accept a grade while dispatch executes
   `externalInvocation.cursorModel`.
5. **`name` bypasses lifecycle validation.** `working_dir + background` is rejected
   only when `name` is absent; a `name` with no active team can be ignored, after
   which Cursor background dispatch honors the otherwise-illegal combination.
6. **Execute-time failures lack an envelope.** Dirty-parent, cwd-inside-worktree, and
   missing-definition failures return a failed display with no `ToolResult.error`;
   telemetry records success. For **invalid-worktree the defect is in-process only**:
   the ordinary isolation branch routes its failure through a shared helper that
   omits `error`, while the Cursor branch sets `error: { message }` on the same
   resolution failure and the teammate branch sets it through the spawn-blocked
   result builder. A test written against a route-general claim would fail on two of
   the three routes.
7. **`run_in_background: false` ignored for named teammates** (#9430).
8. **`list_agents` ambiguity** (#9431): empty ordinary-subagent roster while named
   teammates were active, with no prose stating the planes are disjoint.
9. **Coordination prose contradicts runtime.** The **normal** and
   **plan-mode-required** addenda say a final answer ends the turn, then instruct
   repeated `task_list`. Read-only teammates are excluded from runtime auto-claim
   while the coordinate skill says tasks are auto-assigned.
10. **Loop detection terminates a stateful read** (#9450).

### Source-backed design gaps

- **Peer discovery.** The teammate addendum requires collaboration but ships no roster
  and no discovery path; the leader-only `team_create` prose that documents the team
  config file never reaches teammates. A live teammate reportedly stated it did not
  know a peer's agent name; **that sentence was not independently persisted**, so this
  is a design gap and likely tool-prose defect, not a confirmed routing failure.
- **Rejected definitions are unreachable.** A definition rejected at load never becomes
  a `SubagentConfig`, so `/agents manage` and AgentTool advertisement cannot report it.
- **No leader-visible team health.** Tracked as #9449, a separate downstream feature.

### Design decisions

- **D1.** One unnormalized `DefinitionInventory` of per-source buckets serves every
  consumer. Canonical ordering, folding, and dedup are a later policy change.
- **D2.** The success projection is route-discriminated and, at freeze, **total**;
  produced one-way at the route boundary, built from defensive copies, and frozen.
- **D3.** Capability is projected from facts each adapter already produces.
- **D4.** One typed rejection carrier covers both phases and survives every hop; its
  category is a pure function of its code, never a stored field.
- **D5.** Named teammates are inherently concurrent; `run_in_background: false` is
  rejected, never ignored.
- **D6.** `BackgroundTaskRegistry` and `TeamManager` stay separate.
- **D7.** Definition diagnostics live in one atomically rebuilt snapshot, model- and
  user-visible. Debug logs are not a contract surface.
- **D8.** Malformed capability frontmatter rejects the whole definition as a
  **definition diagnostic** before any route is selected — never as a launch code.

### Open product decisions

**O1** eligible definition sources for safe and SDK listings, plus the canonical
precedence/dedup rule. **O2** whether teammate task-list discovery stays the default
workflow. **O3** whether a grade on a fixed-model definition is rejected rather than
shadowed. **O4** how much external Cursor capability may be projected. **O5** the
tracked home for versioned skills and fixtures. No scope consumes any of them; each
blocks exactly the scopes named in the delivery table.

## Definition inventory: behavior-neutral by construction

```ts
interface DefinitionRecord {
  readonly rawName: string; // original spelling, unmodified, never folded
  readonly fileIdentity: string; // scope-relative, e.g. "reviewer.md"
  readonly config: SubagentConfig;
}

interface DefinitionInventory {
  readonly session: readonly DefinitionRecord[];
  readonly project: readonly DefinitionRecord[];
  readonly user: readonly DefinitionRecord[];
  readonly extension: readonly DefinitionRecord[];
  readonly builtin: readonly DefinitionRecord[];
}
```

Each bucket preserves **its own source's original order, original spelling, and
duplicates**. The inventory imposes no cross-bucket precedence, performs no case
folding, and drops nothing. It is frozen and shared immutably.

S1a centralizes **source loading only**. All five consumers — AgentTool advertisement,
AgentTool launch, TeamManager specialized teammate types, workflow contexts,
background-agent resume — receive the same raw inventory and keep their existing
behavior in a thin adapter:

| Adapter                     | Applies today's own order, filter, and dedup                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `adaptAdvertisementListing` | project → user → builtin → extension, session omitted, case-**sensitive** dedup, safe/SDK eligibility unchanged |
| `adaptLaunchResolution`     | session → project → user → extension → builtin, case-**insensitive** first match, unrestricted loader           |
| `adaptTeammateTypes`        | TeamManager's current specialized-type filter and order                                                         |
| `adaptWorkflowContext`      | workflow context builder's current selection                                                                    |
| `adaptBackgroundResume`     | resume path's current lookup                                                                                    |

Because the shared object is unnormalized, an adapter cannot inherit another adapter's
ordering or folding by accident. Adoption is byte-identical.

| `safeMode` | `sdkMode` | Lists today                                     | Executes today |
| ---------- | --------- | ----------------------------------------------- | -------------- |
| false      | false     | project, user, built-in, extension (no session) | all sources    |
| true       | false     | built-in only                                   | all sources    |
| false      | true      | session only                                    | all sources    |
| true       | true      | session only (SDK checked first)                | all sources    |

- **S1a (behavior-neutral).** Extract the inventory; adapt all five consumers. Gated
  by G0: raw bucket equality plus byte-identical adapter output, including case-only
  collisions (`Reviewer` vs `reviewer`) and builtin/extension name collisions.
- **S1b (policy, blocked by O1).** Canonical precedence, case folding, first-win
  dedup, and advertised/executable parity land here and nowhere else. Until O1
  resolves, **no artifact names a canonical winner** and no projection field claims
  one. Divergence does not become impossible when the inventory lands.

## The success projection

```ts
type LaunchRouteKind =
  | 'in-process'
  | 'fork'
  | 'teammate'
  | 'workflow'
  | 'cursor-sdk'
  | 'cursor-cli';

interface LaunchCommon {
  readonly version: 1; // added by S_v1 only
  readonly lifecycle: ResolvedLifecycle;
  readonly workspace: ResolvedWorkspace;
  readonly enforcement: ResolvedEnforcement;
  readonly model: ResolvedModel;
  readonly limits: ResolvedLimits;
}

type ResolvedAgentLaunchV1 =
  | (LaunchCommon & {
      readonly route: 'in-process';
      readonly definition: DefinitionFacts;
      readonly depth: number;
      readonly maxDepth: number;
      readonly capability: InProcessCapability;
    })
  | (LaunchCommon & {
      readonly route: 'fork';
      readonly definition: null;
      readonly inheritedTurns: number | 'all';
      readonly capability: ForkCapability;
    })
  | (LaunchCommon & {
      readonly route: 'teammate';
      readonly definition: DefinitionFacts | null;
      readonly readOnly: boolean;
      readonly planModeRequired: boolean;
      readonly capability: TeammateCapability;
    })
  | (LaunchCommon & {
      readonly route: 'workflow';
      readonly definition: DefinitionFacts | null;
      readonly capability: WorkflowCapability;
    })
  | (LaunchCommon & {
      readonly route: 'cursor-sdk';
      readonly definition: DefinitionFacts;
      readonly capability: CursorSdkCapability;
    })
  | (LaunchCommon & {
      readonly route: 'cursor-cli';
      readonly definition: DefinitionFacts;
      readonly capability: CursorCliCapability;
    });

interface DefinitionFacts {
  readonly requestedName: string;
  readonly resolvedName: string; // rawName of the record the executing resolver matched
  readonly matchedCaseInsensitively: boolean;
  readonly source: 'session' | 'project' | 'user' | 'extension' | 'builtin';
  readonly listing: {
    readonly safeMode: boolean;
    readonly sdkMode: boolean;
    readonly listedByAdvertisement: boolean;
  };
}
```

`resolvedName` is the observed match of today's execution resolver. It is deliberately
**not** a canonical name: naming a canonical winner requires O1 and is an S1b concern.

**This is the final, frozen V1 target shape, not the first thing implemented.**
Delivery is split so no gate claims more than it proves:

- **S_projection** builds and emits **private, unversioned route fragments** — one per
  route, each added only after that route's facts exist in a landed fact scope. No
  `version` field, no export, no published name. Gate G12.
- **S_cursor** finalizes Cursor capability depth under O4. Until then the private
  Cursor fragments carry only observed bridged Qwen tool names and an opaque-native
  marker. Gate G13.
- **S_v1** is the only scope that adds `version: 1`, exports `ResolvedAgentLaunchV1`,
  and freezes public compatibility. Gate G14.

Gates G0 through G11 assert route behavior and must not imply that any projection
exists. The projection is one-way in either state.

```ts
interface ResolvedLifecycle {
  readonly execution: 'foreground' | 'background-registry' | 'team-concurrent';
  readonly requestedBackground: boolean | 'unset';
  readonly resolvedBy:
    | 'route-default'
    | 'explicit-request'
    | 'implicit-downgrade';
  readonly registryTracked: boolean;
  readonly listedByListAgents: boolean;
  readonly nested: boolean;
  readonly headless: boolean;
}

interface ResolvedWorkspace {
  readonly kind:
    | 'inherited-cwd'
    | 'tool-managed-worktree'
    | 'tool-managed-temp-dir'
    | 'caller-owned-worktree';
  readonly cleanupOwner: 'tool' | 'caller' | 'none';
  readonly cleanupTiming: 'at-completion' | 'if-unchanged' | 'never';
  readonly removalRequiresShutdown: boolean;
}

interface ResolvedModel {
  readonly effective: string;
  readonly requestedGrade?: string;
  readonly gradeOutcome: 'applied' | 'shadowed' | 'not-requested';
  readonly shadowedBy?: 'definition-fixed-model' | 'cursor-external-invocation';
}

interface ResolvedLimits {
  readonly maxTurns?: number;
  readonly maxTimeMinutes?: number;
}

interface ResolvedEnforcement {
  readonly individualToolCallsQwenGated: boolean; // false only inside a native loop
  readonly qwenEnforcedRegardless: readonly (
    | 'launch-decision'
    | 'workspace-boundary'
    | 'launch-limits'
    | 'transport-compatibility'
    | 'bridged-qwen-tool-wrappers'
  )[];
}
```

`ResolvedLimits` carries **effective values only**. Unsupported keys such as
`max_turns` and `timeout_mins` are a load-time definition diagnostic, not a launch
field; a successful launch never restates them.

`tool-managed-temp-dir` is the Cursor `isolatedCwd` case: `cleanupOwner: 'tool'`,
`cleanupTiming: 'at-completion'`. `tool-managed-worktree` keeps
`cleanupTiming: 'if-unchanged'`. Caller-owned worktrees are never created or removed
by the tool and set `removalRequiresShutdown: true` when a named teammate is pinned.

**No generic warning bag.** Presentation warnings are derived at render time from
exactly one owner each: the diagnostics snapshot, `model.gradeOutcome`, or
`definition.listing`.

**Immutability is concrete.** Every field is `readonly`; every array and nested object
is a defensive copy, never an alias; the whole graph is deep-frozen at the boundary.

## Capability as observed facts

```ts
interface InProcessCapability {
  readonly declaredAllow: readonly string[] | 'inherit';
  readonly declaredDeny: readonly string[];
  readonly preparedToolNames: readonly string[];
}
interface ForkCapability {
  readonly visibleToolNames: readonly string[];
  readonly executableToolNames: readonly string[];
}
interface TeammateCapability {
  readonly baseToolNames: readonly string[] | 'inherit';
  readonly coordinationToolsAdded: readonly string[];
  readonly coordinationNamesClearedFromDeny: readonly string[];
  readonly readOnlySurface: readonly string[] | null;
}
interface WorkflowCapability {
  readonly definitionAllow: readonly string[] | 'inherit';
  readonly definitionDeny: readonly string[];
  readonly mandatoryDenyFloor: readonly string[];
  readonly structuredOutputAdded: boolean;
  readonly askUserQuestionDenyAdded: boolean;
  readonly effectivePreparedToolNames: readonly string[] | null;
}
interface CursorSdkCapability {
  readonly bridgedQwenToolNames: readonly string[];
}
interface CursorCliCapability {
  readonly nativeCapability: 'opaque';
}
```

Route invariants stay in prose: the Cursor SDK route does not run `prepareTools()`,
and the Cursor CLI route advertises no bridge. Both Cursor shapes are provisional
until S_cursor closes O4. `individualToolCallsQwenGated` is `false` only for calls
inside an external agent's native loop; Qwen still enforces the launch decision, the
workspace boundary, launch limits, transport compatibility, and every bridged Qwen
tool wrapper.

## Frontmatter, model, and limits

| Input                                     | Current                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Contract                                                                                        |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `tools` omitted                           | inherit (`['*']`)                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Unchanged                                                                                       |
| `tools: []`                               | **Inherit-all, whichever sibling `disallowedTools` accompanies it.** Empty or absent → the tool-config gate is false and the conversion returns no `ToolConfig`, but the headless launch path then materializes `tools: ['*']`. Non-empty → the gate is true and the `[]` survives conversion, and `prepareTools()` treats an empty list exactly as it treats `['*']`. Both arms inherit the registry surface minus the subagent exclusion set, minus the denies (fail-open). | Explicit deny-all in both cases — **behavior change** (see below)                               |
| `disallowedTools: []`                     | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Explicit "no denies"; not a malformation                                                        |
| `tools`/`disallowedTools` not an array    | only a **string** is coerced (comma-split into an array); every other non-array type becomes `undefined`, i.e. inherit                                                                                                                                                                                                                                                                                                                                                        | Definition rejected; `malformed-capability-frontmatter` diagnostic                              |
| Any non-string entry (incl. mixed arrays) | non-strings dropped; an **all**-non-string array becomes `[]` and from there follows the `tools: []` row exactly — inherit-all under either sibling `disallowedTools`                                                                                                                                                                                                                                                                                                         | Definition rejected; same diagnostic                                                            |
| Fixed non-built-in model + grade          | silently shadowed                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `gradeOutcome: 'shadowed'`, `shadowedBy: 'definition-fixed-model'` (O3)                         |
| `model: inherit` + grade                  | accepted                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `gradeOutcome: 'applied'`                                                                       |
| Cursor built-in + grade                   | grade unused                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `effective` = `externalInvocation.cursorModel`, `shadowedBy: 'cursor-external-invocation'` (O3) |
| `max_turns` / `timeout_mins`              | dropped silently                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `unsupported-limit-key` diagnostic naming the replacement                                       |

**`tools: []` deny-all is a behavior change against all four current cases.** Today an
author who writes `tools: []` gets the _opposite_ of what they wrote no matter what sits
beside it. The two inputs that reach `[]` — an explicit empty array, and an
all-non-string array reduced to one by the string filter that runs at frontmatter-parse
time, well before the config-building gate — are indistinguishable from that point on.
The chain is four links, and the outcome is the same at the end of each branch:

1. The config-building gate in runtime-config conversion requires a non-empty `tools`
   **or** a non-empty `disallowedTools`. With an empty-or-absent `disallowedTools`
   beside `tools: []`, the gate is false and **no `ToolConfig` is returned**.
2. When the gate _is_ open, the tool list is `config.tools ? transform(config.tools) :
['*']`. An empty array is truthy, so the first arm is selected and transforming `[]`
   yields `[]`. The empty list survives conversion.
3. The headless launch path then builds a `ToolConfig` **unconditionally**, as
   `tools: configuredToolConfig?.tools ?? ['*']`. A returned `{ tools: [] }` is not
   nullish and survives intact; a returned `undefined` **does** materialize `['*']`
   right here.
4. `prepareTools()` inherits when the list contains `'*'` **or** is empty of both
   strings and inline declarations. `['*']` satisfies the first disjunct and `[]`
   satisfies the second, so both push the registry declarations — filtered, as they
   are pushed, through the subagent exclusion set, with the AgentTool re-admitted when
   nesting depth permits. `disallowedTools` is subtracted afterwards.

So **all four cases — explicit `tools: []` and all-non-string `tools`, each beside an
empty and beside a non-empty `disallowedTools` — converge on the same inherited
surface: the registry minus the subagent exclusion set, minus the denies.**
None of the four is deny-all today. Three in-tree statements corroborate the same
conclusion: the `prepareTools()` docstring ("If no explicit toolConfig or it contains
`"*"` or is empty, inherits all tools"); the definition-loader warning that an empty
tools array means the "subagent will inherit all available tools"; and the workflow
orchestrator's comment that an undefined-or-empty `tools` "lets every registered tool
through".

**The seam matters.** Conversion returning no `ToolConfig` is _not_ the observable end
state, because the headless launch path materializes one immediately afterwards. Any
gate, test, or artifact that asserts "no `ToolConfig` was constructed" at the
`AgentCore` seam can never fire, and would be silently dead. Equally, any artifact
claiming that `tools: []` beside a non-empty `disallowedTools` is already deny-all is
describing a state the runtime does not produce.

Making `tools: []` deny-all is therefore a **behavior change requiring its own RED and
control** before implementation, delivered under S3 and gated by G2. The RED must be
written against an observable the runtime actually produces — the prepared tool set —
and must cover all four cases, because all four currently inherit. The control must show
that an omitted `tools` still inherits and that a genuinely restrictive list such as
`tools: ['read_file']` still narrows to exactly that set.

## Definition diagnostics: one atomic snapshot

```ts
interface DefinitionDiagnostic {
  readonly code:
    | 'malformed-capability-frontmatter'
    | 'unsupported-limit-key'
    | 'unparseable-frontmatter'
    | 'duplicate-name-shadowed';
  readonly severity: 'error' | 'warning';
  readonly scope: 'session' | 'project' | 'user' | 'extension' | 'builtin';
  readonly fileIdentity: string; // scope-relative name only
  readonly field?: string;
  readonly remediation: string; // sanitized
}

interface DefinitionDiagnosticsSnapshot {
  readonly generation: number;
  readonly diagnostics: readonly DefinitionDiagnostic[];
}

function getDefinitionDiagnosticsSnapshot(): DefinitionDiagnosticsSnapshot;
```

This is the **only** diagnostics API. Each definition refresh builds a complete new
snapshot off to the side, keyed uniquely by `(scope, fileIdentity, field, code)` with
**replacement semantics**, then swaps it in atomically under a new `generation`.
Nothing appends to a live snapshot, so a re-scan cannot accumulate stale duplicates,
and a reader holding a whole snapshot value cannot tear mid-render.

Ownership is exclusive. The snapshot owns unsupported-limit, malformed, unparseable,
and duplicate-shadow information; `ResolvedModel` owns grade outcome;
`DefinitionFacts.listing` owns listing facts. Presentation derives every warning from
exactly one of those owners, and none restates another.

`listSubagents` returns valid configs; the snapshot is read through the sibling API
with the same lifetime. AgentTool advertisement text and `/agents manage` consume
both, so a rejected definition is finally reachable. Error-severity diagnostics also
make the definition ineligible for advertisement and launch. Debug logs satisfy
nothing.

## Rejection carrier, end to end

```ts
type LaunchRejectionCode =
  | 'read-only-requires-named-teammate'
  | 'read-only-requires-active-team'
  | 'plan-mode-required-requires-named-teammate'
  | 'plan-mode-required-requires-active-team'
  | 'read-only-and-plan-mode-required-conflict'
  | 'teammate-spawn-from-teammate'
  | 'team-name-without-active-team'
  | 'cursor-boundary-trust-required'
  | 'fork-from-non-parent-origin'
  | 'named-teammate-with-foreground'
  | 'nested-background-rejected'
  | 'caller-working-dir-with-background'
  | 'max-subagent-depth-exceeded'
  | 'fork-origin-spawn-rejected'
  | 'nested-fork-rejected'
  | 'cursor-tool-owned-isolation-rejected'
  | 'dirty-parent-isolation'
  | 'invalid-linked-worktree'
  | 'cwd-inside-tool-managed-worktree'
  | 'named-teammate-isolation-rejected'
  | 'workflow-worktree-provisioning-failed'
  | 'agent-definition-not-found'
  | 'named-teammate-model-override-rejected'
  | 'cursor-cli-capability-unsupported'
  | 'cursor-cli-auto-review-unsupported'
  | 'fork-option-on-non-fork-route'
  | 'fork-tools-and-profile-conflict'
  | 'cursor-api-key-missing'
  | 'cursor-cli-transport-unavailable';

type LaunchRejectionCategory =
  | 'role'
  | 'lifecycle'
  | 'workspace'
  | 'depth'
  | 'definition'
  | 'capability'
  | 'transport';

// Exhaustive, pure, total. The table below documents this function; it is not a
// second source of truth, and no carrier stores a category.
function categoryForLaunchRejectionCode(
  code: LaunchRejectionCode,
): LaunchRejectionCategory;

interface AgentLaunchRejection {
  readonly code: LaunchRejectionCode;
  readonly phase: 'validation' | 'execution';
  readonly route: LaunchRouteKind | 'unresolved';
  readonly message: string; // sanitized, structured transport
  readonly remediation?: string; // sanitized
}
```

`malformed-capability-frontmatter` is **not** a launch rejection code. It is a
`DefinitionDiagnostic` raised at load, before any route is selected, so it has no
legal route and cannot appear in the tuple table.

`cwd-inside-tool-managed-worktree` renames the former `nested-isolation` code to match
the actual path predicate. Tightening it into a genuine nested-agent-identity check
would be a behavior change requiring its own RED and control.

**Launch rejections versus runtime failures.** A code is a launch rejection only if the
condition is detectable before the route's first model request or native external run.
`cursor-cli-transport-unavailable` is a launch rejection when the transport cannot be
established at spawn, and a later runtime failure otherwise.

**Workflow-owned worktree provisioning failure — chosen boundary.** A workflow launch
requesting `isolation: 'worktree'` calls `provisionWorkflowWorktree(config)` after the
workflow route and its options are selected but **before** `createAgentHeadless`,
`subagent.execute`, and the first workflow model request. A provisioning failure is
therefore a launch rejection, not a later workflow runtime failure: it uses the launch
envelope as `workflow-worktree-provisioning-failed`, category `workspace`, phase
`execution`, route `workflow`. The boundary is exact — failures arising after
`subagent.execute` begins remain **workflow runtime failures outside this launch
taxonomy**, surfaced through the ordinary workflow error path with no
`LaunchRejectionCode`.

### Legal `(code, phase, route)` tuples

This table has **26 rows**, one per code, and no cross-product is ever manufactured or
tested. The `Category` column is the documented output of
`categoryForLaunchRejectionCode`. The union declares 29 codes: the three that carry no
tuple row are specified, not yet raised, and are enumerated in _Contract-only codes_
below.

**`Route(s)` is a reachability set, not a per-instance value.** A row lists every route
from which its code can be raised. A single emitted carrier always reports exactly one
`route`, and `unresolved` is itself a legal value of that field — not a placeholder for
a set. Rows and tuples are therefore different counts: expanding each row across its
route set yields **32 distinct `(code, phase, route)` triples** from these 26 rows.
Wherever this document says "tuple" it means one such triple, and wherever it says
"row" it means one code's line in this table. Any assertion that enumerates tuples must
be written against the 32, and any assertion that enumerates codes against the 26.

**Phase is derived, not asserted.** `phase` is `validation` if and only if the rejection
is returned by `validateToolParams`; every other rejection is `execution`. The rule is
mechanical and admits no per-code judgment. It is a statement about where a check _lives_,
not about where it _could_ live — several execution-phase conditions are decidable from
the parameters plus ambient caller context and are simply not checked during validation
today. If one later moves into validation, its phase moves with it, and the row is edited
rather than argued about. A `†` in the Phase column marks a condition checked in **both**
phases; the column records the earliest gate, and the backstop is specified in _The
dual-gate marker_ below.

**Pre-resolution carrier rule.** Not every code carries a resolved route. A rejection
raised before its launch's route is selected sets `route: 'unresolved'` — that is the
only truthful value available at that instant, and it is why `LaunchRouteKind` is
widened with `'unresolved'` in the carrier. A consumer must therefore never infer a
route from a code, and a test must never assert a resolved route on a pre-resolution
row. Widening such a row into an enumeration of every route the request _might_ still
have resolved to is prohibited: it states a fact the runtime has not computed.

| Code                                         | Category   | Phase        | Route(s)                                     |
| -------------------------------------------- | ---------- | ------------ | -------------------------------------------- |
| `read-only-requires-named-teammate`          | role       | validation   | unresolved                                   |
| `read-only-requires-active-team`             | role       | validation   | unresolved                                   |
| `plan-mode-required-requires-named-teammate` | role       | validation   | unresolved                                   |
| `plan-mode-required-requires-active-team`    | role       | validation   | unresolved                                   |
| `read-only-and-plan-mode-required-conflict`  | role       | validation   | unresolved                                   |
| `named-teammate-model-override-rejected`     | capability | validation † | teammate                                     |
| `named-teammate-isolation-rejected`          | workspace  | validation † | teammate                                     |
| `caller-working-dir-with-background`         | lifecycle  | validation † | unresolved                                   |
| `fork-option-on-non-fork-route`              | capability | validation   | unresolved                                   |
| `fork-tools-and-profile-conflict`            | capability | validation   | fork                                         |
| `cursor-tool-owned-isolation-rejected`       | workspace  | validation   | cursor-sdk, cursor-cli                       |
| `max-subagent-depth-exceeded`                | depth      | execution    | unresolved                                   |
| `teammate-spawn-from-teammate`               | role       | execution    | unresolved                                   |
| `fork-origin-spawn-rejected`                 | role       | execution    | unresolved                                   |
| `nested-fork-rejected`                       | depth      | execution    | fork                                         |
| `nested-background-rejected`                 | lifecycle  | execution    | unresolved                                   |
| `cursor-boundary-trust-required`             | role       | execution    | cursor-sdk, cursor-cli                       |
| `cursor-api-key-missing`                     | transport  | execution    | cursor-sdk, cursor-cli                       |
| `cursor-cli-capability-unsupported`          | capability | execution    | cursor-cli                                   |
| `cursor-cli-auto-review-unsupported`         | capability | execution    | cursor-cli                                   |
| `agent-definition-not-found`                 | definition | execution    | unresolved                                   |
| `dirty-parent-isolation`                     | workspace  | execution    | in-process                                   |
| `cwd-inside-tool-managed-worktree`           | workspace  | execution    | in-process                                   |
| `invalid-linked-worktree`                    | workspace  | execution    | in-process, teammate, cursor-sdk, cursor-cli |
| `workflow-worktree-provisioning-failed`      | workspace  | execution    | workflow                                     |
| `cursor-cli-transport-unavailable`           | transport  | execution    | cursor-cli                                   |

Route assignments follow source reachability, not symmetry. The five role/plan-mode
conflict codes are `unresolved` because they fire before or without teammate route
resolution. The named-teammate codes — the two named-teammate `†` rows here, and
contract-only `named-teammate-with-foreground` below — carry a resolved `teammate` route
without violating the pre-resolution rule, because each one's own guard condition **is** the
teammate-route predicate: a `name`, from a non-teammate caller, in a top-level session,
with an active team manager. The route is established by the check itself, not inferred
from the code, which is exactly what the rule requires.
`dirty-parent-isolation` and `cwd-inside-tool-managed-worktree` execute only on the
ordinary in-process isolation branch, so the former teammate and Cursor rows were
unreachable and are removed. `invalid-linked-worktree` keeps every route that actually
resolves an external `working_dir`.

**The three spawn-guard codes are execution-phase and pre-resolution.**
`max-subagent-depth-exceeded`, `teammate-spawn-from-teammate`, and
`fork-origin-spawn-rejected` are the depth, teammate-origin, and fork-origin arms of the
single spawn guard the invocation consults inside `execute()`, after the role, plan-mode,
and team-routing steps and **before** worktree isolation state, definition resolution,
and Cursor route resolution. All three are decided by the shared `spawnBlockReason`
predicate, which parameter validation never calls — the reason their phase is `execution`,
not `validation` — and their route is `unresolved`: at that instant the requested
`subagent_type` has not yet been resolved to a route. The named-teammate path has already
returned by then, so `teammate` is the one route all three codes provably exclude — but
excluding one route is not the same as having resolved one, and no such row may be
rewritten as an enumeration of the routes that remain possible.

**The two nested-caller codes are execution-phase, and only one of them knows its route.**
`nested-fork-rejected` and `nested-background-rejected` both fire inside `execute()`,
immediately after the spawn guard, and neither appears in `validateToolParams`, so both
are `execution`. They part company on route.

- `nested-fork-rejected` keeps `route: 'fork'`. Fork selection is a pure function of the
  requested pseudo-type, already read from the parameters at that point, and needs no
  definition resolution; the route is genuinely known.
- `nested-background-rejected` becomes `route: 'unresolved'`, replacing the former
  `in-process, cursor-sdk, cursor-cli` enumeration. It fires one branch after the fork
  check and one branch **before** the definition is loaded, and it is the loaded
  definition's external-invocation kind that decides in-process versus cursor-sdk versus
  cursor-cli. Listing those three was exactly the prohibited widening: an enumeration of
  the routes the request might still have resolved to. Fork and teammate are excluded by
  the two branches above it, but excluding routes is not resolving one. The rule applies
  to a row this spec inherited on the same terms as one it wrote.

`fork-origin-spawn-rejected` and `nested-fork-rejected` are distinct conditions and must
not be folded into one code. `fork-origin-spawn-rejected` fires on the **caller's
origin** — a caller already executing inside a fork may spawn nothing at all, whatever it
asked for — and is `role`, the same caller-context family as
`teammate-spawn-from-teammate`. `nested-fork-rejected` fires on the **request** — a
nested caller asking for `subagent_type: 'fork'` — and stays `depth` on route `fork`.

**`fork-from-non-parent-origin` has no locatable firing site, and leaves the table.**
Two independent searches covered the shared `spawnBlockReason` predicate, every fork
branch in the AgentTool invocation, the whole of the fork-subagent module, and text
searches across `packages/`. Neither found a launch rejection that raises this
condition. The nearest candidates are resume-plane blocks in the background-agent resume
path, which reject a _resume_ rather than a launch and are therefore outside this
taxonomy. Retaining the row would have had G6 assert a tuple that no rejection can
produce — a gate that can never go RED and can never catch a regression. The code
therefore moves to _Contract-only codes_ below, recorded as specified-but-unraised. If a
firing site is later located, the row returns with its phase derived by the mechanical
rule and its route derived at that site, not restored on the strength of having once
been listed.

**Cursor rejections are not uniformly validation-phase.** Six codes in the table are
Cursor-specific: **1 validation and 5 execution.** The single validation code is
`cursor-tool-owned-isolation-rejected` — the only Cursor-related check in
`validateToolParams`, keyed on `isolation === 'worktree'` against a definition whose
external invocation is Cursor. The other five — `cursor-boundary-trust-required`,
`cursor-api-key-missing`, `cursor-cli-capability-unsupported`,
`cursor-cli-auto-review-unsupported`, and `cursor-cli-transport-unavailable` — are
absent from parameter validation entirely and are **execution-stage launch rejections
raised before the first native or model run**. This spec deliberately does not pin them
to a finer position than that, and no artifact may claim a specific firing line for
them. Each keeps its resolved Cursor route: all five are Cursor-specific conditions, so
the route is necessarily known wherever they fire. Three of the five are narrower still
— the `cursor-cli-*` codes are conditions of the CLI transport alone, which is why their
route cells carry `cursor-cli` and not the SDK.

Two category assignments are non-obvious and fixed here.
`cursor-boundary-trust-required` is `role`, not `transport`: it is the operator-consent
gate on who may cross the boundary, and fires before any transport is attempted.
`named-teammate-model-override-rejected` is `capability`, not `role`: it rejects a
requested capability of the teammate configuration, while
`named-teammate-isolation-rejected` is `workspace` because it rejects a workspace
request.

**The last two multi-route validation rows are now `unresolved`.** Parameter validation
performs exactly one definition lookup — the `availableSubagents` search behind
`cursor-tool-owned-isolation-rejected` — so that row's Cursor route set is genuinely
known where it fires. The two remaining rows had no such lookup and were the last
inhabitants of the widening the pre-resolution rule prohibits. Both now carry
`unresolved`, on exactly the terms already applied to `nested-background-rejected`.

- `caller-working-dir-with-background` fires from the `working_dir` block of
  `validateToolParams`, on an explicit `run_in_background: true` with no `name`. Nothing
  at that point loads a definition, so no route is knowable. The former
  `in-process, cursor-sdk, cursor-cli` cell was also **under-inclusive**: the
  "`working_dir` requires an explicit non-`fork` `subagent_type`" rejection sits _after_
  this check, so `subagent_type: 'fork'` with `working_dir` and an explicit background
  request returns this very error — `fork` was reachable and unlisted. Simultaneously
  too wide and too narrow is what a guessed route cell looks like. Its **execution
  backstop is in-process only**, separately: the Cursor branch returns on every path it
  can take — background dispatch, foreground dispatch, and rethrow — and closes well
  before the resolved-background check, so no Cursor launch can reach that backstop.
  Teammate is excluded the same structural way, by team routing returning earlier.
  `fork` is **not**: control does reach the backstop on the fork path, and fork is kept
  out only by the validation-phase "`working_dir` requires an explicit non-`fork`
  `subagent_type`" rejection. That exclusion is therefore contingent, not structural —
  which matters here because this section's whole premise is that a validation gate can
  be bypassed or go stale. G6 should assert the backstop on the in-process route while
  treating the fork exclusion as validation-dependent rather than guaranteed.
- `fork-option-on-non-fork-route` fires from the three `fork_turns` / `fork_tools` /
  `fork_profile` guards, each of which tests only that `subagent_type` is _not_ `fork`.
  Knowing which route a request is not is not resolving the one it is. The former cell
  additionally listed `workflow`, which is unreachable: the `fork_*` options exist only
  on `AgentParams`, are rejected only in `validateToolParams`, and the workflow route never
  passes through it — the orchestrator calls the headless launch path directly.

### The dual-gate marker: `†`

Three conditions are checked **twice** — once in `validateToolParams` as the early schema
gate, and again inside `execute()` as a runtime backstop:

| Code                                     | Validation gate                                                              | Execution backstop                                                                                    |
| ---------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `named-teammate-model-override-rejected` | rejects a `model` grade on a named teammate                                  | re-rejects it in the team-routing branch                                                              |
| `named-teammate-isolation-rejected`      | rejects `isolation` on a named teammate when no `working_dir` accompanies it | re-rejects `isolation` in the team-routing branch                                                     |
| `caller-working-dir-with-background`     | rejects `working_dir` beside an explicit `run_in_background: true`           | re-rejects `working_dir` against the **resolved** background decision, after the definition is loaded |

This is the same schema-gate/runtime-backstop pairing the spec already documents for the
spawn guard, and it exists for the same reason: parameter validation can be bypassed or
can run against state that changes before execution — a team created between the two
points, for instance — so the runtime check is load-bearing rather than decorative.

The three pairs are **not equivalent to each other**, and only one of them has an
execution gate that covers an input its validation gate structurally cannot see. The
distinction is load-bearing, because it decides exactly how much protection is lost if a
backstop is deleted.

- **Stale-state backstop — `named-teammate-model-override-rejected`.** The two gates
  test the _identical_ condition: a `name`, from a non-teammate caller, in a top-level
  session, with an active team manager, alongside a `model` grade. Nothing is visible at
  execution that was invisible at validation. The only difference is temporal — a team
  created between schema build and execution, or a validation call that was bypassed
  altogether. This backstop guards against stale state, not against an unseeable input.
- **Stale-state backstop — `named-teammate-isolation-rejected`.** Likewise one effective
  condition. The validation check additionally requires `working_dir` to be absent, and
  the invocation drops `isolation` whenever `working_dir` is present, so the two
  predicates are complementary rather than one broad and one narrow. Same temporal
  rationale as the pair above.
- **Structurally unseeable input — `caller-working-dir-with-background`.** This is the
  sharpest case and the reason this section exists at all. Validation can only see an
  **explicit** `run_in_background: true` parameter. A definition carrying
  `background: true` reaches the same illegal combination without any such parameter,
  and only the resolved background decision — computed after the definition loads —
  catches it. Deleting that backstop as "redundant" would silently reopen the second
  route into the bug.

Both stale-state backstops remain load-bearing and remain `†`: a schema gate that can be
bypassed, or outrun by a team created a moment later, is not a guarantee. What a reviewer
must not do is defend either of them with the input-visibility argument, which only the
third pair actually supports.

The third pair is also why `caller-working-dir-with-background` reads `unresolved`. Its
two gates know different things about the route: at validation nothing is resolved,
while at the execution
backstop the definition is loaded and the route is necessarily in-process, the Cursor
branch having already returned. The single route cell describes the **earliest** gate,
matching the Phase column, so `unresolved` is the only truthful value it can hold. The
in-process execution backstop is not lost by that choice — G6 asserts it separately
under the `†` rule, which requires both firings of every `†` row.

**Design decision — a single-valued `phase` recording the earliest firing gate.** The
alternatives were a dual-valued phase column and a code split; both are rejected.

- A **dual value** would misdescribe every carrier ever emitted. `phase` is a fact about
  the rejection instance that actually occurred, and a launch is rejected exactly once,
  at whichever gate catches it first. No carrier can truthfully report two phases, so a
  dual-valued column would document a value the runtime cannot produce — the same class
  of error as the deny-all claim corrected above, which described a `tools: []` state
  the runtime never reaches.
- A **code split** would leak an internal gate position into the model-visible code.
  The caller's remediation is identical either way, `categoryForLaunchRejectionCode`
  would gain two indistinguishable entries, and the tuple table would carry a
  distinction no consumer can act on.

So the tuple row records the phase of the gate that fires first, marked `†`, and the
backstop is specified here instead of being squeezed into the column. **G6 asserts both
firings for a `†` row**; asserting only the validation gate would let the backstop rot
undetected, which is how a bypassed schema gate turns into a silent launch.

**This model forced a re-examination of every other row, and it found one more.** The
third pair above is not a Finding-7 inheritance; it surfaced only because "earliest firing
gate" obliges a search for a twin on both sides. `validateToolParams` was read end to end,
and every execute-side spawn-block site was enumerated, for this revision. Two closure
claims follow, at different strengths:

- **Strong.** The execution-phase spawn-guard, nested-caller, and worktree-state codes,
  **all five** execution-phase Cursor codes — including
  `cursor-cli-transport-unavailable`, which is a condition of establishing the CLI
  transport and has no counterpart anywhere in parameter validation — and
  `agent-definition-not-found` have no validation-side check at all, so their single
  execution phase is their only phase. `cursor-tool-owned-isolation-rejected`,
  `fork-option-on-non-fork-route`, and `fork-tools-and-profile-conflict` have no
  execute-side twin among the enumerated spawn-block sites.
- **Weaker.** `workflow-worktree-provisioning-failed` was not re-examined here; it sits
  on the workflow route rather than the AgentTool spawn path.

A row's absent `†` is only as trustworthy as the closure statement covering it. The two
bullets above cover every row except the five role and plan-mode validation rows, whose
closure rests on the same end-to-end read of `validateToolParams` but was not written out
per code.

Should a later change add a twin on either side of any condition, it gains a `†` and a row
in the table above — it must not silently flip phase, and a `†` row must never lose a gate
on a "redundant check" cleanup.

### Contract-only codes: specified, not yet raised

Three union members carry no tuple row. All three remain in `LaunchRejectionCode` and in
`categoryForLaunchRejectionCode`, which stays total over all 29 codes; what they lack is
a legal tuple to assert. **They are here for two different reasons, and the difference
matters to any gate that reads this section.**

The first two describe **desired behavior, not current behavior**: they are today's
confirmed defects 5 and 7 — the runtime reaches these states and continues rather than
rejecting — and both are delivered by S5 under G7, the same mechanism the spec uses for
the `tools: []` deny-all behavior change.

| Code                             | Category  | Current behavior                                                                                                  | Contract `(phase, route)` after S5                                                                                                                                                                |
| -------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `named-teammate-with-foreground` | lifecycle | `run_in_background: false` alongside a `name` is **silently ignored**; the teammate launches concurrently (#9430) | `validation`, `teammate` — decidable from the parameters plus the teammate-route predicate, exactly like its two `†` siblings, and it should acquire the same execution backstop when implemented |
| `team-name-without-active-team`  | role      | a `name` with no active team manager emits a debug log and **falls through** to spawning an ordinary agent        | `execution`, `unresolved` — the contract validates the _resolution_, after team routing, and at that instant no route has been selected                                                           |

The third is different in kind: it is a code with **no locatable firing site**, not a
known behavior the spec wants changed.

| Code                          | Category | Current status                                                                                                                                                                                                                                                                                                           | Contract `(phase, route)`                                                                                                                                         |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fork-from-non-parent-origin` | role     | No launch rejection raising this condition was found across the shared spawn-block predicate, the AgentTool fork branches, the fork-subagent module, or a text search of `packages/`. Whether the condition is unreachable, folded into `fork-origin-spawn-rejected`, or simply never implemented is **not established** | **Undetermined.** No scope owns it, and neither phase nor route may be assigned until a firing site is located or the code is deliberately deleted from the union |

No gate may assert a rejection for any of the three, and no artifact may claim one is
raised today. G6 asserts their **absence** from the legal tuple set. For the first two,
G7 owns the behavior change itself, with the lifecycle matrix rows as its RED; the third
has no owning gate beyond that absence assertion, and resolving its status — locate,
fold, or delete — is a prerequisite for any future attempt to give it a row.

### Typed carrier and every hop

```ts
class ToolParamValidationError extends Error {
  readonly details?: { readonly agentLaunch?: AgentLaunchRejection };
}
```

The carrier is additive at each hop; existing `message` strings and error `type` values
keep their current shapes so no current consumer breaks.

1. **Validation** throws `ToolParamValidationError` carrying `details.agentLaunch`.
2. **Conversion** maps it to `ToolResult.error`, preserving `message` and `type`.
3. **`ToolCallResponseInfo.error`** is extended with the same optional `details`.
4. **Scheduler** preserves `code`, `phase`, and `route` verbatim; never reconstructed
   from text.
5. **ACP** propagates the carrier as tool-call metadata and on the update event.
6. **Telemetry** emits `agent_launch_rejected` with `code`, `phase`, `route`, and
   `categoryForLaunchRejectionCode(code)` — never `message` text.
7. **JSONL / recording** serialize the carrier as a stable nested object.

**Sanitization is structural.** `message` and `remediation` carry no absolute paths, no
session identifiers, no user identities, and no raw prompts. Current UI display text
may still render a raw absolute path — existing behavior — but such text must never
enter a structured diagnostic, warning, or telemetry field.

## Route lifecycle matrix

| Route / combination                                              | Lifecycle outcome                                                                                                                                                                                                                         | Registry tracked         | Listed by `list_agents`  |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------ |
| Regular top-level agent, background unset                        | `background-registry`, `route-default`                                                                                                                                                                                                    | yes                      | yes                      |
| Regular top-level agent, `run_in_background: false`              | `foreground`, `explicit-request`                                                                                                                                                                                                          | yes                      | no                       |
| Headless fork                                                    | Detached to the background registry; completion notification                                                                                                                                                                              | yes                      | yes                      |
| Interactive fork, background unset                               | `foreground`; result returns inline                                                                                                                                                                                                       | yes                      | no                       |
| Interactive fork, `run_in_background: true`                      | `background-registry`, completion notification                                                                                                                                                                                            | yes                      | yes                      |
| Nested agent, explicit `run_in_background: true`                 | Rejected: `nested-background-rejected`                                                                                                                                                                                                    | n/a                      | n/a                      |
| Nested agent, background unset                                   | `foreground`, `implicit-downgrade`                                                                                                                                                                                                        | yes                      | no                       |
| Named teammate                                                   | `team-concurrent`                                                                                                                                                                                                                         | no                       | no                       |
| Named teammate + `run_in_background: false`                      | **Ignored today** (#9430): the flag is dropped and the teammate runs `team-concurrent`. Contract: rejected as `named-teammate-with-foreground` — **behavior change**, S5                                                                  | today no / contract n/a  | today no / contract n/a  |
| Workflow context                                                 | Inherits its host loop; no independent background registration                                                                                                                                                                            | no                       | no                       |
| Cursor SDK / CLI, background unset                               | `foreground` — **no** default-background inheritance                                                                                                                                                                                      | yes                      | no                       |
| Cursor SDK / CLI, explicit `run_in_background: true`             | `background-registry`; must not outrank a workspace or role rejection                                                                                                                                                                     | yes                      | yes                      |
| Caller-owned `working_dir` + background, no `name`               | Rejected: `caller-working-dir-with-background`                                                                                                                                                                                            | n/a                      | n/a                      |
| Caller-owned `working_dir` + background + `name`, no active team | **Escapes today**: the `name` is logged and dropped, and the launch proceeds as an ordinary background agent. Contract: validate the _resolution_, after team routing, so `team-name-without-active-team` fires — **behavior change**, S5 | today yes / contract n/a | today yes / contract n/a |
| Resolved cwd inside `.qwen/worktrees` + in-process isolation     | Rejected: `cwd-inside-tool-managed-worktree`                                                                                                                                                                                              | n/a                      | n/a                      |
| Dirty parent + in-process tool-managed isolation                 | Rejected: `dirty-parent-isolation`, phase `execution`                                                                                                                                                                                     | n/a                      | n/a                      |

Registry visibility is **total** and comes from one source fact:
`BackgroundTaskRegistry` tracks ordinary agents in both modes, and `list_agents`
filters that same registry by `isBackgrounded`. Named teammates are `no`/`no` because
they live in TeamManager; a workflow context is `no`/`no` because it runs on its own
host loop. A rejected combination never reaches lifecycle resolution, so both columns
are `n/a`. The two `today … / contract …` rows are the exception, and deliberately so:
those combinations are **not rejected today**, they launch, so a bare `n/a` would state
the contract as if it were current behavior. Both are behavior changes owned by S5 and
gated by G7, and their current-behavior halves are that gate's RED. The escaping row is
an ordering bug: team routing returns before
foreground/background resolution, so validation keyed off `name` runs against the
_request_. Validating the resolved snapshot fixes the class, not the instance.

## Two control planes

**BackgroundTaskRegistry** tracks ordinary agents in both execution modes;
`list_agents` filters by `isBackgrounded` and therefore enumerates background ordinary
subagents only. **TeamManager** owns named teammates, shared task lists, peer
messaging, and `team_shutdown`. Teammates are concurrent by construction. Automatic
final-answer forwarding is **current behavior**, not an ahistorical claim. The
TeamManager coordination protocol is unchanged by this spec.

Corrections locked here: `list_agents` prose states the planes are disjoint (#9431);
the separated `team_shutdown` discriminator stays separated (296 shutdown-shaped
teammate message failures pre-fix); blank optional filters stay normalized (409
`task_list` calls materialized blanks; 15 exact empty results correlated); the
repeated-`task_list` instruction is removed from the **normal** and
**plan-mode-required** addenda only; teammate prose gains one documented peer discovery
route.

### Pressure scenarios with call-count oracles

| Scenario                                              | Baseline RED                                                                                                                    | GREEN oracle                                                                                                | Scope |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----- |
| Named teammate with `run_in_background: false`        | Launch accepted, teammate runs concurrently                                                                                     | 0 concurrent launches; 1 rejection                                                                          | S5    |
| `list_agents` used for team status                    | ≥1 `list_agents` call while teammates active                                                                                    | 0 substitute polling calls **and** exactly 1 bounded `status unavailable; await automatic messages` outcome | S6a   |
| Repeated task polling                                 | ≥2 identical `task_list` calls with no intervening state change                                                                 | ≤1 such call per turn                                                                                       | S6b   |
| Peer discovery                                        | Handoff task without a named peer: guesses, gives up, polls, or misaddresses                                                    | 1 documented discovery read **or** 1 bounded leader clarification; 0 misaddressed calls                     | S6c   |
| Hybrid bounded reviewer, prompt only                  | Bounded read-only reviewer in the hybrid skill makes ≥1 `task_list` call or ≥1 claim call despite an authoritative direct brief | 0 `task_list` calls **and** 0 claim calls for that reviewer; it returns its final report directly           | S6d   |
| Runtime read-only addendum + coordinate-skill wording | Addendum excludes read-only teammates from auto-claim while the skill promises auto-assignment                                  | Decided together under O2; oracle written when O2 resolves                                                  | S6e   |

**S6d is prompt-only and unblocked.** Its zero/zero oracle is sound _because_ the
bounded reviewer receives an authoritative direct brief in the hybrid skill, so it has
nothing to look up and nothing to claim. It changes no runtime behavior and makes no
global "zero manual claims" promise. **S6e is the separate product change** — runtime
read-only addendum plus coordinate-skill auto-assignment wording — blocked by O2 in
full.

Because #9449 is published but not implemented, the `list_agents` GREEN oracle must not
assert a team-status query that has no implementation; it asserts absence of substitute
polling plus one bounded insufficient-observability report.

### Leader health is a separate downstream feature

#9449 remains downstream and is not designed here. One operating rule is recorded now,
because a confirmed controller incident deleted a healthy reviewer 32 seconds after it
emitted a model response: **a timer or a missing report is never terminal evidence.**
Teardown requires explicit terminal, idle, or failure lifecycle evidence, every expected
verdict, or user-authorized cancellation.

## Loop detection versus the `task_list` read

V1 covers exactly one tool — `task_list` (#9450) — and preserves every hard cap.

**Digest.** Compute a keyed digest **in-process** over the _exact privacy-sanitized
model-visible `llmContent` string that `task_list` returns_, byte for byte, including
drained teammate messages and active-team hints appended to that content. The digest is
never reconstructed from selected task fields — a subject, description, block, or
appended message edit must move it. Only the opaque digest and an equality outcome are
retained; the content itself is never copied into telemetry, logs, or journals.

**Contract.** For `task_list` only, skip the _pre-execution_, argument-only duplicate
and stagnation decisions and decide after execution, through two distinct helpers:

- `recordIdenticalQueryRepeat(queryKey, digest)` drives the **identical-query
  duplicate** counters — always-on consecutive, heuristic global duplicate, and the
  adaptive soft-cap stuck signal. A counter increments only when the canonicalized
  query key **and** the digest are both unchanged from the previous `task_list` call.
  Any digest change resets all three to zero.
- `recordActionStagnationSample(digest)` drives the **action-stagnation same-tool-name**
  counter. It increments after _any_ `task_list` call whose digest is unchanged from the
  previous `task_list` result, **regardless of arguments**, because varying filters while
  the board is provably identical is exactly the stagnation the detector exists to catch.
  A changed digest resets it to zero.

The two rules are deliberately different: the first requires argument identity, the
second ignores arguments entirely.

### Detector-by-runtime matrix

| Detector                        | Helper                         | Changed-digest behavior           | Unchanged-digest control        | Main           | Subagent       | ACP            |
| ------------------------------- | ------------------------------ | --------------------------------- | ------------------------------- | -------------- | -------------- | -------------- |
| Always-on consecutive identical | `recordIdenticalQueryRepeat`   | Does not halt                     | Still halts at threshold        | post-exec hook | post-exec hook | post-exec hook |
| Heuristic global duplicate      | `recordIdenticalQueryRepeat`   | Does not halt                     | Still halts at threshold of six | post-exec hook | post-exec hook | post-exec hook |
| Action stagnation               | `recordActionStagnationSample` | Not counted as stagnant           | Still counted, any args         | post-exec hook | post-exec hook | post-exec hook |
| Adaptive soft-cap stuck signal  | `recordIdenticalQueryRepeat`   | Signal suppressed for `task_list` | Signal still raised             | existing       | existing       | post-exec hook |
| Explicit cap                    | —                              | Unchanged — always halts          | Unchanged                       | existing       | existing       | existing       |
| Hard backstop                   | —                              | Unchanged — always halts          | Unchanged                       | existing       | existing       | existing       |

**ACP support is mandatory, not conditional.** The reduced ACP path receives the
executed tool name, canonicalized arguments, and digest through the same handoff seam
the main loop uses. No runtime silently skips the changed-state exemption. Add a stable
`LoopType` diagnostic so the next occurrence is attributable from the journal alone.

**Evidence boundary.** A reproduced teammate run contacted an inactive peer, then
repeatedly inspected another teammate's task state. Five identical
`task_list(status=in_progress, owner=…, blockedBy="")` calls are recorded; the sixth
would meet the global duplicate threshold of six. The run terminated with the generic
duplicate-tool-loop message. The leader journal does not retain the in-process
teammate's `LoopType`, so **the exact reproduced `LoopType` is explicitly unproven.**
That teammate made 93 model requests before termination: 25,684,064 cumulative input,
133,202 output, 25,309,577 cached, 121,471 thought tokens — **API-throughput counters,
not context occupancy and not billing.**

## Drift gates

Every gate is a behavior or serialization oracle; architecture-shape gates are removed.
Numbering is sequential and gap-free, G0 through G14.

| Gate                                        | Oracle                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | RED                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Adjacent control                                                                                                                                                                                                                        | Exact consumers                                                                                                             |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| G0 raw inventory + adapter parity           | Each bucket equals its loader's order/spelling/duplicates; all five adapters emit byte-identical output to pre-extraction, incl. case-only and builtin/extension collisions                                                                                                                                                                                                                                                                                                                                                                                                                   | Inventory folds case or imposes cross-bucket order, changing advertisement output                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Distinct names still resolve separately on every adapter                                                                                                                                                                                | AgentTool advertisement, AgentTool launch, TeamManager specialized types, workflow context builder, background-agent resume |
| G1 canonical parity (**S1b only**)          | Advertised set equals executable set per listing-boolean pair under the O1 rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Divergence on each of the four rows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Normal-mode launch of an existing definition unchanged                                                                                                                                                                                  | Same five consumers                                                                                                         |
| G2 frontmatter fail-closed                  | Malformed field rejects the definition; `tools: []` is deny-all **regardless of `disallowedTools`**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | All four current cases — explicit `tools: []` and an all-non-string `tools` (filtered to `[]` before the gate), each beside an empty/absent and beside a non-empty `disallowedTools` — yield a **prepared tool set equal to the registry surface minus the subagent exclusion set (with the AgentTool re-admitted when nesting depth permits), minus the denies**. The RED asserts that prepared set, which is the only observable the runtime produces here. The exclusion set is filtered out as the declarations are pushed, before `disallowedTools` is subtracted, so a RED expecting the unfiltered registry surface would fail against any realistic registry. It must **not** assert "no `ToolConfig` constructed": the headless launch path materializes one after conversion returns, so such an assertion can never fire and the gate would be silently dead | Omitted `tools` still inherits; `disallowedTools: []` still valid; an explicit narrowing list such as `tools: ['read_file']` still narrows to exactly that set; a non-empty `disallowedTools` still subtracts from an inherited surface | Definition loader, `listSubagents`, AgentTool advertisement, AgentTool launch                                               |
| G3 model grade outcome                      | `gradeOutcome`/`shadowedBy` correct on fixed-model and Cursor definitions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Cursor grade reported as applied                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `model: inherit` grade still applies                                                                                                                                                                                                    | AgentTool result text, `/agents manage`, telemetry                                                                          |
| G4 diagnostics snapshot                     | Refresh replaces the whole snapshot atomically under a new `generation`; repeated scans yield one entry per `(scope,fileIdentity,field,code)`; a rejected definition is visible in advertisement text and `/agents manage`; no absolute or private path in any field                                                                                                                                                                                                                                                                                                                          | Re-scan appends duplicates; rejected definition invisible everywhere                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Valid definitions still listed unchanged                                                                                                                                                                                                | Definition loader, `listSubagents`, diagnostics API, AgentTool advertisement, `/agents manage`                              |
| G5 rejection serialization                  | ≥1 validation-phase and ≥1 execution-phase rejection round-trip through JSONL/recording with `code`/`phase`/`route` intact                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Execute-time dirty-parent recorded as success                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Existing validation rejection keeps `message` and `type`                                                                                                                                                                                | Tool result, scheduler, JSONL writer, recording                                                                             |
| G6 rejection taxonomy                       | Each of the **26 rows** asserted against its whole route **set**, not one route per code — **32 legal `(code, phase, route)` triples** in total — and nothing else; the **three** contract-only codes assert **no** tuple; `categoryForLaunchRejectionCode` total and exhaustive over all 29 union members; every pre-resolution row carries `route: 'unresolved'`; each `†` row asserted at **both** its validation gate and its execution backstop, and `caller-working-dir-with-background`'s backstop asserted on the **in-process** route only; every carrier hop asserted including ACP | An illegal triple accepted; a multi-route row asserted at one route only (one triple per row asserts 26 of the 32, silently omitting 6); a code missing from the category function; a pre-resolution row asserting a resolved route; a `†` row asserted at only one of its two gates; a contract-only code asserted as raised today; any hop dropping `details`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Non-rejected launch emits no carrier                                                                                                                                                                                                    | Validation, execution, `ToolCallResponseInfo`, scheduler, ACP bridge, telemetry                                             |
| G7 lifecycle matrix                         | Every matrix row asserted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Named teammate + foreground accepted; `name` bypass; Cursor default-background                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Legitimate named teammate launch still succeeds                                                                                                                                                                                         | AgentTool validation, team routing, Cursor SDK dispatch, Cursor CLI dispatch                                                |
| G8 workspace ownership                      | `kind`/`cleanupOwner`/`cleanupTiming`/`removalRequiresShutdown` match actual cleanup, incl. `tool-managed-temp-dir`                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Caller worktree removed by tool; Cursor temp dir leaked                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Tool-managed no-change worktree still auto-removed                                                                                                                                                                                      | Worktree manager, Cursor isolation, teammate shutdown                                                                       |
| G9 control-plane split                      | `list_agents` never reports teammates; team tools never report subagents; foreground ordinary agents tracked but unlisted                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Ambiguous empty roster                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Registry reuse by `task_id` still works                                                                                                                                                                                                 | `list_agents`, `send_message`, team tools, docs                                                                             |
| G10 prose parity                            | Schema text, docs, and skill fixtures match runtime, with the call-count oracles above                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Each pressure-scenario baseline                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | A correct scenario stays at its current call count                                                                                                                                                                                      | Agent tool schema, team tool schemas, `docs/`, hybrid skill                                                                 |
| G11 loop detector matrix                    | Both helpers asserted per row on main, subagent, and ACP; identical-query and action-stagnation rules asserted separately, incl. changed-args/unchanged-digest                                                                                                                                                                                                                                                                                                                                                                                                                                | Stateful read halted at argument-only threshold; stagnation reset by merely varying args                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Deterministic repeat and every cap still halt                                                                                                                                                                                           | Main loop, subagent loop, ACP tool executor, `LoopDetectionService`                                                         |
| G12 success projection emission             | Exactly one immutable projection per route, emitted after that route's authoritative preparation and before its first model or native request; zero projections on any rejection; mutating a source array after emission does not mutate the snapshot; the frozen graph survives a privacy-safe serialization round trip                                                                                                                                                                                                                                                                      | A route emits none, emits twice, emits on rejection, or aliases a live array                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Each route's existing successful launch still completes unchanged                                                                                                                                                                       | All six route branches, telemetry, JSONL writer, recording                                                                  |
| G13 Cursor capability finalization (**O4**) | Projected Cursor capability equals exactly what O4 permits for SDK and CLI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Projection implies Qwen gating over the native loop                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Bridged Qwen tool wrappers still enforced                                                                                                                                                                                               | Cursor SDK bridge, Cursor CLI dispatch                                                                                      |
| G14 V1 freeze                               | `version: 1` present, `ResolvedAgentLaunchV1` exported, all six variants total with every required field — lifecycle, workspace, enforcement, model, limits, definition, capability — populated and round-tripping stably                                                                                                                                                                                                                                                                                                                                                                     | An exported V1 missing a route variant or a required field                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Private fragments from G12 keep passing unchanged                                                                                                                                                                                       | Public type export, telemetry, recording, downstream consumers                                                              |

## Delivery scopes

Characterization is **adjacent**, not omnibus: each behavior scope carries its own
characterization step immediately before its change. Each requires a true RED capture
before any production change, a passing control, the minimal GREEN change, real-medium
verification, and a fresh independent review of the revised diff.

| Scope        | Content                                                                                                                    | Gate    | Blocked by                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------- |
| S1a          | Unnormalized `DefinitionInventory`; five adapters keep existing order/filter/dedup                                         | G0      | —                                                                      |
| S1b          | Canonical precedence, folding, first-win dedup, advertised/executable parity                                               | G1      | O1                                                                     |
| S2           | Typed rejection carrier through all seven hops; legal tuple set; `categoryForLaunchRejectionCode`                          | G5, G6  | —                                                                      |
| S3           | Whole-definition fail-closed frontmatter                                                                                   | G2      | —                                                                      |
| S4           | Model grade projection; atomic diagnostics snapshot and its transport                                                      | G3, G4  | O3 (reject-instead-of-shadow only)                                     |
| S5           | Validate the resolution after team routing; lifecycle, workspace, enforcement, and capability facts; matching schema prose | G7, G8  | —                                                                      |
| S6a          | `list_agents` boundary prose                                                                                               | G9, G10 | —                                                                      |
| S6b          | Remove repeated-`task_list` instruction from normal and plan-required addenda                                              | G10     | —                                                                      |
| S6c          | Peer discovery route in teammate prose                                                                                     | G10     | —                                                                      |
| S6d          | Hybrid-skill bounded reviewer prompt only; zero `task_list`, zero claims                                                   | G10     | —                                                                      |
| S6e          | Runtime read-only addendum + coordinate-skill auto-assignment wording, decided together                                    | G10     | O2                                                                     |
| S7           | `task_list` result digest; two post-execution counters; stable `LoopType`; ACP handoff seam                                | G11     | —                                                                      |
| S8           | Versioned skills and fixtures                                                                                              | —       | O5                                                                     |
| S_projection | Private, unversioned route fragments and per-route emission; defensive copy and deep freeze; privacy-safe serialization    | G12     | S1a, S3, S4, S5 (each route fragment lands only after its facts exist) |
| S_cursor     | Finalize Cursor SDK/CLI capability projection depth                                                                        | G13     | O4                                                                     |
| S_v1         | Add `version: 1`, export `ResolvedAgentLaunchV1`, freeze public compatibility                                              | G14     | O1, O4, S1b, S_projection, S_cursor, S2–S7                             |

### V1 stability

`ResolvedAgentLaunchV1` is **private, internal, and explicitly incomplete** until S_v1.
Earlier increments carry unversioned route fragments with no `version` field and no
export, asserted through behavior and serialization oracles only. Until O4 closes
through S_cursor, the private Cursor fragments carry only observed bridged Qwen tool
names and an opaque-native marker, and cannot be frozen.

Per-finding traceability from each review round to the sections and scopes above is
maintained in the project's review ledger, not in this document.

## Evidence and publication boundary

Drawn from 52 project chat journals, 2026-07-31 through 2026-08-18, zero parse
failures. Retained: source paths, structured tool statuses, argument-presence shapes,
fixed error classes, aggregate counts. **Never retained or projected:** session
identifiers, absolute or private paths, raw prompts, raw logs, task or message bodies,
model output, user identities, concrete teammate identities, or secrets.

- Launch rejections: **45 total** across 10 observed categories — 24
  read-only-requires-named-teammate, 6 read-only-requires-active-team, 4
  nested-background, 3 Cursor tool-owned isolation, 2 caller working_dir + background,
  2 dirty-parent isolation, and 1 each invalid linked worktree, cwd inside a
  tool-managed worktree, teammate spawn from teammate, and definition not found.
- Envelope mismatch: validation failures returned error + not_started; execute-time
  failures returned success + success with no structured error.
- Team surface: 296 shutdown-shaped teammate message failures pre-fix; 409 `task_list`
  calls with materialized blank optional filters; 15 exact empty results correlated.
- Concurrency: one structured run launched two named teammates with
  `run_in_background: false`; both ran concurrently across 21 model requests
  (1,245,003 input, 8,591 output, 879,500 cached tokens).
- Loop termination: one teammate run terminated after five recorded identical stateful
  reads, the sixth meeting the threshold of six; `LoopType` unproven.
- Controller incident: a healthy reviewer emitted a model response 32 seconds before a
  fallback-driven deletion, after 55 requests (15,922,095 input, 61,675 output,
  15,425,025 cached, 53,138 thought tokens).

Every token figure above is an **API-throughput counter** — cumulative across requests.
None is context-window occupancy and none is a billing figure. Emitted counters are
labeled `api_input_tokens`, `api_output_tokens`, `api_cached_tokens`,
`api_thought_tokens` for exactly that reason.

Published upstream, in filing order:

| Issue   | Subject                                                                                |
| ------- | -------------------------------------------------------------------------------------- |
| `#9430` | named teammates silently ignore `run_in_background: false`                             |
| `#9431` | `list_agents` empty result is ambiguous while teammates are active                     |
| `#9449` | leader-visible Agent Team health status and terminal failure notifications             |
| `#9450` | `task_list` can falsely trigger duplicate tool-call loop detection as team state moves |
| `#9509` | agent launch failures are reported as successful tool calls                            |
| `#9510` | shutdown requests overload the teammate message channel and reject ordinary reports    |
| `#9514` | tool parameters document effects but not preconditions or failure modes                |
| `#9515` | auto-extracted skills cannot reach user scope                                          |

All are filed against `QwenLM/qwen-code`. `#9430` and `#9431` were resolved
upstream before this document was published; the remainder were open at the time
of writing. Each issue owns one class — this document deliberately does not
restate their contents, and none of them depends on this document to be
actionable.

## Open product decisions

1. **O1** — eligible definition sources for the safe and SDK listing booleans,
   including the both-true combination, plus the canonical precedence and dedup rule.
   Blocks S1b and, through it, S_v1. S1a is unaffected.
2. **O2** — whether teammate task-list discovery is required, optional bookkeeping, or
   replaced by authoritative initial briefs. Blocks S6e entirely; S6d is prompt-only
   and unblocked.
3. **O3** — whether a model grade on a fixed-model or Cursor definition is rejected
   rather than shadowed. Blocks that part of S4.
4. **O4** — how much external Cursor capability may be projected without implying Qwen
   enforcement over its native loop. Blocks S_cursor and, through it, S_v1.
5. **O5** — the tracked home for versioned orchestration skills and contract fixtures.
   Blocks S8.
