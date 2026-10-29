# Web Shell voice feedback

[English](web-shell-voice-feedback.md) | [简体中文](web-shell-voice-feedback.zh-CN.md)

## Problem and scope

The composer dictation button translates its operation labels, but displays
browser and daemon errors verbatim in English. Its feedback bubble cannot be
dismissed, leaving the microphone red until another recording starts. The
no-speech notice stores already translated text, so it cannot follow a language
change while visible.

This change covers composer dictation feedback in English and Simplified
Chinese. Live Voice, daemon protocols, workspace routing, recording limits and
provider behavior are outside its scope.

## Proposed behavior

Translate errors at the Web Shell presentation boundary. A small voice error
formatter maps existing browser/daemon messages to translation keys. Recognize
the sample-rate and connection-close templates, translate known close reasons,
and preserve numeric diagnostics. Unknown exceptions and close reasons use
localized generic feedback instead of displaying untranslated technical text.
The transport retains the original errors and its existing callbacks.

Use the same translated error in the bubble, microphone tooltip and accessible
retry label. Keep the no-speech notice as state rather than translated text so
all feedback follows the current language at render time.

Add a shared Button with a localized accessible name and an X icon at the upper
right of error and no-speech bubbles. Make the bubble interactive and reserve
space for the button without covering or truncating its message. Clicking or
keyboard-activating close clears the notice and resets an error capture through
the existing abort operation, restoring the normal microphone. It neither
starts recording nor inserts text. A later error must appear again. Live interim
transcripts remain recording content and do not receive the feedback close
button.

## Implementation and decisions

- `client/voice/voice-error.ts` maps the existing transport vocabulary; its
  collocated tests cover all explicit errors, dynamic templates and unknowns.
- `client/voice/messages.ts` supplies paired English/Chinese messages, merged
  into the shared translator by `client/i18n.tsx`.
- `client/voice/VoiceButton.tsx` renders translations and handles dismissal;
  `VoiceButton.module.css` retains the existing scoped styling and adds only
  feedback layout and close-button styling.
- Component tests and a browser E2E test cover both languages, dismissal, retry
  and no-speech behavior using the existing mock daemon.

Presentation mapping keeps older daemons compatible and avoids a cross-package
protocol change for a UI improvement. New daemon wording will use the generic
localized fallback until explicitly mapped. Dismissal does not resolve the
underlying configuration or permission problem; another attempt may fail again.

Dictation is an interactive composer surface. Its dictionary follows the existing
transcript-only empty-stub mechanism so exported read-only transcripts do not
carry unused dictation strings. Artifact tests guard both their absence from the
transcript entry and their presence in the interactive entry, while preserving
the existing transcript size budget.

## Validation and acceptance

1. Every explicit dictation error has English and Chinese feedback; dynamic
   browser errors never leak untranslated strings into Chinese UI.
2. Bubble, tooltip and accessible retry label agree, including after a language
   change while feedback is visible.
3. Close is visible, keyboard accessible and usable on narrow screens. Error
   dismissal removes the bubble and red state; no-speech dismissal clears the
   notice; retry still works and can show a fresh error.
4. Recording, interim transcripts, final insertion and workspace isolation
   retain their existing behavior.
5. Focused tests, build, typecheck and browser E2E pass. Automated browser tests
   simulate microphone/daemon responses; supplemental no-model verification may
   use a real local daemon. Neither proves real ASR operation.
6. The transcript build excludes dictation translation keys and stays within
   its existing size budget; the interactive build retains both languages.

## Open questions

None.
