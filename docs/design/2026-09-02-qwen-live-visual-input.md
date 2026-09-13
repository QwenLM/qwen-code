# Qwen Live visual input — Source × Mode

## Goal

Make visual input explicit instead of asking the model to infer whether an
image came from the desktop or camera. Visual input has two independent axes:

- Source: `screen` or `camera`
- Mode: `on-demand` or `live-feed`

The selected pair is authoritative. The model never inspects or claims to see
the unselected source.

## Configuration

```json
{
  "visualInput": {
    "source": "screen",
    "mode": "on-demand",
    "fps": 1,
    "cameraResolution": { "width": 1280, "height": 720 },
    "cameraSnapshotResolution": "native",
    "liveResolution": { "width": 1280, "height": 720 },
    "snapshotResolution": "native"
  }
}
```

These defaults make visual capture private and pull-based until the user or
model needs it. `qwen-live init` persists these defaults without prompting for
them. The configuration file and environment variables can set the startup
values; the Host orb can change Source and Mode at runtime without rewriting
the file.

Environment overrides:

- `QWEN_LIVE_VISUAL_SOURCE`
- `QWEN_LIVE_VISUAL_MODE`
- `QWEN_LIVE_VISUAL_FPS`
- `QWEN_LIVE_CAMERA_RESOLUTION`
- `QWEN_LIVE_CAMERA_SNAPSHOT_RESOLUTION`
- `QWEN_LIVE_VISUAL_LIVE_RESOLUTION`
- `QWEN_LIVE_VISUAL_SNAPSHOT_RESOLUTION`

FPS is bounded to 0.1–10. Camera and Live Feed resolutions are width/height
pairs and default to 1280×720. Screen `snapshotResolution` and Camera
`cameraSnapshotResolution` independently accept a pair or `native`.

## Mode semantics

### Live Feed

The Host samples the selected source continuously at the configured FPS and
resolution. Each bounded JPEG travels as `host.visual_frame`, is validated
again by the daemon, and becomes `input_image_buffer.append` on the active
Omni Realtime connection. Frames are best-effort and remain scoped by call
epoch. Realtime rejects image frames until at least one microphone audio frame
has been appended; periodic sampling naturally recovers after audio starts.

- Screen uses the in-process native Appshot implementation on the foreground
  non-Host window.
- Camera uses one preload-owned MediaStream, requested at the configured
  `cameraResolution`, shared by transport and preview.
- The `appshot` model tool is disabled in this mode.

Before the first microphone frame is available, the daemon retains only the
latest sampled frame and sends it immediately after audio starts. This keeps
the provider's required audio-before-image ordering without losing the newest
view during connection startup.

### On Demand

The foreground model calls `appshot` when current visual information is needed.
Active visual Proactive tasks independently request periodic private captures
for their Monitor sessions in this mode. For Appshot, the daemon sends a correlated
`host.capture_visual` request for the selected source. The Host captures one
frame and returns `host.visual_capture_result`. `LiveSession` registers the
captured file as an asset and returns the source metadata and asset handle via
the original `function_call_output` continuation path. It does not append the
snapshot to Realtime, commit an audio buffer, or change VAD mode.

Screen results also carry bounded app/window/accessibility metadata and keep
the native PNG as a handoff asset. Camera results keep an independently captured
still JPEG at `cameraSnapshotResolution` as a handoff asset. When pixel-level interpretation is needed, the model delegates
the user's visual question with that asset in `input_refs`. A source or mode
change rejects any obsolete pending capture.

## Resolution and payload policy

Live Feed provider input is canonical raw JPEG base64, never a data URL, and is
capped at 190 KiB decoded. Every JPEG sent to Omni is also proportionally fitted
within 1920×1080, the provider's 1080p input boundary.

- Live Feed first scales within `liveResolution`, lowers JPEG quality, and may
  reduce dimensions further when necessary.
- Camera Appshot captures a full still image, then fits its asset within
  `cameraSnapshotResolution` when configured. Native requests the device's
  available still-image size; a supported video-constraint fallback restores
  the preview after capture. Failure to obtain native capture is explicit.
- Camera assets are limited to 8 MiB and stay on the Host-local asset path.
  Their transport preview remains a bounded 1080p/190 KiB JPEG. Private
  Monitor frames use the preview/Live resolution and never trigger still
  capture. Screen PNG assets keep their captured dimensions.
- Screen snapshot transport first fits its configured boundary and the 1080p
  cap, then lowers quality. An oversized minimum-quality transport frame
  fails explicitly. Live Feed retains its additional downscaling fallback.

No media payload, transcript, API key, or credential is written to diagnostics.
Screen PNGs and camera JPEG handoff assets are private temporary files managed
by the existing Appshot capture service.

## Host UI and permissions

Whenever the Host is connected, the orb or setup panel shows two compact
controls, `Source` and `Mode`, including when the selected source is not ready.
Clicking either opens an English text menu. Camera Source also shows a mirrored
preview whenever the usable orb is visible, labelled `Camera · On Demand` or
`Camera · Live Feed`. The selected camera stream remains local while idle;
Live Feed uploads frames to Realtime only during an active call. On Demand
Appshot returns a local handoff asset, while an active Proactive task may
continuously request bounded Monitor frames. Stopping the call disposes those
tasks; the idle camera preview stays local.

Readiness is source-specific:

- Both sources require microphone, audio self-checks, and the shortcut.
- Screen requires Accessibility, Screen Recording, and Appshot readiness.
- Camera requires Camera permission; missing Screen permissions do not block it.

Changing Source requests only the new source's permissions. If a call is
active, the Host keeps the working source selected until the new source is
ready, then applies the requested source atomically; this prevents the
permission prompt itself from stopping the call. Stop, disconnect, renderer
loss, epoch change, mode/source change, and Host shutdown all tear down the
obsolete timer, stream, or pending request.

## Prompt contract

The system instructions define exactly one selected source and mode. A silent
`[VISUAL_INPUT] source=… mode=….` context item updates that contract after an
orb change.

- Live Feed: answer visual questions from recent selected-source frames; never
  call `appshot`.
- On Demand: call `appshot`; use its Screen metadata when sufficient, or hand
  off the returned Screen/Camera asset for pixel-level interpretation.
- Never combine, guess, or claim to see the unselected source. Ask the user to
  switch Source in the orb when they request it.

## Protocol compatibility

Visual input and playback identities use Host protocol v9 so an older Host cannot appear
connected while silently rejecting the new capture commands:

- optional `host.welcome.visualInput`
- `host.visual_frame`
- `host.visual_settings`
- `host.capture_visual`
- `host.visual_capture_result`

The built-in `qwen serve` daemon can omit `visualInput`; the v9 Host then exposes
no Source/Mode controls and uses `host.capture_visual` with source `screen` for
Appshot. The qwen-live and CLI protocol type files remain byte-identical.

## Diagnostics and verification

`qwen-live --debug` logs privacy-safe configuration, connection, call, capture,
frame acceptance, and provider error metadata to stderr. The Host executable
also accepts `--live-debug` for capture-side dimensions, byte counts, and error
codes. (`--debug` is reserved by Electron.)

Automated coverage includes config defaults/validation, init exclusion,
protocol parsing and size limits, runtime setting persistence, correlated
capture, source/mode frame filtering, Realtime audio-first image delivery,
prompt routing, Host lifecycle, camera preview architecture, and package
typecheck/build.
