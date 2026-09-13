# Web Shell Session Sources

Status: implemented on this branch; local validation is recorded in the
[implementation notes](../plans/web-shell-session-sources.md).

[中文版](./web-shell-session-sources.zh-CN.md)

## Decision and scope

Provide one Sources section for the session's uploaded files, workspace-file
references, and links. The section combines existing attachment storage with
explicit source metadata; users see each uploaded file once. A listed material
does not mean that a model has read, cited, or used it. Keep these inputs separate
from artifacts, and reuse existing previews and workspace ownership checks.

The first implementation provides:

- A `record_source` tool for explicit file/link registration.
- Session APIs to list, upsert, and remove references.
- Optional attachment metadata enrichment after Web Shell prompt admission.
- Durable metadata, deduplication, and a Sources section in the environment
  panel, with previews in the existing right panel.

Registration stores metadata only. It does not read or copy a file, fetch a URL,
publish content, append resource contents to a prompt, or change permissions.
An explicit tool call still contributes its normal tool acknowledgement to the
conversation. Adding the tool therefore changes the available tool schema, but
does not change prompt admission, scheduling, or model context construction.

MCP/API connection management, automatic collection of file reads/search results,
usage tracking, citation graphs, hook producers, generic `ToolResult.sources`,
cross-session source libraries, and content retention are outside this phase.
The Desktop workspace connection registry is a different feature.

## Current implementation and reuse boundaries

This proposal was checked against `main` at `fb12a6e7fe` on 2026-09-07.

| Existing surface                                                                               | Relevant behavior                                                        | Source implementation decision                                                     |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| [record-artifact.ts](../../packages/core/src/tools/record-artifact.ts)                         | Emits artifact metadata through `ToolResult.artifacts`                   | Reuse naming and input conventions; do not emit artifacts for sources              |
| [sessionArtifacts.ts](../../packages/acp-bridge/src/sessionArtifacts.ts)                       | Maintains artifact records, persistence coordination, and content status | Keep existing artifact behavior intact; do not add a source role to every artifact |
| [session routes](../../packages/cli/src/serve/routes/session.ts)                               | Owner-aware artifact and attachment APIs                                 | Apply the same session owner and client authorization boundaries                   |
| [sessionAttachments.ts](../../packages/acp-bridge/src/sessionAttachments.ts)                   | Owns uploaded attachment bytes and references                            | Reference existing attachment IDs; do not create another upload store              |
| [session actions](../../packages/web-shell/client/daemon/session/actions.ts)                   | Uploads attachments, then obtains prompt admission                       | Register accepted attachment references through a separate metadata request        |
| [EnvironmentPanel.tsx](../../packages/web-shell/client/components/panels/EnvironmentPanel.tsx) | Environment, subagents, and background task sections                     | Add a configurable `sources` section                                               |
| [ArtifactPanel.tsx](../../packages/web-shell/client/components/artifacts/ArtifactPanel.tsx)    | File previews and right-panel detail surfaces                            | Reuse the relevant renderers and owner resolver through a source tab               |

The existing artifact `source: tool | hook | client` field describes the
registrant. It is not a session reference entity. An artifact and a source may
point to the same workspace file, but have independent IDs and removal behavior.
Source previews must not create hidden artifact records or add output cards to
the transcript.

## Unified view and registered metadata

Attachments remain the durable store for uploaded file bytes. The Sources
section displays those files directly, including historical files with no source
record. The source APIs continue to manage explicit reference metadata. The UI
uses real source records and attachment references as separate input types; it
does not invent source IDs or timestamps for uploaded files.

Deduplicate by attachment ID. When a registered attachment source exists, its
title and description take precedence; otherwise show the existing filename.
Workspace references and links remain independent, even when names match. No
read, refresh, or migration automatically registers historical attachments.

The source API's 200-record and field-length limits apply to registered metadata,
not to the number or filename length of already-uploaded files in the unified
view. The view preserves each store's ordering rather than inventing a common
creation time.

Removing an attachment's source registration removes its metadata and source ID
from the source API. It does not delete the bytes: the file remains visible as a
plain uploaded file. Opening or refreshing that file does not recreate the
registration or advance its revision. Removing workspace-file or link references
removes those explicit entries. The unified list has no per-row dismiss action.

## Data contract for registered metadata

Public source API types:

```ts
type SessionSourceLocator =
  | { type: 'workspace_file'; workspacePath: string }
  | { type: 'attachment'; attachmentId: string }
  | { type: 'url'; url: string };

interface SessionSourceInput {
  title: string;
  locator: SessionSourceLocator;
  description?: string;
}

interface SessionSource extends SessionSourceInput {
  id: string;
  kind: 'file' | 'link';
  workspaceCwd?: string;
  createdAt: string;
  updatedAt: string;
}

interface SessionSourcesSnapshot {
  version: 1;
  revision: number;
  sources: SessionSource[];
}
```

The server derives `kind`, ID, timestamps, and `workspaceCwd`; callers cannot set
them. `workspaceCwd` is required on stored workspace-file sources and absent on
other kinds. It captures the owning workspace at registration, so a later
session cwd change cannot silently retarget a reference. MIME
type, byte size, and resource availability come from the existing file or
attachment resolver when opening a preview. They are not registration-time
claims. No extensible metadata bag, retention flags, “used” state, per-turn usage
history, or caller-supplied workspace identity is needed.

### Validation and identity

- Accept exactly one locator variant with its required field; reject unknown
  input fields. Trim titles/descriptions, reject empty titles and control
  characters, and limit title to 200, description to 1,000, workspace path to
  500, attachment ID to 200, and URL to 2,048 characters.
- Workspace paths are relative to the session's bound workspace. Normalize
  separators and `.` segments and reject absolute paths, traversal outside the
  root, and NULs. Registration performs lexical validation only; preview uses
  existing filesystem access/trust checks, including symlink containment.
- Attachment IDs must identify an existing attachment in the same session on
  registration. The daemon checks this before forwarding the mutation. The
  tool accepts only workspace files and URLs, so it cannot bypass this check.
- URLs must parse as HTTP(S), have a hostname, and have no embedded credentials.
  Do not fetch them or infer canonical URLs through redirects. Preserve query
  parameters and fragments: distinct document sections remain distinct sources.
  Persisted URL/title data uses existing transcript privacy handling; no new
  logging of raw source payloads is introduced.
- Deduplication key is the session ID plus locator type, normalized locator, and
  the server-derived workspace cwd for workspace files.
  Use a deterministic digest for the opaque source ID. Keep path case intact;
  do not resolve symlinks or hash file contents to deduplicate.
- Upsert of the same locator keeps its ID and `createdAt`. A changed title or
  description updates `updatedAt`; omitted description preserves the previous
  value and an empty description clears it. Identical input is a no-op.
- URLs and files with similar names are distinct. Uploaded bytes with different
  attachment IDs are distinct even when their filenames match.
- Cap the list at 200 records. Updating existing records still works at the
  limit; adding another returns `409 source_limit_reached`. Do not silently
  evict entries that the user expects to find later.

Registered list order is stable: newest `createdAt` first, then ID. Metadata edits do not
reorder the list.

## Registration and API behavior

### Agent tool

`record_source` accepts `title`, optional `description`, and either a
`workspace_file` or `url` locator. Its description explains that the caller is
adding a reference, not proving usage, and should use `record_artifact` for
newly produced deliverables.

Example:

```json
{
  "title": "Project requirements",
  "locator": {
    "type": "workspace_file",
    "workspacePath": "docs/requirements.md"
  }
}
```

Register the tool only for a top-level daemon ACP session with a bound source
service. Follow existing tool allow/deny rules. Do not expose it in standalone
CLI, SDK-only, or subagent execution in this phase; do not introduce a global
service or reuse the artifact enable flag. Binding must be established before
tool discovery and refreshed correctly on session load/replacement.

The tool calls the session's source service directly and returns a short
acknowledgement with the source ID only after persistence succeeds. Validation
or persistence failure produces an ordinary tool error. Avoid new metadata
fields in every tool result, tool scheduler, hook result, and history replay
path just to support one explicit registration tool.

### Session HTTP API

| Method and path                         | Input                    | Successful result                                                                        |
| --------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------- |
| `GET /session/:id/sources`              | None                     | `200 { revision, sources }`                                                              |
| `POST /session/:id/sources`             | One `SessionSourceInput` | `200 { revision, source, change }`, where change is `created`, `updated`, or `unchanged` |
| `DELETE /session/:id/sources/:sourceId` | None                     | `200 { revision, removed }`; an already absent ID gives `removed: false`                 |

There is no PATCH endpoint; POST is the metadata upsert. No batch endpoint is
needed initially. Attachment automation sends the small number of references
individually and reports any failures per item.

All three routes are **live-session-owner scoped**. Reads use
`withOwnerReadSession`; mutations use `withOwnerMutableSession` and the existing
strict mutation gate. Require a valid session-bound client ID for mutations;
reads retain the existing session read authorization rules. Resolve exactly one
trusted owning runtime before touching a bridge, service, file, or attachment.

Reuse existing owner errors: unknown session, untrusted workspace, ambiguous
owner, and bootstrapping/draining/removed runtime states follow the established
route helpers. Never fall back to the primary runtime. Persisted-only sessions
must be resumed through the existing session lifecycle before these routes work.
Archived-session mutations follow the shared archive coordinator's rejection.
Source metadata operations may run while a prompt is active; they serialize
with source mutations and the recording writer, not with the entire model turn.
They must not acquire an idle-only prompt gate or hold a prompt scheduling lock.

Invalid source payloads return `400 invalid_source`; unavailable persistence
returns `503 source_persistence_unavailable`. Use `404` for a missing attachment
at registration, without revealing attachments belonging to other sessions.
Mutation timeout is an unknown outcome: refetch the list or retry the same
upsert/delete. Do not retry through a different owner or transport.

The TypeScript daemon session client exposes `listSources`, `upsertSource`, and
`removeSource`. These public methods use owner-routed REST even when the client
uses ACP for prompts, preserving one client authorization path. Internal child
methods described below are not an alternative public mutation transport.

### Attachment metadata enrichment

In the Web Shell session action, keep upload, prompt submission, admission
callbacks, optimistic messages, and rejected-upload cleanup unchanged. After
`submitPrompt` returns acceptance, launch a caught, independent registration
operation using the uploaded attachment IDs and original display names.

- Capture the admitted session/client identity, attachment IDs, and owner guard.
  Never obtain the destination from a later active-session selection.
- Do not await source registration before continuing stream handling or reporting
  admission. Do not add source contents or source IDs to the prompt body.
- A definite prompt rejection or cancellation before acceptance registers nothing.
  A model failure after acceptance does not remove the added references.
- Ambiguous admission follows existing prompt recovery. Do not register until
  acceptance is confirmed, and never resubmit a prompt to repair source metadata.
- A registration failure leaves the sent message and visible uploaded file
  intact. Show “Message sent; some source details could not be saved” with a
  metadata-only Retry action.
  On owner change, suppress stale UI callbacks; a request already sent remains
  bound to the original session.
- Browser closure can lose this best-effort metadata enrichment. Retry state is
  in memory only. The uploaded file remains visible and previewable without a
  source record; do not scan/replay old messages to backfill metadata.
- Removing registered metadata does not cause a background history scan to add
  it back. Existing uploaded bytes remain visible as a file. Explicit registration
  or a newly accepted message may add metadata again.

This boundary deliberately avoids server-side prompt admission changes and a
durable registration job queue.

## Ownership, persistence, and notifications

Use one small session-bound source service in the ACP child/core layer, where
the chat recording writer already lives. Both the tool and daemon-forwarded
mutations call this service. The bridge provides routing and notifications; it
does not maintain a second authoritative mutable source store.

Proposed internal child methods are `qwen/session/sources/list`,
`qwen/session/sources/upsert`, and `qwen/session/sources/remove`, carried over the
existing authenticated daemon-to-child connection. Bind and validate their
session IDs like other internal session methods. External clients cannot use
these to bypass REST authorization or attachment ownership validation.

Persist a versioned `session_sources_snapshot` system record containing the
complete bounded list and revision. With a maximum of 200 metadata entries,
one snapshot per actual mutation is simpler than a separate event journal,
tombstone index, database, and sidecar cache. Registration is explicit and
low-frequency; no-op retries do not append records.

Start an empty service at revision zero. Serialize mutations through the session
service. Build and validate the next snapshot with revision N+1, append it
through the existing chat recording owner's strict append path (as used by
`recordSessionArtifactSnapshot`), then publish it as the live state. Durability
uses that writer's acknowledged-write guarantee, not a new power-loss guarantee.
A failed append changes neither
the live list nor the acknowledged revision. Deletion uses the same ordering;
do not show durable success for a removal that can reappear after restart.
If the append outcome is uncertain, reload the latest valid persisted snapshot
before accepting another mutation. Never acknowledge a volatile-only success.

After commit, the child sends `qwen/notify/session/sources-changed` with session
ID and revision. The bridge exposes `source_changed` on the existing daemon
event stream with the same fields. This is a list invalidation signal, not a
chat message or artifact event. Clients fetch the authoritative list and ignore
older revisions and responses from stale session owners. Notification failure
does not undo a committed write; mutation responses and reconnect refresh repair
the display. Mark it as a known non-transcript event in SDK normalization and
reducers, so it cannot become a debug bubble in the conversation.

### Lifecycle rules

| Operation           | Registered metadata behavior                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Refresh/reconnect   | Fetch the current list after attachment to the session                                                                     |
| Restart/load/resume | Restore the latest valid supported snapshot; no source records means an empty metadata list; uploaded files remain visible |
| History replay      | Rebuild metadata only; never rerun registration tools or copy attachments                                                  |
| Compaction          | Preserve the latest snapshot as session metadata, excluded from model context and summaries                                |
| Rewind              | Keep the current reference list; if history is rewritten, carry its latest snapshot forward                                |
| Fork                | Copy the current reference list as session metadata, independently of a turn cutoff; regenerate IDs for the target session |
| Archive             | Keep metadata with the session; disable mutations under existing archive rules                                             |
| Session deletion    | Delete metadata through normal session storage deletion; external resources remain untouched                               |
| Remove reference    | Persist the new list; leave original files, attachment bytes, and prior chat content intact                                |

Fork uses existing attachment-copy/remap results for attachment locators. Keep
workspace-relative references only when the target has the same bound workspace
identity. Omit unmappable attachments or cross-workspace file references with a
source-specific warning; never guess paths or point at the parent's attachment
store. Links copy unchanged. A target source-snapshot write failure must be
reported as sources not copied and must not invalidate an otherwise successful
conversation fork. There is no promise of original file bytes: previews show
the currently accessible resource.

Validate restored snapshots before use. A malformed last record or unsupported
version must not silently restore an older pre-removal list. Preserve the
transcript, mark registered metadata unavailable, and reject source writes until a supported
valid state can be restored. Conversation loading still proceeds. Restore/fork,
rewind, and compaction tests are required before advertising persistence support.

## Web Shell interaction and preview

Use `sources` in the default environment section list, after Environment and
before Subagents, and stop displaying a separate Attachments section. Keep the
public `attachments` customization value as a compatibility choice for hosts:
`attachments` alone shows uploaded files, `sources` shows the complete reference
view, and including both still produces one section.

The `session_sources` capability gates registered metadata and Add actions. An
older daemon can still show its uploaded files through the existing attachment
capabilities. Source metadata and attachment-list loading/errors are independent;
one failed request must not hide successful results from the other store.

- Header: “Sources” / “来源”, count, and an Add action. Show three rows initially.
  Longer lists offer an accessible “View all” / “查看全部” button, which becomes
  “Collapse” / “收起” when expanded and restores the three-row view.
- Rows show a file/link icon and a single-line, truncated title. The full locator
  remains available in the hover title and preview details. Activating a row
  opens its preview. Support keyboard focus, overflow truncation, and clear
  accessible names.
- Empty state: “Add files or links for reference.” Explain in the Add form that
  adding a reference does not send its contents to the assistant.
- Add supports a workspace-relative path or HTTP(S) link. Use existing primitives
  and the portal root. Uploading stays in the composer; uploaded files already
  appear in Sources and need no second picker or registration step. A title can
  default to the filename/hostname and be edited before registration.
- Loading, failed load with Retry, and capability absence are separate states.
  A failed refresh keeps the last same-owner list with a visible error. Initial
  failure must not look like an empty successful list.

Registered sources use a `source` right-panel tab keyed by session ID and source
ID. Plain uploaded files reuse existing attachment preview tabs, with HTML forced
to source-text rendering and that preview mode retained on tab restoration.
Both paths retain the session/workspace owner identity and locator. Resolve current capabilities at
use time, as described in
[artifact workspace ownership](./web-shell-artifact-workspace-ownership.md).
Invalidate pending loads and open tabs on owner replacement or trust loss.
Workspace-file previews must match the stored `workspaceCwd` to the session's
current bound workspace; mismatch shows an unavailable reference. Never rebase
the path onto a new cwd. Other references remain usable. A subsequent explicit
registration in the new workspace creates a distinct file source.

Reuse file renderers through a narrow internal adapter or extraction where
needed. Do not generalize the entire artifact model or modify stable CSS merely
for consistency. Workspace files use scoped file actions; attachment bytes use
the existing session attachment endpoint and blob lifecycle. URL sources display
their metadata and an explicit Open original link, with no automatic fetch,
iframe, or link preview request. Source HTML defaults to source-text preview;
registering input HTML must not invoke artifact publishing or execute it.

Reuse existing size limits and supported image/PDF/text previews. Unsupported
types offer the existing permitted download/open behavior. Missing files,
removed attachments, blocked access, and network errors appear in the detail
view with Retry where appropriate; they do not delete the reference. List
rendering does not stat every file or probe every URL. A source removed while
its tab is open closes that tab after successful refresh/mutation.

## Implementation sequence and consumer checklist

The implementation follows this sequence, with capability advertising after the
service, transport, and UI are connected:

1. Core source types/service and snapshot validation; chat recording record
   allowlists, restore, fork, rewind, and compaction handling.
2. Session-bound `record_source` tool and internal ACP handlers; bridge routing,
   attachment validation, source event forwarding, and owner-aware REST routes.
3. TypeScript daemon request/response types, session client methods, event parser,
   UI normalizer, and Web Shell daemon actions/provider event signals.
4. Web Shell source hook, environment section/customization, post-admission
   registration with retry, and source preview tab with owner guards.
5. Focused regression tests, E2E evidence, documentation, then advertise
   `session_sources` and expose the tool for supported sessions.

The changes span core, CLI/ACP, bridge, TypeScript SDK, and Web Shell. Review must
cover all consumers above, including event-to-transcript conversion and session
lifecycle reconstruction. Python/Java SDKs, standalone CLI, other ACP clients,
and Desktop receive no new public source API in this phase; their existing
history readers must ignore the new metadata record safely. Existing artifact
records and APIs need no migration. Old sessions start with an empty metadata list while their uploaded files remain
visible; older daemons show files without source metadata actions. Do not fall back to artifact registration when
the source capability is absent or an operation fails.

## Verification plan for implementation

The acceptance matrix below defines the implementation checks. The global CLI
baseline, focused regression results, actual daemon and browser runs, and
self-audit notes are recorded locally under `.qwen/e2e-tests/session-sources.md`.
See the implementation notes for the tested boundaries.

| Area                   | Required evidence                                                                                                                                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registration           | File/link upsert, stable IDs, no-op revision, metadata edit, description clear, capacity, invalid locators and fields                                                                                                  |
| Concurrency/durability | Simultaneous tool/client writes serialize; write failure retains old state; timeout/retry does not duplicate; restart after deletion does not resurrect                                                                |
| Lifecycle              | Load, reconnect, compaction, rewind, fork attachment remap/cross-workspace omissions, archive rejection, malformed/future snapshots                                                                                    |
| Ownership              | Primary and secondary sessions route correctly; unknown, untrusted, ambiguous, bootstrapping, draining, removed, and replaced owners never call primary operations                                                     |
| Attachments            | Upload alone adds nothing; accepted message enriches file metadata; rejected submission adds nothing; registration failure/retry never resends the prompt; historical uploaded files stay visible without registration |
| Conversation isolation | Prompt content before/after registration is identical; no file read/network fetch during registration; no artifact added; source notifications produce no transcript bubble; model tool success requires persistence   |
| UI                     | Empty/loading/error/long list; Add/open; keyboard and narrow layout; explicit host section configuration; capability absent                                                                                            |
| Preview                | Workspace file, attachment image/PDF/text, URL Open original, source HTML text, unsupported type, revoked trust, stale response, missing resource, removed open tab                                                    |
| Compatibility          | Older daemon shows uploaded files; old session metadata loads empty; existing artifacts and prompt flow remain unchanged; unrelated clients ignore metadata safely                                                     |

The main tradeoff is deliberate: explicit registration and a small durable list
give a usable reference panel without a provenance engine. Automatic attachment
registration can be lost if the browser closes after admission; the initial
design makes that limitation visible and repairable without changing message
delivery or adding background infrastructure.
