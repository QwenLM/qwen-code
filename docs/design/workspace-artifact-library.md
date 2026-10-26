# Workspace artifact queries and batch removal

[English](workspace-artifact-library.md) | [简体中文](workspace-artifact-library.zh-CN.md)

## Problem and scope

The existing artifact library reads one live, unloaded, or archived session.
Repeated workspace queries currently replay every unloaded transcript. Add
workspace-wide reads, reads by session IDs, and removal by explicit
`{ sessionId, artifactId }` pairs. Keep workspace files and conversation history.
This extends REST only; SDK wrappers and a disk index are outside this change.

## Protocol

All routes are persisted-workspace scoped and require the same trusted runtime
and daemon authentication as the existing artifact library. Advertise
`workspace_artifact_library` only when artifact persistence is available.

| Method | Route                                            | Input                                                                          |
| ------ | ------------------------------------------------ | ------------------------------------------------------------------------------ |
| GET    | `/workspaces/:workspace/artifact-library`        | All active and archived sessions, including live sessions without a transcript |
| POST   | `/workspaces/:workspace/artifact-library/query`  | `{ "sessionIds": ["..."] }`, 1–100 IDs                                         |
| POST   | `/workspaces/:workspace/artifact-library/delete` | `{ "artifacts": [{ "sessionId": "...", "artifactId": "..." }] }`, 1–100 pairs  |

Queries return `v: 1`, `sessions` (existing per-session envelopes), and `errors`
(session ID, HTTP-equivalent status, code, message). Full discovery omits foreign
or absent sessions; explicit queries report them. A failed member never becomes
an empty successful result. Duplicate IDs or pairs are processed once. Removal
returns `v: 1` and `results`, one mutation result or error per distinct pair.
Already-absent artifact IDs succeed with no changes. Batches are not transactional
across sessions; live removals report each pair independently. Preserve live
persistence warnings and do not report a removal when the bridge kept it.

Invalid input and workspace-level failures use ordinary HTTP errors. Removal
uses the strict mutation guard. Both reads and writes validate live ownership;
internal conversation runtimes also validate each session's eligibility. Shared
archive barriers protect reads, exclusive barriers protect grouped removals,
and runtime activity/generation guards protect the entire operation. There is
no primary-runtime fallback and no session load or unarchive.

## Cache design

Keep a bounded cache per runtime object, so generations and storage roots cannot
share results. Live sessions always read the bridge and discard any cold cache
entry. Cache only successful cold artifact envelopes, including empty results;
never retain transcripts or file contents. Share concurrent loads of the same
unchanged session.

Validate cold entries using `lstat` identities for both transcript locations and
runtime ownership metadata: device, inode, mode, size, mtime, and ctime. Compare
identities before and after loading and cache only an unchanged projection.
Unchanged entries have no expiration requiring transcript replay. External
changes, deletion, archive moves, and replacement files are detected on the next
query. Clear entries around explicit removals. Cache metadata has a 32 MiB
serialized-size budget per runtime. Keep admitted unchanged entries; return new
over-budget results uncached instead of evicting earlier entries on every full
scan. Those uncached sessions require replay on subsequent queries. Invalidation
and discovery of removed sessions release cache space.

Discover candidate filenames in both chat directories without parsing all
transcripts. Cache discovery by directory identity and share concurrent scans.
Use existing session reads for project validation, avoiding the existing
session enumeration method's silent 10,000-file limit. Merge live IDs on every
request. Full responses still incur work proportional to returned metadata;
this change does not claim constant-time queries or real-time filesystem status
for cold artifacts. Filesystem identity checks remain proportional to sessions.

## Grouped persistence

Group removal pairs by session. For a cold group, acquire one existing writer or
maintenance lease, replay once, append one artifact event with the selected
tombstones, and release the lease. Preserve active-branch parenting, managed
authority refusal, storage validation, and shared-preview reference cleanup.
The existing single-artifact service method delegates to the grouped operation.
The 100-pair request limit remains below the persistence event's 800-change limit.

## Components and validation

Changes affect the CLI artifact helper/cache, session routes, capability and
telemetry registration, core grouped artifact removal, protocol documentation,
and focused tests. Existing single-session routes retain their contracts.

Verify live/cold/archived discovery; explicit batches; duplicate and invalid
input; mixed member failures; scope/trust/generation guards; unchanged cold
queries parsing once even after time passes; concurrent-load sharing; external
replacement and runtime-metadata invalidation; empty-cache hits; archive and
load/unload transitions; grouped deletion durability, idempotence, warnings,
and unchanged workspace files. Build, typecheck, bundle, run focused tests, and
exercise the global CLI baseline and local bundle in isolated temporary runtimes.
The E2E plan is `.qwen/e2e-tests/workspace-artifact-library.md`.

## Decisions and limitations

No open product questions remain: deletion targets explicit pairs, never all
artifacts implicitly. Memory caching optimizes repeated requests within one
daemon lifetime; restart rebuilds it. Results are per-session snapshots, not a
transactional snapshot of the whole workspace. Partial errors remain explicit.
