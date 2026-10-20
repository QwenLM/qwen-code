# Managed extension process acceptance

[English](2026-10-16-managed-extension-acceptance.md) | [简体中文](2026-10-16-managed-extension-acceptance.zh-CN.md)

Status: implemented; the focused Linux/MySQL class passes locally with two cases and zero skips. This is process acceptance with a controlled model, not production acceptance.

## Problem and current state

PR #14319 connects published static Skills, MCP server pins and independent Hook catalog pins to Managed Sessions. Its packaged-process checks exercise Skill history and recovery, but do not establish physical Linux MCP/Hook execution. Configuration admission and mocked Runtime replies cannot establish execution, non-replay or cleanup.

## Proposed acceptance gate

Add a Linux `HostedExtensionsIT` to the existing `hosted-harness-mysql` profile. Run the public AgentDefinition and Session APIs against the real Spring control plane, SQL Session Store and embedded Runtime Broker. Use the packaged CLI for both the Hosted Harness and native Workspace worker. A deterministic loopback model chooses the tools; a real stdio MCP subprocess and command Hook run in the selected Workspace. The existing Hosted CI job already delegates a cgroup v2 subtree to its process gates.

The test owns unique tenants, Workspace roots, manifests, evidence files, processes and a Hook cgroup subtree. Administrator manifests select the test programs; public definitions contain only immutable pins. The fixture computes digests for its recipes and uses matching public pins; it does not claim that the Runtime independently recomputes recipe digests.

## Scenarios and evidence

| Scenario                                      | Required evidence                                                                                                                                                                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Skill and MCP execution                       | Model request advertises the saved Skill and MCP tool; the Skill response contains the exact published body; a real MCP process records the selected Workspace cwd and one physical append.                                                                                           |
| Hook decisions                                | A command Hook records its actual PID, input and cwd; allow reaches the MCP process and deny does not.                                                                                                                                                                                |
| Configuration pinning and Harness replacement | Publish a newer definition, kill the original Harness, start a replacement with a fresh home and continue the original Session; original Skill bytes and extension revisions remain in use.                                                                                           |
| Cancellation                                  | Hold a command Hook with a live descendant, cancel through the public API, and verify physical process death, no MCP effect and safe subsequent use.                                                                                                                                  |
| Close                                         | Complete public close with lifecycle v2 enabled for the MCP profile; confirm terminal operation state, original MCP and worker process death, and empty Hook units.                                                                                                                   |
| Unknown outcome                               | Exit the real MCP process after fsyncing its physical effect but before its reply, retain the original worker and SQL, and replace the Harness; recovery must refuse automatic replay, keep the effect count at one and avoid reporting successful close without settlement evidence. |

Use SQL records, model messages, append-only process evidence and operating-system process/cgroup observations together. A public status alone does not prove physical cleanup. Keep test cleanup separate from product close assertions so forced teardown cannot make a failing product lifecycle appear successful.

The interrupted MCP fault arm omits the optional Hook catalog so it exercises ordinary tool takeover; in-flight Hook Sessions currently refuse takeover. The normal cold-load arm retains all three extensions. Dynamic MCP tool calls use the ordinary `ma_tool_execution` ledger, not the separate MCP control-operation domain. Join its Harness prompt identity to the public Turn and require the same `UNKNOWN` execution before and after replacement, with no settled result or second execution. Observe an actual replacement-Harness load refusal with `hosted_turn_recovery_required` and `runtime_broker_execution_unknown`; the public Turn remains `RUNNING`, and new input and close both return `409 turn_active`. Do not assume that an unresolvable admitted Turn becomes `FAILED`.

## Scope and implementation

Changes are confined to acceptance fixtures and verification documentation. No product-source defect was established and no production code changes are needed. No new public contract, tool profile, admission default, credential API or Runtime provider is proposed. Reuse the current publisher, connector and execution protocols. Preserve explicit `hosted-workspace-mcp/1` allowlisting and lifecycle negotiation.

The files are a dedicated Java integration test, a small MCP/Hook process fixture under test resources, verification instructions, and this bilingual design. Existing `Hosted*IT` discovery includes the new class without another CI job. Model requests, process evidence, physical writes, Harness logs and selected SQL records are retained under `target/failsafe-reports/hosted-extension-evidence/` before forced fixture teardown, so the existing report upload preserves successful as well as failed runs. Unimplemented MCP methods return JSON-RPC `-32601` instead of terminating the fixture.

## Validation and boundaries

Dry-run the installed global CLI in an isolated home and record its exact version and capability differences. Verify the candidate with root build/typecheck/bundle, the focused Linux MySQL integration class, Java verification and two clean diff audits. An independent test engineer validates the process evidence; an independent review checks the gate and its negative controls.

This gate uses a controlled model and local stdio MCP server on one Linux host. It does not establish real upstream-model behavior, production credentials, remote HTTP/SSE MCP transports, physical host reboot, cross-machine recovery, SSH MCP/Hook support, or production acceptance. Missing prerequisites must be visible; a skipped test is not a passing Linux gate.

## Open questions

None for the acceptance scope. Record any observed unsupported recovery or lifecycle boundary before changing expectations; do not weaken a safety predicate to obtain a green result.
