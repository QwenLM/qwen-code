# Trusted daemon invocation context

## Goal

Carry daemon-attested identity for one accepted root prompt to MCP servers that Qwen launches over stdio. The context is correlation metadata, not an authorization credential.

The complete production path is:

```text
daemon prompt admission
  -> private ACP child
  -> root Session turn
  -> Qwen-launched stdio MCP tools/call request metadata
```

## Wire contract

Qwen adds the following value to `tools/call.params._meta["qwen-code/invocation"]`:

```ts
interface InvocationContextV1 {
  version: 1;
  sessionId: string;
  promptId: string;
  originatorClientId?: string;
}
```

- `sessionId` is the live daemon session selected by the request route.
- `promptId` is fixed when the daemon admits the prompt, before it waits in the per-session queue. Non-blocking callers may supply the correlation id used by existing terminal-event matching; otherwise the daemon generates a UUID. In either case the value identifies the prompt the daemon actually admitted, rather than metadata copied from the prompt body.
- `originatorClientId`, when present, is the request header value after the daemon verifies it is registered on that session.
- Unknown fields, unknown versions, and blank identifiers are invalid.

The daemon removes caller-provided values for the reserved metadata keys and reconstructs the context from its own state. It passes the value only to the ACP child it launched and authenticated with a per-process capability. Standalone ACP callers cannot inject the reserved context.

## Lifetime and disclosure

The ACP Session verifies that the context session matches its actual session and binds it to the root prompt with `AsyncLocalStorage`. Concurrent prompts remain isolated, including when they share a pooled MCP transport. Deferred confirmation callbacks explicitly restore the captured context.

Automatic cron turns, background notifications, resumed background agents, and subagent reasoning loops run with no invocation context. The context is not persisted after the root turn settles.

Only a transport instance created by Qwen as `StdioClientTransport` from an MCP `command` configuration is marked eligible. HTTP, SSE, WebSocket, reverse, SDK-provided, and client-hosted transports do not receive the metadata. The eligibility marker follows tool discovery, cloning, pooling, reconnect, and retry without becoming a public MCP configuration option.

## Non-goals

- No Browser Use, opencode, local/remote backend, page, or skill-specific behavior.
- No ingress enumeration or general provenance graph.
- No new TypeScript SDK API or qwen-serve MCP lifecycle behavior.
- No authorization decision based on `originatorClientId`.
