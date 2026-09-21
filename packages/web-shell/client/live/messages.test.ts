/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getTranslator } from '../i18n';
import { LIVE_MESSAGES_EN, LIVE_MESSAGES_ZH } from './messages';
import * as transcriptStub from './messages.transcript-stub';

const CLIENT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIVE_PREFIXES = [
  'live.',
  'settings.liveSetup.',
  'settings.liveShortcut.',
];
const LIVE_KEY = /['"`](live\.|settings\.live(Setup|Shortcut)\.)/;

describe('Live Voice messages', () => {
  it('still reach the app through the main dictionary, in both languages', () => {
    expect(getTranslator('en')('live.browser.connect')).toBe(
      'Talk in this browser',
    );
    expect(getTranslator('zh-CN')('live.browser.connect')).toBe(
      '在此浏览器中通话',
    );
    expect(
      getTranslator('en')('live.shortcutHint', { shortcut: 'Command+E' }),
    ).toBe('Global shortcut: Command+E');
    expect(
      getTranslator('en')('live.browser.sharingNamed', { target: 'Terminal' }),
    ).toBe('Sharing Terminal. Qwen looks only when asked.');
    expect(
      getTranslator('zh-CN')('live.browser.sharingNamed', {
        target: 'Terminal',
      }),
    ).toBe('正在共享Terminal，Qwen 只在需要时查看。');
  });

  it('hold only Live keys, translated one for one', () => {
    const en = Object.keys(LIVE_MESSAGES_EN);
    expect(en.length).toBeGreaterThan(0);
    for (const key of en) {
      expect(LIVE_PREFIXES.some((prefix) => key.startsWith(prefix))).toBe(true);
    }
    expect(Object.keys(LIVE_MESSAGES_ZH).sort()).toEqual([...en].sort());
  });

  it('are replaced by a stub of the same shape in the transcript build', () => {
    expect(Object.keys(transcriptStub).sort()).toEqual([
      'LIVE_MESSAGES_EN',
      'LIVE_MESSAGES_ZH',
    ]);
    expect(transcriptStub.LIVE_MESSAGES_EN).toEqual({});
    expect(transcriptStub.LIVE_MESSAGES_ZH).toEqual({});
  });

  // The transcript build drops this module. Whether anything the transcript
  // renders asks for a Live string is a property of the built bundle, not of
  // the source tree — the composer's add menu opens Live Voice, and the
  // static import graph reaches the composer from the transcript entry even
  // though tree shaking removes it — so that half of the guard lives in
  // build-artifact.test.ts. This half keeps the strings from drifting back
  // into the dictionary the transcript does embed.
  it('are defined only here, not back in the main dictionary', () => {
    const dictionary = readFileSync(join(CLIENT_DIR, 'i18n.tsx'), 'utf8');
    expect(LIVE_KEY.test(dictionary)).toBe(false);
  });
});
