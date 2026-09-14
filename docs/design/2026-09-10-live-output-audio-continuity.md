# Continuous Live output audio

[English](2026-09-10-live-output-audio-continuity.md) | [简体中文](2026-09-10-live-output-audio-continuity.zh-CN.md)

## Observed defect

The user hears periodic sharp crackles during continuous speech on Bluetooth
headphones. A safe Chromium OfflineAudioContext reproduction using the actual
Host audio engine found a digital discontinuity independent of hardware: the
same 24 kHz PCM tone played as chunks and as one buffer differs at chunk joins.
At 44.1 kHz, 480-sample chunks can produce a sample near -0.804 instead of -0.400.
Seventeen of twenty-five tested rate/partition combinations failed. Separately,
a chunk arriving with 5 ms still queued received an unnecessary 5 ms gap.

This establishes defects in the playback path, not proof of the cause of every
Bluetooth noise. Opening a Bluetooth headset microphone can still switch macOS
to a lower-quality hands-free route; that is a separate device behavior.

## Change

Keep the AudioContext on the device's default clock. In current connections that
negotiate output-end markers, continuously resample each `(epoch, outputId)`
stream before constructing device-rate AudioBuffers. A windowed-sinc low-pass
filter retains a short, bounded input history and lookahead across PCM chunks.
The filter also rejects above-Nyquist content when a device runs below 24 kHz;
linear interpolation would not provide this anti-aliasing property.

The final output marker flushes the retained tail. Playback completion waits for
all scheduled sources including that tail; mute, clear, disconnect, context loss
and mode changes discard the state. Epoch and output identity fencing remains
unchanged. The phase-kernel cache is bounded at 1,025 entries. Connections without
end markers retain the existing per-frame conversion and drain path so a filter
tail cannot wait indefinitely for a marker those peers never send.

Schedule current connections at integer device-sample boundaries. Add the small
startup lead only when no audio remains queued; never insert it between already
contiguous chunks. No new configuration or forced hardware sample rate is added.

## Verification and limits

Focused tests cover rate conversion, partition invariance, anti-alias rejection,
empty/tiny outputs, completion, late markers, failed scheduling, mute/clear and
legacy peers. The same Chromium offline oracle must pass against source and built
preload, including a non-silent waveform check. No actual audio device or user
microphone is needed for these tests.

Physical Bluetooth listening remains a user/runtime verification step. Genuine
network underruns are not solved by this change. A late final marker can schedule
the short retained tail after an earlier source has drained.
