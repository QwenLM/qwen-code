# Web Shell sidebar session details

## Goal

Make session rows easier to scan without adding another navigation surface:

- show the existing details panel from row hover and remove the Details action
  from the overflow menu;
- preview five sessions per expanded folder or session group, with an explicit
  control to reveal the remainder until that section is collapsed;
- move timestamps into the details panel and reserve the row's trailing slot
  for branch or worktree state;
- fade overflowing titles at the right edge and scroll them slowly on hover;
- use a neutral spinner for running sessions;
- keep the brand, New task action, and footer fixed while the remaining
  navigation and session content share one scroll area.

## Design

The row remains the only session-selection and keyboard target. A controlled
Radix popover is anchored to it and opens only from pointer hover. The panel
does not participate in keyboard navigation; its session ID copy action is a
pointer-only affordance. The panel contains the title and relative time, final
workspace path segment, optional git branch or worktree, session status, and a
copyable session ID. Existing action menus keep all mutation actions but no
longer include Details. Rename targets the selected session through its owning
workspace, so current, background, secondary-workspace, and archived sessions
share the same action.

Session limits are local UI state. Direct workspace lists and grouped lists
show the first five items; revealing the remainder is not persisted, so
collapsing and reopening the owning section restores the five-item preview.

Title overflow uses a CSS mask for the trailing fade. On hover, one DOM width
measurement supplies the exact scroll distance to a CSS animation, avoiding a
timer or dependency.

The workspace-qualified metadata route keeps background-session renames inside
the resolved workspace runtime. Its dedicated `workspace_session_metadata`
capability prevents clients from exposing the action against older daemons
that do not mount the route. No session schema changes are required.
