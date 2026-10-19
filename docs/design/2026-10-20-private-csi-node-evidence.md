# Private CSI node evidence and controlled creation

[English](2026-10-20-private-csi-node-evidence.md) | [简体中文](2026-10-20-private-csi-node-evidence.zh-CN.md)

## Status and problem

This is the third functional extraction from cumulative Draft #13526, frozen at
`af312254483a350d5655a40c84591c9e5512aaa9`, onto main
`06efd789b`. Complete private cold recovery has landed in #14695. Original-owner
application retirement has also landed in #14698. This extraction
does not inherit either the cumulative branch's test results or native deployment
qualification.

The private file runtime can already construct and recover an execution owner.
That does not establish that the original node, runtime, container creation,
publication and retained source observation belong to one continuous chain.
The next slice supplies that evidence boundary without adding a physical release
coordinator or enabling public CSI selection.

## Scope and components

| Layer                  | Included behavior                                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Go source and gateway  | Authenticated, bounded original-task observations, durable hash-chained journal, descriptor custody and CSI frontend evidence                |
| Controlled creation    | Dedicated shim, paired sandbox/container pre-execution birth records, retained OCI input identities and effective CRI/NRI/service checks     |
| Installation contracts | Strict installed-byte and cold-bootstrap data readers needed by the source; no installation authority                                        |
| Java transport         | Exact Go journal decoding, independent durable-head validation, creation-contract and installed-byte validation, authenticated source client |
| Java persistence       | Original binding/reservation association with monotonic ARMED, BOUND and PUBLISHED evidence                                                  |
| Private provisioner    | Explicit serve-evidence operator, reviewed node/runtime checks, scheduling gate and exact original Pod identity                              |

The source journal retains stop and unpublish event grammar because those records
extend the same original evidence chain. This PR does not add the coordinator,
durable physical plan, Pod deletion operation or physical progress database.

## Creation and ownership

The explicit private operator reads independent reviewed node, image, birth and
installed-artifact inputs. It verifies the exact Node UID, boot ID, Ready state
and dedicated RuntimeClass before ARM. The authenticated source saves the ARM
prefix, and SQL saves it before any Pod CREATE. The Pod uses a scheduling gate,
required affinity to that node, the dedicated worker account, fixed AppArmor
profile and explicit tolerations.

After CREATE, the gateway registers the exact original Pod UID. Source BIND
requires the target to be absent and the task not yet created. SQL saves the
BOUND prefix before a JSON patch tests the original UID, resourceVersion and
complete gated spec, then removes the sole gate. Publication requires matching
original container/image, paired births, custody and CSI publication, and saves
the extending prefix as PUBLISHED before accepting the resource handle.

Source and gateway HTTP routes are node-source scoped. Provisioner operations
are original binding/reservation scoped. No request chooses a fallback Workspace
or primary runtime. Unknown identities, replaced processes/descriptors, changed
inputs, incomplete journals and ambiguous persistence refuse further progress.

## Extraction decisions

Keep the installed-artifact format and mandatory cold-bootstrap graph intact.
These readers are shared protocol prerequisites even though artifact generation,
policy compilation, packaging, initrd and actual PID1 handoff remain a later
slice. Tests must label synthetic compilation, service, runtime and mount data.

Use source-specific closed JSON parsing and retain the existing ten-second
whole-transaction SQL deadline locally. Neither utility requires application
retirement classes. Preserve the common binding-control lock followed by the
original binding, storage alias and holder locks on the same Connection.

Append V13 containing only ma_csi_source and its physical-key index.
Preserve published V1–V12 bytes. Extend schema-version recognition to validate
the old table set separately from the new one; do not repair or adopt a foreign
catalog. V12 remains the application-retirement migration from #14698.

Preserve the published 32-table application-inventory/2 encoding, including saved
frozen baselines and retained history. Its existing lane can continue when the
original binding and physical volume have no node-source association. Any related
source row refuses retirement before sealing the binding, blocks live inventory,
and refuses original or foreign-owner historical reads. Live checks use the same
locked Connection; historical checks use the read-only repeatable-read snapshot.
Retirement of the new evidence lane requires a later explicit integration; this
slice must not silently omit its evidence or change the old encoding.

Ordinary serve, Spring configuration, public selectors, worker boot/handle
versions and existing recovery behavior retain their existing contracts.

## Files and boundaries

Implementation lives in packages/k2-node-evidence, Java transport source
protocols, the source persistence/operator classes, the existing CSI provisioner
and Kubernetes client, and canonical managed-schema initialization/validation.
Tests include the canonical Go-encoded journal fixtures, Java source/store and
provisioner checks, and schema migration controls.

Excluded: application freeze/cut/finalization, physical retirement coordination,
Pod deletion, RELEASED, released-history reads, volume reuse, deployment policy
generation/compilation, artifact packaging, native cold boot and public CSI
selection. No new TypeScript consumer or public API is required.

## Validation and acceptance

Record a global qwen baseline first. The private Java operator is not a public
CLI command, so a test-script/component fallback is required for the actual
protocol. Validate the extracted candidate, not historical branch results:

- Build and typecheck the repository for existing JavaScript interoperability.
- Run focused Java source client/journal, creation contract, installed bytes,
  source persistence, node/runtime checks, Kubernetes patch and schema tests.
- Run complete Java module verification with Checkstyle and SpotBugs.
- Exercise source association and migration against disposable MySQL 8.4;
  H2 alone does not establish the transaction/catalog behavior.
- Run portable Go tests, module verification and Linux command builds for amd64
  and arm64. Native Linux Go tests are separate from cross-compilation.
- Verify exact original prefixes survive store restart, refusal leaves state
  unchanged, saved BOUND precedes gate opening, and ordinary creation remains
  compatible. Check strict negative controls for changed identity, journal,
  installed graph, source incarnation and effective runtime/service state.
- Verify related source rows refuse retirement before changing the READY owner
  or reserved holder, and ordinary application inventory retains its exact
  encoding. Exercise the old application-retirement chain on the merged base.

Software acceptance does not establish native descriptor mediation, kernel
confinement, actual ACK installation, continuous actor/CSI exclusion, physical
release or reuse. Record unavailable gates and skips explicitly.

## Risks and follow-up

The source, shim and dedicated daemon are trusted implementation. Artifact
hashes authenticate bytes but do not establish reviewed runnable host policy or
containment. Native qualification, reviewed compiler/host inputs and actual
cold-boot execution remain open. Application retirement for the evidence lane is
explicitly unavailable; recovered-owner retirement and final atomic
physical release remain separate work. Maintainer architecture review is
required for the new cross-language contracts and private provisioning path.
