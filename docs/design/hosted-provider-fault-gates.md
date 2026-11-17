# Hosted provider fault gates

[English](hosted-provider-fault-gates.md) | [简体中文](hosted-provider-fault-gates.zh-CN.md)

## Problem and current state

This completes the provider-control slice of FG6f in #12872, after #12868.
The Shell-output slice is already covered by #12954. The production Broker
client and packaged worker implement seven-field prepared references and
close-admission release. Existing provider tests mostly use transport fixtures;
the Hosted model loop still uses its separately gated raw-tool protocol.

The new gates exercise the production provider client, Spring Broker, Workspace
transport, packaged worker and real MySQL/MariaDB. They do not connect provider
controls to the Hosted model loop or enable new public capabilities.

## Scenarios and acceptance

| Scenario              | Fault or attempted retry                                                                                                                        | Required evidence                                                                                                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider start        | Lose the first start response after forwarding, then retry the saved reservation and original execution                                         | Exactly seven saved reference fields, no tool arguments, one reservation/dispatch and one append; observations and retries identify the original execution                                                       |
| Contract substitution | Send a raw payload to a provider reservation, before start and after settlement; also change the saved reference under the same idempotency key | The Broker refuses the changed contract even when the execution is already terminal; the original reference and effect remain unchanged                                                                          |
| Raw control           | Start a raw reservation without its required payload, before start and after settlement                                                         | The provider start route cannot adopt a raw reservation; its legitimate raw start remains usable                                                                                                                 |
| Release response loss | Let the worker close admission, then discard its response before the Workspace transport receives it                                            | Runtime Session stays RELEASING with its original storage owner; the worker rejects new admission and retains terminal evidence; retrying release acknowledges closure before deactivation and ownership release |

Use deterministic, short append commands to distinguish duplicate physical
execution from identical overwrites. Inspect the workspace proof and the SQL
execution ledger independently of driver success markers. Invalid attempts must
not change the reference, dispatch generation or original result.
The same-key substitution probes change `policyRevision`, `capabilityDigest`
and `invocationId`; the saved-reference assertion compares all seven fields.

## Fixture design

Extend the existing Hosted Workspace integration family with a selectable
provider driver and a Java probe. Reuse its Spring/database setup, mounted
Workspace sessions and packaged-worker provisioning. The TypeScript driver uses
the production Broker client and provider controls; no model is needed to select
a prepared invocation. Each scenario has a separate Runtime Session.

The Java probe adds an HTTP forward proxy to the existing Workspace transport's
HTTP client in the fixture only. For release it forwards to the real owned
worker, confirms the actual successful response, and discards that response.
Before it can reach the Workspace transport, verify the original SQL owner is
still held and probe the original worker's closed admission. This intermediate
boundary distinguishes ordering from an eventual RELEASED result. Other worker
operations retain their real transport behavior. No production test switches or
alternative release implementation are introduced.

After uncertain release, retry through the public Broker route. Verify the
original terminal execution remains readable, the closed worker cannot be
reacquired, and storage ownership is relinquished only following acknowledged
closure. All probes select the fixture's original session, lease and generation.
Forwarded worker closures must equal the number of discarded replies plus one
acknowledged closure, so a retry cannot skip the worker after a lost response.
Keep diagnostics and cleanup effective on both successful and failed runs.

## Files and validation

Implementation touches the existing Hosted integration entry, a dedicated
TypeScript driver and Java probe, and this bilingual design. The existing Hosted
MySQL profile discovers the entry; no additional CI job or product route is
needed. Scenarios can be selected independently for mutation checks.

Write the exact E2E commands and evidence under `.qwen/e2e-tests/`. Try the global
CLI first; a missing private worker capability is an unavailable baseline, not
a reproduced defect. Build, typecheck and bundle the local CLI, compile and
Checkstyle the Java tests, run focused provider tests and the full Hosted family
against MySQL/MariaDB. H2 is not sufficient acceptance evidence.

Remove the relevant contract and release-order guards in isolated mutation
runs, retaining the shipping gate assertions and real faults. Require failures
at behavioral assertions, restore every source and artifact byte, and rerun the
normal gates. Independently check SQL, filesystem effects and process cleanup.
Read the full diff in open-ended and reverse audit passes until two consecutive
passes are clean; after round five only Critical corrections remain in scope.

## Scope and risks

These tests establish today's fixed-contract and closed-admission ordering.
They do not implement automatic continuation, worker adoption/reclamation,
provider wiring into Hosted model turns, remote provisioners or public Shell
admission. Short local commands use POSIX behavior; this is not Windows proof.
The extra HTTP proxy and database checks increase test time, so faults are
selected by observed protocol boundaries rather than timing sleeps.

No open product-design decision is required for this test-only slice.
