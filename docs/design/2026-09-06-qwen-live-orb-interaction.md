# Qwen Live stable orb and settings

## Problem and evidence

The September 5 investigation reproduced full-tree redraws on unchanged Host
state, focus/animation resets, preview-slot replacement, dropped clicks when
closing menus, menus clipped by 11px, and a 52px jump between listening and
thinking. Native logic also repositions on every active update and retains
stale mouse-interactivity state across overlay replacement.

The user approved a stable orb with click-open settings, remembered dragging,
hover-only controls, Command+E, a persistent gray stopped state, explicit quit,
and removal of shadow and clipped animation.

## Behavior

- First launch places the overlay at the bottom-right of a display. Setup and
  orb share one saved window position, retained across transitions/restarts.
  Restore clamps to available work areas when displays change.
- The setup view focuses on connection and required authorization. Source is
  selectable there because Camera must not require Screen permissions. Mode,
  Memory and input device preferences live in the normal Settings panel.
- The orb, toolbar, status, caption and preview slot are created once. Updates
  only change text, values, attributes and visibility. No transcript update
  may recreate the orb or reattach an unchanged camera preview.
- A fixed orb anchor does not move when status/captions appear. Animation has
  bounded scale and reserved space. No orb drop shadow is rendered.
- Hovering the orb reveals Microphone, Voice output, Start/End call, Settings
  and Quit controls. Leaving their interaction area waits 1 second before a
  fade; reentry cancels hiding. Keyboard focus and an open settings panel keep
  controls available. Call stop never hides the window and makes the orb gray.
- Setup header and orb can be dragged. Dragging must not accidentally start a
  call. Window position is updated only for explicit dragging, initial restore,
  or display topology changes, not every live status update.
- Settings contains Source, Mode, input device selection, and the existing
  Memory controls as an embedded stable section. It closes by Escape or
  outside interaction, without destroying the clicked control. Async actions
  show pending/failure feedback and retain editor drafts/focus.
- Command+E uses the existing global shortcut path for starting/ending calls.
  Preserve explicit custom configuration, while checking the user's current
  shortcut and documenting the default.
- End call stops interaction, leaving the app and gray orb available. Quit
  shuts down the connected standalone Live daemon gracefully and closes Host;
  owned session/adapter/media resources are released. It must not terminate
  unrelated Qwen Code serve processes or sessions. Legacy WebShell connections
  may end only their Live call and close Host, never shut down the shared server.
- An idle camera preview remains local only, as before. No user camera/mic or
  model API is used for automated verification.

## Implementation boundaries

Renderer changes stay in live-host, retaining Memory action validation and
call-time locking. Native Host owns bounds persistence, pointer/drag routing,
visibility and trusted IPC. Quit is an authenticated, instance-scoped operation
handled by the standalone daemon's existing cleanup path, not an OS PID kill.
The renderer never receives credentials or filesystem paths for daemon access.

Primary files: live-host renderer/main.ts, style.css, memory-panel.ts and new
settings component; preload/index.ts; shared/host-api.ts; main/index.ts and
overlay position helpers; Host daemon connection; standalone daemon/host
coordinator and matched wire types; package tests and READMEs.

Reuse previous bug reproductions; add position persistence, graceful quit,
hover timing, stable DOM, settings dismissal and layout boundary regressions.
No issue/PR creation, release, or unrelated refactor is included.
