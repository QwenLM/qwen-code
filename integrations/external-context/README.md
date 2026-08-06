# External Context extension

This private Qwen Code integration connects one interactive CLI process to one
administrator-bound external context corpus without changing Qwen Core. It has
two mutually exclusive retrieval-only profiles:

- **On-demand:** version 1 configuration and the MCP
  `context_search({ query })` tool.
- **Auto-recall:** version 2 configuration and an administrator-installed
  `UserPromptSubmit` Hook, with no external-context MCP server.

The built-in adapters support Mem0 Platform V3 search and a small Generic HTTP
Search V1 contract for existing knowledge or RAG services. There are no write
tools, personal memory, trusted user identity, per-document ACLs, or
tamper-resistant audit.

Use the governed Gateway/Orchestrator Profile described in #7449 when those
controls are required.

## Trust boundary

In the on-demand profile, the model can provide only the search query. In the
auto-recall profile, the query is derived only from Qwen's optional
`submitted_prompt` provenance, captured before model-bound expansions.
Provider type, endpoint, credential, Mem0 `app_id`, and all other corpus
selectors are fixed before either process starts.

The actual corpus-isolation boundary is the provider-side credential, project,
index, or corpus. A Mem0 `app_id` or any other client-supplied filter is
classification, not authorization. The credential must be restricted to the
intended corpus and should be read-only where the provider supports that.

For on-demand retrieval, the extension manifest alone is not a managed binding.
Qwen merges MCP servers by name, and a settings, project, or command-line
server named `external-context` can replace the manifest contribution while
retaining the same permission-rule name. A managed deployment must therefore
start Qwen with an administrator-owned `--mcp-config` based on
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

### On-demand profile

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

   The MCP subprocess honors `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY`
   through an environment-aware dispatcher. If the provider requires an
   egress proxy, the launcher must include the administrator-approved proxy
   variables in that clean environment. Include `localhost`, `127.0.0.1`, and
   `[::1]` in `NO_PROXY` when using the loopback Generic HTTP provider.

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
provide the managed MCP source binding described above. Before starting Qwen,
the trial environment must set `QWEN_EXTERNAL_CONTEXT_CONFIG` to the absolute
configuration path and set the credential environment variable referenced by
that file.

Each MCP subprocess reads configuration and credentials once when it starts.
Qwen may restart that subprocess, so the configuration path, file contents,
and credential-to-corpus binding must remain immutable for the whole Qwen
session. Do not overwrite or reuse a configuration path for another corpus.
Changing the working directory does not change the configured corpus. The
managed settings disable Qwen's `/cd` command as an accidental-misuse guard,
but cannot prevent every same-UID action. To switch corpora, terminate the old
Qwen session and start a new one with a new managed configuration path.

### Auto-recall profile

Auto-recall sends a sanitized best-effort query to the external provider for
each eligible ordinary interactive prompt. It requires a non-empty
`submitted_prompt` captured by the supported interactive TUI before reminders,
file and resource expansion, extension output, and vision expansion. It never
falls back to the legacy model-bound `prompt`. Missing or invalid provenance
fails closed before configuration or credentials are read. Common credential
shapes are removed from the submitted text, but this is not DLP.

1. Copy `examples/auto-recall-mem0.json` or
   `examples/auto-recall-generic-http.json` to an
   administrator-owned location. Set `repositoryRoot` to the one absolute
   repository bound to the Provider credential. The directory must exist and
   must not be a filesystem root.
2. Build this workspace so `dist/auto-recall.js` exists.
3. Put the applicable
   `examples/managed-auto-recall-user-settings-posix.json` or
   `examples/managed-auto-recall-user-settings-windows.json` content in the
   `settings.json` of a dedicated administrator-controlled `QWEN_HOME`.
   Replace all placeholders with fixed absolute Node and Hook paths.
4. Point `QWEN_CODE_SYSTEM_SETTINGS_PATH` at an administrator-controlled copy
   of `examples/managed-auto-recall-system-settings.json`. Its system-level
   `disableAllHooks: false` prevents lower-precedence workspace settings from
   suppressing the required Hook.
5. Use a launcher that accepts no arguments, verifies stdin and stdout are
   TTYs, starts in `repositoryRoot`, supplies only an administrator-approved
   environment, and fixes all Qwen, Node, Hook, configuration, settings, and
   credential paths. It must set
   `QWEN_CODE_MEMORY_TEAM=0`, `QWEN_CODE_MEMORY_TEAM_SYNC=0`,
   `QWEN_TELEMETRY_ENABLED=0`, `QWEN_TELEMETRY_LOG_PROMPTS=0`,
   `QWEN_TELEMETRY_INCLUDE_SENSITIVE_SPAN_ATTRIBUTES=0`, and
   `QWEN_USAGE_STATISTICS_ENABLED=0`.
   On Windows, the approved `PATH` must resolve `powershell` to the system
   executable, and PowerShell profiles must be absent or
   administrator-controlled. A user-controlled shell shim or profile is
   outside the Direct Profile trust model.

Do not link or enable the external-context Extension Manifest and do not
install `examples/managed-mcp.json` in the auto-recall process; either action
would add the on-demand MCP surface and permit duplicate retrieval. The
shared configuration loader accepts v1 and v2, but the MCP process entry point
requires v1 and the Hook requires v2. Supplying the same v2 configuration to
the MCP therefore fails startup. The managed Auto Profile must still omit the
extension and MCP configuration because a separately configured v1 MCP process
would permit duplicate retrieval. In v2, `autoRecall.timeoutMs` is the only
request timeout the Hook reads; the top-level `timeoutMs` remains for schema
compatibility and has no current runtime consumer. The profile supports only a
fresh interactive TTY session. The managed system settings explicitly disable
speculative execution because accepted speculation can bypass the normal
`UserPromptSubmit` path. It does not support
`-p`, stream-json, ACP, `serve`, YOLO, `--continue`, `--resume`, arbitrary
launcher arguments, or switching repositories in one process. Mid-turn
steering messages do not fire `UserPromptSubmit` and therefore do not trigger
recall; only ordinary submitted turns are eligible.

The Hook reads at most 1 MiB from stdin, emits at most 4000 code units of
structured `untrusted_external_context`, performs no retries or caching, and
fails open as `{}` after the Node entry point starts. Failure to spawn the
pinned Node process and a Qwen outer command timeout retain Qwen's blocking
command-Hook semantics. The Provider timeout defaults to 1500ms and is capped
at 5000ms; the internal Hook wall-clock budget is 6500ms and the managed Qwen
command timeout is 8000ms. Each Hook invocation destroys its own proxy
dispatcher after the attempted retrieval so stalled proxy connections cannot
retain the child process; the long-running MCP process keeps its dispatcher.

Retrieved results are sent to the model provider as user-layer additional
context. The managed profile disables Qwen chat recording, native memory,
usage statistics, and telemetry by default. Provider-side access logs remain
outside this integration's control.

For Mem0 auto-recall, verify that Memory Decay is disabled for the bound
Project. If that cannot be verified, use the on-demand profile.

The integration emits no local per-request audit record. It does not write
queries, results, credentials, provider errors, or operation metadata to
`stderr`. The on-demand MCP entry point may write a sanitized startup
configuration error once before it exits; unexpected startup failures remain
opaque. The auto-recall Hook emits only `{}` on failure.
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

Start with the pinned on-demand MCP for one workspace and validate search
quality and provenance. Enable auto-recall only after the administrator accepts
automatic query forwarding, first with a fake provider, then one trusted
repository, and finally a small team. Do not run both profiles in one process.

Removing the pinned MCP or auto-recall Hook from the managed launcher rolls
back the Qwen integration; local on-demand trials can instead disable or remove
the extension. Restore a preserved v1 configuration before rolling back to a
binary that does not understand v2. The integration does not call explicit
mutation or deletion APIs, but rollback does not remove provider-side search
logs or access metadata.
