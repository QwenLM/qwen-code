# Daemon Skill batch toggle

## Problem

Remote Skill managers need both single and batch mutations to behave like
workspace settings writes. A runtime Skill snapshot is not an ownership source
for `skills.disabled` or `skills.enabled`: entries may be declared before
installation and may intentionally outlive the currently loaded catalog.

## API

Add collection-level mutation routes:

- `POST /workspace/skills/enable`
- `POST /workspaces/:workspace/skills/enable`

The request body is:

```json
{
  "skillNames": ["review", "deploy", "missing"],
  "enabled": false
}
```

`skillNames` is a non-empty string array with at most 100 entries. Names are
trimmed and deduplicated case-insensitively while preserving first-seen order.
The daemon does not read or validate against runtime Skill status. Every name
is persisted in one locked write, and changes are applied with one live-session
refresh. Enabling one removes a matching workspace `skills.disabled` entry and
is otherwise a no-op, except for the existing `defaultDisabled` override
behavior; disabling one writes `skills.disabled`. Unknown, non-user-invocable,
inactive-Extension, and higher-scope-disabled names use the same settings path.
Higher scopes still determine effective availability after settings merge, but
do not prevent the workspace scope from recording its own declaration.
Unexpected persistence and runtime-generation failures fail the whole request.

```json
{
  "enabled": false,
  "activation": "applied",
  "sessionsRefreshed": 2,
  "sessionsFailed": 0,
  "results": [
    {
      "skillName": "review",
      "enabled": false,
      "changed": true
    },
    {
      "skillName": "deploy",
      "enabled": false,
      "changed": true
    },
    {
      "skillName": "missing",
      "enabled": false,
      "changed": true
    }
  ],
  "errors": []
}
```

`results` preserves request order. `errors` remains present for wire
compatibility and is empty for structurally valid names.

Malformed requests still fail as a whole with HTTP 400. Workspace trust,
authentication, client identity, and generation ownership use the same gates
as the single-Skill route.

## Compatibility

Advertise `workspace_skill_batch_toggle` separately from
`workspace_skill_toggle`. Clients must pre-flight the new capability before
calling the collection route. The single-Skill route now follows the same
settings-only contract and returns the trimmed request name because there is no
catalog lookup from which to obtain a canonical spelling. The collection
routes are HTTP-only: the ACP
`_qwen/workspace/skills` dispatch surface stays read-only, matching the
single-Skill toggle.
