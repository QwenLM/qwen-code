# Web Shell split-view usability

The split view is intended for large displays and multiple monitors. Keep its
equal-width horizontal row, full-height transcripts, independent session
providers, six-pane limit, add/close controls, back navigation, maximize/restore,
and existing per-tab session persistence. Additional layout modes, width dragging,
and moving sessions between windows are outside this change.

Three small improvements make the existing view easier to use without adding a
toolbar row or reducing transcript height:

- Reuse the sidebar's session-details popover on the pane title. Keep its delayed
  pointer hover, copy control, workspace, branch, PR/issue links, and status. Open
  below the title and constrain it to its pane, inside the Web Shell root. Honor
  the host's session-details action allowlist. Header action buttons
  remain outside the hover target. Hovering must not focus or activate a pane.
- Mark the last clicked or keyboard-focused pane with an inset line in its
  existing header. Adding, closing, and maximizing panes keep this selection
  valid, choosing a neighbour when the selected pane closes. Expose the same
  current location to assistive technology.
- Show a pending-session count in the existing toolbar only while a pane awaits
  tool approval or a user answer. Clicking cycles through waiting panes in row
  order, reveals a hidden maximized sibling when needed, scrolls the row to the
  target, and focuses the labelled pane wrapper outside all approval keyboard
  handlers. Enter, Escape, and digits immediately after navigation cannot submit
  a response; Escape can restore the row. Tab or a deliberate click enters the
  pane's controls. Announce pending counts without moving focus, and return focus
  to Back if the focused pending button disappears. The outer session's notice
  appears until a pane actually reports that approval, so failed or
  still-attaching panes cannot hide the only available notice.

`ChatPane` already derives its pending tool/question request from its own
transcript. Report that boolean to `SplitView` with a stable callback, including
cleanup when the session changes or unmounts. The parent counts only currently
open panes, including hidden siblings. Do not infer waiting state from the
session-list running flag or introduce another daemon subscription.

`SplitView` passes session-list metadata to the pane; its live running state
comes from the pane's existing active-prompt bridge. Until metadata is available,
retain the native title fallback. Extend
`SessionDetailsTooltip` with bottom placement while preserving the sidebar's
right placement and scoped portal behavior. Keep the shared details markup and
styling, with no duplicate tooltip implementation.

Affected areas are `SplitView`, `ChatPane`, the shared sidebar details popover,
their CSS and focused tests, English/Chinese labels, and the split-view browser
regression suite. No daemon protocol, persistence format, package API, or layout
breakpoint changes are required. There are no open design questions.

Validation covers delayed hover without focus theft, action-button exclusion,
active-pane pointer/keyboard selection, pending tool and question transitions,
hidden-pane navigation, draft retention, and existing add/close/maximize/reload
behavior. The browser regressions are committed in
`packages/web-shell/client/e2e/web-shell.split-persist.spec.ts` and tagged
`@smoke` for PR CI. The baseline and verification evidence are published in
[PR #11250](https://github.com/QwenLM/qwen-code/pull/11250).

The PR's browser CI job runs on GitHub hosted Ubuntu. The unchanged feature
passed the document gate and all 50 smoke cases there, while three ECS runs
failed during browser resource loading or at the document performance budget.
Keep the existing 60-second document budget, smoke assertions, triggers, and
hosted 20-minute job limit. Other CI jobs retain their current runner routing.
This uses hosted capacity for the browser job and may incur hosted queue time;
it does not diagnose the underlying ECS network or performance bottleneck.
