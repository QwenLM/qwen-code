# OpenTUI voice input parity

[English](2026-10-26-opentui-voice-input-parity.md) | [简体中文](2026-10-26-opentui-voice-input-parity.zh-CN.md)

## Status and evidence

Implementation in progress; not accepted or fully verified. Baseline is main `162ad9f8b2d4ce14bdafcc2c08e843dbd4739644`. A mock-only test using the real OpenTUI shell and composer fails because enabled tap-mode Space enters an ordinary space and never calls recorder.start. Disabled and nonempty-input controls pass. Unchanged Ink InputPrompt and shared voice-hook wholefiles pass 295 tests with one pre-existing skip; all 24 shared-hook tests pass. This proves a component integration gap, not a native microphone or platform failure. The global CLI is 0.22.0 and is provenance only.

## Problem and scope

The shared /voice command and auxiliary voice-model selector persist valid settings and announce dictation, but OpenTUI does not consume the configured voice feature. Ink already supports hold/tap input, permission notices, batch and streaming transcription, optional refinement, cancellation and a visible recording indicator. Entry-point registration must not count as behavioral parity.

This batch completes the voice capability using existing implementation and dependencies. Shell promotion/focus, render-mode switching, installation/platform qualification, screen-reader support and migration defaults remain separately tracked. Do not add a new audio backend, protocol, fake product switch, framework or library upgrade.

## Shared configuration and ownership

Extract Ink's existing configured voice pipeline into a hook used by both composers. Keep useVoiceInput as the single state machine and preserve its recorder lifetime, streaming transport selection, network-policy checks, retry behavior, keyterm filtering, transcript refinement and stale-result cancellation. Preserve the current model/settings semantics and permission notice deduplication. A session-level warning ref belongs to the owning UI, not a recording or transient dialog.

The shared hook receives the current settings/configuration, real text buffer, history writer and submission callback. OpenTUI's shell must populate the integration at the actual composer mount; a declaration with no production caller is insufficient. Record failures and permission notices through the owning history path, rather than only a transient banner. Existing Ink behavior remains the compatibility control.

## Keyboard and submission

Only a focused, empty, ordinary chat prompt can start dictation. Match Ink's modal, shell, search, completion, attachment and Vim ownership order; active recording/transcription cancellation must reach the existing hook. Space consumed by dictation must not also insert a native space. Disabling voice or unmounting cancels pending work through the existing lifecycle. Preserve the shared hook’s model-change semantics: replacing one valid model with another does not itself cancel; opening a model dialog cancels through composer unmount.

Transcription uses the ordinary composer submission path. It must preserve exact sanitized Unicode text, submit once in tap mode, keep hold-mode editing behavior and avoid clipboard framing or falsely restoring imported-input provenance. Do not bypass pending draft/attachment ownership, queue or live-turn policies.

## Presentation

Render recording, transcribing and refining states using the existing translated labels and indicator semantics, including the audio-level meter and escaped interim text. Match the current Ink presentation without importing Ink components into the native renderer. Use existing RGBA.fromIndex slots 9/6/8/3 for Ink redBright/cyan/gray/yellow, preserving terminal palette customization without RGB guesses or new palette probes. Keep interim text dimmed without forcing a foreground color, matching Ink’s inherited-color semantics. Use the existing width-aware text utility for end truncation at the terminal width minus the row padding. The native truncate flag truncates in the middle, so it does not match Ink. Verify the end ellipsis through the real native test renderer as well as the Ink narrow-width control. Pending labels use the existing wrap-ansi dependency with Ink’s exact hard/trim options before native no-wrap rendering; native word wrapping alone moves the marker onto an extra line in a 12-column viewport. Share small presentation logic only when both renderers consume it; avoid a new UI abstraction.

Full-block comparison retains four recording differences at 12 columns: the Ink reference loses the recording marker and two meter cells and overlaps its label, while the native row retains that information on additional lines. These are known reference defects and unresolved parity differences requiring an explicit maintainer decision. Keep their original comparison failures; do not change the reference or remove information to manufacture equality.

## Validation and regression

Keep the original failing test and raw 1F2P result. Before implementation, test-engineer independently checks the failing positive oracle and Ink/shared-hook controls. After implementation, repeat the same discriminator without weakening its start/stop, exact transcription, single-submission and ordinary-Space assertions. Add focused coverage for modal/focus ownership, hold/tap, cancellation, disable/unmount, stale completion, permission notice deduplication and visible states, reusing existing hook tests instead of duplicating their state-machine suite.

Run package-scoped affected wholefiles, build, typecheck, lint and bundle. Test-engineer verifies the corrected integration and reports the exact boundary. Review the complete diff in open-ended passes until two consecutive clean passes; rerun affected checks after fixes. Keep both language designs synchronized. Retain original skips and failures. Publish one complete capability batch, preferred 2–3k changed lines and hard maximum 6000 additions plus deletions against its actual PR base, with current-head CI and review evidence.

## Acceptance and remaining gates

Acceptance requires the production shell to configure voice, empty-prompt Space to start once, tap completion to submit the exact text once, controls to preserve normal typing, and cancellation/lifecycle/presentation tests to pass without device or network access. Mock success does not qualify Bun native capture binaries, real streaming providers, OS microphone permissions, hold timing, device changes or accessibility. Those require explicit final platform/manual evidence. No default-renderer switch, release, automatic merge or Ink removal is authorized by this batch.
