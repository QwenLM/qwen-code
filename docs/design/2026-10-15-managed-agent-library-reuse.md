# Managed Agent Server Library Reuse

[English](2026-10-15-managed-agent-library-reuse.md) | [简体中文](2026-10-15-managed-agent-library-reuse.zh-CN.md)

## Problem and Scope

The Managed Agent Server repeats generic string truncation, null-safe blank
checks, numeric checks, SHA-256 calculations, and HMAC initialization. Some
request paths also construct a new JSON mapper or digest component for every
call. These implementations add
maintenance work even though the existing dependencies provide the same
operations.

This is a behavior-preserving refactor within the server. Public APIs, database
schemas, ownership checks, and lifecycle transitions retain their contracts.

## Approach and Constraints

- Declare `commons-lang3` and `commons-codec` directly in the server POM, using
  Spring Boot dependency management to preserve the resolved versions.
- Use `StringUtils.truncate` for ordinary error and title truncations and
  `StringUtils.isBlank` / `isNotBlank` for ordinary null-safe blank checks.
  Preserve UTF-16 truncation and null handling. Retain the title-specific
  `unicodeBlank` predicate, including its NBSP and BOM behavior.
- Use `StringUtils.isNumeric` for the reserved event ID's numeric suffix,
  retaining its prefix check and existing Unicode digit acceptance. Keep
  ASCII-only contract validation explicit.
- Delegate repeated raw SHA-256 helpers to `DigestUtils`. Preserve each
  caller's byte encoding, hexadecimal case, prefix, and JSON canonicalization.
  Initialize incremental digest state with `DigestUtils.getSha256Digest()`;
  preserve length-prefixed fields, streaming limits, heartbeat checks, and
  length verification. Remove the Channel service's raw digest forwarding
  method and use `sha256Hex` directly at its hexadecimal callers.
- Use a fresh `HmacUtils` instance per call for signature authentication,
  writer credentials, snapshot cursors, and host identities. Preserve input
  bytes, binary or hexadecimal results, Base64 encoding, constant-time
  comparisons, and exception mappings. Distinguish invalid cursor input from
  wrapped security-provider failures.
- Reuse fixed-configuration JSON mappers. Inject the existing `RequestDigests`
  component into the definition store; keep its canonical mapper separate from
  the default storage mapper. Do not replace protocol JSON settings with
  mutable application-wide configuration.
- Record these reuse rules in the service's `AGENTS.md` so future changes use
  the same conventions.
- Split Git output with `StringUtils.split(text, '\n')`, dropping only empty
  lines and preserving carriage returns. Escape continuation-history text with
  `StringUtils.replaceEach`, replacing only `&`, `<`, and `>` once; quotes,
  control characters, and existing entity text retain the previous behavior.
- Delegate artifact byte-range parsing and normalization to Spring's
  `HttpRange.parseRanges`. Retain the ASCII grammar guard, outer `trim()`,
  single-range restriction, 1 MiB limit, and existing 400/416 error mapping.
  Parse invalid syntax and overflowing numbers before checking whether an
  artifact is empty; malformed ranges remain 400 responses for empty artifacts.

## Validation and Acceptance

Verify truncation equivalence for null, empty, boundary-length, and surrogate
inputs; verify ordinary blank-check equivalence and the distinct title rules.
Compare raw digest and hexadecimal output, including empty and UTF-8 payloads.
Compare incremental digests and HMAC output against the existing JDK
implementations. Verify reserved event ID suffixes retain Unicode digit
acceptance and reject empty or nonnumeric suffixes. Keep existing canonical
JSON, five-field cron/DST evaluation, and JSON-byte-budget truncation unchanged.
Verify LF-only splitting and continuation-history escaping through their
callers. Cover closed, open-ended, and suffix byte ranges, empty artifacts,
numeric overflow, non-ASCII digits, signs, whitespace, multiple ranges, and
the exact 1 MiB boundary with unchanged selections and error codes.

On fresh worktrees, prepare Core and CLI build artifacts using the repository
dependency setup and build; the native CSI conformance tests import them.

Run the affected definition, action, child Workspace, message-relay,
authentication, credential, snapshot, event, and automation tests,
then `mvn verify` for the module's unit/H2 tests, Checkstyle, and SpotBugs gate.
Check the resolved dependency versions and both documents' formatting and
links. Acceptance requires unchanged digest bytes and existing behavior tests
passing; this refactor does not establish new MySQL or Hosted recovery evidence.
