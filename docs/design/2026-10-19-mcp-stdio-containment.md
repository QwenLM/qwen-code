# Hosted stdio MCP process containment

[English](2026-10-19-mcp-stdio-containment.md) | [简体中文](2026-10-19-mcp-stdio-containment.zh-CN.md)

## Problem and scope

Issue [#14503](https://github.com/QwenLM/qwen-code/issues/14503), found by the FG12 round ([#14447](https://github.com/QwenLM/qwen-code/issues/14447)), records that a Hosted stdio MCP server is spawned directly by the Runtime worker and nothing contains its process tree. The reproduction at `main` `79362c2ecc` on macOS 26.5.1 (the report is `.qwen/issues/issue-14503.md`) showed four leaks with the real `ManagedMcpRuntime`:

- a worker SIGKILL leaves an EOF-ignoring server alive, reparented to PID 1, in the Workspace and holding the manifest token;
- a graceful release leaves a server-spawned descendant alive while reporting `released: true`;
- a descendant holding stdout turns the close into `managed_mcp_drain_unknown` at 5 s and survives;
- a non-forwarding forking wrapper dies, its inner server survives, and the close is again `managed_mcp_drain_unknown`.

In every case the server shared the worker's PGID: there was no process group and no cgroup. On POSIX, this slice gives each stdio server its own process group and a launcher that reaps the group when the transport's stdin closes, whether that close is a graceful release or a worker SIGKILL. It does not add a cgroup unit, change the Broker's stopped-worker proof, or cover a descendant that calls `setsid`; Windows keeps the previous launch path.

## Decision

- On POSIX, every stdio connection is launched through a small supervisor (`managed-stdio-supervisor.ts`). It spawns the real command with `detached: true`, so the command becomes a new session and process-group leader, and pipes its stdin.
- The launcher forwards the transport's stdin to the server. On stdin EOF it ends the server's stdin, waits 1 s, sends SIGTERM to the whole group, waits 300 ms, sends SIGKILL, and exits.
- The launcher stays outside the server's process group, so the group signal never reaches it. When the worker is SIGKILLed, the launcher is reparented and its stdin reaches EOF, which starts the same reap.
- A 100 ms parent-process check reaps when the worker disappears, even while the stdin pipe is paused for backpressure. stdin EOF remains the normal trigger.
- The SDK's `StdioClientTransport.close()` ends the launcher's stdin and waits up to 2 s before escalating. The launcher's roughly 1.5 s bound fits that first window.
- On Windows the runtime keeps the SDK's original transport, so cross-spawn still resolves `.cmd`/`.bat` command shims; containment there is unchanged.
- The launcher needs no cgroup root. Current Hosted lanes and local development do not delegate one for MCP, and a hard refusal would turn a containment fix into an availability regression.

## Why not a cgroup unit in this slice

The issue allows a process-group fallback, and the process group fixes all four reproduced leaks. The Shell and Hook cgroup path requires a delegated root; the MCP integration tests do not provide one. A cgroup unit remains the stronger follow-up for the two gaps this slice leaves: a descendant that calls `setsid` escapes the group, and the Broker has no unit it can prove empty before its stopped-worker close. Both need a durable unit identity and a Broker-visible emptiness proof, which is a cross-language change.

## Behavior and acceptance

- The launcher's own tests cover a stdin close, a SIGKILL of the process that holds stdin, and the same SIGKILL while the stdin pipe is saturated; all three must reap the server and its descendant.
- The existing `managed-mcp-runtime` suite stays green; the launcher is transparent to MCP traffic, env, cwd and exit handling.
- The reproduction harness is re-run against the patched source: no server or descendant survives a graceful close, a worker SIGKILL, the drain timeout, or the wrapper.
- `packages/cli` typecheck and lint pass.

## Limits

- A descendant that calls `setsid` leaves the process group and survives; only a cgroup unit catches it.
- The Broker's stopped-worker close still treats the absent worker PID as proof. The launcher bounds the orphan window to about 1.5 s, but the Broker receives no emptiness proof. A cgroup unit plus a durable proof is follow-up.
- A process-group id can be reused in principle. The short reap window makes it unlikely, not impossible; a cgroup unit removes the race.
- Each stdio connection keeps one small Node launcher resident for its lifetime. A bare launcher measured about 44 MB RSS; at the 16-connection limit that is roughly 700 MB per Runtime session before the servers' own memory. The Hosted memory budget must account for this second process; a lighter or shared supervisor is future work if the bound becomes tight.
- The supervisor is POSIX-only. Windows keeps the prior direct spawn, so `npx`, `npm` and `.cmd` shims still resolve, but it gains no containment.
