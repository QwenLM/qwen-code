# Cycle 68 — Voice input (Web Speech dictation) in the composer

Proposal: `add-voice-input`. The PWA composer gains push-to-talk dictation that
fills the prompt box (does NOT auto-send), per the proposal.

## Deviation note

Purely client-side (browser `SpeechRecognition`/`webkitSpeechRecognition`); no
gateway/daemon change, no new route. Recognition runs in the browser; only the
final transcript text ever exists, and it goes into the existing prompt
textarea which the user reviews and sends manually.

## What it adds

A "Dictate" button in the existing `#composer` next to Send. Click → start
`SpeechRecognition`; on a result, the transcript is appended into `#prompt`
(never auto-sent). Click again (or on end) stops. Feature-detected at load: when
the API is absent (e.g. headless/Firefox), the button is disabled with a title
explaining it, so the composer never breaks.

## Decisions

1. Append (not replace) the transcript to any existing `#prompt` text, so voice
   complements typing. Final results only (`interimResults=false`) to avoid
   churn; `continuous=false` (one utterance per press).
2. Fill-only, never auto-send — the proposal's hard rule (review before send).
3. Graceful degradation: `const SR = window.SpeechRecognition ||
window.webkitSpeechRecognition`; absent → `dictate.disabled = true` + title.
   All recognition callbacks are wrapped so a permission denial / error just
   resets the button.
4. The button label toggles "Dictate" ↔ "Stop". textContent only. Additive to
   the composer; touches no existing handler.

## Verification

Playwright in-session (headless Chromium): the composer (revealed after a watch)
shows a Dictate button; assert it exists. The actual mic/recognition is NOT
testable headless (no audio device / API may be absent) → assert the
feature-detect path (button disabled+titled when SR is absent, OR present when
SR exists) rather than a live transcription. This is "wiring + graceful
degradation verified", NOT live dictation. lint/build/test unchanged, e2e 45/45.

## Deferred

Live interim results; language selection; a waveform/level meter; auto-send on a
trailing-silence timeout; verifying real transcription (needs a mic).
