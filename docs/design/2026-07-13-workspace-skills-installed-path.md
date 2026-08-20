# Workspace Skill Installation Paths

Date: 2026-07-13

## Contract

Each skill returned by `GET /workspace/skills` and
`GET /workspaces/:workspace/skills` includes `installedPath`, the existing
absolute `SkillConfig.filePath` that points to its `SKILL.md` file. The value is
copied as stored; the status layer does not resolve symlinks or canonicalize it
again.

## Compatibility

This is an additive v1 field. The current daemon always emits it, while the ACP
bridge and TypeScript SDK public status types keep it optional so clients stay
compatible with older daemons. The protocol version and capability list do not
change.

## Data Flow

`SkillManager.listSkills()` supplies `SkillConfig` records. The shared
`mapSkillConfigToStatus()` function copies `filePath` to `installedPath`. Both
the live ACP snapshot and daemon-local fallback use that mapper, so project,
user, bundled, extension, inactive-extension, and disabled skills have the same
shape. The workspace status service forwards that shared result to both route
forms.

## Redaction Boundary

The status mapper remains an explicit metadata allowlist. It exposes the
installation file path but not the skill body, hooks, `skillRoot`, or any other
skill configuration. This change adds no UI behavior.
