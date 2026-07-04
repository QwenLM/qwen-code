# Skill Required Capabilities Design

Status: design note; this PR proceeds with Option B and leaves
`required-capabilities` as a future proposal.

## Context

Web Shell can render custom fenced code blocks through its markdown renderer. The
chart renderer proposal uses an `echarts-fulldata` fenced code block so the model
can return a complete ECharts option and dataset payload that Web Shell renders
as an interactive chart.

That output contract is only useful in clients that can render it. In the CLI,
ACP clients, or any other surface without a matching renderer, the same response
would appear as a large code block instead of a chart.

The initial bundled chart skill proposal relied on wording to tell the model
that the format is for Web Shell. This is a soft guard. If the skill is exposed
in a non-Web-Shell session, the model can still choose an output format that the
client cannot render.

For the current PR, Qwen Code keeps the renderer extension point in Web Shell
but does not bundle `qwencode-viz` in core. The Web Shell package includes a
copyable, non-auto-loaded skill template, and hosts should install or inject
that skill only when they also register an `echarts-fulldata` renderer.

## Problem

Qwen Code needs a clear way to decide whether a host-specific skill should be
shown to the model and to users.

For `qwencode-viz`, the concrete question is:

- Should core support a generic `required-capabilities` skill metadata field?
- Or should `qwencode-viz` not be a core bundled skill at all, and instead be
  supplied only by Web Shell clients that install or inject it?

## Goals

- Prevent renderer-specific skills from being exposed when the current client
  cannot satisfy their output contract.
- Keep startup skill reminders, explicit skill activation, slash-command
  discovery, and skill validation consistent.
- Avoid hardcoding `qwencode-viz` as a special case.
- Preserve existing skill behavior when no capability requirement is declared.
- Keep the design extensible for future host capabilities, not only ECharts.

## Non-goals

- Implementing the ECharts renderer itself.
- Redesigning all client/server capability negotiation.
- Changing the semantics of existing skill frontmatter.
- Solving multi-client shared-session capability changes in the first version.

## Current Related Mechanisms

The codebase already has several visibility controls, but none represent client
rendering capabilities:

- `disable-model-invocation`: prevents a skill from being auto-invoked by the
  model.
- `user-invocable`: controls whether a bundled skill is available as a command.
- `paths`: scopes skill availability to matching workspace paths.
- `skills.disabled`: disables configured skills.
- `allowedTools`: currently used by bundled skill loading to hide cron-oriented
  skills when cron tools are unavailable.
- Slash command `supportedModes`: filters commands by execution mode.
- Daemon and ACP capability objects: describe protocol or client support, but
  are not currently connected to skill exposure.

There is no existing `required-capabilities` or equivalent skill frontmatter.
Adding it would be a new skill contract.

## Option A: Add `required-capabilities`

Add a generic skill frontmatter field:

```yaml
---
name: qwencode-viz
description: Render analytical charts in Web Shell using echarts-fulldata fenced code blocks.
required-capabilities:
  - markdown.codeBlock.echarts-fulldata
---
```

When the current client/session does not advertise all listed capabilities, the
skill is treated as unavailable.

### Capability Naming

Use namespaced string capabilities:

```text
markdown.codeBlock.echarts-fulldata
```

This keeps the field generic while making the contract precise:

- `markdown`: the capability belongs to rendered markdown.
- `codeBlock`: the capability applies to fenced code block rendering.
- `echarts-fulldata`: the specific language/info string supported by the
  renderer.

Future examples could be:

- `markdown.codeBlock.vega-lite`
- `markdown.codeBlock.mermaid-interactive`
- `artifact.openUrl`

### Skill Metadata

Add `requiredCapabilities?: string[]` to skill configuration after parsing the
frontmatter key `required-capabilities`.

Both skill parsing paths should understand the field:

- `packages/core/src/skills/skill-load.ts`
- `packages/core/src/skills/skill-manager.ts`

The field should be optional. Missing or empty means the skill has no client
capability requirement.

### Runtime Capability Source

Add client/session capabilities to the runtime config:

```ts
interface ConfigParameters {
  clientCapabilitiesProvider?: () => ReadonlySet<string>;
}
```

Expose a helper on `Config`, for example:

```ts
config.getClientCapabilities(): ReadonlySet<string>
```

Then centralize the check:

```ts
function skillMeetsRequiredCapabilities(skill: Skill, config: Config): boolean {
  return skill.config.requiredCapabilities.every((capability) =>
    config.getClientCapabilities().has(capability),
  );
}
```

### Filtering Points

The capability filter should be applied before skills are exposed to either the
model or the user:

- `collectAvailableSkillEntries` in `packages/core/src/tools/skill-utils.ts`
  should skip skills whose required capabilities are missing. This keeps startup
  skill reminders, delta reminders, `SkillTool` validation, and model-invocable
  activation aligned.
- `BundledSkillLoader` should skip unavailable bundled skills when creating
  user-facing commands.
- `SkillCommandLoader` should skip unavailable file-system skills when creating
  user-facing commands.

The important invariant is that a skill hidden from the model should not still
appear as an invocable command unless the project intentionally supports a
manual override.

### Web Shell Registration

Web Shell should advertise renderer support explicitly rather than relying on
the presence of an opaque `renderCodeBlock` callback.

For example:

```tsx
<WebShell
  customization={{
    markdown: {
      renderableCodeBlockLanguages: ['echarts-fulldata'],
      renderCodeBlock(info) {
        // render custom blocks
      },
    },
  }}
/>
```

The Web Shell client can map that to:

```text
markdown.codeBlock.echarts-fulldata
```

This makes the capability declaration stable even if the renderer callback
contains custom logic, fallbacks, or multiple supported languages.

### Daemon and ACP Propagation

For hosted or daemon-based sessions, the client capability set needs to reach
core before skills are loaded or listed. A minimal version can pass capabilities
when creating a session:

```ts
interface CreateSessionRequest {
  clientCapabilities?: string[];
}
```

The daemon bridge, SDK, and ACP session creation flow can store this as
session-scoped config.

For the first version, capabilities can be session-scoped. If multiple clients
attach to the same session, the behavior should be documented as using the
capabilities from session creation time.

### Pros

- Keeps `qwencode-viz` as one canonical bundled skill.
- Prevents host-specific output contracts from leaking into unsupported
  clients.
- Creates a reusable mechanism for future renderer-specific or host-specific
  skills.
- Makes the dependency explicit and testable.

### Cons

- Adds a new cross-cutting skill metadata field.
- Requires client/session capability plumbing across Web Shell, daemon, SDK, and
  ACP surfaces.
- Needs careful documentation for shared-session behavior.
- May be more machinery than needed if `qwencode-viz` is the only expected
  capability-gated skill.

## Option B: Client-Supplied Skill

Do not add a generic `required-capabilities` field. Instead, avoid bundling
`qwencode-viz` in core. The Web Shell client, or any client that supports the
renderer, supplies the skill itself.

Possible distribution models:

- The Web Shell host installs `.qwen/skills/qwencode-viz/SKILL.md`.
- The Web Shell package ships an optional non-auto-loaded skill template that a
  host can copy or install when chart rendering is enabled.
- The Web Shell integration ships an extension skill package.
- The Web Shell integration injects equivalent model instructions only when its
  chart renderer is enabled.

In this model, the skill is available only because the rendering client chose to
provide it.

### Pros

- Minimal core change.
- No new global skill metadata contract.
- Capability availability is naturally owned by the client that implements the
  renderer.
- Avoids daemon or ACP plumbing unless the client already has a skill injection
  mechanism.

### Cons

- No canonical bundled skill unless all clients copy the same content.
- More burden on each Web Shell integrator.
- Users moving between clients may see inconsistent skill availability.
- Does not create a general safeguard for future host-specific skills.
- Harder to test in core because availability depends on external installation
  or injection.

## Recommendation

For this PR, use Option B.

That keeps the core skill system unchanged and avoids exposing
`echarts-fulldata` instructions in unsupported clients. The Web Shell renderer
hook remains useful for any host-owned block renderer, while chart-specific
model instructions become an explicit host opt-in.

Longer term, discuss this as a product/API boundary decision.

Choose Option A if maintainers expect Qwen Code to support more client-rendered
output contracts over time. In that case, `required-capabilities` is a small
general contract that keeps skill exposure honest across CLI, Web Shell, ACP,
and future clients.

Choose Option B if `qwencode-viz` is expected to remain a Web-Shell-only
extension and maintainers do not want core skills to depend on client rendering
features. In that case, the current bundled skill should be removed from core
and supplied by Web Shell clients that support `echarts-fulldata`.

The recommended future default is Option A only if maintainers are comfortable
making client/session capabilities part of the skill system. Otherwise, keep
host-renderer skills client-owned.

## Open Questions

- Should capabilities be session-scoped, request-scoped, or client-scoped?
- Should missing capabilities hide user-invocable commands, or only hide
  model-invocable skill activation?
- Should capability names be free-form strings or validated against a known
  registry?
- Should unavailable skills be hidden entirely from `/skills`, or shown as
  disabled with a reason?
- Should there be a manual override for users who intentionally want to emit raw
  `echarts-fulldata` blocks in unsupported clients?
- Should the field name be `required-capabilities`, `requires-capabilities`, or
  `client-capabilities`?

## Validation Plan

If Option A is implemented, add tests for:

- Frontmatter parsing in both skill parsing paths.
- `collectAvailableSkillEntries` hiding a skill when capabilities are missing.
- The same skill appearing when capabilities are present.
- Interaction with `paths`, `skills.disabled`, and `disable-model-invocation`.
- `BundledSkillLoader` and `SkillCommandLoader` command visibility.
- Web Shell mapping from supported code block languages to client capabilities.
- Daemon or ACP session creation preserving the capability set.
- Existing bundled skill integration tests, to ensure skills without
  `required-capabilities` are unchanged.

## Migration

Existing skills require no migration because the new field is optional.

For the current Option B path, remove the chart skill from core bundled skills.
The Web Shell package template must not be loaded by core automatically; hosts
opt in by installing or injecting it.

If Option A is accepted, add:

```yaml
required-capabilities:
  - markdown.codeBlock.echarts-fulldata
```

to a future bundled `qwencode-viz`.

If Option B is accepted, remove the chart skill from core bundled skills and
document how Web Shell clients can install or inject it when they register an
`echarts-fulldata` renderer.
