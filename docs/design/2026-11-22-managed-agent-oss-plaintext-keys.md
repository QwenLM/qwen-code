# Plaintext identity segments in managed-agent OSS object keys

[English](2026-11-22-managed-agent-oss-plaintext-keys.md) | [简体中文](2026-11-22-managed-agent-oss-plaintext-keys.zh-CN.md)

Status: implemented (2026-11-22). The OSS externalization feature is unreleased, so no backward compatibility with the previous hashed key layout is required.

## Problem

The managed-agent server externalizes three kinds of bytes to a private Aliyun OSS bucket: oversized session resources, compacted journal packs, and tool publication outputs. All three addressed objects under a SHA-256 hash of the session identity (the same `scope_key` value used as a SQL index key). The hash made OSS objects opaque: an operator browsing the bucket console could not tell which tenant, workspace, or session an object belonged to without first querying SQL to map identities to hashes. Debugging and storage audits required that extra lookup for every object.

## Proposal

Replace only the hashed scope segment of each OSS key with plaintext identity segments. The SQL `scope_key` hash and every SQL identity derived from it stay unchanged; OSS reads always resolve the exact stored `object_key` column, so key construction and SQL identity are decoupled.

New layouts:

- Session resources: `{ossKeyPrefix}{tenantId}/{sessionId}/{resourceId}/{uuid}` (default prefix `session-resources/`).
- Journal packs: `{ossKeyPrefix}packs/{tenantId}/{sessionId}/{packId}` where `packId` is `pack-` plus a UUID.
- Tool publication outputs: `managed-tool-results/{tenantId}/{workspaceId}/{sessionId}/{publicationId}/{slot}`. The slot is used verbatim (`admission`, `terminal`, `segment:stdout:0`, `page:stderr:12`, `manifest:1`, `content:<id>`); it was previously hashed.

The publication layout includes `workspaceId` because its scope hash is a (tenant, workspace, session) triple, while the other two scope on (tenant, session) only.

## Design decisions

1. **SQL identity stays hashed.** `scope_key CHAR(64)` is an index and unique-key component across the publication catalog tables, and resource identity keys are hashes of (scope, resourceId). Changing them would be a schema migration with no operability benefit; only the OSS path needed to become readable.
2. **No compatibility shim.** The feature has not shipped, so no object in the hashed layout exists in any deployment. Replay paths recompute the key deterministically from the same validated inputs, so a recomputed key always equals the stored one; reads of already-written objects use the stored key regardless.
3. **Path safety relies on existing boundary validation, not new encoding.** Tenant identity is admitted by the tenant header filter as `[A-Za-z0-9._:-]{1,128}`; workspace selection admits `[A-Za-z0-9._:-]{1,128}`; session identity is a server-generated UUID (relay lookups admit `[A-Za-z0-9._-]{1,256}`); publication identifiers are `[a-z0-9_-]{1,128}`; slots are fixed protocol strings or match `segment:`/`page:`/`content:` regexes. None contains `/` or control characters, so no segment needs escaping.
4. **Resource identifiers remain opaque text.** A session resource id is validated as non-empty Unicode text of at most 512 bytes without control characters; it may contain `/`. That only adds console hierarchy levels. Correctness is unaffected because allocation, upload, and read all use the exact key stored in the allocation row, and the trailing UUID keeps keys unique.

## Constraints

OSS keys are limited to 1023 bytes. Worst-case lengths with the default prefix, using the conservative 256-byte session bound (real sessions are 36-byte UUIDs): session resources ≤ 971 bytes, publication outputs ≤ 901 bytes, journal packs ≤ 451 bytes. A custom `ossKeyPrefix` consumes the remaining headroom; an over-long key fails the PUT closed and the operation stays retryable — it is never silently truncated.

## Risks

- Tenant, workspace, and session identities become visible in OSS access logs and the console. Accepted: the bucket is private and operator-only, and the identities are already visible in SQL.
- Objects of one tenant share a key prefix, so OSS prefix partitioning is coarser than with hashed scopes. Accepted: per-tenant session load is bounded, and readability is the goal of the change.

## Validation and acceptance

- Focused unit tests assert the new plaintext prefixes for session resources and journal packs and round-trip the externalized bytes; the publication suite exercises upload, verify, finish, and replay over the new keys.
- Checkstyle passes on the changed production module.
- Acceptance: the module's full CI gates pass on the PR revision. Local validation covered the focused regressions above; the full suite runs in CI.

## Open questions

None.
