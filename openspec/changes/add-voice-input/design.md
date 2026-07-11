# Design — add-voice-input

## Context

The PWA's input bar today is a single-line text field plus Send
button. On a phone keyboard, a 100-character prompt takes about 30
seconds of one-handed typing. Voice would shorten that to about 6
seconds plus a review tap. The Web Speech API has been in browsers
for over a decade and is exactly fit-for-purpose for prompt-length
dictation in mainstream languages.

The architectural commitment from `add-remote-control` is "no
vendor relay we operate." Web Speech in Chromium streams audio to
Google's speech-to-text service; in Safari it varies by version
between on-device and Apple-server STT. This is a vendor relay we
do NOT operate but the user is implicitly opting into by using
their browser's dictation feature. We choose to ship voice input
ON TOP of that pipeline because:

- It is opt-in (a button the user presses).
- It is transparent (we expose what's happening).
- It is reversible (don't press the button).
- It avoids building a server-side STT path that would add scope
  and ongoing cost.

A self-hosted alternative (Whisper compiled to WASM, running in the
browser) is plausible and explicitly noted as future work. It
requires shipping a 30–80 MB model bundle, accepting a few-second
warm-up, and dealing with mobile memory pressure. Not in scope for
this change.

## Goals / Non-Goals

**Goals:**

- Press-and-hold microphone button in the PWA input bar.
- Configurable push-to-talk hotkey.
- Live partial transcript visible while recording.
- Volume meter visual to confirm mic is picking up audio.
- Per-client language selection.
- Explicit privacy disclosure with persistent indicator.
- Graceful absence when the API is unavailable.
- Accessibility parity for keyboard / screen reader users.

**Non-Goals:**

- Server-side STT proxy. Audio MUST stay in the user agent.
- Wake-word / always-on listening.
- Voice output (TTS).
- Auto-submit. The user always sees text and presses Send.
- Multi-language auto-detect in one utterance.
- Custom vocabularies / domain models.
- Saved recordings.

## Architecture

```
   ┌────────────────────────────────────────────────────────────┐
   │ PWA (browser or native-shell WebView)                       │
   │                                                             │
   │  InputBar.tsx                                               │
   │    │                                                        │
   │    ├── MicButton.tsx ◀── press/release ◀── pointer / hotkey│
   │    │       │                                                │
   │    │       └── voice/recognition.ts                         │
   │    │             ├── feature detect (SpeechRecognition      │
   │    │             │   or webkitSpeechRecognition)            │
   │    │             ├── start(): partial events → onPartial   │
   │    │             │           final events → onFinal        │
   │    │             ├── stop()                                 │
   │    │             ├── onError(err): emit + show toast       │
   │    │             └── 60s safety timer                       │
   │    │                                                        │
   │    ├── VolumeMeter.tsx                                      │
   │    │       └── voice/volumeMeter.ts                         │
   │    │             ├── getUserMedia({audio:true})             │
   │    │             ├── AnalyserNode → byteFrequencyData       │
   │    │             └── 30 fps RMS → 0..1 normalized           │
   │    │                                                        │
   │    └── input text field ◀── transcript injected             │
   │            (gray for interim, black for final)              │
   │                                                             │
   │  Settings.tsx                                               │
   │    ├── voice.lang (BCP-47, default navigator.language)      │
   │    ├── voice.hotkey                                         │
   │    └── voice.disabled (kill switch)                         │
   │                                                             │
   │  PrivacyBanner.tsx                                          │
   │    └── shown on first activation per origin; persists       │
   │        dismissal in localStorage["qwen-rc:voice-disclosure"]│
   └────────────────────────────────────────────────────────────┘
```

No daemon-side code paths. Audio is captured locally and sent only
to the browser's built-in STT.

## Recognition module API

```ts
// packages/web-client/src/voice/recognition.ts

export type RecognitionEvent =
  | { kind: 'start' }
  | { kind: 'partial'; text: string }
  | { kind: 'final'; text: string }
  | { kind: 'error'; code: ErrorCode; message: string }
  | { kind: 'end' };

export type ErrorCode =
  | 'not-supported'
  | 'permission-denied'
  | 'no-speech'
  | 'audio-capture'
  | 'network'
  | 'language-not-supported'
  | 'aborted'
  | 'max-duration';

export function isSupported(): boolean;

export interface RecognitionSession {
  start(opts: { lang: string }): void;
  stop(): void; // gentle stop, await final
  abort(): void; // immediate, no final
  on(handler: (e: RecognitionEvent) => void): () => void; // returns off()
}

export function createSession(): RecognitionSession;
```

Implementation wraps `SpeechRecognition` (or
`webkitSpeechRecognition`). Continuous mode OFF (we only care
about the press-to-release utterance); interim results ON;
`lang` set per call.

A safety timer arms on `start` and triggers `abort()` plus a
`max-duration` error event at 60s. A pre-warning is emitted at
55s for the UI to render the chip.

## Volume meter

```ts
// packages/web-client/src/voice/volumeMeter.ts
export function startVolumeMeter(): {
  level$: Observable<number>; // 0..1, ~30 fps
  stop(): void;
};
```

Uses `getUserMedia({audio: true})` → `AudioContext` →
`AnalyserNode` (FFT size 256). RMS over the freq buckets,
normalized. The user-media permission for the meter is the SAME
permission Web Speech needs; the meter just consumes the stream
visualization.

When `getUserMedia` rejects (permission denied), the meter shows
"mic blocked" and the recognition session reports
`permission-denied` symmetrically.

## UI

### MicButton states

| State             | Visual                                 | Trigger                              |
| ----------------- | -------------------------------------- | ------------------------------------ |
| idle              | mic icon, not pressed                  | default                              |
| recording         | filled circle, volume halo, "rec" pill | pointer-down OR hotkey down          |
| transcribing      | rotating spinner                       | pointer-up; awaiting final event     |
| error             | red mic with toast                     | onError                              |
| unavailable       | hidden                                 | `!isSupported()` OR `voice.disabled` |
| max-duration-warn | recording + "5s left" chip             | 55 s into a recording                |

### Live transcript

While recording, the input field renders the interim transcript in
gray. On `final`, the gray text replaces with the final
transcription in normal color. On `error` or `aborted`, the gray
text is removed; the final-so-far stays. The cursor lands at the
end of the inserted text.

If the input field already contained user-typed text, the voice
transcript appends (separated by a single space) rather than
overwrites. This matches the "voice augments typing" pattern.

### Slash command rendering

If, after final transcription, the text begins with a recognized
slash command (one of the known commands in the palette), the web
client renders the slash command pill BUT does not execute. The
user must press Send. This mirrors how typed slash commands work
today.

### Privacy disclosure

First invocation per origin shows a modal:

```
Voice input sends audio to your browser vendor's speech-to-text
service.
  • Chromium / Edge: Google STT
  • Safari: Apple STT (may be on-device on newer iOS)
  • Firefox: not supported (this button is hidden there)

The qwen daemon never receives the audio. Dismiss?
[Don't show again]  [Open settings]  [Got it]
```

Dismissal persisted in
`localStorage["qwen-rc:voice-disclosure:<origin>"] = "v1"`. When
the privacy text content changes materially, bump the version to
re-surface the banner.

A persistent pill "Voice: vendor-side" in the input bar (visible
when the mic button is visible) is non-dismissable. Tapping it
re-opens the disclosure.

### Hotkey

Configurable in settings; default depends on context:

- When the prompt input is NOT focused: `Space` held >150ms (so
  brief taps still scroll/page).
- When the prompt input IS focused: `Ctrl+Shift+M` held.

Both are configurable to a single chord. Implementation hooks the
hotkey at the keydown / keyup pair; debounce 150ms to distinguish
hold-vs-tap.

## Languages

Default `navigator.language` (e.g., `en-US`). Settings allow
override via BCP-47 tag input. On invalid tag, the recognition
session emits `language-not-supported` error and the input falls
back silently to the default.

A small dropdown lists common preset tags but a free-text field
accepts any tag (browser ultimately decides what it supports).

## Decisions

### D1 — Use the platform Web Speech API; no server STT

**Choice**: Voice input goes through the browser's built-in
`SpeechRecognition`. The daemon does not see audio.

**Alternative considered**: Stream audio to the daemon, run
Whisper (or call a vendor like Deepgram).

**Why**: Keeps the architectural promise "no vendor relay we
operate." Avoids adding server-side audio infrastructure (memory,
compute, model files, IPC). Trades worse privacy disclosure (the
browser vendor sees audio) for better simplicity AND the user can
just not press the button.

**Cost**: Audio goes to Google / Apple. Documented. Future change
can add Whisper-WASM as a local alternative.

### D2 — Hold-to-talk, never auto-submit

**Choice**: User holds the button (or hotkey) while speaking;
release stops capture; transcript appears in the input; user
presses Send.

**Alternative considered**: Tap to start, tap to stop (toggle
mode); auto-submit on end-of-speech detection.

**Why**: Hold-to-talk has a clear mental model — your finger is
the mic switch. Toggle modes invite "forgot to stop" recordings
(privacy + 60s timer mitigates, but the UX is worse). Auto-submit
prevents review and edit, which is exactly the wrong move when
transcription quality is imperfect.

**Cost**: Holding a finger on the screen for long thoughts is
awkward on a phone. Mitigated by the 60s cap (long thoughts are
truncated regardless) and by the desktop hotkey.

### D3 — Slash commands rendered, not executed

**Choice**: If transcribed text begins with `/`, the input parses
it as a slash command for display but waits for Send.

**Alternative considered**: Auto-execute the slash command on
final transcript.

**Why**: STT mishears. "Slash clear" might be heard as "lash
clear" or "clash clear." Auto-executing destructive commands
based on misheard audio is the worst possible outcome. Render +
wait is one cheap extra tap that prevents that.

**Cost**: Voice slash commands take one extra tap vs typed. Same
as voice prompts; consistent. Acceptable.

### D4 — 60s hard cap, 55s warning

**Choice**: Recording aborts at 60 seconds with a `max-duration`
event. A 5-second warning chip appears at 55 s.

**Alternative considered**: No cap; let the user record as long
as they want.

**Why**: Web Speech sessions that run longer than ~60s tend to
hit vendor rate limits or accumulate errors; long sessions also
ship more audio data than a "prompt" warrants. A hard cap is a
defensive default. Users who need long-form dictation should type
or break the thought into multiple presses.

**Cost**: A user composing a long thought has to break it into
chunks. Acceptable; matches typical dictation UX.

### D5 — Privacy banner per-origin, persistent pill in-bar

**Choice**: Disclosure modal on first use; persistent
"Voice: vendor-side" pill while the mic is active.

**Alternative considered**: Modal on every session start; tiny
disclosure link in settings only.

**Why**: One-time modal respects user intelligence after the
first read. Persistent pill keeps the disclosure visible in
the surface where it matters (the input bar) without nagging.

**Cost**: Some screen real estate. Tradeable for the privacy
posture this preserves.

### D6 — No daemon-side awareness of voice

**Choice**: The daemon receives only the final submitted text;
it does not know voice was used. No new audit entries.

**Alternative considered**: Stamp each prompt with `inputMethod:
voice` for audit visibility.

**Why**: The user reviewed and submitted the text. From the
daemon's perspective the prompt is identical to a typed one. Adding
`inputMethod` leaks behavior to all attached clients (including
bridges, including audit logs) for no operational benefit.

**Cost**: An operator who wants "did the partner type or speak
this?" cannot tell from audit. Acceptable; out of audit scope.

### D7 — Inherited unchanged in native shells

**Choice**: The native shells from `add-native-mobile-shells` get
voice input "for free" because their WebView exposes the platform
Web Speech API. No bridge methods added.

**Alternative considered**: Add a `bridge.recordAudio()` method
that uses native APIs (e.g., iOS Speech framework directly,
which can be on-device-only).

**Why**: Native APIs would give better privacy posture on iOS
(on-device-only via SFSpeechRecognizer), but adding the method
expands the bridge surface, requires per-platform code, and
diverges native vs. web behavior. Web Speech in the WKWebView IS
what's available and IS what the user already accepts from any
other web app. Future improvement can add a native pipeline if
operators demand it.

**Cost**: iOS users do not get the more-private on-device path
even on supported iOS versions. Documented in
`apps/ios/README.md`.

## Threat model

| Attacker                                   | Capability                                         | Mitigation                                                                                                                                                                                     |
| ------------------------------------------ | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser vendor (Google/Apple)              | Sees audio + transcript                            | Documented in disclosure; user opts in per use. No daemon-side surface.                                                                                                                        |
| Network passive between browser and vendor | Sees audio (HTTPS encrypted but vendor terminates) | Out of our control; consistent with operating system dictation. Documented.                                                                                                                    |
| Compromised page (XSS) starts recording    | Records ambient audio                              | Press-and-hold model means recording only when button pressed; hotkey requires actual keydown; getUserMedia permission is per-origin and prompts on first use; CSP excludes 3rd-party scripts. |
| Stolen unlocked phone                      | Records ambient audio in PWA                       | Same as above; recording requires the button pressed; mitigation = lock the phone (biometric on the shell from `add-native-mobile-shells`).                                                    |
| Misheard destructive command auto-runs     | Voice input causes harm                            | Slash commands never auto-execute (D3); plain prompts go through the agent which has its own approval gating (`add-policy-engine`).                                                            |
| Permission denial leaks user state         | The Web Speech "denied" state is observable        | Negligible; not a credential.                                                                                                                                                                  |

## Risks / Trade-offs

| Risk                                        | Likelihood | Impact | Mitigation                                                                                         |
| ------------------------------------------- | ---------- | ------ | -------------------------------------------------------------------------------------------------- |
| Web Speech rate-limited by vendor           | M          | L      | Hold-to-talk pattern produces bounded short sessions; 60s cap.                                     |
| Safari Web Speech support gaps in older iOS | M          | M      | Feature detect; button hidden when unsupported; documented as "may be partial".                    |
| Volume meter battery drain                  | L          | L      | Meter runs only while recording; AudioContext disposed on stop.                                    |
| User believes audio goes to daemon          | M          | M      | Disclosure modal first time + persistent pill.                                                     |
| Mic permission prompt confuses on phone     | M          | L      | Microbutton press launches getUserMedia first time; subsequent presses use the granted permission. |
| Hotkey conflict with browser shortcut       | M          | L      | Configurable; default uses uncommon chord on focused input.                                        |

## Open questions

1. **Should pressing Send while voice is still finalizing be
   permitted?** Two options: (a) block Send until final event;
   (b) allow Send with current interim text. Leaning (a) for
   cleanliness — a small spinner replaces the Send button during
   "transcribing" state.

2. **Edge case: device locks mid-recording.** The OS may suspend
   the page; `SpeechRecognition.onend` may not fire. On page
   visibility return, we abort any in-flight session. Implemented
   in `recognition.ts`.

3. **Should we send the final transcript through a separate
   "voice confidence" filter?** The API exposes confidence per
   result. If confidence < some threshold, we could highlight low-
   confidence words. Out of scope this change; nice-to-have for
   future.

4. **Wake-word "Hey Qwen"?** Out of scope per Non-Goals. Would
   require always-on mic which we explicitly do not want.

5. **Whisper-WASM as an alternative pipeline.** Documented as
   future work. Approximate effort: 1 week to package a model and
   wire as a swappable backend behind the same `recognition.ts`
   interface. Decision deferred until operator demand or until
   Web Speech gets retired by some vendor.
