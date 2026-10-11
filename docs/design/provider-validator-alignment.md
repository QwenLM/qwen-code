# Provider validator alignment

[English](provider-validator-alignment.md) | [简体中文](provider-validator-alignment.zh-CN.md)

## Problem and scope

Issue #13041 identifies five remaining acceptance differences between the
TypeScript worker and Java Broker for managed-runtime-provider/1: checkpoint
promptId length, three unpaired-surrogate cases, and Session UUID casing.
The same promptId length gap also exists in raw history rewind and restored
history snapshots. This change covers these differences without changing
protocol versions, routes, or tool-specific input semantics.

## Rules and implementation

- Every protocol promptId is a nonempty string of at most 128 UTF-16 code
  units, without NUL. Java reuses one helper for identities, references,
  checkpoints, raw history prepare/rewind, and both snapshot binding forms.
  Snapshot containers retain the worker's maximum of 100 unique promptIds.
- Operation strings and object keys must contain well-formed Unicode. The
  worker checks this after its existing JSON shape/depth/size validation.
  The Broker's existing rejection remains: its encoder otherwise replaces an
  unpaired surrogate with a question mark and changes a tool argument.
- Tool identity and reference Session UUIDs must be lowercase and exactly
  equal the envelope runtimeSessionId. Core's general-purpose UUID parser
  remains unchanged. The provider compares the original identity with the
  parsed value so normalization cannot admit a value the runtime later rejects.
- Envelope Session IDs remain opaque, path-safe and case-sensitive. Their
  spelling, routing, storage keys and ownership are never normalized. A
  non-identity operation may still use an uppercase opaque Session ID.
- Acquire/release and execution/status/cancel keep their existing distinct
  Broker entry points. Their routing difference is intentional.

## Compatibility and constraints

Valid lowercase identities and well-formed text retain their behavior.
Inputs that previously passed one validator and failed later now fail at
admission. In particular, identity aliases are not added: core's runtime and
the Broker execution ledger compare original identities and reference digests.
Normalizing stored references would change idempotency semantics.

The snapshot addition validates prompt identities and their container; it
does not duplicate the worker's unrelated timestamp, backup, or path parsers.
This is not a replacement for every worker semantic validation.

## Verification and acceptance criteria

- Both languages replay the same shared request corpus, including positive
  and negative provider controls. Java must reject invalid controls before
  sending any HTTP request, and retain the exact valid envelope.
- Cover 128/129 boundaries on each protocol promptId path, nested invalid
  promptIds, surrogate values and keys, valid emoji, UUID casing combinations,
  and preservation of case-sensitive opaque envelopes.
- Exercise both TypeScript request and standalone operation entry points.
  Keep Java snapshot type, duplicate and 100/101 capacity checks covered.
- Run focused protocol, provider, worker and Java transport tests, project
  build/bundle/typechecks, and a real bundled worker probe. Preserve the
  baseline failures and state any verification limitations in the local report.
- Review every affected consumer and the complete diff before delivery.
