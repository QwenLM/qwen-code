# Live status placement and cumulative audit

## Requested adjustment

Move the status pill below the orb, retain hover-only controls above it, use
a translucent status background, replace the Settings sliders icon with a
round cog, and make the Settings scrollbar visible on opening. Preserve
automatic startup, compact edge clamping, macOS top compensation, preview-only
visibility controls, and all existing Memory/Proactive behavior.

## Layout

Keep the orb anchor and its maximum animation envelope stable. Move status
and background-permission action below the orb with an explicit gap. Expand
the shared compact collision envelope to include the status, so neither
progress/error text nor the permission action is clipped at screen edges.
The caption and camera preview remain above the floating controls.

Use a symmetric toothed cog with a circular hub, inside a round Settings
button. Status translucency must remain readable on both light and dark
desktop backgrounds. Settings owns a persistent scrollbar track/thumb and
stable gutter, without changing macOS system scrollbar preferences.

## Verification and audit

Add geometry/style regression checks and inspect the actual browser/native
renderer at the 384 by 480 viewport. Then audit all accumulated changes from
baseline `f7b0b88b2fc0124d55d04b7797c8f8f342fadd63`, including untracked files,
following AGENTS.md and CONTRIBUTING.md. Check parameter producers/consumers,
daemon-route ownership, authenticated protocol boundaries, capture/audio state,
Memory persistence and model calls, Proactive FIFO, startup/quit, CLI parity,
documentation and dependencies. Reproduce confirmed problems before fixing.

Run scoped suites from package directories, root build/typecheck/bundle,
changed-file formatting/lint and boundary checks. Do not run full preflight's
clean/reinstall on this mixed local dependency tree. Do not change user config,
Memory data or live device permissions. No GitHub writes or release work.
