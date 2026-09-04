# Web Shell File Upload

## Problem

The Web Shell composer allows referencing workspace files via `@path/to/file`, but the file must already exist in the workspace. Users frequently need to bring local files (screenshots, data files, configs) into the workspace to reference them in prompts. The current workflow requires manually saving files via the CLI or another tool before the Web Shell can see them.

This feature adds direct file upload from the browser to the workspace:

1. **Drag-and-drop** onto the composer input — uploads to the target workspace root, shows inline progress above the input.
2. **@ panel upload item** — uploads to the currently browsed directory in the @ file picker.
3. After upload, the composer automatically inserts `@filename` so the existing `@` resolver can consume supported files.

## Out of scope

- Multipart form parsing, resumable/chunked uploads, folder upload.
- `expectedHash`-gated writes (CAS): the browser cannot cheaply hash a large file before upload. Can be added later if a client needs it.
- In-place overwrite of existing files via upload: **uploads never overwrite**. The server always resolves an ordinary name conflict by auto-numbering. If in-place replacement or fail-on-conflict behavior is ever needed, it should be added only with a concrete client requirement and an explicit contract.
- ACP-HTTP parity (`_qwen/file/upload`): REST-only for v1, see below.
- Configurable size limit (env/flag): hardcoded constant for now, matching existing limit style.

## Design

### fs layer: new `writeBytesAtomic`

`WorkspaceFileSystem` (`packages/cli/src/serve/fs/workspace-file-system.ts`) has byte **reads** (`readBytes` / `readBytesWindow`) but only text **writes** (`writeTextAtomic` / `writeTextOverwrite` / `writeText` / `edit*`), all of which apply encoding/BOM/line-ending normalization that would corrupt binary content. This feature therefore adds a symmetric binary write method to the interface first:

```typescript
writeBytesAtomic(
  p: ResolvedPath,
  data: Buffer,
): Promise<{ sizeBytes: number; hash: ContentHash }>;
```

The method is a single-purpose no-clobber create primitive; it cannot modify or replace existing file content. Posture mirrors the existing `writeTextAtomic({ mode: 'create' })` publication semantics:

- Add `MAX_UPLOAD_BYTES = 50 * 1024 * 1024` to `fs/policy.ts` and export it through `fs/index.ts`. `writeBytesAtomic` enforces `enforceWriteSize(data.length, MAX_UPLOAD_BYTES)`; existing text writes continue using the default `MAX_WRITE_BYTES = 5 * 1024 * 1024`. The upload limit is a distinct binary-ingress policy, not an increase to agent text-write limits.
- `writeBytesAtomic` enforces the trust boundary itself with `assertTrustedForIntent(..., 'write')`; HTTP admission is only an early-rejection optimization. It checks the generation guard at entry, again inside the path lock before temp-file publication, and at the existing final publish checkpoint so a draining/removed runtime cannot commit after admission.
- Atomic temp-file + publish: an interrupted or canceled upload never exposes a partial target.
- An existing target throws `FsError('file_already_exists')` (409), including an external writer racing the final no-clobber publication.
- Symlinks at the target are rejected (`symlink_escape`), consistent with the text writes; boundary resolution goes through the existing `resolve(path, 'write')`.
- A new file is created at `0o600` (not umask default).
- The implementation reuses the existing path lock, temp-file reservation, no-clobber create publication, generation guard, audit, and cleanup machinery. Generalize the current atomic publisher to accept an already validated `Buffer`; do not copy a second binary-specific atomic-write implementation. The byte path must not pass through `atomicWriteTextResolvedFile`, whose internal `enforceWriteSize(buf.length)` intentionally applies the 5 MiB text default. Each public write path validates its final byte buffer with its own policy before calling the shared publisher.

The fs layer also gains `mkdir(p: ResolvedPath, opts?: { recursive?: boolean })` so the upload route can materialize a configured drop folder that does not exist yet. It enforces the same trust boundary and generation guard as the write paths, holds the path lock, creates directories at `0o755` (modulo umask), and re-checks every created component with `lstat` immediately after `mkdir` — plus each component's parent before the next `mkdir` — so a symlink swapped in mid-creation is rejected (`symlink_escape`) instead of followed. An existing directory is a no-op; an existing non-directory or symlink at the target is rejected.

### Daemon: new `POST /file/upload` endpoint

Extend `routes/workspace-file-write.ts`, which already owns the workspace file mutation routes and its private `getFsFactory` / `parseClientId` / `resolveOriginatorClientId` machinery. Keeping upload registration there avoids cloning the trust, identity, and workspace-resolution plumbing into a second module.

**Routes** (both behind `deps.mutate({ strict: true })`):

- `POST /file/upload`
- `POST /workspaces/:workspace/file/upload`

Route ownership/scope is identical to `POST /file/write`: workspace-scoped, resolved-runtime. The qualified variant follows the same failure semantics — unknown (including an already removed workspace), untrusted, or non-active workspace states are rejected and never fall back to the primary runtime.

**Request:**

```
Content-Type: application/octet-stream
X-Qwen-Client-Id: <clientId>

Query parameters:
  path — target file path (relative to workspace root), required,
         encoded by URLSearchParams (filenames are frequently non-ASCII);
         the server validates Express's already-decoded req.query.path and
         must not call decodeURIComponent again

Body: raw binary bytes
```

**Middleware chain:**

1. `deps.mutate({ strict: true })` — unauthenticated mutations are rejected before any buffering.
2. `fileUploadAdmission` — performs every cheap request-level check before buffering (final-name boundary checks happen in the handler's candidate loop, which runs after buffering):
   - Legacy route: verifies the primary workspace is currently trusted through an injected `isWorkspaceTrusted()` dependency.
   - Qualified route: `resolveWorkspaceRuntimeFromParam` → `requireTrustedWorkspaceRuntime` → `setWorkspaceRouteContext`. Unknown (including an already removed workspace), untrusted, or draining workspaces stop here and never fall back to the primary runtime.
   - Requires `Content-Type: application/octet-stream`; otherwise returns `{ errorKind: 'unsupported_media_type', error: 'File uploads require application/octet-stream', status: 415 }` with status 415.
   - Rejects missing/invalid `path` and a requested basename over `MAX_UPLOAD_FILENAME_BYTES` with a standard `parse_error` envelope.
   - If a valid `Content-Length` is present and exceeds `MAX_UPLOAD_BYTES`, returns the upload-specific 413 immediately. The raw parser remains authoritative for chunked bodies and clients that omit or understate the header.
   - Runs `parseClientId` and `resolveOriginatorClientId` against the selected runtime's bridge. An invalid client id is rejected before buffering.
   - Splits `path` into directory + basename, resolves the directory with `fs.resolve(dir, 'write')`, and verifies it is an existing directory with `fs.stat`. A missing parent directory is created first via the new `WorkspaceFileSystem.mkdir(..., { recursive: true })` primitive (uploading into a configured drop folder that does not exist yet creates it, including missing parents). Traversal, parent-link escapes, non-directory parents, and other boundary failures are therefore rejected before buffering. The directory path is also capped at `MAX_UPLOAD_DIR_DEPTH = 64` components, so a single request cannot materialize an unbounded directory tree ahead of the concurrency gate. The requested final name itself is resolved per candidate in the handler's loop after buffering; an escaping final-component symlink surfaces as the loop's boundary error. Note the widened surface: an authenticated client can now create directory trees (up to the depth cap) inside a trusted workspace via REST, including dotfile components such as `.git/` — the existing file-write routes already allow writing inside `.git/`, so this adds directory creation, not a new write class.
   - Stores the requested basename, resolved parent directory, route name, and the per-request fs instance in a private request context for the handler; the handler does not resolve the parent directory again.
3. `fileUploadConcurrencyGate` — admits at most `MAX_CONCURRENT_UPLOADS = 4` requests across the legacy and qualified routes. `createServeApp` creates one shared gate and injects it into both route registrations. A saturated gate returns 429 with `Retry-After: 1` before body parsing. Before the upload handler starts, response `finish` or `close` releases the slot; after the handler starts, the slot remains held until the handler settles so disconnecting clients cannot bypass the memory bound.
4. `fileUploadBodyParser` — wraps `express.raw({ type: 'application/octet-stream', limit: MAX_UPLOAD_BYTES })`. The numeric fs policy constant is the single source of truth for both parser and write limits. Its callback intercepts body-parser `status === 413` and returns the upload-specific `file_too_large` envelope below; other errors call `next(err)`. This prevents the global JSON parser error handler from incorrectly reporting the existing 10 MB JSON limit.
5. Handler: normalizes an absent parsed body for a valid zero-length request to `Buffer.alloc(0)`, takes the admitted request-scoped fs instance, then executes the name-allocation flow below.

Path traversal and symlink escape are blocked by the same `fs.resolve` boundary guards as `/file/write`.

**Name allocation:** `WorkspaceFileSystem` only exposes no-clobber byte creation. The route owns the upload-specific naming policy:

- Try the requested path first, then numbered candidates on `file_already_exists`. Insert ` (N)` before the final extension: `report.pdf → report (1).pdf → report (2).pdf`; no extension: `README → README (1)`; a dotfile with no further extension stays whole: `.env → .env (1)`. The loop makes 1000 attempts total — the requested name plus ` (1)` through ` (999)` — then returns `file_already_exists` if every name is occupied.
- Every numbered candidate is built under the captured resolved directory and independently passes through `fs.resolve(candidate, 'write')`. If resolution produces a different path, that candidate is occupied by an in-workspace symlink and the route continues numbering without calling `writeBytesAtomic`. The no-clobber fs primitive makes concurrent uploads and external writers safe without relying on a route-level lock: if the name is already occupied by any entry, the route tries the next candidate. Boundary and I/O errors stop the loop.
- A route-local `MAX_UPLOAD_FILENAME_BYTES = 255` is the v1 upload filename policy cap, chosen to avoid `ENAMETOOLONG` on common POSIX filesystems; it is not claimed as a complete cross-platform filename validator. When a suffix would exceed the cap, trim only the stem on a Unicode code-point boundary until `stem + suffix + extension` fits; never trim the extension or split a UTF-8 sequence. If the suffix and extension alone cannot fit, return `parse_error`. Platform-specific restrictions such as Windows reserved names remain fs errors from `resolve`/publication.

**Response:** uploads always create, so the response is always 201. `path` is the final server-confirmed path — a numbered candidate when the requested name was occupied — and clients must use it (not the requested path) for the `@` reference.

```json
{
  "kind": "file_upload",
  "path": "relative/path/to/report (1).pdf",
  "sizeBytes": 12345,
  "hash": "sha256:<64 lowercase hex>"
}
```

The response does not include a redundant `renamed` flag. A client that needs to show an auto-numbering hint compares the requested `path` with the returned `path`.

Filesystem and upload-specific validation errors use `{ errorKind, error, status, ...details }`: `file_already_exists` 409 when the numbered-candidate cap is exhausted, `parse_error` 400, `unsupported_media_type` 415, `path_outside_workspace` / `symlink_escape` 400, `untrusted_workspace` / `permission_denied` 403, and upload-specific 413:

```json
{
  "errorKind": "file_too_large",
  "error": "Request body too large (max 50 MiB)",
  "status": 413,
  "maxBytes": 52428800
}
```

The admission check and route-level raw-parser wrapper both emit this response because parser failures occur before the handler and cannot pass through `sendFsError`. Authentication, client-id, and workspace-runtime failures keep their existing daemon envelopes; the SDK's existing `DaemonHttpError` already preserves their status and parsed response body. This route does not duplicate shared validation helpers merely to rename `code` to `errorKind`.

When all upload slots are occupied, the concurrency gate returns:

```json
{
  "errorKind": "upload_busy",
  "error": "Too many uploads in progress",
  "status": 429,
  "retryAfterSeconds": 1
}
```

**Limits:** `MAX_UPLOAD_BYTES` is the shared hardcoded 50 MiB policy constant; no separate string-valued route constant or env/flag configurability without a driver. It is sized for screenshots, data files, and configs. Keeping the parser and fs boundary on the same numeric constant prevents requests from being fully buffered under one limit and rejected later under another. Because `express.raw` holds the complete body in memory, relying on the listener's default 256-connection cap would permit roughly 12.5 GiB of upload buffers. The shared four-slot gate instead bounds upload-body buffering to roughly 200 MiB plus normal framework overhead. Make the limit configurable or replace buffering with a streaming fs primitive only if production measurements require a different throughput/memory tradeoff.

**Capability and limit discovery:** add `workspace_file_upload: { since: 'v1' }` in `capabilities.ts` — convention is new route contract = new tag (same split as `workspace_file_bytes` from `workspace_file_read`). Also add optional `maxWorkspaceFileUploadBytes` to `DaemonCapabilitiesLimits` and advertise `MAX_UPLOAD_BYTES` when the feature is present. Web Shell checks this value before sending and falls back to 50 MiB only if a capability-compatible daemon omits it. Older daemons without the feature tag hide the entry points and return 404 if called directly. A secondary-workspace target additionally requires `workspace_qualified_rest_core`; update that capability's route description to include file upload.

**ACP-HTTP: out of scope for v1.** `/file/write` also exists as `_qwen/file/write` on the ACP-HTTP surface, but `/file/upload` is REST-only: the Web Shell (the only v1 consumer) talks REST directly, and the ACP-HTTP JSON wire cannot carry raw binary. No entries in `acpRouteTable.ts` / `dispatch.ts`; a base64 `_qwen/file/upload` can follow if a non-browser ACP client ever needs it.

**Telemetry:** add the `/workspace/file/upload` suffix to the POST allowlist in `server/telemetry.ts` (normalized from `/workspaces/:workspace/file/upload`, next to the existing `/workspace/file/write` entry), otherwise latency lands in the unknown bucket.

### SDK: `uploadWorkspaceFile()` on both client classes

Follows the existing request-object signature style (`writeWorkspaceFile(req, clientId?)`). Qualified access goes through the existing `client.workspaceById()` / `workspaceByCwd()` selectors — **no** `uploadWorkspaceQualifiedFile` on `DaemonClient`.

```typescript
interface DaemonWorkspaceFileUploadRequest {
  path: string;
  data: ArrayBuffer | Uint8Array | Blob;
  signal?: AbortSignal;
  /** Omitted inherits the client's default; 0 disables the timeout. */
  timeoutMs?: number;
  /** Browser-only: requesting progress without XMLHttpRequest is an error. */
  onProgress?: (event: { loaded: number; total: number }) => void;
}

interface DaemonWorkspaceFileUploadResult {
  kind: 'file_upload';
  path: string;
  sizeBytes: number;
  hash: DaemonContentHash;
}

// DaemonClient (legacy-primary), mirrors writeWorkspaceFile
async uploadWorkspaceFile(
  req: DaemonWorkspaceFileUploadRequest,
  clientId?: string,
): Promise<DaemonWorkspaceFileUploadResult>;

// WorkspaceDaemonClient (workspace-qualified), mirrors its writeWorkspaceFile
async uploadWorkspaceFile(
  req: DaemonWorkspaceFileUploadRequest,
  clientId?: string,
): Promise<DaemonWorkspaceFileUploadResult>;
```

Both delegate to one shared internal raw-POST helper on `DaemonClient`, parameterized by URL + route name, the same pairing `WorkspaceDaemonClient` already uses (`/file/write` → `POST /workspaces/:workspace/file/write`). This keeps authentication headers, timeout/abort composition, response parsing, and `DaemonHttpError` construction in one place. Build the URL with `URL.searchParams.set('path', req.path)`; do not pre-encode `path` with `encodeURIComponent`.

Transport is `XMLHttpRequest` when `onProgress` is provided (`fetch` exposes no upload progress), plain `fetch` otherwise. `onProgress` is explicitly browser-only: if `XMLHttpRequest` is unavailable, fail before sending rather than silently losing progress. Both paths honor `signal`, use the same authentication/client-id headers and `failOnError` response shape, and apply `timeoutMs`. Omission inherits the client's existing timeout; `0` explicitly disables it. The Web Shell passes `timeoutMs: 0` because its per-item `AbortController` owns cancellation and a valid 50 MiB upload can exceed the SDK's general 30-second default.

### Web Shell: target workspace resolution

The Web Shell is multi-workspace, so uploads must use the same target as the composer's existing file actions. Do not add a second voice-style resolver:

- When `useComposerCore` has `workspace` and `atWorkspaceCwd`, use `workspace.client.workspaceByCwd(atWorkspaceCwd).uploadWorkspaceFile(...)`, exactly as its qualified `listDirectory` / `globWorkspace` actions do today. This includes a primary workspace addressed through the qualified route.
- Only the existing legacy composer path with no `atWorkspaceCwd` uses `workspace.client.uploadWorkspaceFile(...)`; a modern multi-workspace composer with a missing cwd is unsupported rather than silently targeting the primary workspace.
- Drag-and-drop and the @ panel entry share the selected client. The @ panel additionally supplies a directory within that workspace.
- A legacy target requires `workspace_file_upload`; a cwd-qualified target requires both `workspace_file_upload` and `workspace_qualified_rest_core`. The selected workspace must also be present exactly once and trusted in the capabilities snapshot. Otherwise hide both upload entry points.
- Host control: the web-shell accepts an optional `fileUploadEnabled` prop (threaded through the customization context). It is an additional gate, not a replacement for the capability: `fileUploadEnabled === false` force-hides both entry points AND disables file drag-and-drop entirely — no drag highlight, no upload, and no inline image/text ingestion from dropped files — even when the daemon advertises `workspace_file_upload`, while `true`/omitted still requires the capability (and the trust / qualified-route checks above). It never bypasses the capability. Clipboard paste of images/text is unaffected.
- Upload directory: an optional `fileUploadDirectory` prop (threaded through the customization context) sets the directory that drag-and-dropped files upload into. It is a **relative path without a leading `/`** (`'uploads'`, `'uploads/images'`); a leading-slash absolute path is rejected by the daemon as outside the workspace. Omitted (or `'.'`) uploads into the workspace root. The daemon creates the directory (including intermediate components) on upload when it does not exist, so a configured drop folder needs no manual setup.

### Upload versus `@` consumption

The upload endpoint is format-agnostic workspace storage. A successful upload guarantees that the bytes were created atomically at the returned path; it does **not** guarantee that every model/provider can inline or interpret that file. The automatically inserted reference continues through the existing `@` resolver and inherits its limits:

- Images use the existing image pipeline and its source/decoding limits.
- PDFs use the existing PDF extraction/rendering behavior.
- Text files remain subject to model context and text-processing limits.
- Unsupported binary formats and oversized non-image binaries may upload successfully but fail when the prompt tries to consume them.

The Web Shell does not duplicate file sniffing or maintain a second format-support matrix. User-facing copy says the file was uploaded and referenced, not that every model can read every format; any consumption failure comes from the existing resolver. E2E verification must exercise actual prompt consumption for a supported text file and image, not only file existence and inserted composer text.

### Web Shell: `useFileUpload` hook

New hook at `packages/web-shell/client/hooks/useFileUpload.ts`:

```typescript
interface UseFileUploadOptions {
  /** Structural client; both daemon client classes satisfy it. */
  client: FileUploadClient | undefined;
  maxBytes: number;
  targetKey: string;
}

interface FileUploadItem {
  id: string;
  file: File;
  targetPath: string; // requested relative path in the target workspace
  status: 'pending' | 'uploading' | 'done' | 'error';
  progress: number; // 0–1
  /** Locally classified failures; the render site localizes them. */
  errorCode?: 'tooLarge' | 'noDaemon' | 'tooManyFiles';
  error?: string; // raw failure message (server-side errors)
  resultPath?: string; // server-confirmed final path
  /** Set on a `tooManyFiles` notice row: how many files were not queued. */
  skippedCount?: number;
}

interface UseFileUploadReturn {
  uploads: FileUploadItem[];
  /** True while any item is pending or in flight; gates composer submit. */
  isBusy: boolean;
  uploadFiles: (
    files: File[],
    targetDir: string,
    onUploaded?: (path: string) => void,
  ) => number; // returns how many files were actually queued
  removeUpload: (id: string) => void; // aborts the in-flight request too
}
```

Occupied names are always auto-numbered; safety-boundary failures, candidate exhaustion, and I/O failures still produce an error row. `uploadFiles` stores `onUploaded` with each queued item and invokes it exactly once per successful upload with the server-confirmed final path. A batch accepts at most `MAX_FILES_PER_BATCH = 100` files; the overflow is not queued and surfaces as a single `tooManyFiles` notice row carrying the skipped count, so unbounded drops cannot keep the strictly-sequential queue busy for hours.

- Done rows display the final file name. If `resultPath !== targetPath`, they additionally show a short auto-numbering hint so the user sees why the name differs from what they dropped.
- Callers pre-flight the target-specific capability set via the same `workspace.capabilities?.features` snapshot `VoiceButton` uses and hide the entry points when unsupported.
- Before queueing, reject files larger than `capabilities.limits.maxWorkspaceFileUploadBytes` (50 MiB fallback) locally with a clear error; the server-side 413 remains authoritative.
- Process each `uploadFiles` batch sequentially in selection order: one item is `uploading`, the rest remain `pending`. A failed or canceled item does not block later items. This keeps browser/daemon memory bounded and makes `@` insertion order deterministic; add concurrency only if measurements justify it later.
- Removing a pending/uploading row aborts the client request. Atomic writes guarantee that a partial target is never exposed, but cancellation is best effort: if the server has already received the body and begun publishing, the complete file may still be written.
- When `targetKey` changes or the hook unmounts, abort and clear the queue. Ignore any late completion from the previous generation so an upload started for workspace A cannot insert a path into workspace B's composer.

### Web Shell: composer drag-and-drop

1. Listen for `dragenter` / `dragover` / `dragleave` / `drop` on the composer surface. A batch containing only supported images remains on the existing image-attachment path; ordinary files and mixed batches use workspace upload, so one drop is never handled by both paths.
2. For workspace-upload batches, extract `event.dataTransfer.files` and call `uploadFiles(files, fileUploadDirectory ?? '.', onUploaded)` — the configured upload directory, or the target workspace root by default. The daemon creates a missing directory on upload.
3. Progress UI: a thin strip above the composer input surface, one row per queued/uploading/error file — filename, state or percentage, and remove/cancel action. State text is not color-only, and icon actions have localized accessible names. Completed rows disappear after three seconds; error rows remain until dismissed.
4. On completion, add an inline `kind: 'file'` composer tag whose serialized value is `@<finalPath>`, escaping through the same pipeline existing file items use (`escapeAtReferenceText(sanitizeInsertText(path))`) — screenshot filenames with spaces and non-ASCII characters are common.

### Web Shell: @ panel upload item

In `useAtMentionMenu.ts`'s `createFileProvider`, when the files provider is in directory-browse mode:

1. Prepend a synthetic `AtMentionItem` with a new `kind: 'upload'` at the top of the list. Its label/description use the existing i18n catalog. It appears only when the entry query is empty (the same condition that shows `currentDirectoryItem`) so it does not pollute filtered results, participates in normal keyboard navigation, and is subject to the existing `ITEM_LIMIT` slice.
2. Selecting it removes the mention text that opened the panel, snapshots `fileDirectoryRef.current`, invokes an `onUploadRequest(targetDir, restoreQuery)` callback wired in from the composer as a `UseAtMentionMenuOptions` field, and closes the menu. If upload availability vanished while the menu was open (stale item), the accept closes the menu without removing the text. The callback synchronously stores `targetDir` and the current upload `targetKey`, keeps the `restoreQuery` callback, then calls a mounted hidden `<input type="file" multiple>` so the browser treats it as part of the user gesture. This is UI behavior, not a workspace filesystem action, so it does not belong on `AtMentionWorkspaceActions`; the menu hook stays free of `DaemonClient` concerns.
3. The input's change handler uploads the selected files to the captured `targetDir` only if the captured `targetKey` is still current, then clears `input.value` so choosing the same file again fires a new change event. A native `cancel` listener (React only wires `cancel` on `<dialog>`, and the event does not bubble) invokes the stored `restoreQuery` so a canceled picker gives the removed mention text back.
4. On success, add the same inline file tag used by an existing file-menu selection, directly from the server-confirmed response path. No new cache invalidation API is needed: selecting the upload item closes the menu, and `close()` already replaces `builtinCacheRef.current`; the next open fetches a fresh directory listing.

Note: uploads to git-ignored paths succeed but remain invisible in the @ listing (`entries.filter((entry) => !entry.ignored)`); the inserted `@` reference still resolves.

### Data flow summary

```
Browser file
  ↓ (drag-drop or @ panel upload item)
useFileUpload.uploadFiles()            [target workspace resolved]
  ↓ (XHR with progress, or fetch)
DaemonClient / WorkspaceDaemonClient.uploadWorkspaceFile()
  ↓
POST /file/upload?path=... (raw octet-stream body)
  ↓ mutate gate → workspace/trust/client/metadata admission → concurrency gate → raw parser
route candidate loop
  ↓ fs.resolve(candidate, 'write') → fs.writeBytesAtomic (no-clobber create)
  ↓
201 with confirmed (possibly renumbered) path
  ↓
addTags([{ kind: 'file', serialized: '@<finalPath>' }], { placement: 'inline' })
```

## Security and failure behavior

- The route reuses the strict mutation gate, workspace trust checks, client identity validation, and `fs.resolve` boundary guards from the `workspace-file-write.ts` machinery.
- **Uploads never overwrite existing entries.** Occupied names, including in-workspace final-component symlinks, are auto-numbered without writing through them. No path in this feature modifies or replaces existing content — the candidate loop only ever creates new files. Escaping links and other safety-boundary failures, candidate exhaustion, and I/O failures remain errors.
- Binary writes are atomic (temp + publish): network failures and cancels never expose a partial target. A late client cancellation may still result in the complete file being published.
- The upload is not idempotent: if the server publishes the file but the response is lost, the client cannot know whether creation succeeded. The Web Shell does not automatically retry a request after bytes were sent; a manual retry may intentionally create a numbered copy.
- Wrong Content-Type → 415 before buffering. Zero-byte `application/octet-stream` uploads are valid and produce the SHA-256 of an empty buffer.
- Oversized bodies → the route-specific 413 `file_too_large` envelope; handler/fs failures use `sendFsError`; path escape or an escaping/racing symlink → 400; untrusted workspace → 403.
- The qualified route never falls back to the primary runtime for unknown (including already removed), untrusted, or draining workspaces.
- Upload-body memory is bounded by `MAX_UPLOAD_BYTES × MAX_CONCURRENT_UPLOADS` (about 200 MiB with the v1 constants); auth, workspace resolution, trust, Content-Type, Content-Length, metadata, client identity, and initial path-boundary resolution all run before the concurrency gate and body buffering.

## Implementation order

1. **fs layer** — add and export `MAX_UPLOAD_BYTES`, generalize the existing atomic publication internals around an already validated `Buffer`, then add the trust- and generation-gated no-clobber `writeBytesAtomic` create primitive with colocated tests. Preserve the existing 5 MiB text-write policy.
2. **Daemon route** — extend `routes/workspace-file-write.ts` with pre-buffer admission, one shared four-slot concurrency gate injected into legacy + qualified registrations, the route-owned numbered-candidate loop, upload-specific raw-parser errors, capability tag, and telemetry entry; keep route tests colocated in `workspace-file-write.test.ts`, with qualified cases in `workspace-qualified-rest.test.ts`.
3. **SDK** — add `maxWorkspaceFileUploadBytes` capability typing plus `uploadWorkspaceFile()` on `DaemonClient` and `WorkspaceDaemonClient` with the shared raw-POST helper, browser progress, timeout, and abort support, tests.
4. **`useFileUpload` hook** — standalone sequential queue with local size preflight and target-generation cancellation, testable without UI.
5. **Composer drag-and-drop** — hook + progress strip + reference insertion.
6. **@ panel upload item** — synthetic item + target-directory callback wiring; reuse the menu's existing cache reset on close.

## Test plan

- **fs layer**: byte-identical round-trip of binary fixtures, including an empty buffer; a payload greater than 5 MiB and at most `MAX_UPLOAD_BYTES` succeeds, proving the text-write default is not applied to the byte path; a direct `writeBytesAtomic` call above `MAX_UPLOAD_BYTES` fails with `file_too_large`; existing text writes above `MAX_WRITE_BYTES` remain rejected. Trust/generation: a direct untrusted call fails with `untrusted_workspace`; a generation closed after method entry but before publication leaves no target. Atomicity: interrupted write leaves no partial target; an external create racing the no-clobber publish still yields `file_already_exists`; symlink target rejected; new file created at `0o600`.
- **Daemon route**: correct bytes written with correct hash and size; zero-byte octet-stream → 201 with the empty-buffer hash; wrong or missing Content-Type → the exact 415 `unsupported_media_type` envelope before buffering; an upload greater than 5 MiB and at most `MAX_UPLOAD_BYTES` succeeds; an oversized declared `Content-Length` is rejected immediately, while a chunked or understated body above `MAX_UPLOAD_BYTES` is rejected by the raw parser before the handler/fs write; both use the exact upload-specific 413 envelope (`errorKind`, `status`, and `maxBytes` included, with no "10 MB" message). Missing/invalid `path`, a requested basename over 255 UTF-8 bytes, invalid client id, missing/non-directory parents, and boundary escapes are rejected before buffering. Paths containing spaces, non-ASCII, `%`, and `#` decode exactly once; a name occupied by a file, directory, or in-workspace final-component symlink → 201 with a numbered `path`, with no write through the existing entry; an escaping symlink remains a boundary error. Numbering preserves the final extension, handles no-extension and dotfile names, skips taken candidates, trims a long Unicode stem to the 255-byte policy cap, and fails at the 1000-candidate cap; auto-numbering never modifies the requested target; concurrent same-name uploads land on distinct candidates. Four admitted uploads may buffer concurrently across both route forms; a fifth receives the exact 429 `upload_busy` response and `Retry-After`, and disconnect/parser-error paths release their slot. The response has no derived `renamed` flag. Capability tag and `limits.maxWorkspaceFileUploadBytes` are advertised. Qualified route: untrusted, unknown (including already removed), and draining workspaces are rejected before buffering and never fall back to the primary runtime.
- **SDK**: progress callbacks fire in a browser; requesting progress without `XMLHttpRequest` fails before sending; omitted timeout inherits the client default, `timeoutMs: 0` disables it, and an explicit timeout or abort signal cancels the request; filesystem errors expose `errorKind` while other daemon errors preserve their existing parsed bodies; both legacy-primary and workspace-qualified clients.
- **Web Shell hook/UI**: a file above the advertised limit is rejected without an HTTP request; a batch above 100 files queues the first 100 and renders one `tooManyFiles` notice row with the skipped count; a batch runs one request at a time in selection order; failure/cancel does not block the next item; removing a pending item prevents it from starting; a late response after abort does not invoke `onUploaded`; changing the target workspace aborts and clears the old queue and ignores late completions; each successful final path creates exactly one inline file tag; removing the last tag restores the placeholder; completed rows disappear after three seconds. Pure supported-image drops stay on the image-attachment path, while ordinary files and mixed batches upload without leaving drag-active styling behind.
- **Web Shell E2E**: drag a file onto the composer → progress strip appears above the input surface → file exists in the workspace → an inline file tag appears (include filenames with spaces/non-ASCII and a literal `%` to cover escaping); drop a file whose requested name is occupied, including by an in-workspace symlink → upload succeeds as `name (1).ext` with an auto-numbering hint derived from the differing paths, the existing entry untouched, and the tag uses the final name; batch drop preserves upload/tag order. @ panel: browse into a nested directory, select upload, choose a file → the trigger `@` is removed, the captured directory receives the file, and an inline file tag appears; reopening the menu fetches a fresh listing without a public cache API; selecting the same local file twice still fires two uploads. Entry points are hidden when either the upload capability or the required qualified-route capability is absent. Submit prompts that reference one uploaded text file and one uploaded image and verify the existing resolver supplies their content; an unsupported/oversized binary surfaces the resolver's existing readable error rather than being described as universally consumable.
