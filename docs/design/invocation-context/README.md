# Invocation Context v1

## Status

Implementation design for Qwen Code v0.19.10 and later.

## Problem

Qwen Code can enter a session through the CLI, ACP, the HTTP daemon,
messaging channels, scheduled work, or another MCP server. Once the prompt is
inside `Session`, those origins are no longer available to a local MCP tool.
Passing caller-provided metadata through unchanged would be incorrect: public
ACP and daemon clients could forge session, prompt, or client identities, and
client-hosted MCP transports could receive data intended only for a process
started by Qwen Code.

Invocation Context v1 provides correlation metadata with three constraints:

1. Native entry points create or rebuild the context; request payloads do not
   become authority by themselves.
2. The context exists only for the lifetime of an async execution tree and is
   not written into chat history.
3. Only MCP servers launched through an actual stdio transport receive it.

The context is correlation metadata, not an authorization credential.

## Wire contract

```ts
type InvocationIngress =
  | 'cli'
  | 'acp'
  | 'daemon'
  | 'channel'
  | 'scheduler'
  | 'external_mcp'
  | 'internal';

interface InvocationContextV1 {
  version: 1;
  ingress: InvocationIngress;
  sessionId: string;
  promptId: string;
  originatorClientId?: string;
}
```

The parser accepts only this shape. Version, ingress, and IDs are not coerced;
unknown properties and blank IDs are rejected. `promptId` is an opaque root
correlation ID. It does not replace the durable prompt ID used by history,
rewind, or file snapshots.

The reserved metadata keys are:

| Key                                   | Use                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------- |
| `qwen-code/invocation`                | Complete v1 context on a trusted ACP request or MCP tool request          |
| `qwen-code/invocation-ingress`        | Advisory ingress supplied to the daemon or a trusted standalone ACP child |
| `qwen-code/private-parent-capability` | Per-spawn capability in the first ACP initialize request                  |

## Runtime propagation

Core owns a dedicated `AsyncLocalStorage<InvocationContextV1>`. Root entry
points call `runWithInvocationContext`; normal in-process async work and
subagents inherit the store. Deferred approval callbacks restore the snapshot
captured with the request. Timer-driven and persisted work must not rely on
implicit inheritance: cron, notifications, and background resume each create a
new root context and omit `originatorClientId`.

The sources are fixed:

| Entry point                                 | ingress        | promptId                | client identity  |
| ------------------------------------------- | -------------- | ----------------------- | ---------------- |
| CLI                                         | `cli`          | current CLI turn ID     | omitted          |
| Public ACP                                  | `acp`          | child durable prompt ID | omitted          |
| Daemon prompt or public continue            | `daemon`       | daemon admission UUID   | validated client |
| qwen-serve-mcp                              | `external_mcp` | daemon admission UUID   | validated client |
| User channel message                        | `channel`      | current root request ID | omitted          |
| Channel loop, cron, unattended webhook      | `scheduler`    | new execution root ID   | omitted          |
| Notification, background resume, classifier | `internal`     | new execution root ID   | omitted          |

## Daemon authority

Daemon prompt metadata is advisory. The daemon first performs its existing
client attachment and identity validation. It then removes all three reserved
metadata keys and constructs a complete context from the route session ID,
daemon admission UUID, normalized ingress, and validated client ID.

`channel`, `scheduler`, and `internal` deliberately drop the client ID.
`daemon` and `external_mcp` retain the validated client ID. Missing or unknown
advisory values normalize to `daemon`. Consequently, forging ingress can only
change a label or attenuate an already validated identity; it cannot grant an
identity.

SDK defaults and per-prompt overrides are stamped after copying caller
metadata. The precedence is per-prompt override, `DaemonClient` default, then
`daemon`. Both blocking and non-blocking prompt paths use the same stamping
logic.

## Private ACP capability

The daemon bridge and standalone channel bridge each create a 32-byte random
base64url nonce for a private ACP child. The parent forces the nonce into the
child environment as `QWEN_CODE_PRIVATE_ACP_CAPABILITY` and sends it in the
first `InitializeRequest._meta` under
`qwen-code/private-parent-capability`.

The ACP entry point captures and deletes the environment capability before
settings parsing, application initialization, or MCP discovery. A regular or
sandbox relaunch passes it only in the final child's spawn environment and
never restores it in the parent. The final process passes the captured value
in memory to the ACP agent. The child decides trust exactly once on the first
initialize request:

- no capability in the environment means the connection remains untrusted,
  even if initialize or prompt metadata contains reserved keys;
- an environment capability with a missing or different initialize value
  fails initialization rather than downgrading silently;
- the environment value is never visible to MCP servers or later subprocesses;
  later initialize calls cannot upgrade either a trusted, untrusted, or
  rejected connection.

A trusted daemon parent may send a complete context. A trusted standalone
channel parent sends only advisory ingress, because the child owns its native
session and prompt IDs. An untrusted ACP connection strips all reserved prompt
metadata and creates an `acp` root.

This prevents request-level spoofing by ordinary or remote ACP peers. It does
not attempt to defend against a hostile process running as the same OS user
that deliberately emulates the private launcher; that user already controls
the child process and local MCP processes.

## MCP disclosure policy

Disclosure is based on transport ownership, not on a user-configurable server
type or URL. The internal allow bit is set only where Qwen Code constructs a
`StdioClientTransport`. Streamable HTTP, SSE, WebSocket, SDK/reverse transport,
and unknown transports deny disclosure, including loopback URLs.

The policy follows a discovered tool through qualification and trust wrappers.
Reconnect takes the policy from the newly discovered tool; a missing policy is
deny. It is used only by the raw `DiscoveredMCPToolInvocation` path.
Computer Use, A2UI, and callable-tool fallbacks do not inject v1 metadata.

For an allowed call, Qwen Code merges the context into
`CallToolRequest.params._meta['qwen-code/invocation']`. Existing request
metadata such as `progressToken` remains intact. Tool arguments, including an
`arguments._meta` property generated by a model, cannot overwrite request
metadata. When disclosure is denied or no runtime context exists, only the
reserved invocation property is removed.

## qwen-serve-mcp bindings

qwen-serve-mcp keeps one immutable binding record per attached session. The
record contains the session ID, optional legacy client ID, SSE stream, and its
single release promise. Changing the default session changes only a pointer;
other attached sessions stay live.

Load, resume, and close operations are serialized per known session. Create is
committed under the returned session ID after the server responds. A binding
with an active prompt collector cannot be replaced. A successful replacement
installs the new record before releasing one acquisition of the old record;
failure preserves the old record.

Asynchronous stream finalizers and error handlers may remove state only when
their captured record is still current. Prompt cancellation captures the same
record as the prompt and does not replay on an invalid client ID. Idle cleanup
skips active collectors.

Release performs at most one detach attempt per acquisition. Pending detach
promises remain tracked after a record leaves the map. Session lifecycle
operations, including the acquisition phase before create has a session ID,
are tracked as well. The exported idempotent `dispose()` rejects new lifecycle
work, waits for in-flight lifecycle work to settle, releases any resulting
current records, and then waits for all pending releases.

An active prompt handler is tracked through its abort cancellation and
collector cleanup. Shutdown drains that handler before releasing its binding,
so detach cannot overtake cancellation and leave the daemon turn running.

For an accepted asynchronous daemon prompt, `DaemonClient` owns cancellation
until prompt admission has settled and awaits that cancel before returning an
abort. The bridge owns cancellation only after admission has settled while it
is still collecting events. This single-owner boundary prevents a delayed
session-level cancel from reaching the next turn. MCP close, SIGINT, SIGTERM,
and stdin close share one shutdown promise.

## Compatibility and exclusions

There is no feature flag or persisted migration. Older MCP servers ignore the
namespaced request metadata, and older daemons continue to use the anonymous
client path. v1 does not change opencode, remote MCP transports, Computer Use,
A2UI, or the durable prompt history schema.

Normative examples, including rejected payloads, are in
`v1-conformance.json`.
