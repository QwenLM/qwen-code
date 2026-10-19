# External memory import

[English](external-memory-import.md) | [简体中文](external-memory-import.zh-CN.md)

## Problem and scope

External clients need to migrate Codex knowledge into Qwen's native memory without
installing a collector or exposing a local filesystem to a cloud runtime. This
feature belongs to Qwen; no DataAgent/OpenCode UI or standalone tool is included.
Directly turning Markdown bullets into native memories loses context and cannot
reliably reconcile historical knowledge with existing memory.

## Design

A versioned source set contains relative Markdown paths and UTF-8 contents. An
offline parser returns source sections, stable content identities, project scope
hints, references and warnings. Sections retain their surrounding headings and
metadata. Uncertain scope remains pending assignment. Source paths are provenance,
never server destinations. Raw sessions, credentials, configuration and skills
are not accepted. Only selected sections become immutable retained resources. Before parsing, conservative
line and inline-marker limits bound admitted Markdown complexity. Repeated ancestor
context counts toward an 8 MiB preview expansion limit; oversize sources must be split.

A trusted workspace owns each submitted batch. The caller explicitly maps selected
sections to project or user scope in that workspace; other project groups can be
submitted to other workspace IDs. Unknown, untrusted, removed, SSH and draining
runtimes fail closed. The `memory_import_v1` capability advertises this contract.
HTTP uses existing daemon authentication and strict mutation protection.

Preview is deterministic and does not call a model or write memory/task records.
Confirmation persists selected resources and a durable task before returning.
Background processing uses the selected workspace's model through a tool-free,
structured side query. Historical source text is data, not instructions. The model
sees only selected source sections and existing memories in the same scope. It
may propose new records, identify duplicates or flag conflicts; it cannot edit
existing records. Runtime validation precedes every write.

Task state, immutable resources and commit intents live outside scanned memory
roots in the private runtime directory. Deterministic identities and a durable
ledger prevent repeated imports from restoring edited or forgotten output.
Commits are serialized and recheck the scanned memory version after model work.
Validated output is journaled before publication; recovery distinguishes an
unpublished intent from completed output. Cancellation stops further commits.
Recovery resumes durable tasks on runtime service activation; failed model calls
require explicit retry, avoiding an unbounded paid retry loop. Unknown retry IDs do
not allocate task directories. Each lock signals loss only to dependent work; once
detected, that holder cannot replace journals or publish staged documents. Other
tasks continue, while explicit user cancellation can still persist cancelled state.

Imported project documents use a separate private root keyed by the real Git
common directory. Main checkouts and linked worktrees share it; clones/forks do
not share merely because their remotes match. Ordinary project memory remains
worktree-scoped. Native scanning, search, fetch, recall and forget include the
imported layer. Source snapshots never enter native scanning. Native writers are
not granted arbitrary access to retained sources.

## Batching and cost limits

Each runtime groups selected sections by confirmed scope and original project group,
then sorts content IDs and packs at most eight sections / 64 KiB of source per model
request. A response must contain exactly one native-validated decision per source ID.
Per-source identity and publication ledgers remain unchanged. Before the first write,
the complete batch response and baseline document hashes are journaled. Later items
accept only that baseline plus this batch's verified publications; external edits,
deletions or additions cause conflicts. Recovery reuses journaled responses. Scope validation happens before journaling a
model response. If an older journal contains a scope-invalid item, retry discards
only that item and requests a fresh response within the remaining budget, retaining
sibling decisions, baselines and publication records.

The metadata index uses the native parser's recognized fields, including its
normalization rules. The model receives this bounded index and relevant complete documents, not a
copy of every existing body. The local full snapshot still protects against edits
and forgetting. If the index or relevant evidence cannot fit, fail with an actionable
context-limit result rather than silently dropping relevant evidence. Index-only
entries are explicitly identified; uncertain overlap must produce a conflict.

Offline preview estimates calls and input/output tokens by source project group,
reserving the maximum existing-context allowance because preview does not read native
memory. Unassigned groups remain estimates until mapped. These are estimates, not
provider billing quotes. Each task permits at most 32 logical model invocations and
512,000 reserved token units; reservations include request bytes (including prompt
and schema) plus an 8,192-token output allowance. Reserve durably before each call;
failed calls, cancellation and retries never refund or reset the allowance. Budget
exhaustion leaves unfinished items visible without making more calls. Model output
is capped and import disables unattended outer retries. Provider-internal retries
and tokenizer overhead mean this is not a guaranteed billed-token or currency cap.

Repository identity lookup uses a bounded memo cache, cleared by the existing memory
root-cache reset, with runtime paths resolved separately. Ordinary scans skip this
lookup entirely when the runtime has no imported-project-memory directory. Import
writes refresh Git identity so cached recall paths cannot authorize stale targets.
Git-layout changes require the same root-cache reset as ordinary project memory.

## Interfaces

Workspace-qualified HTTP routes provide preview, batch submission, listing,
status, source viewing, cancellation and retry. Requests use source/section IDs,
explicit scope selection and a client idempotency key, never destination paths.
CLI `memory import codex --source <directory> --dry-run --json` uses the same
parser offline. Confirmed CLI imports use the same task service with the local
workspace model configuration. JSON envelopes carry `version: 1` and distinguish
preview, task and result counts; source sections are not final memory counts.

## Validation and delivery

Use synthetic source/HOME/runtime/target directories only. Verify offline preview,
selection boundaries, invalid paths, scope mapping, same-repository worktrees,
real native search/fetch, model schema rejection, duplicates, conflicts, edits,
forgetting, cancellation, partial failures, concurrency and restart recovery.
Exercise HTTP with an independent client and a deterministic model server.
Build/typecheck, focused package tests, full diff privacy review and two clean
self-audits precede a replacement PR. No user memories, previews, screenshots or
local reports are committed. The old PR is closed only after its replacement is
created. Continuous sync and cross-instance synchronization are out of scope.

## Status

Implemented for review with synthetic CLI, HTTP, native recall and process-crash recovery verification. Production model quality and Windows/Linux execution remain CI and maintainer validation responsibilities. No production import or deployment was performed.
