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

The actual corpus-isolation boundary is the provider-side credential, project,
index, or corpus. A Mem0 `app_id` or any other client-supplied filter is
classification, not authorization. The credential must be restricted to the
intended corpus and should be read-only where the provider supports that.

The extension manifest alone is not a managed binding. Qwen merges MCP servers
by name, and a settings, project, or command-line server named
`external-context` can replace the manifest contribution while retaining the
same permission-rule name. A managed deployment must therefore start Qwen with
an administrator-owned `--mcp-config` based on
`examples/managed-mcp.json`. The Phase 1 launcher must construct the complete
Qwen argument vector itself and must not pass through arbitrary caller
arguments. This command-line tier overrides user, project, workspace, and
system MCP settings. The documented permission rule is safe to deploy only
inside that pinned process.

The launcher must also construct an administrator-approved environment rather
than inherit caller-controlled values. Qwen can subsequently load values from
the repository's `.env` and `.qwen/.env` files, so the Direct Profile requires
the repository, those files, and same-UID code to be trusted. The source pin
prevents same-name MCP configuration collisions; it is not a process sandbox.
Use the governed profile when those inputs may be hostile or when credentials
and process execution must be isolated.

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
2. Copy the applicable provider configuration from `examples/` to an
   administrator-owned location outside the repository that the CLI user
   cannot modify. Configure `apiKeyEnv` or `tokenEnv` if needed, then set the
   referenced environment variable to the credential. `timeoutMs` defaults to
   5000 and may be between 1 and 30000 milliseconds.
3. Have the managed launcher set `QWEN_EXTERNAL_CONTEXT_CONFIG` to the absolute
   configuration path.
4. From the Qwen Code checkout, install dependencies and build this workspace:

   ```bash
   npm install
   npm run build --workspace @qwen-code/external-context
   ```

   Phase 1 is a private monorepo workspace. Copying the directory or its npm
   tarball without packaging its runtime dependencies is not a supported
   deployment.

5. Copy `examples/managed-mcp.json` to an administrator-owned location and
   replace every placeholder with an absolute path. The `command`, `args`, and
   `cwd` must identify an administrator-controlled Node executable, reviewed
   checkout, and dependency tree that the CLI user cannot modify. The managed
   launcher must accept no arbitrary Qwen arguments. It must construct a clean,
   administrator-approved environment, inject the provider configuration and
   credential, change to the intended repository, and invoke:

   ```bash
   qwen --mcp-config /administrator/path/external-context-mcp.json
   ```

6. Point `QWEN_CODE_SYSTEM_SETTINGS_PATH` at an administrator-controlled copy
   of `examples/managed-settings.json` only inside this managed launcher; do not
   install its automatic allow rule for unrelated Qwen sessions. It disables
   `/cd` to reduce accidental workspace/corpus mismatch and allows the pinned
   search tool. Neither setting is an authorization boundary: the provider
   credential is still the corpus boundary, and a new Qwen process is required
   to switch repositories.

For a local trusted trial, the built directory may instead be linked with
`qwen extensions link`. The extension manifest contribution and
workspace-scoped enablement are convenience mechanisms only; they do not
provide the managed MCP source binding described above.

Each MCP subprocess reads configuration and credentials once when it starts.
Qwen may restart that subprocess, so the configuration path, file contents,
and credential-to-corpus binding must remain immutable for the whole Qwen
session. Do not overwrite or reuse a configuration path for another corpus.
Changing the working directory does not change the configured corpus. The
managed settings disable Qwen's `/cd` command as an accidental-misuse guard,
but cannot prevent every same-UID action. To switch corpora, terminate the old
Qwen session and start a new one with a new managed configuration path.

Phase 1 emits no local per-request audit record. It does not write queries,
results, credentials, provider errors, or operation metadata to `stderr`.
Operators who need access records may use provider-side logs, but those are
outside this integration and are not a tamper-resistant compliance audit.

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

Enable the pinned managed MCP for one workspace, validate on-demand search
quality and provenance, and then expand to other independently configured
corpora. Removing the pinned configuration from the managed launcher rolls
back the Qwen integration; local trials can instead disable or remove the
extension. Phase 1 does not call explicit mutation or deletion APIs, but
rollback does not remove provider-side search logs or access metadata.
