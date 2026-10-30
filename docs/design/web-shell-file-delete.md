# Web Shell file deletion

[English](web-shell-file-delete.md) | [简体中文](web-shell-file-delete.zh-CN.md)

## Problem and scope

The Files context menu can preview, reference, copy paths and download, but
cannot delete a file. Add permanent deletion of one regular file in a trusted
local workspace, with a second confirmation explicitly warning that deletion
cannot be undone. Directory, symlink and SSH deletion are outside this change.
The regular-file action coexists with main's separately gated directory deletion.

## Design

- Add an optional local filesystem `deleteFile(input)` operation. Resolve the
  parent inside the selected workspace, preserve the lexical basename, reject
  roots/directories/symlinks/other entries, and use non-recursive `unlink`.
  Reuse mutation trust, generation guards, per-path locks and filesystem audit
  with the original file size and ignore-rule attribution.
  Revalidate the canonical parent immediately before unlink. Node's portable
  path-based unlink cannot make parent replacement by an external process
  fully atomic; this retains the existing filesystem mutation boundary model.
- Add only `POST /workspaces/:workspace/file/delete` behind strict mutation
  authentication and trusted selected-runtime resolution. Obtain the filesystem
  from that runtime; reject unsupported factories and never fall back to the
  primary. Return the confirmed workspace-relative deleted path. Advertise
  `workspace_file_delete` as the new contract capability, document the public
  contract, and normalize delete telemetry alongside other file mutations.
- Add a workspace-qualified SDK method and an optional artifact delete action.
  Require both delete and qualified REST capabilities, the exact trusted owner,
  and a local (non-SSH) workspace. Recheck eligibility and authority before and
  after the request so stale handlers cannot mutate a replacement owner.
  Exclude mutation actions from the read-only transcript build, preserving its
  existing size budget.
- Add Delete only to regular-file menus. Use the shared scoped AlertDialog,
  show the absolute workspace file path and an irreversible-deletion warning,
  focus Cancel by default, and require the destructive button to proceed.
  Cancellation and
  Escape send no request. Disable dismissal and duplicate submission while
  deleting; keep errors visible in the dialog for retry.
  Share the existing folder confirmation flow with a file/directory target kind,
  distinct messages and methods. Wait for pending uploads before confirming.
- After success remove the file from the existing tree and clear its preview
  if selected. Preserve other expansion/filter/selection state. Avoid restoring
  dropdown focus over the confirmation dialog; restore tree focus when it
  closes, preferring the active row with the container as fallback. Bind pending
  confirmation/results to the tree/workspace lifetime.

## Files and decisions

The change reaches the CLI filesystem intent/policy/implementation, existing
workspace write-route registration and capability list; the SDK's qualified
client; and Web Shell's artifact target, Files browser and bilingual messages.
The filesystem method is optional because existing SSH/custom factories do not
support deletion. No shell command, recursive removal, trash/recovery feature,
new dependency, or legacy-primary delete route is introduced.

## Validation and acceptance

First record the global CLI baseline, falling back to latest-main browser
coverage where the installed CLI lacks Files. Test filesystem regular/binary/
empty files, directories/roots/symlinks/traversal rejection, trust and closed
runtime guards, parent replacement, canonical path locking and audit fields;
route auth, unsupported factories, selected workspace and no fallback with
same-named files in primary and secondary workspaces; SDK request
shape; stale UI actions; browser cancel/confirm/busy/failure/preview cleanup and
capability/symlink gating. Use an isolated real daemon to verify disk results.
Capture and visually inspect actual confirmation/success UI with a clearly
labeled simulated daemon, and store images separately from implementation.
Run build/typecheck/bundle, focused tests, lint/format and two clean diff audits.

## Open questions

None. Permanent deletion and the explicit second warning are user requirements.
