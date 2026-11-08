# External Tool Guard Provider for Managed ACP

Status: implementation design
Tracking issue: https://github.com/QwenLM/qwen-code/issues/8102
Depends on: https://github.com/QwenLM/qwen-code/pull/8032

## Problem and scope

Qwen Code already supports permission rules and hooks, but those mechanisms do
not give a managed `qwen serve` deployment a mandatory, external,
machine-verifiable decision immediately before every tool executor. PR #8032
adds that executor-boundary callback. This change connects the callback to a
small external provider for managed ACP deployments.

The scope is intentionally one decision:

> Given the runtime-owned session and prompt identity, the runtime-accepted
> tool-call correlation label, the canonical tool name, and final arguments,
> may this invocation execute now?

This change does not add a task protocol, result callback, observer/replay
service, general hook replacement, or an authorization layer for explicit
daemon control/management APIs. It also does not make an allowed tool
implementation deterministic or sandbox the behavior of a command that the
provider chose to allow.

## Safety contract

- Activation is process-start only: `off` (default) or `required`.
- In `off`, no provider is constructed, no provider RPC is made, and no
  capability is advertised. With none of the new inputs present, standalone
  CLI / ordinary ACP behavior is unchanged. The reserved token environment
  variable is still scrubbed from descendant execution environments if set.
- In `required`, daemon startup performs an authenticated, versioned handshake.
  Missing or invalid configuration and an unavailable or incompatible provider
  fail daemon startup.
- Every supported top-level invocation that passes the existing permission and
  `PreToolUse` gates and reaches the final execution boundary performs exactly
  one bounded `prepare` request. An earlier permission/hook denial performs no
  provider request. There is no retry. Timeout, cancellation, transport
  failure, malformed response, identity mismatch, or explicit denial prevents
  the executor from running.
- The inherited PR #8032 order is permission handling, `PreToolUse` hooks,
  then this Guard, then the target executor. The Guard authorizes only the
  target tool executor; it does not authorize or sandbox hook behavior.
  Managed deployments that require an all-effects boundary must disable hooks
  or trust and govern them independently.
- Slash-command actions are resolved before model/tool scheduling and are not
  Tool Guard invocations. Some built-ins can directly mutate files or
  settings. Except for the explicitly rejected nested-agent entries below,
  this change does not classify slash commands; managed hosts must reject
  slash-command input or disable non-approved commands with
  `slashCommands.disabled` / `--disabled-slash-commands`.
- Provider credentials remain in the `qwen serve` process. They are never
  copied to the ACP child, channel worker, tool subprocess, MCP server, hook,
  or sub-agent environment. The CLI captures and deletes the ambient token
  before runtime environment snapshots are frozen.
- The child-to-parent guard request uses the existing private ACP channel. The
  bridge accepts it only for a session owned by that channel and only when its
  prompt ID equals the bridge's active prompt ID.
- Every ACP channel must acknowledge `required-v1` in its initialize response,
  proving that the child consumed the private marker and installed the
  executor callback. A missing or mismatched acknowledgement rejects the
  channel before any Session can be created.
- Managed ACP does not start the interactive suggestion-speculation runtime.
  If an embedding independently reaches the PR #8032 speculation path, the
  same callback is still required before apply.
- V1 supports only top-level tool invocations made during an active foreground
  managed Prompt. `agent`, `workflow`, `create_sub_session`, `send_message`,
  the direct `/fork` entry point, and agent-backed workspace memory
  remember/dream controls are rejected before they can start, resume, or
  delegate to an independent AgentCore/Session. Automatic/cron turns and
  restored background agents carry no active managed Prompt context, so their
  guarded tools fail closed.
- A top-level shell invocation with `is_background=true`, or a `monitor`
  invocation, is still one guarded invocation: the provider sees its final
  arguments and may deny it. The Guard does not continuously authorize the
  launched process or add a new process-completion audit protocol. Managed
  policies that require foreground completion must deny those argument/tool
  shapes.
- A guarded MCP transport error is treated as an ambiguous result and is not
  automatically reconnected/replayed. The previous allow cannot authorize a
  second execution attempt.
- Existing ACP `session/update` tool lifecycle events remain the source of
  execution observation. The provider request and those events correlate on
  `sessionId`, `promptId`, and `toolCallId`.

Identity strength is deliberately explicit:

- `sessionId` is generated and owned by the daemon/ACP Session;
- `promptId` is generated by the daemon and rebound after caller metadata is
  stripped;
- `toolCallId` is a runtime-accepted correlation label. It may originate in the
  model tool call, so it is not an authentication subject or a standalone
  idempotency key;
- `requestId` is generated by `qwen serve` for the one provider RPC. It is the
  provider decision-operation identifier, but existing lifecycle events
  correlate using the full `(sessionId, promptId, toolCallId)` tuple.

## Configuration

```bash
export QWEN_CODE_EXTERNAL_TOOL_GUARD_TOKEN='replace-with-local-secret'

qwen serve \
  --external-tool-guard-mode=required \
  --external-tool-guard-endpoint=http://127.0.0.1:8787 \
  --external-tool-guard-timeout-ms=3000
```

Rules:

- `--external-tool-guard-mode` accepts `off|required` and defaults to `off`.
- `required` requires an origin-only loopback HTTP(S) endpoint and a non-blank
  token of at most 8192 UTF-16 code units without control characters from
  `QWEN_CODE_EXTERNAL_TOOL_GUARD_TOKEN`.
- Endpoint userinfo, query, fragment, and non-root paths are rejected.
- `localhost` is pinned by the client to `127.0.0.1` (with `localhost` SNI for
  HTTPS); it is never resolved through ambient DNS or proxy configuration.
- Timeout is an integer from 100 through 30000 ms. The default is 3000 ms.
- Endpoint and token without `mode=required` do not activate a provider. The
  reserved token is still consumed and scrubbed rather than exposed to tools.

## Runtime data flow

```mermaid
sequenceDiagram
    participant Host as "DataAgent / operator"
    participant Serve as "qwen serve"
    participant Guard as "External Guard"
    participant ACP as "private qwen --acp"
    participant Exec as "Tool executor"

    Host->>Serve: "start with mode=required"
    Serve->>Guard: "POST /v1/handshake (Bearer token)"
    Guard-->>Serve: "version + nonce + prepare capability"
    Serve->>ACP: "spawn; private ACP capability + required marker"
    ACP-->>Serve: "initialize acknowledgement: required-v1"
    Host->>Serve: "prompt"
    Serve->>ACP: "prompt + runtime-owned sessionId/promptId"
    ACP->>ACP: "permission + PreToolUse gates"
    ACP->>Serve: "private extMethod prepare(sessionId,promptId,toolCallId,name,args)"
    Serve->>Serve: "verify owned session + active prompt"
    Serve->>Guard: "POST /v1/prepare (exactly once)"
    Guard-->>Serve: "allow or deny"
    Serve-->>ACP: "decision"
    alt "allow"
        ACP->>Exec: "execute final invocation"
        ACP-->>Serve: "existing tool_call_update terminal event"
    else "deny / unknown / timeout / cancel"
        ACP-->>Serve: "existing EXECUTION_DENIED/cancelled terminal event"
    end
```

## Wire contract

All bodies use UTF-8 JSON and `Content-Type: application/json`. Requests use
`Authorization: Bearer <token>`. Redirects are not followed. Response bodies
are bounded before JSON parsing. A serialized request may not exceed 1 MiB, a
response may not exceed 64 KiB, and a denial reason may not exceed 500 UTF-16
code units or contain control characters.

Final tool arguments are application data and may contain source code, paths,
queries, or credentials supplied to a tool. The provider must treat them as
sensitive and must not persist them indiscriminately merely because the
transport is loopback.

Handshake request:

```json
{
  "protocolVersion": 1,
  "nonce": "runtime-random-value",
  "client": "qwen-code"
}
```

Handshake response:

```json
{
  "protocolVersion": 1,
  "nonce": "same-runtime-random-value",
  "capabilities": { "prepare": true }
}
```

Prepare request:

```json
{
  "protocolVersion": 1,
  "requestId": "runtime-random-value",
  "sessionId": "runtime-owned-session-id",
  "promptId": "runtime-owned-prompt-id",
  "toolCallId": "runtime-accepted-tool-call-correlation-id",
  "toolName": "canonical_tool_name",
  "arguments": { "final": "tool arguments" }
}
```

Allow response:

```json
{
  "protocolVersion": 1,
  "requestId": "same-runtime-random-value",
  "allowed": true
}
```

Deny response:

```json
{
  "protocolVersion": 1,
  "requestId": "same-runtime-random-value",
  "allowed": false,
  "reason": "Safe user-visible policy reason"
}
```

Unknown fields, wrong versions/nonces/request IDs, invalid booleans, oversized
bodies, and unsafe denial reasons are protocol failures and therefore deny.

## Source implementation map

| Concern                                                                     | Implementation point                                                                |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| CLI flags, token capture, and non-serve bootstrap scrubbing                 | `packages/cli/src/commands/serve.ts`, `packages/cli/src/cli.ts`                     |
| Public embedded options                                                     | `packages/cli/src/serve/types.ts`                                                   |
| Config validation, loopback HTTP client, handshake, response parsing        | `packages/cli/src/serve/external-tool-guard-provider.ts`                            |
| Provider construction, boot handshake, capability and bridge wiring         | `packages/cli/src/serve/run-qwen-serve.ts`                                          |
| Shared private ext-method and handler types                                 | `packages/acp-bridge/src/status.ts`, `bridgeOptions.ts`                             |
| Owned-session / active-prompt validation                                    | `packages/acp-bridge/src/bridgeClient.ts`                                           |
| Bridge injection                                                            | `packages/acp-bridge/src/bridge.ts`                                                 |
| Private required marker capture, token scrubbing, and relaunch preservation | `packages/cli/src/gemini.tsx`                                                       |
| Per-session Config injection and child callback                             | `packages/cli/src/acp-integration/acpAgent.ts`, `packages/cli/src/config/config.ts` |
| Required child acknowledgement and parent-side admission                    | `packages/cli/src/acp-integration/acpAgent.ts`, `packages/acp-bridge/src/bridge.ts` |
| Runtime context at executor boundary                                        | `packages/core/src/core/tool-invocation-guard.ts` and the three PR #8032 call sites |
| Conditional feature advertisement                                           | `packages/cli/src/serve/capabilities.ts`                                            |

## Compatibility and failure behavior

| Deployment                                             | Expected behavior                                                |
| ------------------------------------------------------ | ---------------------------------------------------------------- |
| `qwen` interactive/headless                            | Existing execution behavior unchanged when new inputs are absent |
| `qwen --acp` launched by an IDE                        | No provider; private marker absent                               |
| `qwen serve` with no new flags                         | No provider, no capability, current preheat/retry behavior       |
| `qwen serve`, endpoint/token present, mode omitted/off | No provider/capability; reserved token is scrubbed from children |
| `qwen serve`, required, valid provider                 | Capability advertised; every supported top-level tool is guarded |
| `qwen serve`, required, invalid config/handshake       | Listener does not start                                          |
| Required, child does not acknowledge installed Guard   | ACP channel is rejected before Session creation                  |
| Required provider fails during a turn                  | Invocation becomes denied; executor count remains zero           |
| Required, unsupported nested/hidden AgentCore entry    | Rejected locally before nested execution starts                  |
| Required, MCP response is lost/connection closes       | First attempt fails; no automatic reconnect or replay            |

The capability is `external_tool_guard` and is advertised only when required
mode completed its startup handshake.

## Verification plan

Unit and contract tests must prove:

1. strict endpoint/config validation;
2. authenticated handshake, nonce/version/schema validation and body limits;
3. allow, explicit deny, timeout, abort, connection failure and malformed
   response, with no retry;
4. BridgeClient rejects unknown session and stale prompt identity before calling
   the provider;
5. default-off creates no provider and advertises no capability;
6. token never enters the ACP child's effective environment;
7. required marker survives the existing relaunch path but is deleted before
   tools can inherit the ACP process environment;
8. required mode injects the callback into every live ACP session Config;
9. every required ACP channel must acknowledge the installed callback before
   Session creation;
10. managed ACP does not start suggestion speculation, and a separately invoked
    speculation path still requires the callback before apply;
11. nested/delegating `agent`, `workflow`, `create_sub_session`,
    `send_message`, direct `/fork`, and agent-backed workspace memory controls
    are rejected, while automatic/background turns without the active Prompt
    context fail closed;
12. a guarded MCP connection error performs one call and no reconnect/replay;
13. a managed ACP end-to-end case matches the provider's
    `sessionId/promptId/toolCallId` to existing start/terminal events and proves
    executor count is one for allow and zero for deny/failure.

Run focused package tests, repository build/typecheck/lint, and the daemon E2E
suite. The PR report records commands and exact results.

## Non-goals and follow-ups

- Unix-domain socket transport; v1 uses an origin-only loopback HTTP(S)
  endpoint.
- Provider-side decision replay or idempotent re-submission; Qwen Code sends no
  retries.
- Nested/delegated execution lineage (`agent`, `workflow`,
  `create_sub_session`, `send_message`, `/fork`), agent-backed workspace
  memory controls, and a future attempt-aware Guard protocol. V1 rejects those
  nested/hidden agent entry points rather than claiming unsupported
  correlation.
- Result reporting or audit storage in Qwen Code. The provider and DataAgent
  own their audit records; Qwen Code supplies stable correlation keys and
  existing lifecycle events.
- Continuous authorization or a new terminal-result contract for a background
  shell/monitor process after its guarded start. Providers may reject those
  invocations from their final tool name and arguments.
- A business Task API, plan approval, grants, or DataAgent-specific policy.
- Authorization or sandboxing of hook implementations. `PreToolUse` runs
  before this executor Guard under the PR #8032 contract.
- Authorization of slash-command actions. They run before the tool scheduler;
  managed hosts that need an all-effects boundary must reject slash-command
  input or maintain a strict deployment denylist outside this feature.
- Semantic inspection or sandboxing of an allowed tool implementation or
  shell command. The provider decides over the canonical name and final
  arguments; a managed deployment must combine that decision with its
  existing tool policy and isolation boundary.
- Authorization for explicit daemon REST/ACP control operations; those remain
  governed by the daemon's existing authentication and API contracts.
