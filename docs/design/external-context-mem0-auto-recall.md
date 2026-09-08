# Mem0 External Context Auto Recall

**Status:** Implemented

**Date:** 2026-09-04

## Decision

Add an administrator-installed `UserPromptSubmit` command Hook to the public
Mem0 External Context package. The Hook reuses the administrator-owned
`DialectV1`, bounded request engine, and untrusted result envelope without
changing Qwen Core or the default Extension manifest.

The retrieval profiles are mutually exclusive:

- **On-demand:** `InstanceConfigV2`, the default Extension manifest, and the
  `context_search({ query })` MCP tool.
- **Auto recall:** `InstanceConfigV3`, an administrator-installed Hook, and no
  Mem0 External Context MCP server.

The default manifest does not register the Hook. Installing or upgrading the
Extension therefore cannot cause automatic prompt forwarding or add a process
spawn to existing user turns. Auto recall requires both a v3 configuration and
an explicit Hook registration in an administrator-controlled `QWEN_HOME`.

## Scope

### Goals

- Perform at most one provider search for an eligible user submission.
- Preserve the v2 MCP configuration and `context_search` contract.
- Keep the endpoint, credential, scope, dialect, and repository binding outside
  model control.
- Use only `submitted_prompt` provenance captured before model-bound expansion.
- Reduce accidental credential forwarding before a query leaves the host.
- Inject only bounded, structured, untrusted user-layer context.
- Fail open with bounded latency and no integration-generated request logs.

### Non-goals

- Memory creation, update, deletion, ingestion, or automatic memory extraction.
- Built-in provider presets or provider-specific dialects.
- Qwen Core changes or conditional Extension-manifest features.
- DLP, user authentication, tenant authorization, or compliance audit.
- Input paths that do not provide `submitted_prompt`.
- Retry, redirect, cache, protocol probing, or a persistent Hook process.
- Preventing indirect prompt injection from retrieved content.

## Configuration

`InstanceConfigV2` remains the exact on-demand schema. Auto recall uses a
separate canonical schema and `schemaVersion: 3`:

```json
{
  "schemaVersion": 3,
  "autoRecall": {
    "repositoryRoot": "/absolute/path/to/repository"
  },
  "dialectPath": "/etc/qwen/external-context/memory.dialect.json",
  "endpoint": {
    "origin": "https://memory.example.com",
    "basePath": "",
    "allowInsecureHttp": false
  },
  "credentialEnv": "MEMORY_API_KEY",
  "scope": {
    "userId": "repository-memory"
  },
  "timeoutMs": 1500
}
```

The Hook and MCP entry points share
`QWEN_EXTERNAL_CONTEXT_MEM0_CONFIG`, but accept different configuration
versions. The MCP loader accepts only v2 and the Hook loader accepts only v3.
This rejects accidental cross-mode use while preserving existing deployments.
The auto-recall timeout must be from 100 through 5000 milliseconds.

`repositoryRoot` must be an existing absolute directory and cannot be a
filesystem root. The loader resolves it through `realpath`. Each event `cwd` is
also resolved through `realpath`; retrieval runs only for the configured root
or a descendant. The repository check prevents accidental corpus reuse after a
directory change. Provider-side credentials and authorization remain the
actual security boundary.

`DialectV1` is unchanged. It remains a closed administrator-owned grammar and
cannot define arbitrary headers, templates, transformations, or write methods.

## Runtime flow

Each eligible invocation starts a new Node process:

1. Read at most 1 MiB of Hook JSON from stdin.
2. Require `hook_event_name: "UserPromptSubmit"`, a non-empty
   `submitted_prompt`, and a string `cwd`.
3. Load and validate `InstanceConfigV3`, `DialectV1`, the canonical repository
   root, and the named credential.
4. Resolve `cwd` and skip retrieval when it is outside the configured root.
5. Remove fenced code, the exact configured credential, and common secret
   shapes; collapse whitespace and keep at most 512 Unicode code points.
6. Call the existing request engine once with the configured timeout.
7. Return at most five results through `UserPromptSubmit.additionalContext` as
   the existing `untrusted_external_context` envelope.
8. Emit `{}` for missing provenance, mismatched paths, empty results, invalid
   configuration, timeouts, transport failures, or invalid provider responses.

The Hook never reads or falls back to the legacy `prompt` field. Eligibility
depends on `submitted_prompt`, not the input transport: supported TUI
submissions and headless CLI user turns supply it, including `qwen -p` and
stream-json user messages from SDK clients. Events without this field, such as
tool-result continuations, skip retrieval. Do not infer a TUI-only origin or
exclude a transport merely from its name.

Configuration and dialect paths must resolve to regular files and are bounded
to 64 KiB. Nonblocking open and descriptor validation reject FIFOs before a
filesystem worker can block waiting for a writer. The long-running MCP
process reads them once at startup. The command Hook reads them once per
eligible invocation, so administrator file changes apply to the next eligible
submission; changing its environment or Hook registration requires restarting
Qwen.

## Bounds and failure semantics

- Sanitizer input: 4096 Unicode code points.
- Provider query: 512 Unicode code points.
- Provider timeout: 100-5000 ms.
- Internal Hook wall-clock budget: 6500 ms.
- Qwen command-Hook timeout: 8000 ms.
- Provider response: 1 MiB before JSON parsing.
- Output: five items, 1000 Unicode code points per content field, and 4000
  JavaScript code units for the serialized envelope.

There is no retry, redirect, or cache. The Hook writes exactly one JSON object
to stdout and emits no integration-generated stderr. Once the pinned Node
entry point starts, handled failures return `{}` with exit code zero. The
executable flushes stdout and explicitly exits so abandoned connections do not
keep the event loop alive after the result is ready. Secret-assignment
matching starts at identifier boundaries and checks the keyword separately from
the assignment suffix, avoiding overlapping scans on repeated-keyword inputs.
A launcher failure before Node starts or an outer Qwen timeout follows the
command-Hook runner's own error policy; ordinary runner timeouts are nonfatal
but delay the turn. Administrators must validate the fixed binary and bundle
paths before rollout.

Sanitization is a best-effort reduction, not DLP. The external provider may log
the sanitized query. Retrieved content is sent to the model provider and may be
persisted in the session transcript. The untrusted envelope and Qwen's reserved
Hook-context wrapper preserve provenance but do not prevent the model from
following malicious retrieved instructions.

## Deployment

The package ships `dist/auto-recall.js`, the v3 schema, and unbranded POSIX and
Windows Hook examples. It ships no provider preset or provider dialect.

The administrator installs a pinned package version at a stable absolute path,
creates the v3 instance and dialect files outside ordinary workspaces, injects
the configuration path and credential through the managed process environment,
and copies the applicable Hook definition into an administrator-controlled
`QWEN_HOME/settings.json`.

This registration opts in every eligible input handled by that launcher,
including headless and stream-json user turns. Automation can disable all Hooks
with `--bare`, `--safe-mode`, or `disableAllHooks: true` in managed settings
before startup. The two flags also change which customizations are loaded.
When automation needs other Hooks, use a separate controlled `QWEN_HOME`
without this Hook and omit its configuration and credential from the
automation environment. A protocol-level TUI-only filter would require a
separate Core/CLI provenance change and is outside this package-only design.

The auto-recall process must not enable the package's default Extension
manifest or configure another on-demand Mem0 MCP server. Otherwise one turn
could produce both a deterministic Hook request and a model-selected MCP
request. A separate pinned installation path is preferred for the Hook-only
profile.

Rollback removes the Hook registration and credential from the managed
launcher and restarts Qwen. It does not delete provider records or access logs.

## Verification

Unit tests cover strict v2/v3 parsing, canonical roots, containment, missing
provenance, legacy-prompt isolation, input limits, credential patterns, Unicode
bounds, one-request behavior, fail-open output, timeouts, and final context
bounds. Package test commands build the shipped bundles before running tests.
Local subprocess tests execute the Hook bundle with a fake provider and cover
configuration, `DialectV1`, exact outbound requests, flushed Hook stdout, and
successful process exit during a stalled TLS handshake and rejection of instance
or dialect FIFOs. Repeated secret-keyword
near misses are tested in bundle-importing subprocesses with a real deadline.

Package verification builds both entry points and inspects `npm pack --dry-run`
to confirm that the tarball contains the runtime, schemas, manifest,
documentation, and unbranded Hook examples, with no provider-specific data.
The default manifest test continues to require exactly `context_search` and no
Hook registration.
