# Web Shell file tree uploads

[English](web-shell-file-tree-upload.md) | [简体中文](web-shell-file-tree-upload.zh-CN.md)

## Problem and scope

The Files panel browses workspace directories but cannot receive local files.
Add file drag and drop to its tree sidebar, with a thin progress bar pinned to
its bottom. Reuse the existing workspace upload endpoint and queue; no backend,
SDK, dependency, recursive folder upload, or composer behavior changes.

## Proposed behavior

- Drop on a directory row to upload into that directory, including collapsed
  directories. Drop on a file row to upload into its parent. Sidebar whitespace
  targets the workspace root, regardless of selection or filter.
- Only file drags are handled. Ignore dragged local directories. Show the
  destination while dragging. Cancel default file-drop behavior for events
  reaching the Files panel, including its preview container and toolbar, even
  when upload is unavailable. The
  root destination hint uses the workspace name rather than the protocol sentinel.
- Reuse `useFileUpload` for sequential uploads, progress, limits, cancellation,
  collision-safe server naming, and failures. Respect `fileUploadEnabled` and
  the daemon's advertised `workspace_file_upload` capability. Never use the
  composer's default upload directory for explicit tree destinations.
- Uploads belong to the Files tab's trusted workspace, including when that tab
  differs from the current session. Require qualified REST support for an
  advertised workspace ID; never fall back to the primary runtime.
- Keep the progress bar at the sidebar bottom while pending or uploading;
  hide it after the queue settles. When the tree is collapsed, show the bar at
  the Files panel bottom. Keep dismissible failures above the split panels so
  collapsing the tree cannot hide them. Announce terminal results through one
  polite status region instead of an assertive alert per failed file.
- Insert each server-confirmed path into the tree without losing expansion,
  selection, search, or preview. Clear an empty-directory notice for its parent.
  Changing the workspace or revoking upload support aborts and clears the queue.

## Implementation and decisions

`useArtifactWorkspaceTarget.ts` exposes an optional guarded upload action using
its existing owner authority checks before and after the request. Uploads require
an explicitly trusted, uniquely advertised owner. Legacy reads remain unchanged.
`WorkspaceFileBrowser.tsx` consumes that action and the existing upload hook.
The native drag event's composed path identifies Pierre shadow DOM tree rows;
the tree’s directory metadata determines directory targets, including ancestors
restored from an upload during a pending refresh. Its CSS module
provides the destination hint and a three-pixel bottom progress bar. Existing
localized upload messages are reused; new destination text is bilingual.

The aggregate progress covers the current queue, including successful entries
even after their notices expire. Clear byte accounting when the queue becomes
idle; recent success notices do not contribute to the next queue. It represents
transferred bytes, while the bar
stays visible until the server confirms completion. Existing files are never
overwritten by this UI: the existing endpoint automatically numbers collisions.

## Validation and acceptance criteria

Focused unit tests cover capability gating, trusted workspace ownership, stale
owners, host disable overrides, advertised size limits, overflow notices,
polite failure announcements, and existing queue behavior. Browser E2E uses the actual Pierre tree and
a simulated daemon to cover root, nested/collapsed directory and file-row drops,
binary bytes, progress visibility and bottom placement (including collapsed trees), stable
progress after success-notice expiry and fresh progress for subsequent queues,
readable destination hints and drag-leave cleanup, successful insertion,
errors, non-file drags, directory rejection, and unavailable upload support.
A real daemon check verifies actual filesystem bytes and collision naming if
available. Screenshots document UI behavior only, with simulated-daemon evidence
clearly labeled. Run build, typecheck, focused tests, lint, and two clean diff
review passes before opening a ready-for-review PR.

## Constraints, risks, and open questions

Native folder uploads and a new manual cancel control are outside scope.
Existing cancellation on target changes and unmount remains in effect. Upload cancellation cannot recall a
file the server already published. Drag targeting depends on Pierre's existing
row path attributes and composed events, so browser coverage is required.
Events inside an embedded preview iframe belong to that iframe document and
are outside this container-level guard. There are no unresolved product questions.
