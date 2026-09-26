# Managed Agent Eager Authoritative Turn P7

## Status

P7 removes Runtime readiness from the critical path of the authoritative model
turn. It remains experimental behind
`qwen serve --experimental-managed-agents`.

The resident Gateway owns a versioned, immutable Agent Definition containing
the read-only Tool declarations that may be shown to the model. On admission,
the Gateway starts the authoritative model request and Runtime provisioning in
parallel. The model waits for the Runtime only if it emits a local Tool Call.

## Target timeline

```text
admit Prompt
  +--> authoritative Gateway model starts immediately
  |      +--> no Tool Call: stream and commit final answer
  |      `--> Tool Call: emit tool_requested -> WAITING_RUNTIME
  |                                      -> validate Runtime capability
  |                                      -> execute Tool
  |                                      -> continue the same model context
  `--> provision or restore isolated Runtime concurrently
```

There is no separate bootstrap model response in the P7 path. The first model
output is authoritative and is committed to Gateway-owned conversation
history.

## Gateway-owned Agent Definition

At daemon startup, the resident runner snapshots the safe Tool declarations
from its build-owned registry. The definition contains:

- schema version `1`;
- an immutable set of `Read`, `Search`, and `Fetch` declarations;
- a stable definition id containing the versioned declaration digest.

The definition is ready before a user Prompt. The model therefore does not
need a live Runtime manifest to begin inference.

This local prototype derives the snapshot from an untrusted, safe-mode,
workspace-settings-disabled Gateway `Config`. It initializes that Config with
MCP discovery, hooks, skills, and checkpointing disabled before publishing the
definition. A production control plane should publish signed, versioned Agent
Definitions independently of any tenant Runtime.

## Runtime compatibility handshake

When the model requests a Tool, the Gateway waits for the Session Runtime and
fetches its live manifest. Before execution it verifies:

1. the Runtime manifest digest binds its declarations;
2. the requested Tool exists in both definitions;
3. name and input schema match after JSON normalization;
4. the Runtime still classifies the Tool as read-only;
5. the execution request pins the Runtime's current capability digest.

Descriptions may differ because they are presentation text; executable schemas
may not. Any mismatch fails closed before Tool dispatch.

## Runtime warmup lifecycle

Runtime provisioning is daemon-owned rather than Prompt-deadline-owned. A
Prompt that does not need a local Tool may complete while warmup continues.
The resulting binding is cached for later turns. A Tool wait still observes the
Prompt deadline, but timing out that wait does not blindly retry or duplicate a
Runtime creation already in progress.

Warmups are single-flight per Session, source-bound to `managed-gateway`, and
aborted during daemon shutdown. A failed warmup is removed so a later turn can
retry. A continuation first resumes persisted Runtime state and falls back to a
fresh source-bound Runtime only when no persisted Session exists.

A Managed Runtime Session permanently holds automatic cron, Goal, and
notification drains. The bridge rejects model-starting Prompt, Goal control,
and Workflow control surfaces for that Session, while the HTTP and generic ACP
routing layers hide both live and persisted Runtime state from Session
discovery, inspection, mutation, restore, and lifecycle routes. Consequently,
only the Gateway's manifest, Tool execution,
cancellation, and lifecycle calls can enter the Runtime; restored local
automation cannot start a second model loop there.

`runtime_ready` or `runtime_failed` may be journaled after a no-Tool turn has
already completed. The original SSE closes at the terminal turn event; a later
status read or reconnect can observe the updated readiness. Durable Prompt
outcome and Runtime readiness remain separate axes.

## Failure semantics

- Model or history failure fails the turn.
- Runtime failure fails the turn only if the model needs a local Tool.
- A no-Tool answer may complete with `runtimeReady=false` while warmup continues.
- Prompt deadline aborts model streaming and any wait for a Tool result; it does
  not replay a dispatched Tool.
- Runtime identity, schema, or digest mismatch fails before execution.
- Exact HTTP retry returns the durable outcome and does not start another model
  turn or Runtime warmup.
- Terminal `completed` and `failed` events are published only after the durable
  Prompt outcome commits, so an immediate next turn cannot race the terminal
  event.
- A Session whose initial turn failed has no committed conversation history and
  rejects continuations; the client must create a new Session. Its cached or
  late-arriving Runtime Session is discarded because it cannot be reused.
- Gateway shutdown aborts pending warmups and cleans up any late Runtime Session.

## Scope and remaining production gaps

P7 proves the desired latency boundary in one daemon process. It does not yet
provide authenticated multi-tenant identity, a distributed Runtime registry,
lease/fencing over a remote transport, permission UI, mutating Tools, signed
Agent Definitions, an atomic recovery boundary across the Prompt journal and
conversation history, bounded journal/history compaction and retention, or provider-credential stripping from the ordinary
local ACP child. The local prototype also requires `qwen serve` itself to be
running; it does not expose the resident Gateway route during that daemon's own
cold bootstrap. Those remain required before deployment as a real Managed
Agents service.

The [Managed session surfaces](managed-agent-session-surfaces.md) follow-up
adds durable display replay for new events, Gateway catalog/history reads,
independent Runtime state, exact-Prompt cancellation, and a capability-gated Web
Shell surface. Its upgrade and retention boundaries are documented separately.

## Exit criteria

1. `agent_started` is emitted before `runtime_ready` for a delayed Runtime.
2. A no-Tool authoritative answer completes without calling `getManifest`.
3. A Tool turn emits output or thought before Runtime readiness when the model
   provides it, then waits only at the Tool boundary.
4. The Tool executes once after manifest/schema validation and feeds the next
   Gateway model round.
5. Multi-turn history, exact retry, conservative restart recovery, deadline
   cancellation, and generic Runtime isolation remain intact.
