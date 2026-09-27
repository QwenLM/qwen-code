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
import {
  formatElapsed,
  statusReasonLabel,
  triggerLabel,
} from './agents-view-logic';
import { COLLAB_MESSAGES_EN, COLLAB_MESSAGES_ZH } from './messages';
import * as transcriptStub from './messages.transcript-stub';

const CLIENT_DIR = join(dirname(fileURLToPath(import.meta.url)), '../..');

describe('collaboration messages', () => {
  it('still reach the app through the main dictionary, in both languages', () => {
    expect(getTranslator('en')('collab.agent.new')).toBe('New agent');
    expect(getTranslator('zh-CN')('collab.agent.new')).toBe('新建 Agent');
    expect(
      getTranslator('zh-CN')('collab.run.queuedBehind', {
        agent: 'lead',
        count: 2,
      }),
    ).toBe('lead 排队中，前面还有 2 个');
  });

  it("translate the server's triggers, status reasons and durations", () => {
    // The server words triggers in English; a Chinese page showed them raw.
    const zh = getTranslator('zh-CN');
    expect(triggerLabel('mentioned by you', zh)).toBe('你 @ 了它');
    expect(triggerLabel('mentioned by lead', zh)).toBe('lead @ 了它');
    expect(triggerLabel('something new', zh)).toBe('something new');
    expect(formatElapsed(405_000, zh)).toBe('6 分 45 秒');
    // Status reasons: the live line comes in Chinese, the rest in English.
    const en = getTranslator('en');
    expect(statusReasonLabel('3 个智能体执行中，1 个排队中', en)).toBe(
      '3 working, 1 queued',
    );
    expect(statusReasonLabel('no outstanding close obligation', zh)).toBe(
      '没有待处理的事',
    );
  });

  it('hold only collab keys, translated one for one', () => {
    const en = Object.keys(COLLAB_MESSAGES_EN);
    expect(en.length).toBeGreaterThan(0);
    expect(en.every((key) => key.startsWith('collab.'))).toBe(true);
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
  });
});
