# Managed `/loop` skill asset

[English](2026-11-14-managed-loop-skill-asset.md) | [简体中文](2026-11-14-managed-loop-skill-asset.zh-CN.md)

Status: proposal. Resolves open question 4 of the
[fixed-interval schedule design](2026-11-10-managed-loop-schedule.md) and the
shared skill touchpoint of the
[self-paced wakeup design](2026-11-10-managed-loop-wakeup.md). The two tool
slices are merged (#16835 `70a487be84`, #17088 `f3dc48c79e`, review follow-ups
#17197 `0ffaea08ba` and #17235 `9d390e23af`); the skill variant they both
deferred is still unimplemented.

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
- The real `/loop` model-turn E2E remains a separate validation effort.

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
must be added even when the caller supplies an empty `skills` array (the
built-in `qwen-code` case), so the `if (!skills.isEmpty())` save guard is widened
to "save when the effective catalog is non-empty". The variant is injected
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

**D3 — Body source and single source of truth.** The shared skill content lives
in the bundled `SKILL.md`. The managed variant is expressed as a small,
documented set of wording substitutions (the durable/expiry sentences) plus the
profile-conditional section blocks. The managed body asset is committed under
`packages/core/src/managed-runtime/contracts/` (the directory the contracts
module already copies onto the Java classpath, `contracts/pom.xml:53-54`), so
Java reads it as a classpath resource with no new build machinery. A TypeScript
parity test reads the bundled `SKILL.md`, applies the documented substitutions
and section selection, and asserts byte-equality with the committed managed
asset for each profile shape — drift in either direction reddens the test
(the "pin the consumer from the producer" pattern). The asset is the single
committed artifact Java publishes; the test binds it to the bundled source.

**D4 — Frozen, replay-safe, capacity-bounded.** The injected variant rides the
existing immutable receipt and digest; no new resource kind, no schema version
bump. The loop body is ~7 KiB, far under the 512 KiB per-body / 2 MiB catalog
limits (`AgentDefinitionExtensions.java:42-81`). Injection is deterministic in
the profile, preserving replay under the idempotency key.

**D5 — Naming.** The variant keeps the skill name `loop` so `/loop` invocation
and the `allowedTools` source property are unchanged; only the body wording and
the profile-conditional sections differ. A caller who imports a local `loop`
skill in the same creation conflicts on the duplicate name — the admission
already rejects duplicate names (`AgentDefinitionExtensions.java` names set);
the design treats the server variant as authoritative and documents that a
managed-bound creation should not also import the local `loop` body.

### Files affected

- `packages/core/src/managed-runtime/contracts/` — the managed loop body
  asset(s) (shared content + profile-conditional blocks), copied to Java.
- `packages/core/src/skills/bundled/loop/` — a parity test binding the managed
  asset to `SKILL.md` (no change to `SKILL.md` itself).
- `packages/managed-agent-server/persistence/.../AgentSessionAdmissions.java` —
  inject the variant by profile; widen the save guard.
- `packages/managed-agent-server/persistence/.../JdbcManagedSessionSkills.java`
  — read the classpath asset; compose the per-profile body (or a small helper).
- `packages/managed-agent-server/contracts/.../WorkspaceToolProfiles.java` —
  loop-creator predicate helpers if not already present.
- Verification: admission tests for each profile shape, the empty-caller-skills
  case, gate-off behavior, replay determinism, duplicate-name conflict, and the
  READ/no-creator empty contribution.

## Constraints

- The wire format cannot carry `allowedTools`; gating must live in the producer.
- The catalog is immutable post-creation; degradation is fixed at creation.
- The loop env gate is Harness-process-scoped and invisible to Java; the skill
  follows the profile's tool declaration, not the gate.
- Core infrastructure (control-plane admission, contracts, core asset) — this is
  maintainer territory and follows the two-tier gate in `AGENTS.md`.

## Risks

- **Body composition complexity.** Composing markdown sections per profile in
  Java is more fragile than the clause-level tool descriptions. Mitigation: the
  parity test pins each profile's composed body byte-for-byte against the
  bundled source; a mutation that drops a creator section reddens it.
- **Single-source drift.** Two committed bodies (local + managed) can diverge.
  Mitigation: D3's parity test derives the managed asset from the bundled source.
- **Idempotency interaction.** Injecting after the request digest must not change
  replay outcomes. Mitigation: a replay test asserts the identical snapshot.
- **Duplicate-name conflict** with a caller-imported local `loop`. Mitigation:
  D5 documents the server variant as authoritative; a test pins the conflict.

## Validation plan

- Admission matrix: each of shell/3, files/4, team-lead/2, shell/4 receives a
  variant whose body names exactly the creators that profile declares; READ and
  a no-creator profile receive none.
- Empty-caller-skills: a built-in `qwen-code` creation with no caller skills
  still receives the variant (the widened save guard).
- Gate independence: with either deployment gate off, the injected body is
  unchanged for the same profile (the gates are operation gates); a create or
  arming call still gets the typed runtime refusal, and the declaration remains.
- Replay: a re-driven creation injects the identical variant and reproduces the
  identical receipt digest.
- Parity: the TS test asserts each profile's managed body equals the bundled
  source under the documented substitutions; a mutation dropping a section or
  drifting the wording reddens it.
- Skill E2E (deferred to the separate E2E effort): `/loop 5m …` creates the
  definition and runs the prompt immediately; `/loop list` shows it; `/loop
clear` retires it.

## Acceptance criteria

- A Managed Session on a creator-bearing profile has a `loop` skill in its
  published catalog whose body uses Managed durable/expiry wording and names
  only the creators the profile declares.
- The built-in `qwen-code` agent with no caller skills receives the variant.
- The READ profile and no-creator profiles receive no loop skill.
- A replayed creation produces the identical catalog snapshot.
- The managed body cannot drift from the bundled source without a red parity
  test.
- No new wire field, resource kind, or journal change.

## Open questions

Resolved during design (kept here for the record):

- **Composition locus.** Compose the per-profile body in Java at admission
  (D2/D3), keeping one committed asset bound by the parity test, rather than
  pre-generating one body per profile shape at build time. Decided: Java
  composition.
- **Gate-off granularity.** The deployment gates are operation gates that leave
  the tool declaration in place (`hosted-workspace-tool-turn.ts:2488-2513`
  consult no gate), so the body is profile-driven and gate-independent; a gate
  refuses the call at runtime. Decided: gates do not affect the body.
- **Coexistence with a caller-imported local `loop`.** Reject the duplicate
  (current admission behavior) and document that a managed-bound creation should
  not also import the local `loop` body, rather than silently overriding caller
  intent. Decided: reject + document.

No open questions remain for implementation.
