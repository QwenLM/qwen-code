# Live status, docking and audio device compatibility

## Requested behavior and baseline

Cancelled Proactive monitors belong to the Completed aggregate, while details
retain their Cancelled outcome. Cancelled harness jobs and timers do not become
successful. Subagents must avoid the whole orb dock, including its wider lower
Listening bar. Input/output mute states must be visible in that bar. New users
see setup and orb at bottom-right; saved user positions must not be replaced.

The independent actual-source probe reproduces cancelled monitors as
completed=0/cancelled=1, unchanged Listening text in all mute combinations,
34×32 pixels of Subagents/status overlap, and a fresh setup at margins 0/14
instead of 20/20. Host output already uses a default-rate AudioContext with
24 kHz AudioBuffers; there is no forced 24 kHz hardware clock to remove.

The user confirmed Bluetooth headphones and disruption immediately at startup,
before model speech. Microphone activation can switch Bluetooth to hands-free
mode. This cannot be resolved solely by resampling response PCM. Tests must
not claim to reproduce physical Bluetooth behavior without device validation.

## Design

### Status and task totals

Keep detailed terminal states truthful. A small internal monitor identity set
survives detail eviction and lets cancelled monitors contribute once to
Completed rather than Cancelled. It is cleaned on archival. No protocol field
or model/tool semantic change is needed. Mute labels use the central paired
i18n catalogue and a compact secondary line inside the existing 248×32 bar;
the primary call/error/permission state remains available.

### Dock and first-run geometry

Use the complete visible orb dock envelope, not only its motion rectangle,
when placing Subagents. Keep pointer-hit/hover ownership separate if the
placement envelope is larger than the interactive area. Prefer an inward side
with room for the expanded 330×430 panel, re-evaluate a side if expansion no
longer fits, and clamp the panel to the screen without covering the dock when
a nonoverlapping placement is possible. Pinned list/detail navigation preserves
the same bounds; task-state updates do not move a user-dragged panel.

First-run default is bottom-right on the startup display, with 20px margin for
the currently shown layout. Saved coordinates and manual dragging override the
default. Settings/preview changes should preserve the chosen orb position and
should not persist a temporary screen clamp as a new user preference.

### Audio

Official reference inspected 2026-09-08:
https://help.aliyun.com/zh/model-studio/realtime and its session.update link
https://help.aliyun.com/zh/model-studio/client-events#26a8302028sjm .

Qwen3.5 Omni Plus/Flash Realtime support `audio.input.format` and
`audio.output.format` with PCM/WAV and 8/16/24/48 kHz; defaults are 16 kHz input,
24 kHz output. Set PCM input 16000 and output 24000 explicitly for documented
3.5 Plus/Flash model names. Older model names retain legacy PCM format fields
and their fixed 24 kHz output. Do not add unsupported top-level sample_rate
fields, change VAD/tool flow, or send a second monitor voice/output config.

Keep device-native AudioContext output and 24 kHz source buffers. Web Audio
performs source-to-context resampling (including upsampling to 44.1/48/96 kHz)
without forcing a system device rate or introducing a second media clock.
Log source/context rates safely. Muting input must stop tracks and release the
capture graph; unmuting rebuilds it without ending the call. Stale callbacks
must not upload samples or corrupt levels, and device changes while muted must
not reacquire a microphone.

The user is being asked whether an unselected microphone should prefer Mac's
built-in input while retaining system output and explicit saved input choices.
No system-wide audio setting is changed and no real media is opened for tests.

## Verification and scope

Follow the independent baseline/test plan in
`.qwen/e2e-tests/2026-09-08-live-followups.md`. Use offline actual-source tests,
renderer fixtures, safe WebSocket mocks and device fakes. Run focused tests from
package directories, builds/typechecks serially, then two clean review passes.
Preserve all existing dirty changes. No reinstall, publishing, broad refactor,
real provider requests, or writes to user preferences.
