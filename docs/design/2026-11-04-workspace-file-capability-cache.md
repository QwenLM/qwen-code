# Reuse local Workspace file capabilities

[English](2026-11-04-workspace-file-capability-cache.md) | [简体中文](2026-11-04-workspace-file-capability-cache.zh-CN.md)

## Problem and scope

Every local Workspace file query, read, upload and upload-status exchange starts
the CLI twice: once for its versioned capability document and once for the actual
operation. A local acceptance sample measured about 221 ms for the capability
process alone. Reuse a successful handshake for unchanged local executables.

This changes only local capability discovery. Authorization, upload identities,
SQL admission and settlement, maintenance protection, process deadlines and
response validation retain their existing behavior. SSH still probes the remote
CLI on each exchange. There is no new configuration or protocol field.

## Design

`WorkspaceFileProcess` keeps one immutable, volatile snapshot containing the
successful help response and the identities of the configured Node and CLI
files. Identity includes the configured absolute path, resolved path, file key,
size, creation time and modification time. Relative paths, non-regular files and
unreadable identities use the existing uncached probe.

A hit revalidates the requested capability from the saved document. Read support
does not imply upload support. A miss performs the existing bounded probe and
caches it only after successful validation and an unchanged identity recheck.
Failed or malformed handshakes are not cached. Each actual file operation still
starts its own process and validates its own response. Concurrent cold misses
may probe independently; no lock serializes file I/O. Keeping only the latest
snapshot bounds cache storage without a cache service or eviction policy.

Normal CLI rebuilds and deployment replacements change the entry identity and
invalidate the snapshot. Content-hashed bundle imports are updated through that
entry. Editing an imported module in place without rebuilding the entry is not
an identity change; restart the Java process after such development edits. The
cache is a protocol-discovery optimization, not a file-integrity guarantee or
an authorization decision.

## Verification and acceptance

- Repeated reads and uploads reuse a successful probe while actual operations
  still run independently.
- A read-only capability cannot authorize an upload.
- Replacing the CLI or changing the Node identity triggers a fresh probe;
  invalid replacements are refused before the requested operation.
- Relative paths retain per-request probing. Failed probes can recover on the
  next request.
- Existing upload unknown-result, bounded-input and deadline checks pass.
- Repeat the real 32 KiB upload measurement at concurrency 1, 2 and 4, preserving
  the previous sample method and reporting latency, success and lock waits.

Use the existing shared local validation budget and unchanged CLI bundle.
Complete MySQL and Hosted/fault qualification remains in CI. Record executed
checks and limitations separately; this design does not claim completed
acceptance. Open questions: none.
