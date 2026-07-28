# Workspace Generation

## Goal

Provide stateless, tool-free model generation scoped to the resolved workspace
runtime without requiring a live session.

## Ownership

`POST /workspace/generate` is legacy-primary-workspace-runtime scoped. It uses
the bound workspace's provider, model configuration, trust boundary, and ACP
child, but does not read or mutate session history. The bridge must create that
workspace channel when none exists, pin it for the complete request, and return
it to the normal idle-reap lifecycle after completion, failure, or
cancellation. It must never fall back to another workspace runtime.

## Public protocol

The request body is `{ "prompt": string }`; the prompt must be non-empty and no
larger than 32 KiB of UTF-8. A successful request is always SSE and follows the
session-generation v1 envelope. Like session generation, the route uses the
normal mutation gate because it spends model tokens without mutating durable
workspace state.

- `started`: `v`, `type`, `requestId`, `model`, `modelSource`
- `thinking`: `v`, `type`, `requestId`
- `delta`: `v`, `type`, `requestId`, `seq`, `text`
- `done`: `v`, `type`, `requestId`, `model`, `modelSource`, optional usage
- `error`: `v`, `type`, `code`, `message`

The route writes an initial connection comment, periodic heartbeats, respects
HTTP backpressure, cancels on disconnect, and emits exactly one terminal
`done` or `error` event.

## Existing Agent generation

`POST /workspace/agents/generate` keeps its existing request and compatibility
contract and remains independent from this interface. It returns the generated
agent as JSON through the existing `subagentGenerator` path. New UI flows may
choose the generic workspace interface when they only need free-form prompt
text, but this does not change the old route or SDK helper.

## Compatibility

- Session generation is unchanged.
- Agent generation request and JSON response shapes are unchanged.
- Existing Agent-specific ACP and SDK methods remain available.
