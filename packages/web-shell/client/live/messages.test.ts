/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
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

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === 'e2e' || name === 'node_modules' ? [] : sourceFiles(path);
    }
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)
      ? [path]
      : [];
  });
}

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

  // The transcript build drops this module, and the transcript renderer is
  // inlined into every exported document under a byte budget. Both only hold
  // while Live strings live here and nothing else asks for them.
  it('are defined and used nowhere outside client/live', () => {
    const offenders = sourceFiles(CLIENT_DIR)
      .map((path) => ({
        path,
        segments: relative(CLIENT_DIR, path).split(sep),
      }))
      // By path segment, not by a '/'-prefixed string: `relative` returns
      // `live\messages.ts` on Windows and every Live file would be flagged.
      .filter(({ segments }) => segments[0] !== 'live')
      .filter(({ path }) => LIVE_KEY.test(readFileSync(path, 'utf8')))
      .map(({ segments }) => segments.join('/'));
    expect(offenders).toEqual([]);
  });
});
