# Web Shell session sources implementation

The session source list follows the [design contract](../design/web-shell-session-sources.md). The feature is implemented on `codex/session-sources-design` for local acceptance of PR #11262.

## Implementation

The core owns one durable source service per daemon session. Both `record_source` and owner-routed HTTP mutations use this service. Snapshot writes are acknowledged before state changes; invalid or incomplete persisted data makes sources unavailable without preventing conversation loading. Source records remain outside prompt context, compaction summaries, and the active turn branch.

The bridge validates a session-bound client and attachment existence before forwarding mutations to the owning child. It checks the captured owner again after asynchronous attachment validation. Internal source errors use a private result envelope so the ACP transport does not log the original source payload. Public HTTP errors retain the design's status codes.

Daemon forks copy the current list after attachment copying, regenerate source IDs, and omit resources that cannot be mapped. Source-copy warnings are visible for both conversation forks and side tasks. The source copy waits for the temporary target writer to close before restoring the target session.

The TypeScript session client always uses REST for source operations, including when prompts use ACP. Web Shell provides one Sources section combining uploaded files and explicit references, Add/open controls, optional attachment metadata enrichment after acceptance, and metadata-only retry. It deduplicates by attachment ID, preserves historical files without backfilling metadata, and uses the existing guarded preview paths. The standalone Web Shell entry point enables the section; an embedding host's explicit section choices remain authoritative. HTML sources render as text, and link sources require explicit navigation.

## Acceptance and boundaries

Local evidence is kept in `.qwen/e2e-tests/session-sources.md` and its adjacent `session-sources-evidence` directory. It includes the global CLI baseline, package test logs, real daemon HTTP/SSE and recording evidence, browser interaction results, and screenshots. The model endpoint is a deterministic localhost fixture with a test-only credential; the CLI, daemon, source tool, storage, and Web Shell are real local builds. No external model endpoint is part of this acceptance run.

The acceptance covers registration, concurrency, capacity, client/owner rejection, persistence across restart, rewind, compaction, daemon fork and attachment copying, archive rejection, source notifications, preview behavior, and attachment retry without message resubmission. Final build, typecheck, focused tests, formatting, and lint results are recorded with the local evidence.

A recording writer that enters its existing degraded state after an I/O failure continues to reject writes. Restoring filesystem permissions alone does not replace that writer; resume/restart restores the last acknowledged source list before retrying. The feature does not bypass writer ownership or acknowledge memory-only changes.

This phase adds source APIs and complete source copying to daemon/Web Shell sessions. Standalone CLI, external ACP clients, and Python/Java SDKs receive no new source API. Cross-client source copying through standalone CLI `/branch` is outside this phase. Automatic attachment registration remains best-effort and its retry queue is held in browser memory, as specified in the design.

## Unified uploaded files and sources

The follow-up combines the previous Attachments and Sources sections into a single user-facing collection. Attachment bytes and explicit reference metadata retain their existing APIs. Registered attachment metadata supplies a preferred title; an unregistered upload stays visible as a plain file. Removing only its registration never recreates that source record, and does not imply deletion of the uploaded file. No source IDs or timestamps are fabricated for attachments.

The default entry point enables `sources` once. Legacy host `attachments` configuration still displays files; older daemons expose their file list without unsupported metadata actions. Add no longer contains a redundant existing-attachment picker. HTML from either registered or plain uploaded files opens as text. Independent failures preserve whichever side of the unified collection is available. Expanded acceptance is recorded under `.qwen/e2e-tests/unified-session-sources.md`.
