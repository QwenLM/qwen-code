# Live orb startup, sources and compact edges

## Request and current gap

The orb currently shares a 384 by 480 native collision rectangle with setup,
uses a subtle 1.025 speaking scale, starts idle, and places camera preview far
above the orb. Settings order and its combined mode explanation are unclear.

The user confirmed three peer settings groups: Audio Source (microphone),
Video Source (Screen/Camera), and Capture Mode (On Demand/Live Feed). They also
confirmed that hiding camera preview only changes the local small window,
not the selected source or transmitted frames.

## Changes

- Increase speaking motion while reserving its maximum animated extent and
  keeping reduced-motion support. Do not restore a drop shadow or rebuild
  orb/video nodes on state updates.
- Automatically start one call when a newly launched Host first becomes fully
  ready: authenticated connection, renderer/native services, source-specific
  permissions, audio checks and provider availability. Consume the startup
  intention before dispatch. An existing call or explicit start/stop/new/quit
  consumes it; failure, renderer reload and reconnect must not repeatedly
  start calls after the user stopped.
- Present Audio Source, Video Source and Capture Mode as equal settings
  groups, in that order. Use a recognizable sliders Settings icon. Explain
  only the selected mode, using authoritative state rather than optimistic
  selection before acknowledgement.
- Make preview default-visible whenever Camera is selected. A small floating
  show/hide button remains reachable even when the preview is hidden. Hiding
  preserves the video node and camera input; selecting Screen or quitting
  retains the existing capture shutdown behavior.
- Place preview closer to the orb, with caption-aware spacing but a fixed orb
  anchor. Keep controls, captions and the animated orb within the declared
  compact visible envelope.
- Use mode-specific native collision bounds rather than the entire transparent
  window: setup/settings use the full panel, while orb uses its compact content
  envelope (including room for controls and maximum animation). Preview has its
  own envelope. Persist the user's desired resting position, not temporary
  repositioning required to show a full Settings panel. Close Settings restores
  the resting position. Preserve old saved x/y files and clamp against available
  displays on restore/topology change. Do not reposition on every caption.
- macOS clamps the actual native top edge to the menu bar. After placement,
  read back native bounds and compensate `logical - actual` on the voice
  surface through a Host-local offset event. Drag deltas begin at the displayed
  logical origin. Setup/Settings are not transformed; full-frame placement
  resets the offset and closing restores it. Persist only logical desired
  coordinates and ignore older state offsets after dedicated events arrive.

## Ownership and scope

Changes are confined to live-host renderer, native window policy, a one-shot
startup helper, shared Host-local UI types/geometry, tests and READMEs. No wire
protocol or model/Memory/Proactive behavior changes. Configuration, media and
model traffic used by tests are synthetic; startup auto-call will not be tested
against the user's real daemon. Existing user work and configuration stay intact.

## Verification

Reproduce the old full-frame clamp and old mode explanations first. Test the
one-shot startup state machine, manual-stop suppression, edge coordinates,
temporary panel clamping/restoration, preview hide without capture API calls,
and stable node identity. Measure actual renderer geometry in a browser with
the native-size viewport; run native lifecycle tests and a safe isolated window
smoke where possible. Finish with build/typecheck and two clean reviews.
