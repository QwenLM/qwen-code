# Managed Workspace file references

[English](2026-10-19-managed-workspace-file-references.md) | [简体中文](2026-10-19-managed-workspace-file-references.zh-CN.md)

Status: implemented; verification evidence and known limits are recorded in the local E2E report.

## Problem and current behavior

Managed composers support bounded browser attachments and Plan, but disable the
ordinary daemon Workspace actions. Reference file consequently has no provider,
for both local and SSH Workspaces. Enabling the ordinary actions would address
the daemon's Workspace rather than necessarily the persisted Managed binding.

The existing directory-selection API lists only direct subdirectories of an
actor-owned local ROOT Workspace. It excludes SSH and CSI and does not read
files. Existing Managed input already persists complete UTF-8 attachments,
hashes their bytes, and replays the same canonical input after uncertain delivery.

## Goals and scope

Support browsing and filename search, selecting a UTF-8 file, and submitting its
complete selection-time contents from a local or SSH Managed Workspace. Support
the composer before the first Session and in existing Sessions. Keep the UI and
HTTP contract independent of machine addresses and transport implementations.

The result is a file snapshot: editing the source after selection does not
change the draft or an admitted Turn. Existing file tools remain available for
later live reads. Static Skills, MCP, Extensions, directory attachments, binary
files, large-file storage, and K8s/CSI adapters are outside this change.

## API and authorization

Workspace file access requires the existing deployment Workspace-files opt-in, on both query and read. The same gate is rechecked before returning data.

Add Workspace-scoped WebShell query and read endpoints. Requests identify the
Workspace and its relative working directory. Query accepts a relative
directory or a bounded filename search string. Read accepts one relative file
path and the scope revision returned by query. Responses contain relative paths,
bounded entries or UTF-8 contents, and an opaque scope revision. They contain no
host path, SSH target, Pod, Runtime credential, or lease identifier.

Every request requires a trusted tenant/actor, current OPERATOR or OWNER access,
an ACTIVE Workspace, supported storage and enabled Workspace file access. The
server derives generation, storage, configuration and execution location from
the persisted Workspace. The scope revision covers those binding facts, cwd,
and the registration identity. A stale revision refuses a read.

Authorization resolution runs in short transactions before and after file I/O.
The second resolution must retain the same scope and current grants. Local
processes and SSH never run inside a database transaction. Registration,
maintenance, migration, recovery and removal barriers remain effective. Queries
do not claim or release a Runtime/storage execution lease or start a Session,
worker, Hook or model request.

The interface is persisted-Workspace scoped. An existing Session's UI supplies
its saved Workspace/cwd and resets discovery when context revision changes.
Changing Workspace, cwd, tenant, actor or Session must invalidate a selected
snapshot for submission; its draft remains visible with a reselection error.

## File-access boundary and adapters

Keep one internal query/read document and response shape behind the Java
Workspace file service. Select the implementation from the saved storage kind.
The local adapter uses the configured Node executable and CLI entry in a
dedicated, bounded, read-only fast path. The SSH adapter uses the existing
authenticated SSH bootstrap transport, with JSON over stdin and strict host-key
verification. Both call the same TypeScript file-query implementation.

Both transports first invoke `managed-runtime-bootstrap --help` and require its versioned `workspaceFiles: 1` JSON capability. The new CLI answers before reading stdin or initializing a Runtime. Old installations print ordinary help and are refused before an operation is sent; the installed global CLI was verified to consume no stdin and issue no model request on this help path. After the handshake, the existing `probe` operation accepts a versioned `files` subdocument and returns `result.files`. Missing or malformed protocol output is refused. No unknown command is executed as a prompt, and the file probe never reaches Runtime state setup.

Local registration and marker authority remain in the Java storage guard. It
provides the verified root and root identity to the child and verifies them
again before returning. Local marker permissions need not satisfy the stricter
SSH private-state-file contract. SSH verifies its original persisted identity
and private marker, uses the pinned CLI version, and returns before any Runtime
state-directory creation branch.

Unknown, CSI and unsupported placements fail explicitly before accessing a
local path. A future K8s adapter supplies this same query/read contract through
the resolved Runtime/storage binding; it must validate mount identity and
recovery across Pod replacement. No empty K8s implementation or fallback to the
primary daemon is introduced.

The control plane admits at most four concurrent file exchanges and fails excess requests with a retryable busy response. Each local process has a 15-second deadline; SSH retains its existing bounded command transport.

## Paths, limits and filesystem trust

Accept normalized relative POSIX paths only. Reject absolute paths, traversal,
backslashes, control characters, invalid Unicode and reserved maintenance paths.
Exclude `.git`, `.qwen-child-workspaces` and the Managed storage marker. Reject
symlink components and files, directories as attachments, and special files.

Open reads with `O_NOFOLLOW | O_NONBLOCK`; verify an ordinary file with fstat
before reading. Read at most 24 KiB, decode UTF-8 fatally, and reject NUL or empty
contents. Check root, ancestor and file identity/attributes before and after
I/O. Changed or unavailable files produce a typed error without an absolute path.

Query returns at most 50 entries, scans at most 4,096 entries and 32 directory
levels, and checks a two-second scan deadline. Searches match filenames/relative
paths, not file contents. Bound the serialized response as well and report
truncation. A snapshot response must fit 48 KiB after JSON encoding; it is never
silently truncated. SSH's independent 64 KiB envelope limit remains unchanged.

Local and SSH execution retain the existing trusted host/account assumption.
Node's name-based filesystem APIs on macOS do not provide descriptor-relative
`openat` traversal. Ancestor and descriptor checks detect ordinary replacement
and static symlinks, but do not establish isolation against a hostile same-UID
process actively swapping and restoring path components during a read. This
change does not claim such a sandbox or add a native/Python runtime dependency.

## Composer and durable input

While a selected file is loading, the composer disables Send and fresh submission rejects even if no chip has arrived yet. An incomplete selection cannot admit a text-only Turn.

Introduce a narrow Managed file-actions adapter instead of enabling ordinary
daemon Workspace features. Reuse the shared Reference file picker and its
request cancellation/stale-response behavior. Only file actions are supplied;
other menus retain their own capabilities. Unsupported and empty results are
distinct, and read failures retain the draft.

Selecting a file obtains the snapshot before inserting its chip. If the draft
changes during an inline selection read, retain the edited draft, discard the
stale insertion and ask the user to select the file again. Keep the full
contents, path and source scope in its metadata. Managed composers opt into a
versioned draft envelope that atomically stores text and complete file tags,
including inline positions. Restore the tags on remount; keep legacy plain-text
drafts readable and ordinary composer persistence unchanged. Mobile restores
inline references through its existing top-tag fallback, moving only the known
reference spans and preserving their metadata. Accepted input and explicit
clearing synchronously discard saved tag state before navigation. Submission
extracts only valid selected-file annotations, checks the current source scope,
and converts snapshots to existing `input_file` blocks. Recheck the source after
snapshot hashing and after asynchronous attachment encoding, before saving or
admitting a fresh request. A bounded `input_text`
mapping preserves relative paths and disambiguates equal basenames without
changing raw file contents. Typed path-like text alone does not authorize or
trigger a file read.

Reuse existing attachment normalization, full-byte digests, complete pending
request persistence and the overall 48 KiB encoded-input budget. Freeze all bytes
before admitting a command. Replays never reread the source; accepted input is
cleared only through the existing composer commit callback. The browser may
edit its own input, as with uploaded attachments; snapshot metadata is not an
authorization credential. File-read authorization is enforced by the read API.

Plan may receive selected file contents as user input, just as with an uploaded
text attachment. This grants no execution permission and does not change Plan's
tool whitelist or human exit approval. No new InputBlock type, database schema,
server snapshot table, model-side tool or background indexing service is needed.

## Affected components

| Component                                         | Change                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------- |
| Java Workspace/store and storage guards           | Scope resolution, adapters, authorization and binding rechecks            |
| WebShell controller, OpenAPI and surface registry | Workspace file query/read contract and generated types                    |
| CLI fast paths and SSH bootstrap                  | Shared bounded read-only filesystem implementation                        |
| Shared composer and Managed provider              | Narrow file actions, snapshot selection, draft and submission integration |
| Tests and docs                                    | Isolated local/SSH, API, replay and UI acceptance                         |

## Validation and acceptance

Dry-run the E2E plan with the global CLI first. Use disposable databases, roots,
SSH state and service ports; do not exercise the user's actual Session or reset
the local deployment catalog. Verify the built bundle in a separate deployment.

Acceptance requires real local and SSH queries and snapshots, actual selected
bytes in a Managed model request, new/existing Session UI selection, draft
refresh and exact pending replay after source changes, equal-basename mapping,
Plan and ordinary attachment regressions, and explicit oversized/invalid-file
errors. Verify tenant/grant isolation and revocation, stale generation/context,
marker/root replacement, symlinks, special files, scan budgets, unsupported
storage and no local fallback. Assert no worker, Session, lease or Hook is
created by query/read.

Run focused TypeScript and Java tests, root build/typecheck/bundle, Java verify,
API/surface gates, applicable isolated MySQL tests, formatting and two clean
self-audit passes followed by independent review. Record skips and unavailable
platforms. No K8s, hostile same-UID sandbox, full Hosted/fault or upstream-model
acceptance follows from these checks.

## Open questions

None within this scope. Empty files remain explicitly unsupported under the
existing attachment contract. Future live references and K8s adapters require
their own implementations and acceptance evidence.
