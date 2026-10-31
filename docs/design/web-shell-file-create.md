# Web Shell file and folder creation

[English](web-shell-file-create.md) | [简体中文](web-shell-file-create.zh-CN.md)

## Problem and scope

Files can browse existing entries but cannot create files or empty folders.
Add New file and New folder toolbar buttons targeting the workspace root and
the same actions in folder-row trailing menus targeting that folder. Replace
the refresh icon with `rotate-cw`. Creation supports trusted local workspaces.

## Design

- Reuse the qualified file-write API with `mode: create` and empty content.
  Add a qualified directory-create API, capability and SDK method. Resolve
  only the selected active trusted runtime, enforce mutation authentication
  and filesystem boundaries, and never fall back to the primary workspace.
- Create one entry under an existing parent. Existing files or folders cause
  a conflict instead of overwriting or silently reusing them. Preserve final
  symlinks, including dangling links, instead of creating their targets. Keep
  existing idempotent/recursive mkdir callers, generation guards, locks and auditing.
  SSH creation is outside this change. Portable path operations retain the
  existing limitation around external parent-directory replacement races.
- Gate each optional artifact creation action on its capability, qualified
  REST support, a unique trusted owner and local workspace. Recheck current
  authority and eligibility before requests and before applying results.
- Use Pierre's native trailing menu trigger alongside right-click menus.
  Folder menus contain New file and New folder; file menus retain their
  existing actions. Use shared scoped Dialog, Input, Button and DropdownMenu
  primitives. Ask for a single leaf name, display the destination, reject
  separators, empty/dot names and control characters, and focus the input.
- Cancel sends no request. Disable duplicate submission and dismissal while
  pending. Keep failures in the dialog for correction/retry. Bind confirmation
  and completion to the current tree/workspace lifetime.
- Insert successful entries into the current tree and parent listing state,
  preserving other expansion, filtering and previews. Merge locally created
  entries into late directory responses so stale results cannot hide them or
  mark their parent empty. Newly created folders are empty when created and load on first expansion.

## Affected areas and decisions

CLI filesystem, qualified write routes and capabilities; qualified SDK client;
Web Shell artifact actions, Files browser, bilingual messages and tests. No new
dependency, recursive creation UI, file-content editor or automatic replacement.
The toolbar targets root even when another file is selected; folder menus
always target the folder whose menu was opened.

## Validation and acceptance

Record the global CLI baseline; use a latest-main simulated-daemon browser
baseline where the installed CLI lacks Files. Test toolbar and folder trailing
menus, correct target paths, cancel/name validation, busy/failure/retry, owner
revocation, capability gating, stale listings and preservation of tree state.
Use isolated real-daemon fixtures for empty files/directories, conflicts,
secondary-workspace isolation and boundary/auth/trust failures. Run build,
typecheck, bundle, focused tests, browser E2E, lint/format and two clean audits,
then independent review. Capture and visually inspect UI screenshots, clearly
distinguishing simulated UI evidence from real disk assertions.

## Open questions

None. This branch is based on main. Regular-file deletion remains in PR #14158;
this change adds folder deletion only.

## Folder deletion and initial loading

Folder menus also offer **Delete**, separately gated by `workspace_directory_delete`.
The qualified directory-delete endpoint accepts one non-root local directory and
removes its entire subtree. It rejects final symlinks, files, roots and escapes;
symlinks inside the subtree are removed without following their targets.
The selected trusted runtime owns every operation; unsupported SSH/custom
filesystems do not fall back to the primary workspace.

Match file-delete PR #14158 with a destructive AlertDialog, relative target path,
an explicit permanent-deletion warning covering all contents, and Cancel initially
focused. Cancel/Escape sends no request; pending operations cannot be dismissed
or resubmitted. Failures stay visible for retry (recursive filesystem failures may
have removed part of the subtree). Success removes the full subtree, loaded state
and active descendant preview, while preserving other expansion and filters.
Invalidate descendant loads and filter stale parent listings to prevent resurrection.
Portable recursive removal retains external parent-replacement race limitations.
Initial Files lazy-module loading text is horizontally centered. New file uses
the `sticky-note-plus` icon.

Verify non-empty/empty deletion, nested symlink preservation outside the target,
root/boundary/auth/owner refusal, cancel/focus/busy/retry, late descendant listings,
preview cleanup, unrelated expansion and initial loading alignment.

## Review follow-up boundaries

Workspace mutations are excluded at build time from the read-only transcript
entry; the interactive entry retains them. Keep the existing transcript size
ceiling and test both mutation absence and read-only directory access.
Directory rows expose a trailing Options trigger only when directory actions
are available. After deletion, restore focus to a surviving roving row before
falling back to the tree root. Newly created folders load on first expansion,
so external writes made before expansion are visible without Refresh. Successful
exclusive recreation at a loaded directory path discards its stale subtree,
cached listings and descendant preview before adding the new empty directory.
Test late ancestor listings, failed creates without phantom entries, capability
menus with positive controls, and preservation of unrelated previews.

## File-tree upload integration

Retain main's drag-and-drop uploads alongside creation and confirmed folder
deletion. Uploaded files join the confirmed-entry overlay without expanding
their parent, so late empty listings cannot hide them. Keep upload capability
checks independent from local-only creation/deletion, preserving SSH upload
support, and exclude all mutation actions from the transcript build.

Folder deletion confirmation waits for uploads to finish; pending deletion
rejects new file drops. This prevents same-pane uploads from recreating a folder
after its deletion. Existing filesystem concurrency limitations still apply
to other clients and external processes.
