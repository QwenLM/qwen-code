// @vitest-environment jsdom
//
// Regression pin for the Android Chrome half of the attachment-chip deletion
// keys (issue #10794 follow-up). On Android Chrome the composer mounts the
// CodeMirror backend, which swallows the real Backspace keydown and
// re-dispatches a synthetic event carrying only `{key, keyCode}` — the
// repeat flag and every modifier are stripped, so the fallback's guards are
// undeliverable there and the fallback must stay platform-disabled
// (`isAndroidCodeMirrorComposer`). Without that gate, a held key drains
// every pasted chip (~30/s, no undo) and a single Ctrl+Backspace destroys
// one.
//
// The user-agent override must land before the imports below: CodeMirror
// samples it once at module load (`browser.android`) to pick this input
// path. Only the gate signal is pinned here on purpose — with the Android
// input path active, the React harness's commits become nondeterministic in
// jsdom (ingestion settles in ~2s to never), so an end-to-end scenario in
// this file would be flaky rather than guarding. The desktop behavior of
// every guard flag is pinned by useComposerCore.dom.test.tsx.
import { vi } from 'vitest';

vi.hoisted(() => {
  Object.defineProperty(window.navigator, 'userAgent', {
    value:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
    configurable: true,
  });
});

import { describe, expect, it } from 'vitest';
import { isAndroidCodeMirrorComposer } from './useComposerCore';

describe('useComposerCore attachment fallback on Android Chrome', () => {
  it('arms the platform gate under an Android Chrome user agent', () => {
    expect(isAndroidCodeMirrorComposer).toBe(true);
  });
});
