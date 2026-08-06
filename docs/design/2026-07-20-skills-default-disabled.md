# Overridable default-disabled skills

## Problem

`skills.disabled` is a case-insensitive union across settings scopes. That makes it a hard denylist: a project cannot enable a skill disabled by user or system settings. This is correct for policy, but it cannot represent a skill that should start off and remain available for project opt-in.

## Settings

Add two case-insensitive union lists while keeping `skills.disabled` unchanged:

| Setting                  | Meaning                                                 |
| ------------------------ | ------------------------------------------------------- |
| `skills.disabled`        | Hard disable. Always wins and preserves existing locks. |
| `skills.defaultDisabled` | Disabled unless explicitly enabled.                     |
| `skills.enabled`         | Explicit opt-in; cannot override `skills.disabled`.     |

Effective disables are `disabled + (defaultDisabled - enabled)`. An explicit `enabled` list is used instead of replacement semantics so enabling one inherited default does not replace unrelated defaults.

## Runtime and persistence

One CLI-local resolver computes the effective disabled names and whether each disabled skill is `hard` or `default`. Existing runtime consumers continue reading the effective set through `Config.getDisabledSkillNames()`; core skill discovery and execution APIs do not change.

The `/skills` picker and daemon toggle apply the same rules:

- enabling removes a workspace hard disable and adds the canonical name to workspace `skills.enabled` only when needed;
- disabling removes the workspace opt-in and adds the canonical name to workspace `skills.disabled`;
- higher-scope `skills.disabled` entries remain locked;
- unrelated and unavailable skill entries are preserved.

Workspace skill status adds a disable reason and optional lock scope so clients can distinguish a hard lock from an overridable default. The daemon-local and ACP status paths both read the same CLI-local resolver.

## Scope

- No skill is added to `defaultDisabled` by this change.
- `disable-model-invocation` and managed-skill ACP operations are unchanged.
- Existing `skills.disabled` configuration remains compatible.
- Changes are limited to settings, the two existing toggle surfaces, workspace skill status, their wire types, documentation, and focused tests.
