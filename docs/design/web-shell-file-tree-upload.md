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
  destination while dragging. Prevent browser navigation for file drops even
  when upload is unavailable.
- Reuse `useFileUpload` for sequential uploads, progress, limits, cancellation,
  collision-safe server naming, and failures. Respect `fileUploadEnabled` and
  the daemon's advertised `workspace_file_upload` capability. Never use the
  composer's default upload directory for explicit tree destinations.
- Uploads belong to the Files tab's trusted workspace, including when that tab
  differs from the current session. Require qualified REST support for an
  advertised workspace ID; never fall back to the primary runtime.
- Keep the progress bar at the sidebar bottom while pending or uploading;
  hide it after the queue settles. Keep dismissible failures visible and
  announce successful filenames through a polite status region.
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
until their normal dismissal; it represents transferred bytes, while the bar
stays visible until the server confirms completion. Existing files are never
overwritten by this UI: the existing endpoint automatically numbers collisions.

## Validation and acceptance criteria

Focused unit tests cover capability gating, trusted workspace ownership, stale
owners, and existing queue behavior. Browser E2E uses the actual Pierre tree and
a simulated daemon to cover root, nested/collapsed directory and file-row drops,
binary bytes, progress visibility and bottom placement, successful insertion,
errors, non-file drags, directory rejection, and unavailable upload support.
A real daemon check verifies actual filesystem bytes and collision naming if
available. Screenshots document UI behavior only, with simulated-daemon evidence
clearly labeled. Run build, typecheck, focused tests, lint, and two clean diff
review passes before opening a ready-for-review PR.

## Constraints, risks, and open questions

Native folder uploads are outside scope. Upload cancellation cannot recall a
file the server already published. Drag targeting depends on Pierre's existing
row path attributes and composed events, so browser coverage is required.
There are no unresolved product questions.
