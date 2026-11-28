# SDK initialize reply and readiness

[English](sdk-initialize-readiness.md) | [简体中文](sdk-initialize-readiness.zh-CN.md)

## Reply and readiness

The stream JSON CLI ordinarily replies to `initialize` after configuration and
MCP discovery are ready. If the work outlasts the reply deadline, the CLI sends
the controller's success response while initialization continues. The SDK
clients treat an error response as a failed handshake. Queued prompts always
wait for readiness, and any later initialization failure is reported on those
prompts.

## Deadline and shutdown

The local SDKs send the effective client budget in `timeout.controlRequest` and
its absolute deadline in `timeout.controlRequestDeadlineUnixMs`. This lets the
CLI account for process startup and request dispatch. The CLI reserves up to
5 seconds, capped at half the remaining budget, for the response to reach the
client. This calculation assumes the SDK and CLI share a wall clock. Clients
that only send a duration keep the relative deadline. Clients that send neither
use the 55-second default.

At EOF the CLI lets the initialize reply finish. If readiness is still pending,
the CLI gives it 5 more seconds, then rejects the readiness gate so that queued
prompts can report the failure and shutdown can complete.

## Acceptance criteria

- An on-time initialization replies after MCP discovery and then serves prompts.
- The reply uses the remaining time when the client sent an absolute deadline.
- EOF preserves the initialize reply. A queued prompt receives a terminal error
  if readiness never settles, and the CLI can finish shutting down.
- If initialization fails after an early success response, queued prompts receive
  the failure and the original initialize request receives only one reply.
