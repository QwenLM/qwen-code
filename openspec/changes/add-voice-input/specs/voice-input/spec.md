# voice-input — spec delta

## ADDED Requirements

### Requirement: Feature detection and graceful absence

The web client SHALL detect support for the Web Speech API via
`window.SpeechRecognition || window.webkitSpeechRecognition`. When
neither is present, the MicButton SHALL NOT be rendered, and the
settings panel SHALL display "Voice input: unavailable in this
browser" as informational text.

The web client SHALL NOT send audio to the daemon under any
circumstance. Audio capture SHALL terminate at the user agent.

#### Scenario: Feature detection in unsupported browser

- **GIVEN** the PWA is loaded in Firefox (no SpeechRecognition)
- **WHEN** the input bar renders
- **THEN** no MicButton is present
- **AND** no error or warning is shown to the user
- **AND** the settings panel notes voice input is unavailable

#### Scenario: MicButton hidden when unsupported

- **GIVEN** `isSupported()` returns false
- **AND** `settings.voice.disabled` is false
- **WHEN** the input bar renders
- **THEN** the MicButton is not in the DOM

#### Scenario: MicButton hidden when disabled

- **GIVEN** `isSupported()` returns true
- **AND** `settings.voice.disabled` is true
- **WHEN** the input bar renders
- **THEN** the MicButton is not in the DOM

### Requirement: Hold-to-talk recording lifecycle

The MicButton SHALL begin a recognition session on `pointerdown`
and end it on `pointerup` or `pointerleave`. While recording, the
input field SHALL display interim transcripts in a visually-
distinct (gray) style and replace them with the final transcript
on the `final` event.

If the input field already contained user-typed content, the
transcribed text SHALL append separated by a single space, never
overwrite.

Voice input SHALL NOT auto-submit. The user must explicitly press
Send (or the equivalent keyboard action) to send the prompt.

#### Scenario: Hold to talk captures partial then final

- **GIVEN** the MicButton is rendered
- **WHEN** the user presses and holds the button while speaking
  "hello world"
- **THEN** interim transcript text appears in the input bar in
  gray as the user speaks
- **AND** on release the gray text is replaced by the final
  transcript "hello world" in normal color
- **AND** the Send button is NOT auto-triggered

#### Scenario: Append on existing input

- **GIVEN** the input bar contains "summarize"
- **WHEN** the user holds the MicButton and says "the changes"
- **THEN** after release the input contains "summarize the
  changes" (single space separator)

#### Scenario: Pointer leave stops cleanly

- **GIVEN** a recording session is active
- **WHEN** the user's finger slides off the MicButton
- **THEN** the session stops
- **AND** any final-so-far transcript is preserved in the input

### Requirement: 60-second cap with warning

A single recording session SHALL NOT exceed 60 seconds. At 55
seconds elapsed, the UI SHALL display a "5s left" chip near the
MicButton. At 60 seconds, the session SHALL abort and emit a
`max-duration` error event. Any final transcript captured before
60 s SHALL remain in the input.

#### Scenario: 60-second cap fires with warning

- **GIVEN** the user has been holding the MicButton for 55s
- **THEN** a "5s left" chip is visible
- **WHEN** the recording reaches 60s
- **THEN** the session aborts
- **AND** a toast "Recording stopped at 60s limit" is shown
- **AND** any captured transcript remains in the input

### Requirement: Push-to-talk hotkey

The web client SHALL register a configurable push-to-talk hotkey.
Defaults:

- When the prompt input is NOT focused: hold `Space` for at least
  150 ms.
- When the prompt input IS focused: hold `Ctrl+Shift+M`.

The hotkey SHALL be configurable to a single chord via
`settings.voice.hotkey`. Brief presses (< 150 ms) SHALL NOT begin
recording.

#### Scenario: Hotkey holds start recording

- **GIVEN** the default hotkey is configured
- **AND** the prompt input is not focused
- **WHEN** the user holds `Space` for 300 ms
- **THEN** a recording session begins (MicButton visual changes
  to recording state)
- **AND** on release the transcript is inserted

#### Scenario: Brief tap does not start

- **WHEN** the user taps `Space` for 100 ms
- **THEN** no recording session begins
- **AND** the keypress is delivered to the page normally
  (e.g. scrolls)

### Requirement: Volume meter while recording

While a recording session is active, the web client SHALL display
a visual volume meter responding to input audio level at
approximately 30 frames per second. The meter SHALL use a
`getUserMedia({audio: true})` stream and the Web Audio API
(`AnalyserNode`) to compute an RMS normalized to 0..1.

When `getUserMedia` is denied, the meter SHALL display a "mic
blocked" indicator and the recognition session SHALL fail with
`permission-denied`.

#### Scenario: Volume meter responds to audio input

- **GIVEN** the user grants microphone permission
- **AND** a recording session is active
- **WHEN** the user speaks at conversational volume
- **THEN** the meter visual changes at ~30 fps reflecting
  input level

#### Scenario: Mic permission denied shows blocked state

- **GIVEN** the user has previously denied mic permission
- **WHEN** the user presses the MicButton
- **THEN** the MicButton transitions to an error visual
- **AND** a toast explains permission is denied with a path to
  re-enable in browser settings
- **AND** no recognition session begins

### Requirement: Slash command rendering, never auto-executed

When a final voice transcript begins with a string matching the
pattern `/<command-name>` where `<command-name>` is a recognized
slash command in the palette, the input bar SHALL render the
slash-command pill UI BUT SHALL NOT execute the command. The user
MUST press Send or otherwise explicitly submit for execution.

#### Scenario: Dictated slash command not executed

- **GIVEN** `/clear` is a recognized slash command
- **WHEN** the user dictates "slash clear" and Web Speech
  transcribes "/clear"
- **THEN** the input bar shows a `/clear` pill
- **AND** the command is NOT executed
- **AND** pressing Send executes the command

#### Scenario: Unrecognized slash sent as plain text

- **WHEN** the user dictates "slash notreal" producing
  "/notreal"
- **THEN** the input bar shows plain text "/notreal"
- **AND** pressing Send sends "/notreal" as a prompt to the agent

### Requirement: Privacy disclosure

The first time voice input is activated per origin, the web client
SHALL display a modal disclosure naming the vendor that will
receive audio (Google for Chromium/Edge, Apple for Safari) and
confirming the daemon does NOT receive audio. Dismissal SHALL be
persisted in
`localStorage["qwen-rc:voice-disclosure:<origin>"]`.

Whenever the MicButton is visible, a persistent pill labeled
"Voice: vendor-side" (or equivalent localized text) SHALL be
rendered adjacent to the MicButton. The pill SHALL NOT be
dismissable; tapping it SHALL re-open the disclosure modal.

When the disclosure text changes materially, the stored version
key SHALL be bumped so that the modal re-surfaces on next use.

#### Scenario: Privacy modal on first activation

- **GIVEN** no disclosure dismissal is stored for the current
  origin
- **WHEN** the user presses the MicButton for the first time
- **THEN** the disclosure modal appears
- **AND** recording does NOT begin until the user dismisses it
- **AND** dismissal persists in localStorage

#### Scenario: Pill always visible

- **GIVEN** the MicButton is rendered
- **WHEN** the input bar is visible
- **THEN** the "Voice: vendor-side" pill is also visible
- **AND** tapping it re-opens the disclosure modal

### Requirement: Language selection

The default recognition language SHALL be `navigator.language`.
Operators SHALL be able to override via `settings.voice.lang`
(BCP-47 tag). On an unsupported language, the recognition session
SHALL emit `language-not-supported` and the UI SHALL show a toast;
subsequent presses SHALL retry with the same setting.

#### Scenario: Language preference respected

- **GIVEN** `settings.voice.lang` is `fr-FR`
- **WHEN** the user holds the MicButton and speaks French
- **THEN** the session is started with `lang: "fr-FR"`
- **AND** the transcript is rendered in French characters

#### Scenario: Unsupported language errors gracefully

- **GIVEN** `settings.voice.lang` is `xx-YY`
- **WHEN** the user holds the MicButton
- **THEN** the recognition session emits a `language-not-
supported` error
- **AND** a toast informs the user
- **AND** no transcript is inserted

### Requirement: Accessibility

The MicButton state SHALL be announced via an `aria-live="polite"`
region: "Recording started" on start, "Transcript inserted:
<text>" on final, "Recording error: <reason>" on error.

The hotkey SHALL function independently of focus on the MicButton
so keyboard-only users have parity with pointer users.

#### Scenario: Screen reader announces recording state

- **GIVEN** a screen reader is active
- **WHEN** the user presses the MicButton
- **THEN** the screen reader announces "Recording started"
- **WHEN** the final transcript arrives
- **THEN** the screen reader announces "Transcript inserted:
  <text>"

#### Scenario: Keyboard hotkey works without focusing MicButton

- **GIVEN** focus is elsewhere on the page
- **WHEN** the user holds the configured hotkey
- **THEN** a recording session begins
- **AND** the MicButton visually reflects the recording state

### Requirement: Page visibility cleanup

If the page becomes hidden (`document.visibilityState ==
"hidden"`) during an active recording session, the web client
SHALL call `session.abort()`. Any final-so-far transcript SHALL
remain in the input.

#### Scenario: Visibility hidden aborts cleanly

- **GIVEN** a recording session is active
- **WHEN** the page is backgrounded or screen locks
- **THEN** the session is aborted
- **AND** no error toast is shown (this is expected, not an error)
- **AND** any final transcript already captured remains

### Requirement: No daemon audit visibility

The daemon SHALL NOT receive any indication that a prompt was
composed via voice input. No new audit fields, no new SSE events,
no header on the submitted prompt request.

#### Scenario: Voice-composed prompt indistinguishable in audit

- **GIVEN** the user composes a prompt via voice
- **AND** sends it
- **WHEN** the audit log entry for the prompt is queried
- **THEN** the entry contains the prompt text only, with no
  `inputMethod` or equivalent field

### Requirement: Native shell inheritance

Native shells from `add-native-mobile-shells` SHALL NOT require
bridge methods for voice input. The WebView's exposure of the Web
Speech API is the sole integration surface. Where the WebView
requires a platform manifest entry to access the microphone
(e.g., iOS `NSMicrophoneUsageDescription`, Android
`RECORD_AUDIO` permission), the shell SHALL include it.

#### Scenario: Voice works in Android TWA

- **GIVEN** the Android shell is configured with the required
  manifest microphone permission
- **WHEN** the user holds the MicButton in the TWA-hosted PWA
- **THEN** the recording session functions identically to the
  web case

#### Scenario: Voice works in iOS WKWebView

- **GIVEN** the iOS shell declares
  `NSMicrophoneUsageDescription` in Info.plist
- **WHEN** the user holds the MicButton in the WKWebView-hosted
  PWA
- **THEN** the OS prompts for mic permission on first use
- **AND** subsequent uses proceed without re-prompting
