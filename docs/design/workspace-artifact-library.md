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

## Session metadata and progressive reads

DAC needs session identity alongside artifact snapshots to label tasks, restore
archived sessions, and navigate or filter source-specific tasks. Extend each
artifact-library envelope (single, full, and selected-session queries) with a
required `session` object: optional `displayName`, original `createdAt`,
`archiveState` (`active` or `archived`), `sourceType`, and optional `sourceId`.
Keep the general live `/session/:id/artifacts` contract unchanged.

Use existing persisted session-list metadata for original creation time and
creator attribution. Live titles come from the current bridge summary, while
persisted creation time and attribution take precedence when available. A live
session without a transcript uses bridge metadata. Persisted display names use
custom title, then first prompt, matching the existing directory; absent names
remain absent. Missing source types become `default`; preserve open source
strings and their paired IDs, including `resource_inspection`. DAC can exclude
that source explicitly without enumerating task directories. Do not silently
exclude a source from a full-workspace API.

Cache cold envelopes with their metadata. For live sessions, cache only the
bounded persisted metadata read, never the live artifact response or title.
Use one per-runtime entry map and the existing byte budget, with distinct
live-metadata/cold-envelope entry kinds. Validate both against transcript and
ownership fingerprints. Switching live/cold kinds rebuilds the entry; title-only
transcript appends and archive moves invalidate it even without artifact events.
Read live titles and artifacts anew on every request. Thus a resumed session's
creation time does not become its latest load time, and live renames do not wait
for asynchronous transcript persistence.

Full GET and selected-session POST accept `Accept: text/event-stream`; default
responses remain JSON. Advertise `workspace_artifact_library_stream` only when
artifact persistence is available. This capability includes session metadata on
all artifact-library reads. Clients using older daemons must inspect the
capability/response content type rather than assuming an SSE response.

| SSE event       | Data and meaning                                           |
| --------------- | ---------------------------------------------------------- |
| `start`         | `v: 1`, candidate `total`                                  |
| `session`       | Complete enriched per-session artifact envelope            |
| `session_error` | `v: 1`, `sessionId`, `status`, `code`, `message`           |
| `complete`      | `v: 1`, `total`, `succeeded`, `failed`, `skipped`          |
| `error`         | `v: 1`, `status`, `code`, `message`; fatal request failure |

Discover once per request and run at most four continuously replenished read
workers. Emit each completed session independently, in completion order; a slow
session occupies one slot without holding up the other workers. JSON results
retain selection order. Full reads continue to skip absent/foreign persisted
sessions; explicit queries report them. Only `complete` means the scan finished.
A terminal `error` or disconnection without `complete` means a partial result.
This is a finite query, with no replay, automatic reconnect, or live subscription.
Use fetch-based SSE consumption for POST.

Release each archive read barrier before waiting for network backpressure.
Serialize writes and let each worker wait for its result to drain before taking
another session, bounding pending output by worker count. Send heartbeats only
when no write is pending. On disconnect stop dispatching and writing; let already
started shared cache reads settle under their barriers, without cancelling a
load shared by another request. Keep runtime activity/generation checks for the
whole request. Before headers, preserve ordinary HTTP errors; after headers,
report fatal failures through `error` and never append a JSON error response.
Deletion retains its existing protocol and execution path.

## Cache design

Keep a bounded cache per runtime object, so generations and storage roots cannot
share results. Live sessions always read artifacts from the bridge and replace any cold
entry with bounded persisted identity metadata. Cache successful cold artifact
envelopes, including empty results;
never retain transcripts or file contents. Share concurrent loads of the same
unchanged session.

The existing single-session artifact-library GET shares this cache with full
and batch queries. Warming any of these routes benefits the others; either
single or batch removal invalidates the shared entry. Single-session responses gain only the `session` summary; existing fields
and error shapes remain unchanged. A cached envelope's `generatedAt` records
when that projection was built.

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
Re-enumerate on the first query at least two seconds after a completed scan even
if directory identities match, so coarse timestamps cannot hide new cold
sessions indefinitely. This refresh preserves unchanged artifact projections;
it only scans filenames. Process at most four sessions concurrently per request
to bound simultaneous transcript reads.
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
Also verify original creation times after resume, live and cold rename visibility,
archive moves, source attribution/filtering, cross-route metadata cache reuse,
fast-session delivery past a blocked first session, disconnect cleanup,
backpressure, partial failures and exactly one stream completion.
The E2E plans are `.qwen/e2e-tests/workspace-artifact-library.md` and
`.qwen/e2e-tests/artifact-library-dac.md`.

## Decisions and limitations

No open product questions remain: deletion targets explicit pairs, never all
artifacts implicitly. Memory caching optimizes repeated requests within one
daemon lifetime; restart rebuilds it. Results are per-session snapshots, not a
transactional snapshot of the whole workspace. Partial errors remain explicit.
