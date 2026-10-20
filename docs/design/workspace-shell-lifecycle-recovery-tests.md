# Shell lifecycle recovery acceptance

[English](workspace-shell-lifecycle-recovery-tests.md) | [简体中文](workspace-shell-lifecycle-recovery-tests.zh-CN.md)

## Current state and scope

PR #13931 implements lifecycle v2 for exact `hosted-workspace-shell/1` and
`hosted-workspace-mcp/1`. The native MySQL writer/claim tests and common POSIX
process tests do not exercise a resident Harness through a production Spring
HTTP lifecycle operation. V2 advertisement remains disabled by default.

This first acceptance slice covers public foreground Shell deletion after a
completed Turn, resident writer expiry, a killed Spring owner and lost resource
or detach replies. It uses real MySQL, the packaged CLI, the original durable
Linux worker and production lifecycle/retirement/collection implementations.
It adds test fixtures and a narrow recovery fix for an absent cached Harness
reference after a lost detach reply.

The live HTTP baseline reproduces a successful detach whose reply is lost:
the Harness removes its resident Session, but Java retains the reference.
Later resource requests return 404 without a cleanup load. For v2 resource
phases only, a known 404 now removes that exact cached reference and preserves
the error. The next current claim reloads the saved definition and original
Runtime for cleanup. Neither an unknown reply nor absence proves completion;
effects, files v1 and other errors retain their existing behavior.

Public definitions currently contain neither `hookCatalog` nor `mcpServers`.
Java therefore saves empty effects without a Harness effects request. These
tests cannot certify Hook execution/idempotency, MCP release, background Shell
or Monitor shutdown. They do not inject those fields into production requests.
The remaining full L4/H3/reboot/publication matrix stays a separate release gate.

## Fixture and boundaries

`HostedShellLifecycleRecoveryIT` owns the model fixture, packaged Harness and
three stable loopback HTTP relays. A test-only `HostedShellLifecycleFixtureMain`
starts an independent production Spring process from an explicit configuration
file. The same MySQL database, mounts, credentials and original durable worker
directory are retained when a second Spring process starts. Relays change only
their backend addresses; Session definitions and Runtime identities are never
rewritten.

The local model emits one foreground Shell command and one final reply.
The public approval route answers the real pending action. A workspace marker
and captured stdout prove execution occurred once before lifecycle admission.
The model remains available outside Spring, so killing Spring cannot silently
replace the model or Harness.

Each relay preserves end-to-end headers and bodies, removes HTTP hop headers,
and forwards to exactly one selected backend. Faults act only at a documented
HTTP boundary: before `prepare_resources`, after a successful
`settle_resources`, or after a successful detach. No SQL statement changes
leases, claims, output evidence, retirement or collection state. SQL reads
observe the durable ledger; registry/access inserts supply fixture setup.

## Cases and acceptance evidence

| Case               | Cut                                                                                                                               | Required evidence                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Resident expiry    | Hold the first prepare request until MySQL reports the original writer lease expired                                              | Same writer ID/token/generation renewed by the current v2 DRAINING claim before detach; one execution and original Runtime                    |
| Spring owner death | Kill Spring before forwarding its first prepare request, wait for natural claim and writer expiry, then route to a second process | Original worker remains alive at the cut; new claim generation; replay of the captured old request is rejected; original identity is retained |
| Resource ACK loss  | Forward successful `settle_resources`, then close the response connection                                                         | A retry completes without another command, replacement worker or fabricated resource evidence                                                 |
| Detach ACK loss    | Forward successful detach, then close the response connection                                                                     | A known resource 404 clears the stale reference; the next claim reacquires a cleanup writer after the original seal and completes safely      |

Every case admits delete through a public REST or WebShell route, waits for the
public operation result, and checks protocol 2, the deletion tombstone,
private-output retirement and scheduled O4 collection. Captured bytes become
unavailable/cleared while a companion Session and shared workspace marker
remain intact. The test records exact process IDs, original binding/generation,
writer identity, claim generations and the injected boundary. A cut that was
not reached or a recovery that never completed fails the test.

Resident expiry is observed before forwarding, not inferred from an arbitrary
sleep. Successful phase ACKs are observed before discarding them. A stale
request is replayed while the new claim is held at its resource boundary, not
after Session deletion has hidden the identity. Timeouts are failure bounds,
not substitutes for these synchronization conditions.

Resident recovery preserves the original writer ID, token and generation.
After a confirmed detach has sealed that writer, cold cleanup acquisition may
increment its generation; the old writer remains fenced. That case separately
checks the original Runtime identity and sealed manifest digest/length, so a
new cleanup writer cannot substitute another execution or capture. Focused
connector and real MySQL tests cover both exact Shell/MCP profiles and rejection
of ordinary or stale-claim writer acquisition.

## Execution and remaining gates

The complete gate requires Linux and real MySQL because the production durable
worker uses Linux boot/process/namespace identity. It runs in the existing
`hosted-harness-mysql` Maven profile and Hosted CI job; the report checker
requires the new Hosted test class to run. No OS annotation is bypassed and no
provisioner or stop proof is mocked. macOS compilation, relay unit tests and
skipped integration cases are reported separately from Linux execution.

Before release, independently complete lifecycle Hook cuts, every remaining
effects/seal/stop/tombstone crash boundary, background Shell/Monitor H3 and
reboot identity, live MCP transports and O2 object publication. Upgrade all
Java/Broker consumers before enabling qualified Shell v2; qualify MCP
separately. Unfinished v2 operations still prohibit rollback to v1-only
consumers. This PR does not enable a profile, deploy or merge anything.

## Open questions

None for this bounded test slice. Execution results and exact commit attribution
are recorded in the E2E report, not implied by this design.
