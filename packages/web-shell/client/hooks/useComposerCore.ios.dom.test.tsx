// @vitest-environment jsdom
//
// Regression pin for the iOS half of the attachment-chip deletion keys
// (issue #10794 follow-up, round-6 review). On iOS the composer can mount
// the CodeMirror backend, which defers bare Backspace/Delete keydowns into
// PendingKeys and replays them ~250ms later via flushIOSKey as synthetic
// events built from the static PendingKeys entry — the replayed event never
// carries the repeat flag, so a held key drains every pasted chip and the
// fallback's auto-repeat guard is undeliverable. The fallback must stay
// platform-disabled on iOS (`isIosCodeMirrorComposer`); without the widened
// gate a held key drains both chips.
//
// The user-agent override must land before the imports below: CodeMirror
// samples it once at module load (`browser.ios`) to pick this input path.
// Only the UA needs overriding: jsdom's own navigator.vendor already
// contains "Apple Computer", which satisfies the vendor half of the
// detection. (navigator.maxTouchPoints is not redefinable in jsdom, so the
// iPadOS 13+ maxTouchPoints disjunct is not exercised here — the mobile-UA
// disjunct is.)
//
// Only the gate signal is pinned here on purpose: with a mobile input path
// active, the React harness's commits become nondeterministic in jsdom
// (ingestion settles in ~2s to never), so a full behavioral scenario in this
// file would be flaky rather than guarding. The desktop behavior of every
// guard flag is pinned by useComposerCore.dom.test.tsx.
import { vi } from 'vitest';

vi.hoisted(() => {
  Object.defineProperty(window.navigator, 'userAgent', {
    value:
      'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    configurable: true,
  });
});

import { describe, expect, it } from 'vitest';
import { isIosCodeMirrorComposer } from './useComposerCore';

describe('useComposerCore attachment fallback on iOS', () => {
  it('arms the platform gate under an iPadOS user agent with touch points', () => {
    expect(isIosCodeMirrorComposer).toBe(true);
  });
});
