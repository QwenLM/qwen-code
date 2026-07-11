# tasks — add-voice-input

State machine and alignment pattern: see
`changes/add-remote-control/tasks.md`.

## Phase 0 — Foundation

**Effort:** ~0.5 day.

- [ ] **0.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify `add-remote-control` Phase 6 `completed` (the web
    > client input bar exists and is editable). Verify the web
    > client build pipeline (esbuild per `add-remote-control`)
    > accepts a new module under `src/voice/` without
    > additional configuration. Record the input-bar component
    > path here. Set Status to `in-progress` before any other
    > tool call.

- [ ] **0.1 Feature-detect helper + types**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Files:**
    `packages/web-client/src/voice/recognition.ts`,
    `packages/web-client/src/voice/types.ts`
  - **Prompt:** > Implement `isSupported(): boolean` checking both > `SpeechRecognition` and `webkitSpeechRecognition`. Define > `RecognitionEvent`, `ErrorCode`, `RecognitionSession` > types per `design.md` "Recognition module API". Export > `createSession()` returning a stub that always reports > "not-supported" for now. Acceptance: scenario `Feature
detection in unsupported browser`.

- [ ] **0.2 Wire MicButton placeholder**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Files:**
    `packages/web-client/src/components/MicButton.tsx`,
    `packages/web-client/src/components/InputBar.tsx`
  - **Prompt:**
    > Render a `MicButton` in the input bar IF `isSupported()`
    > AND `!settings.voice.disabled`. Otherwise hidden. Stub
    > onPress/onRelease handlers. Acceptance: scenario
    > `MicButton hidden when unsupported`.

## Phase 1 — Recognition pipeline

**Effort:** ~1.5 days.

- [ ] **1.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 0 `completed`. Verify that Chromium and
    > Safari are both reachable in the dev environment for
    > manual testing; if Safari is not, document the gap and
    > rely on user-agent shims in tests.

- [ ] **1.1 Real RecognitionSession implementation**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `packages/web-client/src/voice/recognition.ts`
  - **Prompt:** > Replace the stub with a real implementation wrapping > `SpeechRecognition`. Continuous OFF; interim results ON; > lang per call. Translate API events to > `RecognitionEvent`. Map API error codes to our > `ErrorCode` union. Acceptance: scenarios `Hold to talk
captures partial then final`, `Permission denied bubbles
error`, `No-speech error returns gracefully`.

- [ ] **1.2 60s safety timer**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > Arm a timer on `start`; at 55s emit a `warning` synthetic
    > event the UI consumes for the chip; at 60s call
    > `abort()` and emit `error { code: "max-duration" }`.
    > Acceptance: scenario `60-second cap fires with warning`.

- [ ] **1.3 MicButton press lifecycle**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `packages/web-client/src/components/MicButton.tsx`
  - **Prompt:** > Pointer-down: call `session.start({ lang })`. Pointer-up > or pointer-leave: `session.stop()`. While recording, emit > the visual state changes per `design.md` "MicButton > states". Insert interim text (gray) and final text > (black) into the input bar (append with single-space > separator if the input already has content). Acceptance: > scenarios `Append on existing input`, `Interim then final
rendering`.

- [ ] **1.4 Page-visibility abort**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > Listen for `document.visibilitychange`. If the page is
    > hidden during recording, call `session.abort()` and
    > preserve any final-so-far text. Acceptance: scenario
    > `Visibility hidden aborts cleanly`.

## Phase 2 — Volume meter + UX

**Effort:** ~1 day.

- [ ] **2.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 1 `completed`. Decide whether the volume
    > meter shares the `getUserMedia` stream with the
    > `SpeechRecognition` API or holds its own. Document the
    > choice here. The recognition API doesn't expose its
    > stream; we need our own.

- [ ] **2.1 Volume meter module**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `packages/web-client/src/voice/volumeMeter.ts`
  - **Prompt:** > Implement `startVolumeMeter()` per `design.md`. Returns > a level observable (0..1) and a stop function. > AudioContext + AnalyserNode (FFT 256), RMS over freq > buckets, normalized; 30 fps update rate. On > getUserMedia rejection, return an observable that emits > 0 and a `permission_denied` error event. Acceptance: > scenarios `Volume meter responds to audio input`, `Mic
permission denied shows blocked state`.

- [ ] **2.2 Volume meter UI component**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Files:**
    `packages/web-client/src/components/VolumeMeter.tsx`
  - **Prompt:**
    > Render a small animated indicator around the MicButton
    > driven by the level observable. Accessibility:
    > `aria-hidden` (visual only; recording state announced
    > separately).

- [ ] **2.3 ARIA live region**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:** > Add an off-screen `aria-live="polite"` region near the > input. On recording start: "Recording started". On final: > "Transcript inserted: <text>". On error: "Recording > error: <reason>". Acceptance: scenario `Screen reader
announces recording state`.

## Phase 3 — Hotkey + slash commands + privacy

**Effort:** ~1 day.

- [ ] **3.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 2 `completed`. Identify the existing hotkey
    > registration module (or create
    > `packages/web-client/src/input/hotkeys.ts`); confirm it
    > supports keydown/keyup pairs with a configurable hold
    > debounce.

- [ ] **3.1 Hotkey integration**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `packages/web-client/src/input/hotkeys.ts`
  - **Prompt:** > Register two default hotkeys per `design.md`. Hold-to- > talk: 150ms debounce distinguishes hold-vs-tap; on hold > start, fire `recognition.start`; on release, fire > `recognition.stop`. Acceptance: scenarios `Hotkey holds
start recording`, `Brief tap does not start`.

- [ ] **3.2 Slash command rendering (no exec)**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Files:** `packages/web-client/src/components/InputBar.tsx`
  - **Prompt:** > After a final voice transcript, if the text begins with a > recognized `/<command>` (looked up in the existing slash- > command palette), render the slash-command pill but do > NOT execute. User must press Send. Acceptance: scenarios > `Dictated slash command not executed`, `Unrecognized
slash sent as plain text`.

- [ ] **3.3 Privacy disclosure modal + persistent pill**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Files:**
    `packages/web-client/src/components/PrivacyBanner.tsx`,
    `packages/web-client/src/components/VoicePill.tsx`
  - **Prompt:** > First voice activation per origin (no > `localStorage["qwen-rc:voice-disclosure:<origin>"]`) > shows the disclosure modal per `design.md`. On dismiss, > store `"v1"`. Persistent pill "Voice: vendor-side" shown > whenever the MicButton is rendered. Tapping pill re- > opens the modal. Acceptance: scenarios `Privacy modal on
first activation`, `Pill always visible`.

## Phase 4 — Polish

**Effort:** ~0.5 day.

- [ ] **4.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 3 `completed`. Cross-check on Android TWA
    > and iOS WKWebView shells (`add-native-mobile-shells`)
    > that voice works in the embedded WebView; if a shell
    > requires `<key>NSMicrophoneUsageDescription</key>` in
    > Info.plist (iOS) or microphone permission in
    > AndroidManifest, add those plist / manifest entries via
    > a cross-change note and link the patch here.

- [ ] **4.1 Settings panel entries**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Files:** `packages/web-client/src/views/Settings.tsx`
  - **Prompt:** > Add three controls under "Voice input": `lang` (BCP-47 > tag, free text + a few presets), `hotkey` (single chord > capture), `disabled` (kill switch). Persist in > `~/.qwen/rc/web.yaml` per-client; defaults from > `design.md`. Acceptance: scenarios `Language preference
respected`, `Disabled hides MicButton`.

- [ ] **4.2 Docs**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Files:** `docs/operator/voice-input.md`
  - **Prompt:**
    > Operator-facing: what data goes to which vendor, how to
    > disable, why slash commands don't auto-execute, hotkey
    > recipe, future Whisper-WASM mention. Under 1000 words.

- [ ] **4.3 Archive change**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > Run `openspec archive add-voice-input`.

## Effort summary

| Phase     | Description              | Estimate (days) |
| --------- | ------------------------ | --------------- |
| 0         | Foundation               | 0.5             |
| 1         | Recognition pipeline     | 1.5             |
| 2         | Volume meter + UX        | 1               |
| 3         | Hotkey + slash + privacy | 1               |
| 4         | Polish + docs + archive  | 0.5             |
| **Total** |                          | **4.5**         |
