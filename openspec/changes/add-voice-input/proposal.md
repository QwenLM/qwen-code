# add-voice-input

## Why

A meaningful share of remote-control sessions happen with the
operator not at a keyboard: walking between rooms, driving (passively
observing), exercising, or with hands occupied. Today the PWA's only
input is a tappable on-screen keyboard. Tapping out a paragraph-
length prompt on a phone is slow enough that operators give up and
wait until they're back at a desk.

Browsers already expose a Web Speech API (`SpeechRecognition`)
implemented by Chromium/Edge/Safari (with `webkitSpeechRecognition`
prefix on Safari; Firefox lacks support). The implementation forwards
audio to the browser vendor's STT service and returns transcripts.
This is "free" in implementation cost and "good enough" in quality
for prompt-length English at normal speaking pace.

The cost is privacy: Chromium's Web Speech sends audio to Google.
Safari sends to Apple's on-device or server model depending on
locale and version. Neither path involves a server we operate, so it
is no worse than the rest of the operating system already does for
dictation — but it IS extra exposure that the operator should be
made aware of, and that they can avoid by simply not using the
feature.

A future change can ship a self-hosted Whisper-in-the-browser
(WASM) alternative; this proposal explicitly excludes that work to
keep scope tight.

## What Changes

- **"Hold to talk" button** in the prompt input bar of the web
  client. Pressing the button begins capture; releasing ends it.
  The transcript is inserted (replacing or appending; see UX
  details below) into the text input, where the user can edit
  before pressing Send. Voice input never auto-submits.
- **Push-to-talk hotkey** (default: hold `Space` when the input is
  not focused, or `Ctrl+Shift+M` when focused). Configurable per
  client in `~/.qwen/rc/web.yaml` or the web client settings.
- **Live partial transcript and volume meter.** While recording,
  the input field shows the interim transcript (gray text); a small
  volume meter visualizes input level so the user can tell the mic
  is picking them up.
- **Languages.** Default `navigator.language`. Per-client
  override via `voiceInput.lang` in settings (BCP-47 tag).
- **Slash-command-aware.** If the transcribed text begins with a
  recognized slash command (`/clear`, `/compact`, …), the input
  field renders the dictated command but does NOT auto-execute.
  User reviews and submits manually.
- **Privacy banner.** First time voice is used in a session, a
  banner explains: "Audio is sent to your browser vendor's STT
  service (e.g., Google for Chromium). To avoid: do not use voice
  input." Banner dismissable; tracked per-origin in
  `localStorage`. A persistent "Voice: vendor-side" pill stays in
  the input bar while voice is enabled.
- **Feature gating.** If `SpeechRecognition` (or
  `webkitSpeechRecognition`) is unavailable, the button is hidden.
  No fallback to a server-side STT path. No audio is ever sent to
  the daemon.
- **Auto-stop at 60 s.** A single press cannot record more than
  60 s. At 55 s a warning chip appears; at 60 s recording stops
  automatically; the transcript so far stays in the input.
- **Accessibility.** Recording state is announced via `aria-live`
  region; partial transcript readable via screen reader; hotkey
  always works in addition to the button.
- **No new daemon endpoints.** This is a purely client-side
  change; the daemon does not learn that voice was used.

## Capabilities

### New Capabilities

- `voice-input` — browser-side STT integration for the PWA,
  hold-to-talk semantics, hotkey configuration, language
  selection, privacy disclosure, accessibility, feature gating.

## User Stories

**V1. Quick prompt while walking.** I'm walking to the office. I
open the PWA on my phone, hold the mic button, say "summarize what
the agent did since 8am," release. The text appears in the input
box. I tap Send. The agent responds.

**V2. Hands-free hotkey on laptop.** I'm at my laptop, hands on
the keyboard, focused elsewhere. I hold `Ctrl+Shift+M`, speak a
prompt, release. The web client transcribes and inserts; I review,
Enter to send.

**V3. Browser lacks Web Speech API.** I open the PWA in Firefox.
The voice button is not rendered. No error; the rest of the input
bar works normally. The settings panel shows "Voice input:
unavailable in this browser."

**V4. Privacy disclosure.** First time I press the voice button,
a banner appears: "Audio is sent to your browser vendor's
speech-to-text service. Dismiss?" I read, dismiss. The transcript
appears. The persistent pill "Voice: vendor-side" stays in the
input bar so I never forget.

**V5. Slash command dictation.** I say "slash clear." The web
client renders `/clear` in the input. I see it; I press Enter; the
command runs. The voice input did not auto-execute.

**V6. Long ramble.** I press and hold for a long thought. At 55
seconds I see a "5 s left" chip. At 60 s recording stops with a
toast "Recording stopped at 60 s limit." The 60 s of transcript
remain in the input.

**V7. Different language.** My team works in French. In settings I
set `voiceInput.lang = fr-FR`. From then on, voice input
transcribes French.

## Impact

- **packages/web-client/**:
  - New module `src/voice/recognition.ts` wrapping
    `SpeechRecognition` with a feature-detected, typed interface.
  - New UI component `src/components/MicButton.tsx`.
  - Hotkey integration in `src/input/hotkeys.ts`.
  - Settings panel additions for language + hotkey + disable.
  - Privacy banner component, persisted per-origin in
    `localStorage`.
- **No daemon changes.** No new endpoints, no new audit entries
  (the daemon doesn't know about voice). The user is the one
  reviewing-then-submitting, so the audit log already captures
  what they actually sent.
- **No new dependencies.** Web Speech API is built into supported
  browsers; volume meter uses Web Audio API (`AnalyserNode`).
- **Native shell inheritance.** Both Android TWA and iOS
  WKWebView shells (`add-native-mobile-shells`) inherit voice
  input because the WebView exposes the same Web Speech API as
  the underlying browser. No bridge change required. iOS Safari's
  Web Speech support is the limiting factor and is documented as
  "may be partial on older iOS."
- **Out of scope** (deliberately):
  - Server-side STT (Whisper or otherwise). Audio never leaves
    the user agent.
  - Continuous "wake word" listening. Hold-to-talk only.
  - Auto-execute on speech end. User must press Send.
  - Voice OUTPUT (TTS) for agent responses. Future change if
    requested.
  - Multilingual auto-detection. One language per session.
  - Custom vocabulary / domain biasing. The platform API does
    not expose this.
  - Recording to file for later review.
