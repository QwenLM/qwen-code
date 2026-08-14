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
  "skillNames": ["review", "deploy", "missing"],
  "enabled": false
}
```

`skillNames` is a non-empty string array with at most 100 entries. Names are
trimmed and deduplicated case-insensitively while preserving first-seen order.
The response is best-effort for expected target errors: installed targets are
validated against one status snapshot, all valid names are persisted in one
locked write, and changes are applied with one live-session refresh. Names
that are not installed remain valid so callers can declare their state before
installation. Enabling one removes a matching workspace `skills.disabled`
entry and is otherwise a no-op, except for the existing `defaultDisabled`
override behavior; disabling one writes `skills.disabled`. Hidden,
inactive-extension, and locked targets are returned without blocking valid
targets. Unexpected persistence and runtime-generation failures fail the whole
request.

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

`results` and `errors` each preserve request order within their own array;
the response does not reconstruct the original mixed ordering, so clients
re-match targets by `skillName`.

Malformed requests still fail as a whole with HTTP 400. Workspace trust,
authentication, client identity, and generation ownership use the same gates
as the single-Skill route.

## Compatibility

Advertise `workspace_skill_batch_toggle` separately from
`workspace_skill_toggle`. Clients must pre-flight the new capability before
calling the collection route. The existing single-Skill route and response
remain unchanged. The collection routes are HTTP-only: the ACP
`_qwen/workspace/skills` dispatch surface stays read-only, matching the
single-Skill toggle.
