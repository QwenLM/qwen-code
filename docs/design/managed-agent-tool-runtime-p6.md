# Managed Agent Tool-only Runtime P6

## Status

Historical design only. P7 retains P6's Gateway-owned conversation and
Tool-only Runtime protocol but removes its separate bootstrap response and the
Runtime-readiness gate before the authoritative model request.

P6 replaced the authoritative ACP model turn in the experimental Managed
Gateway with a resident Gateway-owned agent loop and a Tool-only ACP Runtime.
It remains opt-in behind `qwen serve --experimental-managed-agents`.

The first useful progress message still starts while the workspace Runtime is
provisioned. Once ready, the Runtime publishes a capability manifest and only
executes selected local Tool Calls. It never receives the user Prompt and never
calls a model provider.

Runtime readiness races the bootstrap stream. If the Runtime becomes ready
first, the Gateway stops forwarding bootstrap output, cancels that request, and
starts the authoritative loop immediately. If Runtime provisioning is slower,
bootstrap deltas continue to provide early feedback until the switchover.

## Experience contract

```text
POST /managed/sessions
  -> durable admission
  -> resident Gateway bootstrap model and Runtime startup overlap
  -> Runtime exposes an immutable read-only capability manifest
  -> resident Gateway runs the authoritative model/Tool loop
  -> local Tool Calls execute in the ACP Runtime process
  -> Gateway streams and persists the final model history

POST /managed/sessions/:id/prompts
  -> restore Gateway history and Runtime binding when necessary
  -> resident Gateway advances the same conversation
  -> Runtime remains Tool-only
```

P6 deliberately supports only tools whose registered kind is `Read`, `Search`,
or `Fetch`. This includes read-only Skill discovery and MCP resources/tools
when their registry metadata classifies them as safe reads. Mutating tools,
shell execution, agent creation, stateful Skills, and MCP tools without an
explicit read-only classification remain hidden until the Managed API has an
explicit permission and side-effect contract. This is a protocol slice, not a
claim that the complete production capability set is available.

## Ownership boundaries

| Concern                                                                     | Owner                           |
| --------------------------------------------------------------------------- | ------------------------------- |
| Admission, Session identity, model credentials, model history, final answer | resident Gateway/Harness        |
| Workspace files, local tool registry, MCP transports, Tool execution        | ACP Runtime                     |
| Runtime placement and internal ACP client id                                | daemon workspace registry       |
| Client correlation within this local daemon                                 | durable Managed Gateway binding |

The Gateway does not read workspace files directly and the Runtime does not
receive model-provider credentials through the P6 protocol. The existing ACP
child may still load ordinary Qwen Code modules, but P6 never invokes its
Prompt method.

This local slice is not yet a production multi-tenant authentication boundary.
It currently uses `workspaceId` as `tenantId`, and `managedClientId` is a
caller-supplied correlation secret rather than an identity issued by an
authenticated control plane. A remote deployment must derive tenant and user
identity from the Gateway's authenticated request context and must never trust
either field from the request body or header.

## Private Runtime protocol

The bridge exposes three typed, session-scoped operations rather than a generic
ACP command tunnel:

1. `getManagedRuntimeToolManifest` returns stable function declarations plus a
   digest for the current Runtime Session.
2. `executeManagedRuntimeTool` executes one call identified by Session, turn,
   execution, and Tool Call ids and requires the pinned digest.
3. `cancelManagedRuntimeTool` aborts the matching execution best-effort when the
   Gateway turn is cancelled or reaches its deadline.

The child recomputes the manifest before dispatch and rejects digest drift,
unknown tools, unsafe kinds, malformed arguments, duplicate active execution
ids, and mismatched cancellation. Tool errors are returned as model-consumable
function responses; protocol and identity errors fail the Managed turn.

P6 returns terminal Tool results over the private request/response channel.
Existing ACP permission and Tool Scheduler machinery remains authoritative.
Progress streaming and permission responses through the Managed API are later
slices.

## Gateway agent loop

The resident model receives the Runtime manifest only after Runtime readiness.
It may answer without a Tool Call or request one or more safe tools. The Gateway
normalizes missing provider call ids, executes calls sequentially, appends
paired function responses, preserves provider reasoning signatures required by
subsequent model rounds, and continues until a text answer is produced.
Turns are bounded by a fixed Tool round and Tool Call limit.

That means P6 proves model ownership and Tool-only execution, but its
authoritative model call still waits for Runtime readiness. The concurrent
bootstrap request is a non-authoritative progress path, not early execution of
the real agent turn. Moving a versioned capability manifest into the
Gateway-owned Agent Definition is the next latency slice: the authoritative
model can then start before a Pod or process is ready and wait only when it
actually reaches a local Tool boundary.

Bootstrap output remains non-authoritative and is not committed as assistant
conversation history. Only the authoritative Gateway loop commits a turn.
The Gateway model configuration and conversation journal are initialized during
daemon startup rather than on the first user request.

## Durable conversation history

P5 relied on the ACP model transcript. Removing that model loop requires the
Gateway to own replayable history. P6 adds an append-only Gateway conversation
journal under the existing Managed state directory. Each committed record
contains a complete bounded history snapshot and the message id that advanced
it.

On restart, the latest valid snapshot per Session is restored before accepting
a continuation. A completed durable inbox message without a corresponding
conversation commit is treated as inconsistent and must not be silently
replayed. A crash during Tool execution remains ambiguous and follows the
existing at-most-once failure rule.

## Events

The Session event ring adds explicit Gateway-owned authoritative events:

```text
assistant_thought
assistant_delta
tool_requested
tool_completed
```

Every event carries the current Prompt id. Runtime client ids, execution lease
metadata, Skill bodies, and provider credentials are never exposed. Existing
bootstrap and terminal events remain unchanged. The event ring is an ephemeral
stream cache and resets with the daemon; durable Prompt status and conversation
history remain the recovery authorities.

## Failure semantics

- Runtime startup, manifest, or identity failure terminates the turn; bootstrap
  output is never promoted to a final answer.
- A deadline aborts the Gateway model stream and requests cancellation of the
  active Runtime execution.
- Capability drift fails closed before Tool dispatch.
- The Gateway independently verifies that the capability digest binds the
  received declarations and bounds manifest and Tool-result payloads.
- Mutating or undeclared tools are not sent to the model and cannot be invoked
  through the private method.
- Tool execution is never retried after dispatch.
- A conversation commit failure fails the activation even if preview output was
  already streamed; the durable inbox remains authoritative.
- An exact HTTP retry returns the durable prior outcome without another model or
  Tool call.

## Compatibility and scope

Existing Session and ACP Prompt APIs are unchanged. The private Runtime methods
are reachable only through a live, source-validated Managed Session and its
daemon-owned internal client id. A `managed-gateway` Runtime Session is hidden
from generic Prompt, continuation, recap, side-generation, fork-agent, and
automatic-follow-up surfaces, so knowing its Session id cannot route model work
into the child loop.

P6 uses one daemon and its existing ACP child process. A production Pod can run
the same child protocol over the existing private channel, but distributed
placement, authenticated Runtime registration, permission UI, mutating tools,
MCP/Skill capability refresh, durable Tool result streaming, and side-effect
ledgers remain later work. P6 uses the Gateway's configured resident model and
does not expose a per-Session model override.

The local P6 adapter resolves an existing daemon `WorkspaceRuntime` and calls
its private ACP bridge directly. A remote Runtime transport must converge this
with the P0 broker's tenant, lease, and fencing contract; the direct ACP method
must not become a public cross-host API.

P6 also does not yet prove credential absence inside the ordinary local ACP
child: it proves only that model credentials are not sent over the Tool-only
protocol and that no model turn is invoked through either the Managed or
generic Prompt path. A production remote launcher must explicitly strip model
provider environment and configuration from the Runtime image.

## Exit criteria

1. When Runtime startup is deliberately delayed beyond the model's first
   delta, bootstrap output is observable before Runtime readiness.
2. The authoritative model call runs in `ResidentManagedGatewayModelRunner`.
3. The Runtime receives no Prompt and performs no model generation.
4. A model-selected read-only Tool executes once inside the ACP child and its
   result feeds the next Gateway model round.
5. Final assistant deltas and terminal status use the existing Managed stream.
6. A follow-up preserves Gateway-owned context before and after daemon restart.
7. Wrong identity, capability drift, unsafe tools, cancellation, overlap, and
   exact retry fail according to the contracts above.
