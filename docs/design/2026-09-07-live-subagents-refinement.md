# Subagents pinning, compact presentation, theme and diagnostics

## User request

Keep the Subagents surface present while its list or a task detail is open,
until explicit Close/Escape. When neither is open, hiding must depend on real
pointer/keyboard interaction and clear stale hover state. Preserve the existing
drag/edge invariants. Discuss a few smaller summary layouts before choosing a
permanent replacement. The user chose compact option C: a 132×62 bot/title
summary with dot/running and check/completed counts. A gentle 1.4s opacity pulse
marks a running task only while connected; reduced motion is static. Waiting
uses a conditional amber marker, with exact counts in localized accessible text
and tooltips. Large summary counts truncate at 999+ without losing exact totals.
Add a final Theme setting after Language with System,
Light and Dark, default System, applying to all Host windows. Improve debug
diagnostics for Proactive and separate permission waiting from failure status.

## Interaction ownership

Native SubagentsWindows owns one frameless window for summary/list/detail.
An explicit open is pinned; blur, Settings, disconnect and orb dragging do not
close it. Task selection changes that same panel to detail; Back returns to
the list even when disconnected. Close/Escape hides the panel without affecting
tasks. A new daemon instance invalidates old selection. Expanded headers are
draggable; list and detail share 330×430 bounds, so navigation preserves their
position without resizing into the adjacent orb. Display changes clamp the
panel to the current screen. No macOS title bar, second detail window or new detail-position
preference is used. Content updates never change window bounds.

Hover and keyboard focus are separate from explicit open state. Missing mouse
leave or stale focus must not make a collapsed summary stay forever. Use current
native cursor containment as a bounded backstop while a transient surface is
visible; keyboard-held visibility ends on window blur or pointer interaction.
The orb and side panel own separate keyboard holds, so periodic state updates
cannot release another window's focused control. Real pointer entry reasserts
hover intent even after native cursor checks closed a stale renderer state.
Do not run polling when hidden or when a pinned view already determines state.

## Theme

Theme is Host-local display configuration (`system | light | dark`) persisted
privately, independently of daemon language and memory preferences. The main
process owns Electron nativeTheme and broadcasts both preferred and resolved
appearance. Renderer only applies the resolved appearance; switching theme
does not replace nodes, restart media or update model settings. Every fixed
display label remains in the paired i18n catalogue. Brand orb gradients remain
stable; backgrounds, text, borders, statuses and scrollbars receive light/dark
tokens with readable contrast.

## Proactive and diagnostics

The recent session log confirms a Proactive injection and response creation,
followed by a cancelled response 15 ms before VAD speech-start, then a fatal
unattributed transcript. Independent actual-source replay reproduces the
cancel-before-VAD failure; a bounded 250 ms grace on an active, unfinished
Proactive delivery lets the subsequent VAD requeue it at the FIFO head. Explicit
cancellation is not retried; expiry keeps the existing failure. Missing ASR
commit is a separate failure, not justified by that cancellation race. Do not
weaken tool authority or fabricate audio commits. Log safe IDs/phase, evidence counts/durations,
evaluation accept/reject reasons, trigger/admission, foreground response and
playback barriers, retries, terminal errors and subagent state transitions in
`--debug` stderr. No raw microphone/video/transcript/prompt/key payloads.

`Needs you` is reserved for tasks genuinely waiting for user input/approval.
Failed/interrupted tasks show explicit Error/Interrupted, not a request for
permission. Historical failed counters remain separate from current waiting.

## Verification

Independent actual-class/DOM probes reproduce pin loss and sticky hover before
fixes. Test open list/detail/close permutations, cursor leave without IPC,
keyboard focus, blur, drag, disconnect, delayed load and teardown. Theme tests
cover System changes, persistence failures, all windows, media invariance and
both appearances. Debug tests assert observability and secret/content omission.
Builds and tests are serialized because the user's machine recently restarted.
Use no real devices/provider requests or user preference writes for tests.
