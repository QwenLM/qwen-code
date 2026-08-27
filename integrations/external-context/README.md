# External Context extension

This private Qwen Code integration connects one interactive CLI process to one
administrator-bound external context corpus without changing Qwen Core. It has
three managed deployment variants:

- **Read-only on-demand:** version 1 configuration and the MCP
  `context_search({ query })` tool.
- **Mem0 write:** version 1 Mem0 configuration, the on-demand search tool, and
  the optional `context_remember({ content })` tool with a separate
  content-visible confirmation Hook.
- **Auto-recall:** version 2 configuration and an administrator-installed
  `UserPromptSubmit` Hook, with no external-context MCP server.

The built-in adapters support Mem0 Platform V3 search, the Aliyun PolarDB
Mem0 management API, and a small Generic HTTP Search V1 contract for existing
knowledge or RAG services. Only the Mem0 providers have an optional write path.
There is no generic ingestion protocol, personal memory,
trusted user identity, per-document ACL, or tamper-resistant audit.

Provider teams that need a separately owned and released integration should
implement the
[External Context Provider Extension Profile v1](../../docs/design/external-context-provider-extensions.md).
Modern services can publish a Remote MCP Extension; services with an existing
REST API can copy the local adapter example under
`examples/provider-extension-local/`. These provider-owned extensions do not
add cases to this workspace's private Provider factory.

Use the governed Gateway/Orchestrator Profile described in #7449 when those
controls are required.

## Trust boundary

In the read-only on-demand profile, the model can provide only the search
query. In the Mem0 write variant, it can additionally provide only the exact
content to store. In the auto-recall profile, the query is derived only from
Qwen's optional `submitted_prompt` provenance, captured before model-bound
expansions.
Provider type, endpoint, credential, Mem0 `app_id`, `user_id`, `agent_id`, and
all other corpus selectors are fixed before either process starts.

The actual corpus-isolation boundary is the provider-side credential, project,
index, or corpus. A Mem0 `app_id` or any other client-supplied filter is
classification, not authorization. Read-only deployments should use a
read-only credential where the provider supports one. The write variant
requires a credential that can add memories and therefore grants same-UID code
access to that capability outside Qwen as well.

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

The search tool omits MCP `readOnlyHint` because a provider search may record
access metadata or otherwise have provider-side read effects. It exposes no
explicit mutation in the default extension manifest. The managed Mem0 write
variant exposes an explicit add operation. Both variants pass content to an
external service, so this integration is not a DLP boundary. Credentials
inherited by Qwen may also be visible to same-UID processes and tools. Use the
governed profile when the credential, write authorization, or outbound-content
policy must be isolated from the CLI user.

Retrieved context remains untrusted reference data if the model proposes
storing it back into the shared corpus. A user approval does not upgrade that
trust label. Review the complete write carefully because persisting retrieved
or injected text can expose it to later users and model turns.

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
   cannot modify. Configure `apiKeyEnv`, `credentialEnv`, or `tokenEnv` if
   needed, then set the referenced environment variable to the credential.
   `timeoutMs` defaults to 5000 and may be between 1 and 30000 milliseconds.
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

### Managed Mem0 write variant

This variant is an explicit opt-in for trusted collaborators who need to save
repository-shared notes. It uses Mem0 Direct Import with `infer: false`, so the
validated input is sent unchanged as one `user` message. Direct Import skips
Mem0 inference and duplicate detection. Repeating an approved write may create
another copy of the same content.

1. Provision a dedicated Mem0 Project for the repository. Do not share its key
   with another security domain. Mem0 `app_id` remains classification within
   the Project, not authorization.
2. Copy `examples/mem0-write.json` to an administrator-owned path and set the
   referenced `MEM0_API_KEY`. `write` is accepted only for version 1 Mem0
   configurations. Generic HTTP and version 2 configurations reject it. The
   top-level `timeoutMs` applies to both search and write; choose a write budget
   appropriate for the deployment because a client timeout produces an
   ambiguous `unknown` result.
3. Build the workspace so both `dist/main.js` and
   `dist/write-confirmation.js` exist.
4. Start Qwen with an administrator-owned copy of
   `examples/managed-mem0-write-mcp.json`. The default extension manifest stays
   search-only and does not enable `context_remember`. Register this managed
   MCP server under exactly `external-context`; the Hook matcher uses
   `mcp__external-context__context_remember`, and the command ignores other
   tools if a matcher is accidentally broadened. Another server name would
   therefore prevent the content confirmation from running.
5. Point `QWEN_CODE_SYSTEM_SETTINGS_PATH` at an administrator-controlled copy
   of `examples/managed-mem0-write-system-settings.json`. The provided system
   settings deliberately omit the Hook. Put the applicable POSIX or Windows
   managed write user-settings example in a dedicated administrator-controlled
   `QWEN_HOME/settings.json`. User-scope Hooks take precedence over legacy
   merged Hooks, but a system-scope Hook can still run when user Hooks are
   absent, so audit both scopes and avoid additional matchers for this command.
6. Use the same fixed-path, no-user-arguments, environment-allowlist launcher
   requirements as the read-only profile. In addition, pin the Hook and
   dedicated `QWEN_HOME`; refuse headless, ACP, `serve`, resume/continue, and
   startup YOLO modes; and set `QWEN_CODE_MEMORY_TEAM=0`,
   `QWEN_CODE_MEMORY_TEAM_SYNC=0`, `QWEN_TELEMETRY_ENABLED=0`,
   `QWEN_TELEMETRY_LOG_PROMPTS=0`,
   `QWEN_TELEMETRY_INCLUDE_SENSITIVE_SPAN_ATTRIBUTES=0`, and
   `QWEN_USAGE_STATISTICS_ENABLED=0`.
   On Windows, the approved `PATH` must resolve `powershell` to the system
   executable, and PowerShell profiles must be absent or
   administrator-controlled.

In regular interactive mode, the `permissions.ask` rule presents Qwen's normal
server/tool confirmation and the `PreToolUse` Hook then presents a second
confirmation containing a reversible, safely escaped representation of the
complete text. The Hook confirmation is rendered literally rather than as
inline Markdown, so formatting markers and link targets remain visible. If the
text exceeds the constrained terminal area, Qwen reports the hidden line count
and `Ctrl-S` reveals the remaining confirmation content. YOLO
bypasses the ordinary permission rule, but a working Hook still asks once.
Plan mode, unknown permission modes, malformed Hook input, and environments
unable to confirm are denied. Extra tool arguments are ignored consistently by
the Hook and MCP schema and never reach Mem0. Hook transport failure follows Qwen's existing
fail-open semantics, so this is a user-experience safeguard, not an enforceable
authorization boundary. Strict approval requires the governed profile.

The confirmation Hook code does not read the Provider configuration or
credential, but Qwen command Hooks inherit ordinary third-party credentials
from the parent environment. The Hook process may therefore receive the Mem0
key in its environment. The Direct Profile does not provide credential
isolation from administrator-pinned child processes or same-UID code.

`context_remember` accepts at most 4000 Unicode code points, preserves leading
and trailing whitespace, and rejects empty/invisible-only text and malformed
UTF-16. It never accepts a model-selected tenant, Project, `app_id`, filter, or
metadata. Each approval performs exactly one request; the integration does not
pre-search, retry, poll, cache, or deduplicate.

Mem0 V3 Add is asynchronous in normal operation. `PENDING` with a valid
`event_id` is therefore the expected successful response and returns
`accepted`, not `stored`. A valid synchronous `SUCCEEDED` response returns
`stored` as a defensive compatibility path. Explicit `FAILED` and HTTP 400,
401, 403, or 404 responses return a stable failed result. A timeout,
cancellation, redirect, other HTTP status, broken response, unexpected status,
or invalid operation identifier returns `unknown` and an MCP error warning the
model not to retry automatically, because Mem0 may already have accepted the
write. Cancellation therefore does not prove that no memory was created.

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
The default extension manifest and read-only examples do not enable writes.

The managed write variant additionally calls `POST /v3/memories/add/` with one
exact user message, the configured `app_id`, and `infer: false`. It exposes no
get-all, update, delete, delete-all, entity, event, or Project-management tool.
Mem0 Direct Import does not perform duplicate detection, and the asynchronous
Add API can leave the client unable to determine whether a write was accepted.
The integration therefore never retries an ambiguous write.

Mem0 Memory Decay is opt-in and off by default. If enabled, search reinforces
returned memories, updates access history, and can affect later ranking. Keep
it disabled when search must have no semantic provider-side state change.
Provider audit or access logs may still be retained. See
[Mem0 Memory Decay](https://docs.mem0.ai/platform/features/memory-decay).

## Versioned Mem0-compatible providers

New Mem0-compatible deployments use one `mem0` provider type and select a
reviewed built-in wire contract through `preset`. The endpoint is split into an
`origin` and optional static `basePath`, while the credential and fixed scope
remain administrator-owned:

```json
{
  "type": "mem0",
  "preset": "aliyun-polardb-mysql-2026-08",
  "endpoint": {
    "origin": "https://memory.example.com",
    "basePath": ""
  },
  "credentialEnv": "MEM0_API_KEY",
  "scope": {
    "userId": "repository-memory",
    "agentId": "qwen-code"
  }
}
```

The built-in presets are:

- `mem0-platform-v3`: `/v3` Platform API, `Authorization: Token`, fixed
  `appId`.
- `mem0-oss-rest-2026-08`: stock self-hosted Mem0 `/search` and `/memories`,
  `X-API-Key`, fixed `userId`, and optional `agentId`.
- `aliyun-polardb-mysql-2026-08`: PolarDB `/v2/memories/search` and
  `/v1/memories`, `Authorization: Token`, fixed `userId`, and optional
  `agentId`.

The preset records the whole protocol, not just one API version. Search always
sends a maximum of five through the preset's `top_k` field. The engine does not
probe versions or fall back to a different preset. See
`examples/polardb-mem0.json`, `examples/mem0-oss.json`, and the
[preset design](../../docs/design/direct-external-context-mem0-presets.md).

Non-loopback plain HTTP remains an explicit `allowInsecureHttp` endpoint
opt-in. Because it sends credentials, queries, and memory content in cleartext,
prefer HTTPS or a loopback relay such as `ssh -L`. Both shipped examples use
HTTPS and omit the flag.

Preset scope is fixed in configuration and never supplied by the model. A
missing required scope or an unused configured scope fails startup. The
examples are read-only as shipped: `context_remember` is registered only when
the version 1 configuration carries `"write": { "enabled": true }`. Enabling
writes must reuse the managed write-confirmation Hook and permissions above.

## Rollout and rollback

Start with the pinned read-only on-demand MCP for one workspace and validate
search quality and provenance. For writes, first run the repository's
interactive fake-Mem0 test harness, then progress through an isolated temporary
Mem0 Project, one trusted repository, and a small team. The shipped Mem0
Platform configuration always targets Mem0 Platform, and only the test harness
injects a local endpoint. A versioned `mem0` configuration instead points at
the operator-selected endpoint — plain HTTP included when
`allowInsecureHttp` is on — so treat that endpoint, credential, preset, scope,
and network policy as one immutable access boundary and validate search
read-only before enabling writes. Enable auto-recall only after the
administrator accepts automatic query forwarding. Do not run auto-recall and
an on-demand MCP in one process, and do not expose this server alongside a
second Mem0 Extension for the same corpus.

Removing the pinned MCP or auto-recall Hook from the managed launcher rolls
back the Qwen integration; local on-demand trials can instead disable or remove
the extension. Restore a preserved v1 configuration before rolling back to a
binary that does not understand v2. To roll back the write variant, remove its
MCP configuration, Hook, and credential, restore the read-only v1
configuration, and restart Qwen. Rollback does not delete memories already
accepted by Mem0 or remove provider-side search logs and access metadata;
administrators must handle existing records at the Provider.
