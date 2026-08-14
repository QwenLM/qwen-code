# Electron desktop pet experiment

## Summary

The Electron preview will reuse the existing Qwen capybara spritesheet and
selected companion behaviors from `packages/desktop`, while keeping the pet
implementation exclusive to `packages/desktop-electron`.

Web Shell will gain one generic host-settings extension point. It will not
contain pet assets, pet state, Electron APIs, or pet-specific copy. The normal
standalone Web Shell supplies no host bridge, so its settings and runtime
behavior remain unchanged.

## Goals

- Reuse the existing Qwen pet appearance without regenerating or restyling it.
- Provide an Electron-owned transparent, always-on-top companion window.
- Preserve the useful native interactions: click-through outside the pet,
  dragging, position persistence, resizing through settings, and closing the
  companion independently.
- Drive the existing idle, running, waiting, success, and failure animations
  from Web Shell session lifecycle signals.
- Place enablement and size controls inside the existing Web Shell settings
  surface without adding pet behavior to the web product.
- Keep the experiment isolated from both the existing desktop package and the
  base Electron preview branch.

## Non-goals

- Migrating custom pet discovery in the first experiment.
- Migrating the existing multi-session notification card stack.
- Changing daemon settings schemas or persisting desktop-only settings in
  `~/.qwen/settings.json`.
- Enabling the pet in browser-hosted Web Shell.

## Architecture

### Generic Web Shell host settings

`WebShellProps` accepts optional host settings categories. A category contains
serializable labels and boolean or number controls plus a host change callback.
The existing settings page renders these categories with its own components
and theme tokens.

The standalone entry checks for a narrow host bridge exposed by a trusted
desktop preload. When absent, as it is in browsers and the daemon-served web
product, no host category is created. The bridge also receives the existing
streaming and session lifecycle callbacks; no daemon event contract changes.

### Electron ownership

The Electron main process owns pet settings, the companion `BrowserWindow`,
window position, and lifecycle. A context-isolated preload exposes only typed
operations needed by the Web Shell host adapter and the local pet renderer.

The pet window is frameless, transparent, always on top, omitted from the task
bar, and visible on all macOS workspaces. Empty pixels are mouse-transparent;
the sprite and its small context menu remain interactive. Closing the main
chat window leaves the enabled companion and runtime alive. Cmd+Q still tears
down every Electron window and the bundled daemon process group.

### Asset and animation fidelity

The build copies the existing Qwen spritesheet verbatim from the original
desktop package into the Electron preview output. The new renderer uses the
same 8-column by 9-row atlas geometry and the same row/frame timing contract.
No image generation or asset transformation is involved.

Web Shell lifecycle signals map to pet states as follows:

| Web Shell signal               | Pet state          |
| ------------------------------ | ------------------ |
| idle                           | idle               |
| waiting                        | waiting            |
| responding or prompt submitted | running            |
| turn complete                  | jumping, then idle |
| turn error                     | failed, then idle  |

## Persistence

Desktop-only state remains in Electron's existing `desktop-state.json` next to
the main window bounds. The pet section stores `enabled`, `size`, and optional
screen position. It is deliberately separate from daemon and Web Shell user or
workspace settings.

## Why this demonstrates the Electron approach

The experiment exercises a capability that is awkward for a browser-only
surface but natural for Electron: a second transparent native window that
shares application state with an embedded Web Shell. The product UI stays
canonical, while preload and main-process boundaries provide a typed,
testable native extension. The proof is not that Electron can draw a pet; it is
that desktop-only product behavior can be added without forking the chat UI or
leaking native implementation into the web product.

## Verification

- Unit-test host settings rendering and state normalization.
- Unit-test the pet atlas sequence and lifecycle mappings.
- Build and typecheck Web Shell and the Electron preview.
- Run the packaged runtime smoke test.
- On macOS, verify the exact Qwen appearance, settings integration, idle and
  activity animation, click-through, drag persistence, close/re-enable, main
  window close behavior, and Cmd+Q cleanup.
