# User-scope Skill activation

[English](user-skill-activation.md) | [简体中文](user-skill-activation.zh-CN.md)

Status: implementation design. Baseline: `71119c6fa0`.

## Problem and goals

Hosts need to enable or disable one or more Skills for a user without reading,
editing, and replacing settings themselves. The daemon must serialize the
read-modify-write operation and propagate it to existing workspace sessions.

The design separates a settings-name operation from effective Skill identity.
A bare `pdf` rule can affect several Skills; changing `rust:pdf` must not
silently remove that rule. Persistence must not depend on discovering every
Skill in every workspace. Saving a preference, queuing a refresh, and observing
an effective Skill state are separate outcomes.

## Public contract

`PUT /skills/activation` is process-global and writes User settings. Its body
contains `skillNames` (1–100 non-empty names) and `state` (`enabled` or
`disabled`). Names are trimmed and deduplicated case-insensitively, preserving
the first requested spelling. Name length uses the existing Skill limit.
For `disabled`, optional `mode` is `hard` (default) or `default`; `mode` is
rejected for `enabled`. Invalid requests are rejected before any persistence.
Unknown names are permitted so a host can configure a Skill before installation.

For each explicitly requested name, move that name into exactly one User list:

| Request            | Add to                 | Remove from                             |
| ------------------ | ---------------------- | --------------------------------------- |
| enabled            | skills.enabled         | skills.disabled, skills.defaultDisabled |
| disabled / hard    | skills.disabled        | skills.enabled, skills.defaultDisabled  |
| disabled / default | skills.defaultDisabled | skills.disabled, skills.enabled         |

Other names, other spellings and other scopes are preserved. Existing target
spelling is retained for case-insensitive no-ops. An explicitly requested bare
name retains the existing settings matching semantics. System hard blocks,
other-spelling restrictions and extension activation rules still apply.

The response contains `scope: "user"`, the requested `state`, normalized `mode`
for disables, `results: [{ skillName, changed }]`, and `propagation`:
`queued` means at least one runtime has queued reconciliation, `deferred`
means changes were saved but no runtime queued it, and `not_required` means
the request changed no settings. None certifies effective enablement. Existing
workspace config/runtime queries provide effective state and readiness.

Advertise `user_skill_activation`. The TypeScript SDK exposes
`setUserSkillsActivation(skillNames, activation)`. Browser preflight permits PUT.

## Persistence and ownership

Use the existing primary settings lock. Inside it, reload durable settings,
compute all three User lists and per-name differences, check the generation
guard, and call `setValues` once for all changed keys. No-op requests write
nothing and emit no events. Different-name concurrent operations retain both
changes; same-name operations follow lock order. No catalog read or Skill
identity ordering queue is needed.

The route uses the strict mutation gate and accepts a client belonging to any
managed runtime, including a draining runtime until it is removed. Workspace
trust is not a prerequisite for a User write. A generation closing before
commit uses the existing settings route's retryable 503 response.

## Runtime propagation

After commit, invalidate configuration caches and managed runtime observations.
Broadcast ordinary `settings_changed` events for each changed key with
`scope: "user"`. Consumers already refresh their settings-backed Skill views.
Do not attach a `skill_toggle` mutation or unmeasured session counts.

The coordinator forwards an optional `includeUserSettings` boolean through
the ACP control plane to the workspace child and each Session. Omission keeps
workspace-only refresh behavior. User refresh atomically reloads Workspace and
User settings; existing merge rules still exclude untrusted Workspace settings.
A failed atomic reload is an error, never a successful session refresh.

Track requested and acknowledged User reloads separately. A refresh captures
the requested counter before awaiting the child and acknowledges only that
counter after config and session refresh both succeed. Later requests remain
pending. Ordinary workspace reconciliation cannot erase pending User work.
Cold preparation and pause recovery carry pending work; existing bounded retry
and runtime-epoch behavior govern failures. Workspace-only session-failure
semantics remain unchanged. Persistence is not rolled back by a later refresh
failure; runtime capability status exposes that failure.

Paired children acknowledge a received Skill change with the actual refresh
counts. Partial session or cache failures reach the coordinator as refresh
errors, retaining pending User work without quarantining an acknowledged
channel. An atomic settings reload failure still rejects the change.

If Managed sessions remain live while the workspace control channel is cold
or starting, propagate to those sessions without starting control solely for
this write. Keep the User reload pending until control can also acknowledge
it. Fully cold runtimes still defer to normal startup.

## Implementation boundary

Changes cover CLI settings computation, serve persistence/routes/capabilities,
the runtime coordinator, ACP forwarding and Session reload, TypeScript SDK,
and protocol documentation. Core identity, permission merging, catalog
completeness, Skill directory/level settings and Managed Agent APIs stay on
their existing contracts. There is no configuration migration.

## Validation and acceptance

Validate all three transitions, aliases, unknown names, case-insensitive
idempotence, atomic batch validation, and preservation of unrelated settings.
Concurrency probes must establish their blocking point before testing another
writer. Fault tests cover reload failure, partial session failure, newer writes
during refresh, cold/start/pause/drain transitions and bounded retry.

A test-engineer first records the global CLI baseline, then tests the built
daemon with isolated settings, multiple workspaces, existing sessions and SSE.
Verify real Skill availability and settings events, plus PUT preflight and SDK
exports. Run build, typecheck, bundle, focused tests, formatting and lint;
self-audit until two consecutive clean passes. Report untested platforms and
fault paths explicitly. No product decisions remain open.
