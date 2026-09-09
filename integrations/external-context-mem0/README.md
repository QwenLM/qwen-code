# Mem0 External Context Extension

This package provides on-demand search, Auto Recall, and opt-in daemon
writing and single-record deletion for administrator-configured Mem0-compatible HTTP services. It validates a closed
dialect grammar and uses a bounded HTTP request engine; it does not ship
provider presets or provider-specific configuration.

The default Extension exposes exactly one tool, `context_search({ query })`.
Administrators can instead install the packaged `UserPromptSubmit` Hook for
automatic retrieval. The model cannot select the endpoint, credential, scope,
timeout, result limit, or dialect in either profile.

## Installation

Install the published Extension with Qwen Code:

```bash
qwen extensions install @qwen-code/external-context-mem0
```

This command becomes available after the package's first registry release.

Use an explicit package version when the deployment must remain pinned:

```bash
qwen extensions install @qwen-code/external-context-mem0@x.y.z
```

The Extension version follows the Qwen Code release version. Installation does
not configure a memory service or install provider data. An administrator must
supply an instance file, a dialect file, and the credential environment
variable described below.

## Administrator deployment

### 1. Confirm that the upstream API fits the bounded dialect

The upstream search API must use a static `GET` or `POST` path, one supported
authentication header, simple query and scope placement, and a JSON response
that matches the supported result fields. The dialect cannot define arbitrary
headers, request templates, JSONPath, executable transformations, redirects,
retries, or write operations.

If the upstream API cannot fit this grammar, implement a separate MCP Extension
instead of weakening the boundary.

### 2. Create the dialect file

Store the file outside ordinary workspaces. The following unbranded template
describes a `POST` search endpoint that receives the query and fixed user scope
in JSON:

```json
{
  "dialectVersion": 1,
  "id": "organization-memory-v1",
  "auth": "authorization-bearer",
  "search": {
    "method": "POST",
    "path": "/memories/search",
    "queryLocation": "json",
    "userIdLocation": "json.filters",
    "agentIdLocation": "omit",
    "appIdLocation": "omit",
    "limitField": "limit"
  },
  "response": {
    "collection": "results",
    "idField": "id",
    "contentField": "memory",
    "titleField": "omit",
    "uriField": "omit",
    "scoreField": "score",
    "updatedAtField": "omit"
  }
}
```

Save it, for example, as
`/etc/qwen/external-context/memory.dialect.json`. It must conform to
[`schemas/dialect.schema.json`](./schemas/dialect.schema.json).

Use the dialect fields as follows:

| Upstream contract                    | Dialect value                                |
| ------------------------------------ | -------------------------------------------- |
| `Authorization: Token <credential>`  | `auth: "authorization-token"`                |
| `Authorization: Bearer <credential>` | `auth: "authorization-bearer"`               |
| `X-API-Key: <credential>`            | `auth: "x-api-key"`                          |
| Query string search                  | `method: "GET"` and `queryLocation: "query"` |
| JSON request search                  | `method: "POST"` and `queryLocation: "json"` |
| Scope at the JSON root               | `json`                                       |
| Scope under `filters`                | `json.filters`                               |
| Scope in the query string            | `query`                                      |
| Scope not sent upstream              | `omit`                                       |
| Upstream result limit                | `limitField: "limit"` or `"top_k"`           |
| No upstream result-limit field       | `limitField: "omit"`                         |

`GET` dialects cannot use JSON locations. The `response` object selects only
the supported collection and field names; it does not contain paths or
transformations. The dialect `id` is an administrator-owned audit label and
does not participate in lookup or file-name matching.

Optional `search.threshold` values from 0 through 1 and boolean
`search.rerank` values are sent as query parameters for `GET` or JSON fields
for `POST`. The complete response-field allowlists are defined by the dialect
schema.

### 3. Create the instance file

The instance file binds the dialect to one endpoint, credential variable,
fixed scope, and timeout:

```json
{
  "schemaVersion": 2,
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
  "timeoutMs": 5000
}
```

Save it, for example, as
`/etc/qwen/external-context/memory.instance.json`. It must conform to
[`schemas/instance-config.schema.json`](./schemas/instance-config.schema.json).

`dialectPath` must be an absolute local path. It is not resolved relative to
the instance file, expanded from environment variables, or loaded from a URL.
The old `schemaVersion: 1` and `preset` shape is intentionally unsupported.

Every non-`omit` dialect scope location requires the corresponding `userId`,
`agentId`, or `appId` in the instance file. Every `omit` location requires that
scope value to be absent. Scope values are fixed routing inputs, not an
authorization boundary. Use separate administrator bindings when deployments
must access different fixed corpora.

`endpoint.origin` contains only the scheme and authority. Put a shared static
path prefix in `basePath` and the operation path in the dialect. HTTPS is
required by default. Set `allowInsecureHttp` to `true` only for a trusted
private-network HTTP endpoint; never send a credential over public HTTP in a
production deployment.

### 4. Protect the files and inject the environment

Both JSON files are administrator-controlled configuration, even though they
contain no credential. Restrict their ownership and permissions according to
the host policy. For example:

```bash
install -d -m 700 /etc/qwen/external-context
chmod 600 /etc/qwen/external-context/memory.*.json
```

These are Unix examples. On Windows, use an administrator-controlled absolute
directory and equivalent ACLs; escape backslashes when writing the absolute
path in JSON.

Set `QWEN_EXTERNAL_CONTEXT_MEM0_CONFIG` to the absolute instance-file path in
the Qwen process environment. Separately inject the environment variable named
by `credentialEnv` through the deployment's secret manager or service manager:

```bash
export QWEN_EXTERNAL_CONTEXT_MEM0_CONFIG=/etc/qwen/external-context/memory.instance.json
# The secret manager must populate and export MEMORY_API_KEY before this point.
test -n "${MEMORY_API_KEY:-}" || exit 1
qwen
```

The Extension inherits these values from the Qwen process. Do not put the
credential in either JSON file, Qwen settings, a repository `.env` file, a
launcher script, or a command-line argument. The configuration path is not an
ordinary Qwen setting.

Both files are limited to 64 KiB. The on-demand MCP process reads them once at
startup. Restart Qwen Code after changing either file or environment value in
that profile.

### 5. Verify the deployment

1. Start Qwen Code from the configured process environment.
2. Open `/mcp` and verify that `external-context-mem0` is connected.
3. Verify that the server exposes only `context_search`.
4. Search for a known, non-sensitive record in the fixed scope and confirm the
   expected result.
5. If available, correlate the request with the upstream service access log
   without recording the credential or response body.

The default Extension is retrieval-only. Provision a disposable test record
through an administrator-approved upstream path if a known record is not
already available. The separately configured writer below can create records;
the [explicit deletion profile](#opt-in-daemon-explicit-deletion) can remove
individual records after verification.

## Auto Recall profile

Auto Recall retrieves external context before each eligible ordinary user
submission. It is not enabled by the default Extension manifest. Installing or
upgrading the Extension therefore does not automatically forward prompts or
add a Hook process to existing turns.

Use a separate `schemaVersion: 3` instance file for Auto Recall:

```json
{
  "schemaVersion": 3,
  "autoRecall": {
    "repositoryRoot": "/workspace/my-repository"
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

The file must conform to
[`schemas/auto-recall-instance-config.schema.json`](./schemas/auto-recall-instance-config.schema.json).
`repositoryRoot` must be an existing absolute directory and cannot be a
filesystem root. Auto Recall runs only when the Hook event working directory
is that canonical directory or one of its descendants. The provider timeout
must be from 100 through 5000 milliseconds.

Install a pinned package version at a stable administrator-controlled path,
for example:

```bash
npm install --prefix /opt/qwen/external-context-mem0-auto-recall \
  @qwen-code/external-context-mem0@x.y.z
```

The corresponding bundle is
`/opt/qwen/external-context-mem0-auto-recall/node_modules/@qwen-code/external-context-mem0/dist/auto-recall.js`.
Copy the applicable unbranded Hook definition from
[`examples/managed-auto-recall-user-settings-posix.json`](./examples/managed-auto-recall-user-settings-posix.json)
or
[`examples/managed-auto-recall-user-settings-windows.json`](./examples/managed-auto-recall-user-settings-windows.json)
into the `settings.json` of an administrator-controlled `QWEN_HOME`. Replace
both command placeholders with fixed absolute Node and `dist/auto-recall.js`
paths. The Mem0 instance and dialect remain independent JSON files; Qwen
settings contain only the Hook registration.

The Auto Recall profile must not enable this package's default Extension
manifest or configure another on-demand Mem0 MCP server. Running both profiles
could send two searches for one turn. Use the v2 Extension profile for
on-demand `context_search`, or the v3 Hook-only profile for Auto Recall, never
both in one Qwen process.

The Hook requires a non-empty `submitted_prompt` captured before prompt
expansion. This includes supported interactive TUI submissions and headless
CLI user turns (`qwen -p` and stream-json input, including SDK clients using
that path). The field establishes prompt provenance, not a TUI-only origin.
The Hook never falls back to the expanded `prompt`; events without
`submitted_prompt` do not trigger retrieval.

Register this profile only in launchers where automatic retrieval is intended
for all eligible inputs. To disable every Hook for an automation run, use
`qwen --bare -p '…'`, `qwen --safe-mode -p '…'`, or set `disableAllHooks: true`
in its managed settings before starting Qwen. These options disable all Hooks;
`--bare` and `--safe-mode` also change which customizations are loaded. If
automation needs other Hooks, give it a separate administrator-controlled
`QWEN_HOME` without this Hook and omit the Auto Recall configuration and
credential from that launcher's environment. The Hook itself does not
distinguish TUI, SDK, or other transports supplying the field.

Instance and dialect paths must resolve to regular files. FIFOs and other
special files are rejected before reading configuration.

Missing provenance, invalid configuration, a cwd outside the repository, an
empty result, timeout, or provider failure returns `{}`. The executable flushes
stdout and exits zero even if an aborted request retains open handles, allowing
the user turn to continue after the pinned Node entry point starts.

Before sending the query, the Hook removes fenced code, the configured
credential, and common secret shapes, then keeps at most 512 Unicode code
points. This is best-effort reduction, not DLP. Each eligible invocation is a
new process and reads the v3 instance and dialect once, so administrator file
changes apply to the next eligible prompt. Environment and Hook registration
changes require restarting Qwen Code.

## Runtime guarantees

- The on-demand model supplies only a normalized query of at most 2,000
  Unicode code points; Auto Recall derives at most 512 Unicode code points from
  `submitted_prompt`.
- Requests have the configured timeout, do not retry, and do not follow
  redirects.
- Responses are limited to 1 MiB before JSON parsing.
- Results preserve upstream order and are capped at five entries, 1,000 Unicode
  characters per content field, and 4,000 UTF-16 code units in the serialized
  tool output.
- Provider output is returned as `untrusted_external_context`; it is reference
  data, not trusted instructions.
- Startup and request errors are redacted and do not expose paths, endpoints,
  queries, credentials, or upstream response bodies.

## Explicit writes for daemon workspaces

The separate `dist/write-main.js` entry provides `context_remember({ content })`
for trusted, registered daemon workspaces. It is never started by the default
Extension manifest. Enable it only for workspaces that need writes; configure
each workspace's endpoint, credential environment and scope independently.

The tool accepts one exact string of at most 4000 Unicode code points. It rejects
blank/control-only text and unpaired surrogates, preserves whitespace and Unicode,
and sends one `POST` with `messages: [{"role":"user","content":...}]` and
`infer: false`. The model cannot supply a scope, URL, credential, metadata,
record ID or an alternative inference mode. Use it only when the user explicitly
asks to save a memory. There is no automatic extraction, update, delete, polling
or retry.

### Configure the writer

Create a separate instance file matching
[`write-instance-config.schema.json`](./schemas/write-instance-config.schema.json):

```json
{
  "schemaVersion": 4,
  "repositoryRoot": "/workspace/project",
  "dialectPath": "/etc/qwen/external-context/write.dialect.json",
  "endpoint": {
    "origin": "https://memory.example.com",
    "basePath": "",
    "allowInsecureHttp": false
  },
  "credentialEnv": "MEMORY_WRITE_API_KEY",
  "scope": { "userId": "repository-memory" },
  "timeoutMs": 10000
}
```

V4 is accepted only by the writer; existing V2 search and V3 Auto Recall files
retain their meanings. At least one fixed scope is required. The HTTP deadline
is 100–30000 ms and covers the response body, starting after permission handling.
The instance and dialect files must be absolute paths to regular files of at
most 64 KiB. Startup validates the complete binding and canonical repository/cwd
containment before reading the credential. It rejects filesystem roots and
symlink escapes. Configuration is loaded once per writer process.

The independent closed write dialect matches
[`write-dialect.schema.json`](./schemas/write-dialect.schema.json):

```json
{
  "writeDialectVersion": 1,
  "id": "organization-memory-write-v1",
  "auth": "authorization-token",
  "create": {
    "path": "/memories",
    "userIdLocation": "json",
    "agentIdLocation": "omit",
    "appIdLocation": "omit"
  },
  "response": {
    "completion": "records",
    "collection": "results",
    "idField": "id"
  }
}
```

These are unbranded templates, not service presets. Authentication uses the same
three header options as search. Each scope location is `json` or `omit`, and must
match the presence of its instance value. Responses select exactly one of
`results`, `root-array` or `root-object`, with `id` or `memory_id`. For a service
with top-level `status` and `event_id` acknowledgements, use
`completion: "records-or-event"` with `collection: "results"`. Other combinations,
request templates, scripts and arbitrary mappings are rejected.

Apply [the workspace settings example](./examples/managed-daemon-write-workspace-settings.json)
to the intended trusted workspace. Replace the absolute Node, package, config
and workspace paths. Supply `MEMORY_WRITE_API_KEY` through that workspace's
runtime environment; the example explicitly passes it to the MCP child through
an environment reference. Do not store its actual value in settings or commit
it. Complete the existing MCP configuration approval step before invoking the
tool; approving a server configuration is separate from approving a write.

Do not place one workspace's writer binding in daemon-global settings or child
environment overrides. Session ownership selects the workspace runtime; the
writer's fixed scope selects its corpus. Process cwd checks and invocation
metadata are not tenant authorization. Trusted clients may override MCP
configuration, and same-UID code is within the existing trust boundary.
Conversations, temporary workspaces and automatic corpus switching on `/cd`
are outside this first deployment profile. An existing writer continues using
its configured corpus; use a session in the other configured workspace to switch.

### Permissions and results

The writer uses ordinary daemon MCP permissions. The example uses default
approval mode, `trust: false` and an explicit `permissions.ask` rule. Web Shell
shows the full literal parameter body when the permission has no dedicated
content/diff preview; daemon SDK clients can read `toolCall.rawInput` from the
existing permission request. Reply through the session-qualified permission
API using that session's actual client ID. Replies select an offered option;
`updatedInput` in a daemon client reply does not edit the submitted content.
Reject and issue a new call to change the text.

Explicit ask takes precedence over ordinary allow rules and hides always-allow
choices. Existing YOLO and PermissionRequest Hook approval semantics still
apply, so human approval requires a configuration without those automatic
approvals. No additional PreToolUse confirmation Hook is installed: ACP treats
its `ask` result as a denial rather than opening another dialog.

| Result                             | Meaning                                                                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `stored` + `memoryId`              | The provider returned exactly one valid new-record acknowledgement. Search indexing may still be pending.                                                          |
| `accepted` + `providerOperationId` | The provider acknowledged an operation without a confirmed record ID. No polling or resubmission follows.                                                          |
| `failed`                           | The writer did not submit an HTTP request. Check content/configuration before another attempt.                                                                     |
| `unknown`                          | A request may have committed, including after timeout, cancellation, disconnection, non-2xx status or an invalid reply. Check the provider before another attempt. |

Schema-invalid MCP calls can be rejected by MCP validation before execution.
IDs are bounded literal strings; an operation ID is not a memory ID. Response
bodies are capped at 1 MiB and errors never echo the upstream body. The tool is
marked non-read-only and non-idempotent, preventing Core from transparently
replaying it. A newly requested call can still create another record.

A pending permission has not invoked the writer. Explicitly cancel the active
prompt/session to cancel it. Closing a REST SSE subscription does not itself
cancel a pending approval; Web Shell detachment follows the existing session
lifecycle. The existing permission response timeout defaults to disabled and is
separate from the writer HTTP timeout. Once HTTP submission begins, cancellation
cannot roll back a remote write.

End outstanding write calls before changing a binding, then restart its MCP
server through the selected workspace's MCP management API. The pool fingerprint
includes cwd/env, but changes to file contents at an unchanged config path do not
automatically reload it. Check that the restarted process uses the new binding.

### Verify a shared-memory deployment

First validate the service's `infer: false` behavior in a disposable scope: exact
whitespace/Unicode preservation, one added record, and no modification of an
existing conflicting record. Record acknowledgements alone do not prove those
semantics. Preserve the returned record IDs and clean up only those test records
through the service's administration API.

Then test a rejected and an approved writer call through daemon, observing zero
and one provider write respectively. Configure the existing V2 `context_search`
entry against the same corpus and verify that another client in a new session
can retrieve the saved fact without putting the answer in its query. A different
workspace's independent scope must remain isolated. Auto Recall integration with
daemon is a separate validation and is not a prerequisite for this write profile.

## Opt-in daemon explicit deletion

Deletion is a separate administrator-enabled MCP server, `dist/delete-main.js`.
It exposes only `context_get({ memoryId })` and
`context_forget({ memoryId, expectedContent })`. Installing the default
Extension or enabling the writer does not enable deletion.

Use this profile in registered, trusted daemon workspaces. First read a precise
candidate ID with `context_get`, then carry its complete original text into
`context_forget` for approval. Search text is a summary, not confirmation text.
Search results with IDs longer than 128 Unicode code points are omitted instead
of returning a truncated ID. Full IDs up to 256 ASCII characters can still come
from a writer's `stored.memoryId` or the service administration interface; do
not substitute `accepted.providerOperationId` or repair an old truncated ID.

The tool accepts only ASCII letters, digits, dot, underscore, colon and hyphen
in IDs, rejecting the entire IDs `.` and `..`. Expected text is preserved exactly,
including empty records, whitespace and control characters, with a maximum of
4000 Unicode code points and no unpaired surrogate. Overlong text is rejected,
never summarized or truncated. No scope, URL, credential, query, filters,
confirmation flag or cascade option can be supplied by the model.

### Bind a deletion server

Supply `QWEN_EXTERNAL_CONTEXT_MEM0_DELETE_CONFIG` with an absolute instance path
conforming to [the V5 schema](./schemas/delete-instance-config.schema.json):

```json
{
  "schemaVersion": 5,
  "repositoryRoot": "/workspace/project",
  "dialectPath": "/etc/qwen/external-context/delete.dialect.json",
  "endpoint": {
    "origin": "https://memory.example.com",
    "basePath": "",
    "allowInsecureHttp": false
  },
  "credentialEnv": "MEMORY_DELETE_API_KEY",
  "scope": { "userId": "repository-memory" },
  "timeoutMs": 10000
}
```

V5 is the extension's instance version, not the Qwen settings version. Paths,
regular configuration files (64 KiB maximum), canonical repository containment,
static endpoint and fixed nonempty scope are validated before the credential
is read. The credential must allow both exact reads and deletion. Each process
loads one fixed binding at startup; stop outstanding calls and restart that
workspace's MCP server to change it.

The independent [delete dialect](./schemas/delete-dialect.schema.json) is bounded:

```json
{
  "deleteDialectVersion": 1,
  "id": "organization-memory-delete-v1",
  "auth": "authorization-token",
  "record": {
    "pathPrefix": "/memories/",
    "pathSuffix": "",
    "idField": "id",
    "contentField": "memory",
    "notFound": "http-404"
  }
}
```

This is an unbranded template, not a Holo preset. Authentication uses the same
three supported headers as search. GET and DELETE share the static prefix plus
one encoded ID segment; suffix is empty or `/`. There are no request bodies,
query parameters, redirects, bulk fallbacks or automatic protocol detection.

GET must return HTTP 200 with one root object and the selected `id`/`memory_id`
and `memory`/`content`/`text` fields. Every configured scope must exactly match
the authoritative top-level `user_id`, `agent_id` or `app_id`; arbitrary metadata
is not a scope source. Foreign or missing targets do not disclose their text.
The selected absence contract is either HTTP 404 (`http-404`) or HTTP 200 with
JSON null (`null-200`); other shapes are not interpreted as absence.

DELETE follows the official client's response handling: require a successful
HTTP status and parse the bounded UTF-8 JSON response without matching message
text or imposing extra response-field rules. A successful status alone does not
confirm deletion: an exact GET must then verify absence. Empty responses
(including HTTP 204), invalid JSON and non-success HTTP responses remain unknown.
Responses are bounded to 1 MiB. There are no automatic retries.

### Approval, verification and limits

Apply [the managed workspace settings example](./examples/managed-daemon-delete-workspace-settings.json),
replacing the absolute paths and supplying the credential through that workspace's
runtime environment. Keep the server binding workspace-local and complete normal
MCP configuration approval. The example uses default mode, `trust: false`, and
an explicit ask rule for `context_forget`. The read helper follows its own normal
permission policy; read-only annotations are not automatic authorization.

Web Shell displays the exact ID and full expected text through ordinary MCP
parameter approval. After approval, forget reads the target again and compares
ID, all configured scope fields and full text before submitting one DELETE.
If it receives a successful HTTP response with valid JSON, it performs one exact GET
to verify absence. One total 100–30000 ms deadline covers those three steps;
human approval waiting is outside that deadline. No state, confirmation token
or mandatory earlier get is required: a direct call with the correct full ID
and original text receives the same checks.

| Result        | Meaning                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `deleted`     | Successful HTTP response with valid JSON followed by a read confirming absence.                                                                                    |
| `not_deleted` | This call submitted zero DELETE requests. A fixed reason distinguishes invalid input, unavailable/changed target, verification failure or pre-delete cancellation. |
| `unknown`     | DELETE started but its result or subsequent absence check is uncertain. Do not retry automatically; explicitly read to inspect current state.                      |

MCP schema errors can be rejected before execution. Result messages do not echo
the provider response or target text. Non-idempotent destructive annotations
prevent transparent replay; a new explicit call still follows current permissions.
YOLO and PermissionRequest Hook automatic approvals retain their existing
semantics. Client approval replies cannot edit arguments; reject and request a
new call to change them. Pending approval cancellation and runtime ownership use
the existing daemon lifecycle. Disconnecting a REST SSE subscription is not an
explicit cancellation, and cancellation cannot undo an already submitted DELETE.

The last GET and DELETE are **not atomic**. Changes while waiting for approval
are detected, but an update after the final GET may also be deleted. Atomic
version deletion requires a verified server-side conditional-delete contract;
this client does not claim to provide one. Before accepting a multi-workspace
deployment, verify that record IDs are not reused and scope cannot migrate, or
that the service independently restricts deletion to the credential's fixed
scope. Returned scope fields must be authoritative. Local scope configuration
is not a tenant ACL, and trusted clients/same-UID processes remain within the
existing trust model.

Deletion does not erase old conversations, model context, service logs or
backups, and a search index may lag behind exact reads. Verify propagation with
new clients/sessions and unchanged same-scope and foreign-scope control records.
The full expected text enters ordinary tool parameters and transcripts; this
profile adds no target cache or separate body log. Real Holo conformance must be
verified against its deployed GET/DELETE contract using disposable records;
synthetic tests do not establish Holo support.

## Troubleshooting

| Symptom                                              | What to check                                                                                                                                                                     |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `configuration path must be absolute`                | `QWEN_EXTERNAL_CONTEXT_MEM0_CONFIG` must contain an absolute local path.                                                                                                          |
| `instance configuration is unavailable`              | The instance path or named credential environment variable is missing, blank, unresolved, or unreadable.                                                                          |
| `instance configuration is invalid`                  | Validate the on-demand JSON, `schemaVersion: 2`, required fields, file size, and rejection of extra fields.                                                                       |
| Auto Recall returns `{}`                             | Validate the v3 schema, Hook paths, `submitted_prompt`, repository containment, credential, network, timeout, and provider response. Failures are intentionally silent.           |
| `dialect path must be absolute`                      | `dialectPath` must contain an absolute local path.                                                                                                                                |
| `dialect configuration is unavailable`               | Confirm that the dialect file exists and is readable by the Qwen process user.                                                                                                    |
| `dialect configuration is invalid`                   | Validate JSON, `dialectVersion: 1`, enum values, required fields, file size, and rejection of extra fields.                                                                       |
| `endpoint`, `path`, `scope`, or `dialect` is invalid | Check HTTPS or explicit private HTTP opt-in, static path rules, GET/JSON compatibility, and exact scope/`omit` consistency.                                                       |
| MCP server connects but search returns an error      | Check network routing, DNS, firewall or allowlist rules, upstream authentication, timeout, status code, and response shape. The Extension intentionally redacts upstream details. |

## Administrator acceptance checklist

- The endpoint is reachable from the Qwen host and its network allowlist is
  intentionally scoped.
- Production traffic uses HTTPS; private HTTP is an explicit exception.
- Both configuration paths are absolute, outside ordinary workspaces, and
  readable only by the intended administrator and process user.
- No credential appears in configuration files, settings, repositories,
  scripts, logs, or shell history.
- Every non-`omit` dialect scope has exactly one matching fixed instance value.
- The deployment enables exactly one retrieval profile: v2 MCP or v3 Hook.
- The read server exposes only `context_search`; the Auto Recall profile has
  no read MCP server. An explicitly configured writer is a separate server
  exposing only `context_remember`. A separately enabled deletion server exposes
  only `context_get` and `context_forget`.
- A known-record search succeeds. On-demand file changes take effect after
  restart; Auto Recall file changes take effect on the next eligible prompt.

## Development

```bash
npm run test --workspace=@qwen-code/external-context-mem0
npm run typecheck --workspace=@qwen-code/external-context-mem0
npm run lint --workspace=@qwen-code/external-context-mem0
npm run build --workspace=@qwen-code/external-context-mem0
```

The tests use synthetic dialect and provider-response fixtures only. They make
no request to a live memory service.
