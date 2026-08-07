# Daemon Skill batch toggle

## Problem

Remote Skill managers can toggle only one Skill per request. Closing several
Skills therefore requires client-side request orchestration and provides no
single response that records all target outcomes.

## API

Add collection-level mutation routes:

- `POST /workspace/skills/enable`
- `POST /workspaces/:workspace/skills/enable`

The request body is:

```json
{
  "skillNames": ["review", "deploy"],
  "enabled": false
}
```

`skillNames` is a non-empty string array with at most 100 entries. Names are
trimmed and deduplicated case-insensitively while preserving first-seen order.
The response is best-effort: valid targets are toggled in order, and failures
for individual targets are returned without preventing later targets from
being attempted.

```json
{
  "enabled": false,
  "results": [
    {
      "skillName": "review",
      "enabled": false,
      "changed": true,
      "activation": "applied",
      "sessionsRefreshed": 1,
      "sessionsFailed": 0
    }
  ],
  "errors": [
    {
      "skillName": "missing",
      "code": "skill_not_found",
      "error": "Skill not found: missing"
    }
  ]
}
```

Malformed requests still fail as a whole with HTTP 400. Workspace trust,
authentication, client identity, and generation ownership use the same gates
as the single-Skill route.

## Compatibility

Advertise `workspace_skill_batch_toggle` separately from
`workspace_skill_toggle`. Clients must pre-flight the new capability before
calling the collection route. The existing single-Skill route and response
remain unchanged.
