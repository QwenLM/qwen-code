# Managed MCP local acceptance

[English](2026-10-21-managed-mcp-local-acceptance.md) | [简体中文](2026-10-21-managed-mcp-local-acceptance.zh-CN.md)

## Problem and current state

Managed Sessions already publish MCP server pins, execute tools in the selected
Workspace Runtime, and expose a committed catalog to the composer. The existing
Hosted MCP process and fault tests cover transport, delivery, restart and release
behavior. The combined public extensions acceptance also checks Runtime reuse,
but its Hook/cgroup setup restricts that case to Linux.

The remaining local acceptance gap is one executable witness connecting the
public AgentDefinition and Session APIs, ordinary consecutive model turns, both
catalog surfaces, durable tool results and public close without Hook/cgroup
requirements. Passing a browser catalog fixture does not establish that chain.

## Proposal

Extend the existing `HostedMcpStreamGapIT` rig with an MCP-only acceptance case.
Reuse its real Spring control plane, disposable MySQL, packaged Harness, durable
local worker, stdio server and deterministic OpenAI-compatible model. Publish
configuration through the public API and submit two distinct tasks through the
public Session input route.

Capture the original worker registration and committed MCP configuration after
the first turn. Require the next turn to preserve their binding, generation,
process identity and connection identity. Count physical server starts,
initialization requests and tool calls, and check the fixture's durable effects.
Check committed ordinary tool execution results and model-visible responses;
model tool calls do not create raw `mcp_operation` records.

Read the public catalog and WebShell adapter and require the same sanitized,
nonempty committed catalog. Close through the public Session API and require a
completed operation, released MCP and Runtime ownership, no storage holder, and
termination of the original worker and MCP process. Persist evidence before
test teardown so cleanup cannot satisfy the close assertions.

## Scope and decisions

- Add a process acceptance witness, not a second MCP implementation.
- Reuse the existing rig and server; do not introduce a general fixture layer.
- Keep configuration, credentials, tool authorization and Runtime routing intact.
- Use only a test-owned database, directories, ports and processes.
- Run on native macOS where available and retain Linux compatibility. This does
  not enable SSH MCP or the dedicated resident file-only execution profile.
- A deterministic model proves the protocol and tool-result path, not upstream
  model behavior. Browser interaction and HTTP/SSE transport remain separate
  acceptance dimensions.

## Validation

Attempt the baseline with the installed global CLI, then run the new case with
the freshly built bundle against disposable MySQL 8.4. Run the complete affected
test class and module Java verification. Build/typecheck/bundle the TypeScript
prerequisites and check formatting and the Hosted process budget contracts.
Use a negative witness to demonstrate that a successful-looking MCP response
cannot pass when its expected durable physical effect is missing.
Record commands, measurements, limitations and before/after evidence under
`.qwen/e2e-tests/managed-mcp-local-acceptance.md`.

On native macOS with MySQL 8.4.11 and JDK 21, the new case took 8.776 seconds
alone and 6.017 seconds in the four-case class. All four cases passed in 113.7
seconds. Twice that measured class runtime fits the existing 242-second allowance;
the shared fork, job and step ceilings remain unchanged.

## Open questions

None for this acceptance slice. User configuration management, resource/prompt
execution in WebShell and additional Runtime profiles are independent work.
