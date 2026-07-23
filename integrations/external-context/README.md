# External Context extension

This private Qwen Code integration connects one interactive CLI process to one
administrator-bound external context corpus without changing Qwen Core. Phase
1 exposes exactly one on-demand, retrieval-only MCP tool:
`context_search({ query })`.

The built-in adapters support Mem0 Platform V3 search and a small Generic HTTP
Search V1 contract for existing knowledge or RAG services. There are no hooks,
automatic recall, write tools, personal memory, trusted user identity,
per-document ACLs, or tamper-resistant audit in this phase.

Use the governed Gateway/Orchestrator Profile described in #7449 when those
controls are required.

## Trust boundary

The model can provide only the search query. Provider type, endpoint,
credential, Mem0 `app_id`, and all other corpus selectors are fixed before the
MCP server starts.

The actual isolation boundary is the provider-side credential, project, index,
or corpus. A Mem0 `app_id` or any other client-supplied filter is
classification, not authorization. The credential must be restricted to the
intended corpus and should be read-only where the provider supports that.

The extension omits MCP `readOnlyHint` because a provider search may record
access metadata or otherwise have provider-side read effects. It exposes no
explicit mutation operation, but the Qwen process still passes search queries
to an external service, so this integration is not a DLP boundary. Credentials
inherited by Qwen may also be visible to same-UID processes and tools. Use the
governed profile when the credential or outbound-query policy must be isolated
from the CLI user.

The managed-settings example allows Qwen to invoke search without per-call
confirmation. It is on-demand rather than prompt-triggered, but it is not
necessarily initiated manually by the user. In interactive non-YOLO mode,
placing the tool under `permissions.ask` requests confirmation. YOLO mode
auto-approves ordinary tools despite `ask`, and users can change approval mode
during a session. Phase 1 does not provide non-bypassable per-call
confirmation; use the governed profile when that is required.

## Configure

1. Give the repository its own provider-side project, index, or corpus and a
   credential restricted to it. Verify that the credential cannot access or
   select another corpus.
2. Copy one file from `examples/` to an administrator-owned location outside
   the repository that the CLI user cannot modify. Configure `apiKeyEnv` or
   `tokenEnv` if needed, then set the referenced environment variable to the
   credential. `timeoutMs` defaults to 5000 and may be between 1 and 30000
   milliseconds.
3. Set `QWEN_EXTERNAL_CONTEXT_CONFIG` to the absolute configuration path.
4. From the Qwen Code checkout, install dependencies, build this workspace,
   and link the built directory:

   ```bash
   npm install
   npm run build --workspace @qwen-code/external-context
   qwen extensions link /absolute/path/to/qwen-code/integrations/external-context
   qwen extensions disable external-context
   cd /absolute/path/to/repository
   qwen extensions enable external-context --scope=workspace
   ```

   Phase 1 is a private monorepo workspace. Copying the directory or its npm
   tarball without packaging its runtime dependencies is not a supported
   deployment. The explicit disable/enable sequence disables paths covered by
   the current Qwen user scope and then enables the target workspace. In the
   current CLI, that user scope is path-based under the OS user home. Verify
   `qwen extensions list` from the target and representative unrelated paths;
   explicitly disable or use a separate Qwen home for workspaces outside that
   path scope.

5. Deploy `examples/managed-settings.json` as administrator-controlled
   settings, and inject the configuration and credential only through the
   target repository's managed launcher.

Each MCP subprocess reads configuration and credentials once when it starts.
Qwen may restart that subprocess, so the configuration path, file contents,
and credential-to-corpus binding must remain immutable for the whole Qwen
session. Do not overwrite or reuse a configuration path for another corpus.
Changing the working directory does not change the configured corpus. To
switch corpora, terminate the old Qwen session and start a new one with a new
managed configuration path.

## Generic HTTP Search V1

The configured `baseUrl` must be an origin with no path, query, credentials, or
fragment. That origin receives a request at the fixed path
`/v1/context/search`:

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

The fixed endpoint and the credential's effective capabilities must together
restrict access to one corpus. A bearer credential that can access another
corpus through another endpoint or selector does not meet the Direct Profile
boundary. The request contains no client-selected tenant, repository,
namespace, or filter. HTTPS is required except for explicit loopback HTTP used
in local development.

## Mem0 Platform V3

The adapter calls `POST /v3/memories/search/` with the configured `app_id`,
`top_k: 5`, `threshold: 0.1`, and `rerank: false`. The API key's effective
Mem0 Project must already be restricted to the intended corpus; a different
`app_id` in the same broadly accessible Project does not establish isolation.
This extension does not call Mem0 add, update, or delete APIs.

Mem0 Memory Decay is opt-in and off by default. If enabled, search reinforces
returned memories, updates access history, and can affect later ranking. Keep
it disabled when search must have no semantic provider-side state change.
Provider audit or access logs may still be retained. See
[Mem0 Memory Decay](https://docs.mem0.ai/platform/features/memory-decay).

## Rollout and rollback

Enable the extension for one workspace, validate on-demand search quality and
provenance, and then expand to other independently configured corpora.
Disabling or removing the extension rolls back the Qwen integration. Phase 1
does not call explicit mutation or deletion APIs, but rollback does not remove
provider-side search logs or access metadata.
