# External Context extension

This private Qwen Code integration connects one interactive CLI process to one
administrator-bound repository corpus. It supports Mem0 Platform V3 and a
search-only Generic HTTP contract without changing Qwen Core.

It does not provide trusted users, personal memory, per-document ACL, or
tamper-resistant audit. Use the governed Gateway/Orchestrator Profile described
in #7449 for those requirements.

Credentials inherited from Qwen are visible to other same-UID tools and
processes, and manual search queries are not a DLP boundary. Use a
repository-limited, preferably short-lived credential. If the credential or
outbound query policy must be isolated from the CLI user, use the governed
profile.

## Configure

1. Give the repository its own provider-side project, index, or credential.
   A Mem0 `app_id` is classification, not a security boundary.
2. Copy one file from `examples/`, set an absolute `repositoryRoot`, and name
   the environment variable that contains the credential.
3. Export `QWEN_EXTERNAL_CONTEXT_CONFIG` with the absolute configuration path.
4. Build the workspace and install this directory as a Qwen extension.
5. Deploy `examples/managed-settings.json` as administrator-controlled system
   settings.

Configuration and provider credentials are read once per hook or MCP process.
Restart Qwen to change repository or provider bindings.

## Generic HTTP Search V1

The adapter sends:

```http
POST /v1/context/search
Authorization: Bearer <credential>
Accept: application/json
Content-Type: application/json

{"query":"normalized query","limit":5}
```

The response is:

```json
{
  "items": [
    {
      "id": "opaque-id",
      "content": "retrieved text",
      "title": "optional title",
      "uri": "optional provenance URI",
      "score": 0.82,
      "updated_at": "2026-07-23T00:00:00Z"
    }
  ]
}
```

The endpoint or bearer credential must already be restricted to one repository
corpus. The request contains no client-selected tenant or repository filter.

## Rollout

Start with manual `context_search`. Then enable automatic recall for selected
repositories. Enable Mem0 writes last and only where shared write semantics are
acceptable. Writes are off by default and are subject to normal MCP permission
checks plus a `PreToolUse` confirmation hook.

Removing the extension rolls back the Qwen integration but does not delete
provider data.
