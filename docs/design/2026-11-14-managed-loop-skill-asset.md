# Managed `/loop` skill asset

[English](2026-11-14-managed-loop-skill-asset.md) | [简体中文](2026-11-14-managed-loop-skill-asset.zh-CN.md)

Status: implemented in this change. Resolves open question 4 of the
[fixed-interval schedule design](2026-11-10-managed-loop-schedule.md) and the
shared skill touchpoint of the
[self-paced wakeup design](2026-11-10-managed-loop-wakeup.md). The two tool
slices are merged (#16835 `70a487be84`, #17088 `f3dc48c79e`, review follow-ups
#17197 `0ffaea08ba` and #17235 `9d390e23af`); the skill variant they both
deferred ships here.

## Problem statement

A Managed Session can already run the `/loop` tool surface: the Hosted profiles
declare `cron_create` / `cron_list` / `cron_delete` / `loop_wakeup` with Managed
descriptions, the internal automation routes create H6 definitions, and the
scanner fires them. But the model has no `/loop` skill to drive that surface.
The bundled `loop` skill (`packages/core/src/skills/bundled/loop/SKILL.md`)
carries **local** semantics — `durable` defaults to session-only and recurring
jobs auto-expire 7 days after creation — which are wrong for a Managed
schedule (always durable, runs until cancelled, no expiry). The Hosted skill
catalog carries no loop skill at all today
(`2026-11-10-managed-loop-wakeup.md:31-32`).

The schedule design (decision 8) says the managed variant "ships as a skill
asset through the existing Session Skills publication with the same
`allowedTools` as the bundled skill; its visibility is gated with the tools,
mirroring the local `BundledSkillLoader` rule". Investigation shows that
sentence cannot be implemented literally; this design resolves how it actually
ships.

## Current state (verified at `970e1d6ea2`)

The skill publication has two producers and one consumer; the Harness is only
a consumer.

- **Path A — creation import.** The daemon enumerates workspace skills
  including bundled (`workspace-skills-status.ts:559`,
  `skill-manager.ts:321,479-480`); the snapshot route
  (`routes/workspace-skills.ts:1025-1064`) maps each to
  `{name, description, body, model_invocable?, user_invocable?}`; WebShell
  imports the snapshot at creation
  (`WorkspaceBindingCreator.tsx:861-905`); Java admits and merges
  (`ManagedAgentService.java:532,560-562,591-594`,
  `AgentSessionAdmissions.java:236-264`) and freezes the catalog into
  `ma_request_receipt` (`JdbcManagedSessionSkills.java:190-202`); dispatch
  publishes it as the `managed-agent-skills` resource
  (`QwenHostedHarnessConnector.java:2341-2356`).
- **Path B — stored AgentDefinition skills.** A pinned definition's `skills`
  array (`QwenHostedHarnessConnector.java:2295-2337`). The built-in `qwen-code`
  agent has no stored row and carries no skills
  (`AgentSessionPolicies.java:185-196`).
- **Consumer.** `HostedSkillCatalog`
  (`hosted-skill-catalog.ts`) parses the resource bytes; the effective catalog
  is `sessionSkillsRef ?? agentDefinition.skillsRef`
  (`hosted-harness-session.ts:6354-6355`). The WebShell catalog read returns
  empty for the READ profile (`ManagedSkillCatalogService.java:25-27`).

Four facts constrain the design:

1. **The wire format has no `allowedTools`.** `SKILL_FIELDS` is
   `{name, description, body, base_directory, model_invocable, user_invocable}`
   (`AgentDefinitionExtensions.java:26`); the consumer accepts the same plus
   `asset_directory` (`hosted-skill-catalog.ts:86-160`). Frontmatter is stripped
   when the body is read (`skill-manager.ts:742-749`). The local
   `BundledSkillLoader` gate keys off frontmatter `allowedTools`
   (`BundledSkillLoader.ts:55-66`) and only governs interactive slash-command
   visibility — it cannot be mirrored on the managed wire.
2. **No skill-side gate exists today.** Skill admission consults neither the
   automation setting, the loop env gate, nor the profile (the catalog directory
   has zero `cron` references). The only profile sensitivity is the READ profile
   returning an empty catalog.
3. **The catalog is frozen at creation.** The receipt is digest-addressed and
   immutable; load refuses a changed or omitted ref
   (`hosted-harness-session.ts:6342-6354`). A variant cannot be hot-swapped into
   a live Session; its shape is fixed at creation time.
4. **No managed skill variant precedent exists.** There is no managed-specific
   skill body anywhere and no managed variant of any other bundled skill to use
   as a template. The closest precedent is the per-profile tool-description
   composition (`hosted-workspace-tool-turn.ts:920-981,2716-2742`), which covers
   tools, not skills.

The profile shapes the variant must degrade across
(`WorkspaceToolProfiles.java`, `hosted-workspace-tool-turn.ts:2488-2513`):

| Profile                        | `cron_create` | `cron_list`/`cron_delete` | `loop_wakeup` |
| ------------------------------ | ------------- | ------------------------- | ------------- |
| `hosted-workspace-shell/3`     | —             | ✓                         | ✓             |
| `hosted-workspace-files/4`     | ✓             | ✓                         | —             |
| `hosted-workspace-team-lead/2` | ✓             | ✓                         | —             |
| `hosted-workspace-shell/4`     | ✓             | ✓                         | ✓             |
| `hosted-workspace-read/1`      | —             | —                         | —             |

Two independent deployment gates sit behind the tools: the automation setting
`qwen.managed-agent.automation.enabled` (Java-side, gates `cron_create` and the
scanner, `ManagedAutomationService.java:810`) and the loop env contract
`QWEN_MANAGED_AGENT_LOOP_ENABLED` (Harness process env, gates wakeup arming,
`hosted-loop-session.ts:57-63,354`). Both are **operation gates, not declaration
gates**: the tool declarations are purely profile-driven
(`declaresCronCreate` / `declaresLoopTool` / `declaresCronTools`,
`hosted-workspace-tool-turn.ts:2488-2513`, consult no gate), and a gate refuses
the call at runtime with a typed error while leaving the declaration in place.
The loop gate is also **not visible to Java** at admission time.

## Goals

- Publish a Managed `/loop` skill variant whose body teaches the same parsing,
  interval-to-cron table, and subcommands as the bundled skill, but with Managed
  durable/expiry wording (always durable, runs until cancelled, no 7-day expiry).
- Gate the variant's visibility with the tools the Session's profile declares,
  so the body never steers the model toward a tool the admission chain refuses.
- Degrade correctly across the four creator-bearing profiles and the READ
  profile, and remain correct when only one tool slice's gate is enabled.
- Keep a single source of truth for the shared skill content so the local and
  managed bodies cannot drift apart silently.

## Non-goals

- No change to the tool surface, the scanner, the journal schema, or the fire
  pipeline (all merged).
- No new skill wire field; `allowedTools` stays a source-asset property only.
- No hot-swap of the catalog into a live Session (the receipt is immutable).
- No Web Shell scheduling UI; no change to the creation-import UX beyond the
  variant appearing in the catalog.

## Proposed solution

Inject the managed loop variant **server-side at creation admission**, selected
by the Session's tool profile, into the same merged catalog that is frozen and
published. This is the only point that knows the profile and writes the
immutable snapshot that both the Harness resource and the WebShell catalog read.

### Design decisions

**D1 — Producer: Java creation admission.** In `AgentSessionAdmissions`, after
the caller/definition skills are merged and before `creationSkills.save`, add
the managed loop variant when the profile declares at least one loop creator
(`cron_create` or `loop_wakeup`). Injection is **purely profile-driven**: the
deployment gates do not condition it, because they are operation gates that
leave the tool declaration in place (see Current state), and the skill mirrors
the declaration. The variant is a server contribution, not a caller skill: it
must be added even when the caller supplies an empty `skills` array (a
definition pinned to a creator-bearing profile). The save guard writes a row
when the effective catalog is non-empty AND there is a caller contribution or
the variant was injected; a definition-only catalog (no caller skills, no
variant) stays on the definition `skillsRef` so skill reads keep the
definition-digest conflict check, and an empty effective catalog never writes a
row. The variant is injected
**after** the request digest is computed so it does not perturb idempotency;
because the profile is a deterministic input of the same creation request, a
replay injects the identical variant and reproduces the identical snapshot.

**D2 — Visibility gated with the tools, per profile.** The variant body is
composed from section blocks so it describes only the creators the profile
declares, mirroring the tool-description principle "the declarations must never
name a tool the Session does not declare"
(`hosted-workspace-tool-turn.ts:920-931`). Concretely:

- The fixed-interval recurring section (which calls `cron_create`) is included
  only when the profile declares `cron_create` (files/4, team-lead/2, shell/4).
- The self-paced / wakeup section (which calls `loop_wakeup`) is included only
  when the profile declares `loop_wakeup` (shell/3, shell/4).
- The loop.md task-file mode is described only for the self-paced path: the
  wakeup fire resolves the `<<loop.md-dynamic>>` sentinel, while a cron fire
  neither expands a sentinel nor lets the model open the Harness-host home file
  (reads are confined to the Session working directory), so the cron body and
  the cron half of the union carry no loop.md mode.
- `cron_list` / `cron_delete` and the `list` / `clear` subcommands are always
  described where the union is declared (all four creator-bearing profiles).
- The READ profile and any profile declaring no loop creator get no variant
  (empty contribution), matching the existing READ empty-catalog rule.

Neither deployment gate changes the body. The variant describes the wakeup path
wherever the profile declares `loop_wakeup` and the fixed-interval path wherever
it declares `cron_create`, regardless of the gates; a gate refuses the
create/arming call at runtime with a typed error, exactly as the unchanged tool
declaration already allows. This keeps the skill consistent with the tool
surface rather than trying to predict a runtime operation gate (one of which,
the loop env gate, is not even visible to Java) from the control plane.

**D3 — Skill source and single source of truth.** The shared skill content lives
in the bundled `SKILL.md`. A TypeScript generator
`buildManagedLoopSkill(profile, bundledBody, frontmatterDescription)` derives the
managed skill (description + body) from it: a small documented set of wording
substitutions (the durable/expiry/UTC sentences) plus profile-conditional section
selection. Every top-level section must be classified in an allowlist — an
unknown or renamed section fails the generator until deliberately consumed or
ignored — and the Parsing interval grammar is derived from the source, so a new
section or a grammar edit cannot silently drop out of the managed bodies. Because
the two paths interleave throughout the body (Parsing, loop.md mode, and
Autonomous mode all reference both creators), the composition lives in
TypeScript, not Java string surgery. Three JSON sidecars (description + body) are
generated and committed under `packages/core/src/managed-runtime/contracts/` —
union (shell/4), cron-only (files/4, team-lead/2), and wakeup-only (shell/3) — the
directory the contracts module already copies onto the Java classpath
(`contracts/pom.xml:53-54`). A TypeScript parity test asserts each committed
sidecar equals the generator output byte-for-byte and binds the generator to the
bundled source; drift in either direction reddens the test (the "pin the consumer
from the producer" pattern). Java is a pure selector: it reads the sidecar for the
Session's profile and injects it, doing no string composition.

**D4 — Frozen, replay-safe, capacity-bounded.** The injected variant rides the
existing immutable receipt and digest; no new resource kind, no schema version
bump. The loop bodies are ~6–10 KiB, far under the 512 KiB per-body / 2 MiB
catalog limits (`AgentDefinitionExtensions.java:42-81`). Injection is
deterministic in the profile, preserving replay under the idempotency key.

**D5 — Naming and provenance.** The variant keeps the skill name `loop` so
`/loop` invocation and the `allowedTools` source property are unchanged; only the
body wording and the profile-conditional sections differ. The Web Shell imports
the bundled `loop` skill verbatim from the daemon snapshot, so a caller catalog
already contains a `loop` entry on the default creation path. `mergeInto`
therefore **replaces the bundled caller import** rather than refusing the request
— rejecting would 409 every Web Shell creation on a loop-bearing profile. The
replacement is provenance-scoped: only the entry whose body equals the committed
bundled-body reference is the server's to replace. A **user-authored** caller
`loop` (any other body) and a **definition-authored** `loop` are preserved — the
server neither replaces them nor injects a rival entry (the catalog must keep
unique names). These behaviours are pinned by admission tests (the bundled import
is replaced by the server variant; a user-authored or definition-authored `loop`
body survives on creator-less and creator-bearing profiles alike).

The injection is gated on the negotiated Session Skills capability
(`sessionSkillsSupported`, threaded through `SessionCreationCommand` like the
other capability flags): a Harness that does not advertise `session-skills/2`
gets no server row, keeping the failure at creation time rather than at dispatch.
The save guard is D1's: a row is written only for a caller contribution or the
injected variant (never a definition-only catalog, never an empty one), so an
injected row carries the definition's skills plus `loop` and never shadows the
definition catalog on the consumer side. A child catalog is re-selected before
save: the only non-null child profile is READ (a snapshot child), and the server
loop variant is dropped because it names creators READ does not declare, while a
definition-authored loop inherits unchanged. Server-variant provenance comes from
a marker recorded in the parent's snapshot when the variant was injected, not from
body text, so a variant written by an earlier build is still dropped after the
sidecars are regenerated; the definition carve-out comes from the parent's pinned
definition (does it own a `loop`). A user-authored caller loop is never deleted.
An empty resolved child catalog saves nothing rather than an empty row that every
later snapshot read would reject.

### Files affected

- `packages/core/src/managed-runtime/contracts/` — the three generated managed
  loop JSON sidecars (description + body; union / cron-only / wakeup-only) plus a
  verbatim bundled-body reference used to identify the Web Shell import, copied
  to Java.
- `packages/core/src/skills/bundled/loop/managed-loop-skill.ts` — the
  `buildManagedLoopSkill(profile, bundledBody, frontmatterDescription)` generator
  (wording substitutions + section selection); a collocated parity test binds the
  generated sidecars to `SKILL.md` and pins the shared steward prose across every
  profile (no change to `SKILL.md` itself). `regenerate-managed-loop-assets.ts` is
  the committed regeneration entry point.
- `packages/managed-agent-server/persistence/.../ManagedLoopSkill.java` — the
  pure profile-to-sidecar selector (memoized), `mergeInto` (bundled-only override
  - capability gate + capacity skip that drops the bundled import), and
    `childCatalog` (definition-provenance re-selection for children); reads the
    classpath sidecars, no string composition.
- `packages/managed-agent-server/persistence/.../AgentSessionAdmissions.java` —
  merge the pinned definition's skills (carried on `AgentPin`, parsed once in
  `resolveAgentPin`), call `mergeInto` (reusing its validated catalog), write the
  row only when the effective catalog is non-empty AND there is a caller
  contribution or the variant was injected, and re-select the inherited loop for
  a child by the parent's definition provenance before saving (an empty resolved
  child catalog saves nothing).
- `packages/managed-agent-server/contracts/.../SessionCreationCommand.java` and
  `control-plane/.../ManagedAgentService.java` — thread the
  `sessionSkillsSupported` capability flag from the negotiated Harness.
- `packages/managed-agent-server/contracts/pom.xml` — copy the generated sidecars
  onto the Java classpath.
- `packages/managed-agent-server/Dockerfile` — COPY the generated sidecars into
  the image build; a scripts test pins the COPY set against the contracts pom
  includes so a missing asset copy reddens.
- Verification: a selector unit test across every profile (including null and
  no-creator), the catalog-capacity skip, and the read-only child reselect; and
  admission tests for the empty-caller injection, the caller-imported `loop`
  override, the pinned-definition-with-skills no-shadowing case, gate-off
  behavior, replay determinism, and the creator-less strip — on H2 and real
  MySQL 8.4.

## Constraints

- The wire format cannot carry `allowedTools`; gating must live in the producer.
- The catalog is immutable post-creation; degradation is fixed at creation.
- The loop env gate is Harness-process-scoped and invisible to Java; the skill
  follows the profile's tool declaration, not the gate.
- Core infrastructure (control-plane admission, contracts, core asset) — this is
  maintainer territory and follows the two-tier gate in `AGENTS.md`.

## Risks

- **Body composition complexity.** The two paths interleave throughout the body
  (Parsing, loop.md mode, Autonomous mode), so per-profile composition is
  intricate. Mitigation: the composition lives in the TypeScript generator (D3)
  and Java only selects; the parity test pins each generated body byte-for-byte
  against the bundled source, and a mutation that drops a creator section
  reddens it.
- **Single-source drift.** Two committed bodies (local + managed) can diverge.
  Mitigation: D3's parity test derives the managed asset from the bundled source.
- **Idempotency interaction.** Injecting after the request digest must not change
  replay outcomes. Mitigation: a replay test asserts the identical snapshot.
- **Caller-imported local `loop`.** The Web Shell posts the bundled `loop`
  verbatim, so the server variant replaces it (D5); a test pins the replacement.
  Only the bundled import is replaced: a user-authored caller `loop` is preserved
  on every profile (it is the user's content, even where it names tools the
  profile lacks), and on a creator-less profile only the bundled import is
  dropped, so no server-published body names undeclared tools.
- **Catalog capacity.** The injection is skipped (not refused) when the variant
  cannot fit the published 256-entry / 2 MiB cap; the bundled caller import stays
  dropped so the creation succeeds within capacity rather than being refused.
  Tests pin the skip at 256 entries and that the admission accepts the resulting
  catalog (a catalog already over capacity without the variant is still refused).
- **Snapshot children.** A snapshot child is read-only; the server-injected loop
  variant is dropped before save because it names creators READ lacks, while a
  definition-authored loop inherits unchanged. Provenance is the marker recorded
  in the parent's snapshot when the variant was injected (a current sidecar body
  is a fallback), not body text alone, so a variant written by an earlier build is
  still dropped after sidecar regeneration. A user-authored caller loop (no server
  injection) is the user's content and is never deleted by name. The definition
  carve-out comes from the parent's pinned definition.

## Validation plan

- Admission matrix: a creator-bearing definition receives a variant whose body
  names exactly the creators that profile declares (exercised at files/4, the
  definition-selectable profile; the selector and parity tests cover shell/3,
  team-lead/2 and shell/4). READ and a no-creator profile receive no server
  variant: only the verbatim bundled `loop` import is replaced (creator-bearing)
  or dropped (creator-less); a user-authored `loop` is preserved.
- Empty-caller-skills: a definition pinned to a creator-bearing profile with no
  caller skills still receives the variant. (The built-in `qwen-code` agent
  resolves to shell/1 or files/1 and correctly receives none.)
- Gate independence: with the Session Skills capability off, no server row is
  written and the creation-time behavior is preserved.
- Replay: a re-driven creation injects the identical variant and reproduces the
  identical receipt digest.
- Parity: the TS test asserts each profile's sidecar equals the generator output
  and pins the shared steward prose, the home-only loop.md path, the absence of
  non-expanding cron sentinels, and the UTC wording; a mutation drifting any of
  these reddens it.
- Image: a scripts test pins the Dockerfile COPY set against the contracts pom
  includes so a missing asset copy reddens.
- Skill E2E (`npm run test:e2e:managed-loop-skill`, the full-stack runner's
  `--loop-skill` mode): the Session is created with a caller `loop` import whose
  body is the verbatim bundled reference, so admission's replace path runs as in
  a real creation. The attestation is bidirectional: the import's marker
  description must be gone (the server replaced it with the variant) while a
  second, non-loop probe skill's marker remains (caller skills reached
  admission), so the arm distinguishes a replace that ran from caller skills
  never arriving. A creator-bearing `files/4` definition receives the cron
  variant, the model's first streamed round carries that body in the Skill tool
  result, `cron_list` echoes the created prompt, and `cron_delete` retires the id
  the automation store minted with the delete result stating the retirement. The
  arm runs as a step of the full-tier `hosted-failover-e2e` CI job; observing a
  scheduled fire remains out of scope here and is covered by the follow-up
  [scheduled-fire observation E2E](2026-11-17-managed-loop-fire-e2e.md).

## Acceptance criteria

- A Managed Session on a creator-bearing profile has a `loop` skill in its
  published catalog whose body uses Managed durable/expiry/UTC wording, names
  only the creators the profile declares, teaches no non-expanding cron
  sentinel, and names only the `$QWEN_HOME/loop.md` file the wakeup fire reads.
- A definition pinned to a creator-bearing profile with no caller skills
  receives the variant; the built-in `qwen-code` agent (shell/1 / files/1)
  receives none.
- The READ profile and no-creator profiles publish no server loop variant, and a
  read-only snapshot child inherits none — including a variant written by an
  earlier build, dropped by the snapshot's server-provenance marker rather than by
  body text; a definition-authored `loop` entry is preserved on any profile and
  inherits to children unchanged, and a user-authored caller loop is never deleted.
- A replayed creation produces the identical catalog snapshot.
- The managed sidecar cannot drift from the bundled source without a red parity
  test.
- No new wire field, resource kind, or journal change; the server-loop provenance
  marker lives in the internal creation snapshot (a snapshot version bump), not in
  the published skill wire format.

## Open questions

Resolved during design (kept here for the record):

- **Composition locus.** A TypeScript generator derives one committed body per
  profile shape (union / cron-only / wakeup-only) and Java selects by profile;
  the parity test binds the assets to the bundled source. Refined from pure Java
  composition after finding the two paths interleave throughout the body, which
  makes Java string surgery fragile. Decided: TypeScript generation + Java
  selection.
- **Gate-off granularity.** The deployment gates are operation gates that leave
  the tool declaration in place (`hosted-workspace-tool-turn.ts:2488-2513`
  consult no gate), so the body is profile-driven and gate-independent; a gate
  refuses the call at runtime. Decided: gates do not affect the body.
- **Coexistence with a caller-imported local `loop`.** The Web Shell imports the
  bundled `loop` verbatim from the daemon snapshot, so rejecting the duplicate
  would 409 every creation on a loop-bearing profile. The server variant replaces
  only the bundled import (body equal to the committed bundled-body reference),
  carrying over its invocation flags; on a creator-less profile the bundled import
  is dropped. A user-authored caller `loop` or a definition-authored `loop` is
  preserved and suppresses the server variant — the carve-out from the
  merged-catalog duplicate rule. Decided: replace the bundled import only +
  document (refined from the initial reject proposal after the default-path 409
  was found, then scoped to the bundled import so a user-authored loop is never
  silently overwritten or deleted).
- **Cron fire mechanics.** A Managed cron fire does not expand loop sentinels
  (only the self-paced wakeup fire does), and the model cannot open the
  Harness-host home file (reads are confined to the Session working directory),
  so the cron body carries no loop.md task-file mode and no sentinel at all; the
  cron autonomous loop is a natural-language steward instruction the model
  executes each fire. Only the wakeup path uses sentinels and the loop.md file
  mode. Decided: no loop.md mode on cron (no production fire-path change).

No open questions remain for implementation.
