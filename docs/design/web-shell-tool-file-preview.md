# Web Shell tool file preview

[English](web-shell-tool-file-preview.md) | [简体中文](web-shell-tool-file-preview.zh-CN.md)

## Problem and scope

Expanded file tool cards show read output or an edit diff, but cannot open the
complete current file beside the conversation. Add a right-aligned View file or
View image action for read, edit, write, display_image, and zoom_image tools.
Reuse the existing right panel and file/image renderers. No daemon route or tool
execution changes are required.

## Behavior and constraints

- Show the action only in interactive, expanded details with an open callback, a
  raw file path, a connected daemon, and one available trusted workspace owner.
- Reuse the existing path extraction from arguments, structured content, or
  locations. Never parse shortened display titles or guess a shell command's file.
- Check the scoped file stat on expansion, status change, and window focus. Only
  regular files receive an action. Check again on click. Missing paths, deleted
  files, directories, unavailable workspaces, and failed checks hide the action
  silently, without a toast or placeholder. There is no polling or new file watcher.
- Use the existing workspace authority guard to discard stale results after an
  owner change or unmount; never fall back to the primary workspace.
- Open the current disk file in the existing right panel. Keep the historical read
  output and edit diff inline. The action tooltip says it views the current file.
  Images use the existing image preview. Repeated opening reuses its existing tab
  and refreshes its contents through the renderer’s existing version input.
- Preserve the source session/workspace through the existing turn-output callback
  in the primary transcript, split panes, and resolved subagent details. Legacy
  inline subagent rows without a known workspace show no action. Document/readonly
  exports perform no availability checks and show no action.
- A file can disappear after validation. Opt this tool action into silent failure
  for the existing attachment opener's additional stat, retaining normal errors
  for other attachment entry points. Errors after a preview has already opened
  retain the preview renderer's existing handling.

## Implementation

Forward the existing turn-output open callback through MessageItem, ToolGroup,
and ToolLine. Add a small ToolFilePreviewButton mounted in the expanded card
header. Reuse getToolFilePath, useArtifactWorkspaceTarget, the shared Button, and
attachment open requests. Include callback and locations changes in the existing
memo comparisons. Add matching English and Chinese labels. Extend only the
attachment request/opener with a silent-unavailable option used by this action.
Increment a reused file tab’s preview version and pass it to the existing renderer
version input so an active tab reloads changed text and image bytes.

Affected areas: message and tool rendering, the existing artifact path selector,
attachment opening in App, i18n, focused tests, and these design documents.

## Validation and acceptance

Use the global qwen CLI to confirm the missing entry on the baseline, then the
local built CLI for real browser verification of reading/editing text and reading
an image. Capture and visually inspect before/after screenshots. Add focused
coverage for hidden collapsed/readonly/missing-path states, stat failures and
directories, click-time deletion, stale asynchronous work, owner isolation,
callback propagation, existing panel tab reuse, and refreshing an active preview
after disk changes. Mock-daemon browser tests may
exercise deterministic failure conditions; identify those separately from real
file-tool verification. Run build, typecheck, bundle, and relevant package tests.

Acceptance: supported existing files open in the correct right panel; image files
show images; historical tool detail remains accessible; unavailable targets have
no visible entry or availability-error prompt; no background stat requests for
collapsed tools or exports.

## Open questions

None. Existing renderer format/size limits remain unchanged. Filesystem changes
are observed when expanding, focusing the window, or clicking, rather than by a
new continuous watcher.
