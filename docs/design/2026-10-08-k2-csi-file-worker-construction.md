# K2-A2: private CSI file worker construction

[English](2026-10-08-k2-csi-file-worker-construction.md) | [简体中文](2026-10-08-k2-csi-file-worker-construction.zh-CN.md)

Status: construction implemented and independently verified locally on 2026-10-08. Parent baseline: `1b752436309beed109b6f47959d8bb3ec2994ca8`. Part of [Draft PR #13526](https://github.com/QwenLM/qwen-code/pull/13526), [native file execution](2026-10-07-k2-native-file-execution.md), and [full K2 completion](2026-10-06-kubernetes-k2-retirement-handoff.md).

## 1. Problem and scope

The retained file backend and three-tool composer now share the original root descriptors, but no production worker calls the composer. Legacy entry points deliberately refuse the private manifest. At the parent baseline the CSI provisioner emits boot3 and saves workspace-only handle1; transport calls legacy context and physical attestation routes. Removing those refusals would construct providers, hooks, MCP and Shell before native file admission exists.

This construction step gives the original private provision request a separate boot4/CSI2 producer, consumer, immutable saved handle and authenticated observation/context routes. It creates neither backup directories nor tools. File admission, prepare, Tool-v2 execution and result retention remain unavailable until the original native chain is connected. This is a necessary construction component, not completion of K2-A2 or the overall K2 goal. Public selectors, aggregate DRAINED/RELEASED, physical stop, NodeUnpublish and safe volume handoff remain gated.

## 2. Closed identity and envelopes

Use the exact outer contracts in the native-file design: boot4 and ready4 have `type`, `version`, `managedCsi`, `identity`, `context`, with `storage` only on boot. Identity has exactly `profile`, `sessionId`, `capabilityDigest`. It repeats `csi-files-retirement/1`, the canonical UUID isolation key of the immutable CREATE request, and the registered manifest digest. Inner managed-context boot2 remains closed and has session isolation and the same digest. The fixed Runtime Session and Harness owner both equal this UUID; turn and prompt IDs remain separate.

Physical attestation and context attest/install/receipt wrap the unchanged closed inner contracts with protocolVersion2, managed-csi/2 and the same identity. They use the CSI-v2 prefix. Body version numbers do not authorize capability changes. Validators reject missing/extra fields, cross-profile or cross-Session identities, duplicate JSON keys, invalid UTF-8 and trailing JSON. Replies never echo the boot token.

Reuse the legacy storage, mount and Pod validators as data validation without broadening the legacy boot3 or CSI1 wire. A new parser can project an already shape-checked v2 envelope into that validator; a legacy endpoint cannot accept the new envelope. Keep the initial storage driver/ext4/NVMe restrictions explicit: they describe this qualification profile, not a hard dependency of the runtime architecture on Alibaba Cloud.

## 3. Construction, routes and lifetime

The hidden container bootfile reader selects boot4 before legacy parsing. Stdin and local-process entry points still reject the private digest. Startup validates the whole boot and observes the original mount before opening a listener. It registers only POST context-attest, context, physical attest and drain at the exact CSI-v2 paths. Unknown methods, query aliases and legacy Tool/ACK/provider/publication/MCP/Hook routes return 404. It never calls the generic context factory, shell ledger, publisher registry or three-tool composer.

Context installation verifies the original owner, `cwdRelative: "."`, exact private configuration digest, workspace tuple and ordinary context digest/revision. It borrows the same original mount for verification and records only the original installation receipt. There is no backend metadata I/O. Repeated exact installation reuses the receipt; changed owner/config/context conflicts. Installation becomes unavailable on seal or close. It does not install a native activation or qualify bind/mutation.

Seal is a sticky original retirement ID and prevents new installation. Status requires that same ID. Drain responses remain DRAINING with an explicit file-admission-unavailable blocker; this incomplete composition cannot claim aggregate quiescence, DRAINED or RELEASED. Attestation is read-only; it can observe the same original mount after seal while the mount remains available. Close immediately fences installation, closes the listener and joins the original mount lifetime. Startup/listener failures close that owned lifetime. No new executor is constructed just to provide zero counters.

## 4. Java production and saved identity

Select CSI2 only from the immutable exact private request: provisioner kind, managed-context storage, session isolation, canonical UUID key and registered digest. All other workspace requests retain the original CSI1 producer and handle1. Unsupported session profiles remain refused.

The private saved handle uses version2 with the existing exact saved fields plus `profileIdentity`. The existing saved field `identity` remains the digest of the saved unsigned object; it is not reinterpreted as the new three-field identity. Boot digest includes the boot4 identity. Verify profileIdentity against the request and seed, both original attestation envelopes, Pod/Secret UIDs, pinned image, spec digest, storage reservation and original mount. Resume re-creates and compares exactly that Secret, not a new boot or mount. A handle version/profile mismatch refuses adoption.

HttpRuntimeTransport chooses both CSI-v2 attest paths from the same private request, validates echoed identity, and chooses the CSI-v2 context installation wrapper only for the matching original Session and exact private context configuration. It preserves existing lease checks, redirect refusal and body limits, and requires the original incarnation response header on all three private requests. Legacy response rules remain unchanged. It does not call legacy activation or authorize tools. Existing private acquisition/native admission gates remain in effect until subsequent implementation closes the full chain.

## 5. Integration requirements retained for the next step

Only after original SQL/native READY admission and fixed context installation may bind create the retained Session directory. Retain one compose promise before its first await and pass its exact history instance to actual Write/Edit execution, observation and close. Do not use legacy raw bind, which allocates a second history.

The next native history integration must publish original inputs/definitions and reserve every accepted SQL PREPARED execution before durable intent, then verify that intent on the original connection, prepare preimages, commit prepared and dispatch. A checkpoint carries global tool ordinals and its carried batch ID; tool.intent carries the current assistant-message batch and local ordinals. Do not equate these two IDs/ordinals. Derive exact membership using original assistant/function/part identities and the previous checkpoint, preserving earlier items.

The Broker-to-worker history wire must be specified and qualified before it opens any backup or mutation path. Its producer must derive current original resources, paths and SQL membership from the original authority; caller paths, bearer possession, a local prepared Set and a supplied ref are insufficient. This construction step adds no guessed grant protocol or second journal. The full native-file design remains the authority for subsequent body2 transitions, result consumption and until-finalize retention.

## 6. Validation and acceptance

Check both languages against identical closed fixtures and real Java HTTP producers. Verify a production worker bootfile selects the new branch, ordinary legacy startup remains compatible, and private stdin/local/boot3 paths still refuse. Prove startup/context/attestation produce no history prefix and construct no generic or file tools. Inspect actual HTTP routes, identity mismatch, failed mount startup, seal/install races and repeated close with owned resources.

Tests using a mocked Linux mount observation are wiring fixtures only. Genuine Darwin refusal is required. Actual Linux CSI, Kubernetes API reservation/Secret/Pod identity and MySQL native admission need their own later full-chain evidence; neither parser success nor informational ready can substitute. Global qwen dry-run must record its actual capability gap before local-build verification. Run build, typecheck, applicable bundle and focused tests, then self-audit and the repository review workflow. Keep Draft and maintainer review boundaries.

The independent local run passed 38 selected tests and 10 unique actual built-startup/HTTP groups. Genuine Darwin boot4 reaches the mount refusal without ready output; controlled mount/listener fixtures cover wiring and seal/install/close ordering. Already-compiled Java tests exercise the actual private CREATE producer, H2 persistence/reload and loopback transport; Kubernetes API and mount observations remain doubles. The HTTP dependency preanchor supplement repeats the same 10 groups and is not additional unique coverage. Owned resources were cleaned and the declared input window showed zero drift. These results qualify this construction component only; native review remains incomplete and real Linux CSI/MySQL/full K2 acceptance remains required.

## 7. Affected consumers and remaining questions

Affected production consumers are the CLI container reader/startup/ready lifecycle, dedicated CSI-file envelope/route owner, Java CSI envelope producer, HTTP attest/install transport, CSI provisioner and saved identity reader. Each reads the new version/identity; no optional dead capability switch is added. Legacy schemas and routes remain separate.

The outstanding history-grant trust boundary is not resolved by this component and must be completed before bind/prepare is enabled. Physical writer/helper stop, sealed backup/orphan inventory, original cut/finalize and atomic release still belong to full K2. This document does not postpone or remove those requirements.
