/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getTranslator } from '../../i18n';
import { formatElapsed } from './agents-view-logic';
import { COLLAB_MESSAGES_EN, COLLAB_MESSAGES_ZH } from './messages';
import * as transcriptStub from './messages.transcript-stub';

const CLIENT_DIR = join(dirname(fileURLToPath(import.meta.url)), '../..');

describe('collaboration messages', () => {
  it('still reach the app through the main dictionary, in both languages', () => {
    expect(getTranslator('en')('collab.agent.new')).toBe('New agent');
    expect(getTranslator('zh-CN')('collab.agent.new')).toBe('新建 Agent');
    expect(
      getTranslator('zh-CN')('collab.runtime.joinConnected', {
        server: 'https://coordinator:4170',
      }),
    ).toBe('这台电脑已作为 Runtime 加入 https://coordinator:4170。');
  });

  it("format durations in the reader's language", () => {
    expect(formatElapsed(405_000, getTranslator('zh-CN'))).toBe('6 分 45 秒');
    expect(formatElapsed(45_000, getTranslator('en'))).toBe('45s');
  });

  it('hold only workspace-agent keys, translated one for one', () => {
    const en = Object.keys(COLLAB_MESSAGES_EN);
    expect(en.length).toBeGreaterThan(0);
    expect(
      en.every(
        (key) =>
          key.startsWith('collab.') ||
          key.startsWith('toolName.thread_') ||
          key === 'agents.description',
      ),
    ).toBe(true);
    expect(Object.keys(COLLAB_MESSAGES_ZH).sort()).toEqual([...en].sort());
  });

  it('are replaced by a stub of the same shape in the transcript build', () => {
    expect(Object.keys(transcriptStub).sort()).toEqual([
      'COLLAB_MESSAGES_EN',
      'COLLAB_MESSAGES_ZH',
    ]);
    expect(transcriptStub.COLLAB_MESSAGES_EN).toEqual({});
    expect(transcriptStub.COLLAB_MESSAGES_ZH).toEqual({});
  });

  it('are defined only here, not back in the main dictionary', () => {
    // The transcript build embeds i18n.tsx; a collab key added there instead
    // of here would ship to every exported document.
    const dictionary = readFileSync(join(CLIENT_DIR, 'i18n.tsx'), 'utf8');
    expect(dictionary).not.toMatch(/^ {2}'collab\./m);
    expect(dictionary).not.toMatch(/^ {2}'toolName\.thread_/m);
    expect(dictionary).not.toMatch(/^ {2}'agents\.description'/m);
  });
});
