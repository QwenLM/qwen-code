# Pebble UI for Qwen Live Host

[English](live-pebble-ui.md) | [简体中文](live-pebble-ui.zh-CN.md)

## Intent and current state

The user selected the Pebble design and requested faithful implementation. The default theme color is Iris; users can change the palette in the configuration file. The source of visual truth is the approved local Pebble
prototype, including its red palette exploration; the rejected Atelier work is
not an implementation starting point.

The previous Host used a 112 px orb, hover-only toolbar, a modal settings panel
inside a 384 × 480 transparent overlay, and a separate hover summary that expands
into the existing native task window. These dimensions and interactions differ
from Pebble and cannot be corrected by recoloring alone.

## Presentation and geometry

| Component      | Target                                                   |
| -------------- | -------------------------------------------------------- |
| Voice card     | 234 × 194 px; 26 px radius; 15 px inset                  |
| Header         | 204 × 12 px at card offset 15, 15; 9 px text             |
| Voice disc     | 51 × 51 px at offset 18, 47                              |
| Status         | 12 px / 16 px, weight 550; secondary source/mode at 9 px |
| Toolbar        | 204 × 41 px at offset 15, 116; five 31 × 30 px buttons   |
| Task summary   | Centered below card, 13 px gap, 30 px height             |
| Camera preview | 161 × 107 px; 14 px radius; 5 px image inset             |
| Settings       | 306 × 532 px; 17 px radius; 48 px header                 |
| Tasks          | 280 px content width; bounded scrollable list/detail     |

All dimensions are CSS pixels, independent of display scale. A larger transparent
native canvas accommodates the card and settings together without shrinking the
design. Separate visible bounds cover setup, card, preview and settings. Native
placement, screen clamping and offset compensation use the same geometry as the
renderer. Showing captions moves the preview upward while retaining the card's
anchor; captions cannot overlap the preview or card. Transparent canvas regions
remain click-through.

The title header is the drag handle. The right-hand slot displays the actual
daemon-provided shortcut, replacing the prototype's fictional timer; the protocol
does not provide a call start timestamp. Source, status, captions and task counts
come from existing Host state. Controls stay mounted and visible. No fabricated
task, camera frame, status or elapsed time ships with the product.

## Settings and tasks

Settings retains the existing overlay and await-placement lifecycle, including
stale-open cancellation and draft preservation. Its layout becomes grouped audio,
visual and personalization wells, with collapsed memory details and a config
action in the footer. It is presented beside the card, with non-modal semantics
and existing Escape/outside-close behavior; call controls remain operable. Theme
mode and language continue to use their existing persistence APIs.

The task summary becomes a permanent card-adjacent renderer button, using the
existing snapshot counts and explicit attention indicator. A small trusted Host
IPC opens the existing SubagentsWindows list directly. It does not add a window
type, daemon route or task-control protocol. Existing stale-instance rejection,
pagination, permissions, cancellation, pinned-window lifetime and position
preservation remain intact. Hover no longer opens a duplicate summary.

## Color and motion

Use Iris as the default palette. Use shared
semantic CSS variables for surfaces, ink, secondary text, accent/soft accent,
disc gradient, waveform, borders and shadows. Add the Host-owned top-level `themeColor` key in the existing standalone
`config.json`; `init` writes `"iris"` for new configurations. Supported values are
`iris`, `clay`, `sage`, `tide`, `graphite`, `rose`, and `berry`. Host reads only the
config path advertised by the authenticated connected daemon, on initial
connection or reconnection. It does not read a guessed default path. Missing or
invalid cosmetic preferences fall back to Iris. Manual edits apply after
restarting Host or reconnecting; there is no file watcher or new daemon protocol.
Only the selected palette name enters renderer state. Existing light/dark/system
mode stays independently persisted in Host.

Match Pebble's subtle pressed feedback and waveform states: idle/muted are still,
listening reflects real input level, thinking uses three staggered dots, and
speaking has its distinct waveform. Only transform/opacity animate. Keyboard
actions respond immediately. Reduced motion, reduced transparency and increased
contrast remain usable. Input level never changes the audio sent to the daemon.

## Scope and files

Changes cover Host renderer components and styles, shared overlay geometry,
the minimal preload/main task-open bridge, task window dimensions, focused tests,
Host documentation and shared bilingual UI labels. There are no dependencies,
processes, permissions, installation changes, network routes or media/provider
changes. Camera capture and quota error fixes are documented in the separate
[camera and quota design](live-camera-quota-fixes.md).

## Verification and acceptance

The [before](assets/live-pebble-ui/before.png) and
[after](assets/live-pebble-ui/after.png) screenshots render production components
with synthetic state. The after view combines the card, settings and task window
for inspection; its camera preview is a placeholder, not a real camera image.

1. Record baseline using the installed CLI where applicable and explain why
   native visual behavior needs a renderer/native-window fixture.
2. Build and typecheck Host; run the repository build/typecheck/bundle requirements
   and focused Host regression tests. Record environmental failures separately.
3. Render production components, rather than copying the prototype, in Chrome
   and a local Electron window with deterministic state. Compare component
   dimensions, screenshots and state motion to the approved prototype.
4. Exercise mute, call start/stop versus quit, preview-only hide, settings drafts,
   memory locking, language/theme, tasks and permissions. Confirm stable DOM,
   keyboard accessibility, small-screen placement and no console errors.
5. Perform two clean full-diff self-audits and an independent review. Renderer
   fixture results are not evidence of real microphone, provider or live task E2E.

Acceptance requires matching the dimensions above, equivalent spacing and
materials in light/dark mode, no functional regressions, and clear provenance for
visual evidence. The default Iris and all configurable palettes must apply consistently to the main and task windows in both appearances.
