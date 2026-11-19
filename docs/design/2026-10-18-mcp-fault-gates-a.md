# Hosted MCP fault gates FG12a: lost replies

[English](2026-10-18-mcp-fault-gates-a.md) | [简体中文](2026-10-18-mcp-fault-gates-a.zh-CN.md)

## Problem and scope

Issue #14447 is Stage F round FG12 of #12380: fault gates for the Hosted
MCP domains `mcp_configuration` and `mcp_operation`. The round has six
letters (FG12a–f). This slice implements **FG12a, the control-path lost
replies**, and nothing else.

The property under gate: after an upstream MCP control answered, a lost
reply must be resolved by a **status lookup on the original operation
id**, never by a second configure or invoke. The Runtime joins a repeated
id within one generation, so a resend hides a second physical effect; the
gate therefore asserts the **wire sequence at a Broker proxy**, not only
the Runtime's join.

Three cases ship:

| Case                  | Injection                                                                   | Expect                                                                                                                                                        |
| --------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `configure-reply`     | The replacement `mcp-configure` reply is dropped after the Runtime answered | Exactly one `mcp-configure` control, then an `mcp-status` lookup; the configuration record settles with the replacement revision; no second configure         |
| `resource-read-reply` | The `mcp-invoke` reply for a `resource_read` is dropped                     | Exactly one `mcp-invoke`, an `mcp-status` lookup, the operation record settles with a `resultRef`, and the fixture records exactly one `resource_read` effect |
| `prompt-get-reply`    | The `mcp-invoke` reply for a `prompt_get` is dropped                        | Same shape, exactly one `prompt_get` effect                                                                                                                   |

Deferred to later slices of #14447: `mcp-cancel` and `mcp-release` reply
loss, the Broker owner-release ack, an MCP tool call's start (the ordinary
tool ledger, not the MCP control path), and all of FG12b–f.

## Current state

- `HostedMcpSession.dispatch()` already falls back to `lookup()` when the
  control throws (`packages/cli/src/serve/hosted-mcp-session.ts`), and
  `lookup()` turns any failure into `outcome_unknown`.
- The Runtime joins a repeated operation id within one generation
  (`managed-mcp-runtime.ts`), which is why the wire, not the effect count,
  is the primary witness.
- #14357's `HostedExtensionsIT` proves the packaged boot: a real Harness,
  a durable worker, a real stdio MCP server on MySQL, and lifecycle-v2
  close. It never drops a reply and never creates an `mcp_operation`.
- `HostedMcpReplyLossIT` reuses that boot shape: in-JVM Spring, a real
  MySQL schema, a Broker-fronting proxy, a real Harness and worker, and a
  stdio fixture. A baseline turn performs the initial configuration; the
  private `mcp/configurations` route is replacement-only
  (`expectedRevision` must equal the current revision), so the injected
  configure is a revision-2 replacement.

## Gate ledger

Ground truth is the Broker proxy's wire, the `mcp_configuration` /
`mcp_operation` extension records read over JDBC, and the stdio fixture's
effect log. Every case first establishes its injection: the configure case
asserts the dropped control was forwarded (status 200 at the proxy) before
the lookup; the invoke cases assert the effect count.

**Mutation witness.** Change `dispatch()`'s fallback from `lookup()` to a
second `broker.control()` and the proxy must show a second `mcp-configure`
or `mcp-invoke` where a lookup belonged. The Runtime's id join would hide
the duplicate effect, so the witness is the wire assertion. The witness was run red: with
`dispatch()`'s fallback changed to a second `broker.control()`, the proxy
recorded two `mcp-configure` controls and the gate failed with
`Expected size: 1 but was: 2`; restoring the source and re-bundling
returned it green.

## Fixture design

`HostedMcpReplyLossIT` boots one in-JVM Spring (MySQL required, absence
fails rather than skips), seeds one workspace and storage registration,
pins the Harness broker URL at a Java `HttpServer` proxy, and starts the
packaged Harness with `hosted-workspace-mcp/1`. The proxy forwards every
end-to-end header (including `X-Qwen-Lifecycle-*`) and, for one named
control kind, forwards the request, reads the upstream answer, then closes
the connection **without writing a response** — a connection-level loss,
not an HTTP refusal.

A session is created twice, as FG8 does: the public
`insertWorkspaceSessionCommand` row first (the Broker's scope resolver
reads it), then `POST /session` on the Harness with the managed-session
store descriptor. A single baseline turn performs the initial MCP
configuration. The fixture serves `tools`, `resources` and `prompts` so
both raw operation kinds are discoverable, and records every physical
effect to a JSONL evidence file.

Evidence lands in `target/fg12-cases/fg12a/<tenant>/`; the CI upload carries it.

## Acceptance

- `mvn -DskipTests test-compile checkstyle:check` clean.
- The class green locally on JDK 21 + MariaDB 10.11 (measured 5.1-7.4 s), and
  the mutation witness red before merge.
- `scripts/tests/hosted-process-ci.test.js` green with the fork budget
  moved from 4484 s to 4499 s and the healthy sum from 3874 s to 3889 s.
- This design ships in both languages with matching structure.

## Open questions

- Whether the cancel/release letters can reuse this proxy unchanged
  (they need an in-flight operation and a lifecycle-v2 close).
- Whether FG12c/d need a Broker-only replacement seam; a whole-Spring
  restart replaces the storage guard, which cannot re-register a held
  storage, and that blocks the detach before the Broker release.
