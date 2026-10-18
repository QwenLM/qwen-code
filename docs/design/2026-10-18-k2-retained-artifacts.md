# K2 retained snapshot and agent artifacts

[English](2026-10-18-k2-retained-artifacts.md) | [简体中文](2026-10-18-k2-retained-artifacts.zh-CN.md)

Status: proposed continuation of #13395 and Draft PR #13526, based on `cb806e74bf`.

## Problem and complete objective

The remaining K2 objective includes trusted installation and confinement, original stop/unpublish qualification, final physical authority and atomic release, retained receipt validation, and safe later-cycle reuse. None of those requirements is removed by this change. Current installation inputs do not establish reciprocal host policy, the complete actor/admission boundary or cold exclusive CSI wiring. The dated experimental node cannot supply current qualification.

One independently implementable dependency is already on the production retained-status path. `WorkspaceCsiApplicationHistory.readRetainedProgress` audits structured carriers through `HistoricalScan`. Its native-resource decoder does not recognize the real snapshot manifest/page or agent instructions/skills producers. An unrelated valid public Session can therefore block inspection of the original retirement. Simply adding these kinds to an allowlist would hide ownership references, missing pages or borrowed message bodies.

## Implementation

Reuse the snapshot producer's actual manifest and page DTO decoding from `ManagedSnapshotStore`, without changing the serialized DTOs, stored bytes, public read behavior or SQL schema. Historical decoding additionally requires strict JSON types, complete fields and the existing bounded row metadata/digest checks.

For a published snapshot, obtain the exact same-tenant/Session root, manifest, ordered pages and SNAPSHOT references on the existing read-only Connection. Check canonical snapshot/resource identities, root version/sequence/projection/item count, manifest digest and cursor-secret encoding, contiguous page ordinals, page sequence metadata, item ownership and membership, and the complete referenced body set. The page's last-sequence metadata is the last item's firstSequence. Items follow firstSequence and then binary item-ID order; equal firstSequence values are valid. A page may contain only its producer's maximum 100 items; a single large item remains valid. Empty snapshots have no page and only a manifest reference. An old published root remains valid after retain_until and after it stops being current, until collection removes it. The root and every extra read share the original unique-row, whole-row-byte and elapsed budgets.

Snapshot-held old message bodies need not be the current `ma_message` body. Verify their real resource identity against the saved item owner and digest, with a canonical positive body revision no greater than the saved item revision: terminal projection can advance the item without rewriting its body. A body-backed descriptor must contain an empty inline content list. Require the exact reference set for each snapshot owner; one body can also have a current MESSAGE reference and references from several snapshots. Validate the production message-part format and its coverage by the descriptor rather than trusting a reference alone. Snapshot and body resources and snapshot references retain the producer's null workspace/publish-command/journal fields. Public pages and bodies use the original shared byte budget, without inheriting the unrelated native-kind 8 MiB ceiling. Only a completely checked graph supplies coverage for its pages, bodies and references. Process manifests before their covered resources, as with native chunk manifests. Unknown formats, absent roots, incomplete graphs, unexpected references and original-owner references still refuse; they never expand the original expected image or its roots.

Agent instructions remain bounded UTF-8 text, including the producer's valid empty string. They are not parsed as embedded JSON. Agent skills reuse the existing admitted-skill validator. Both require the actual content-addressed resource ID, publish-command identity, scope, schema and digest. Literal instruction or skill text containing an identifier does not create an ownership reference.

## Affected components and decisions

- `ManagedSnapshotStore`: expose package-local shared decoding and DTOs; preserve its producer and public behavior.
- `WorkspaceCsiApplicationInventory`: connect the recognized artifacts to the existing historical scan, including complete snapshot/body ownership and shared budgets.
- Focused inventory/producer tests and MySQL integration scenarios: generate artifacts with the actual stores, then inspect their real rows in a read-only snapshot.

No new route, optional runtime switch, storage client, writer, authority DTO or migration is introduced. External structured object-store payloads and unsupported/orphan carrier forms retain their refusal. Those remaining decoder domains are still part of the complete K2 work; this increment does not declare the whole historical reader complete.

## Validation and acceptance

Dry-run with the global CLI first, and document why the private Java reader requires a test-script fallback. Use actual public snapshot and agent-resource producers for a positive graph before implementation. Confirm baseline refusal, then acceptance with byte-identical expected history, no added roots and no writes after implementation.

Cover empty and multiple pages, old body versions retained only by a snapshot, same local IDs in different tenants, literal instruction/skill text, malformed UTF-8/JSON/types, wrong content-addressed identity, missing/extra/reordered pages, root/ref/body/scope/sequence/digest changes, original references hidden in item attributes, uncovered resources and shared row/byte/deadline limits. Preserve current unknown/external-payload refusals. Run affected Java tests, module verify with its static gates, and disposable MySQL 8.4 verification. Retain failures and conditional skips separately. Review the full increment until two consecutive clean self-audits and perform code review.

The acceptance claim is limited to these shared historical artifact decoders and their real callers. Current native Linux/Kubernetes installation, full Hosted fault groups, final physical release, historical released receipts and cross-cycle reuse need their own complete evidence before the full goal can finish.
