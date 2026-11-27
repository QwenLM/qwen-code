/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { createAttachmentMessage } from '../factory.js';
import { createUserMessage } from '../../protocol/transcript/conversions.js';
import { estimateTextTokens } from '../../utils/tokenCalculation.js';
import { createSkillAttachmentIfNeeded } from './compact-generators.js';

const PER_SKILL_BUDGET_CHARS = 5_000 * 4;
const TOTAL_BUDGET_CHARS = 25_000 * 4;
const TRUNCATION_NOTICE =
  '[Skill content truncated during compaction recovery. Read the skill file if full instructions are needed.]';

describe('createSkillAttachmentIfNeeded', () => {
  it('sorts invoked skills by most recent invocation first', () => {
    const attachment = createSkillAttachmentIfNeeded([
      {
        name: 'older',
        path: '/skills/older/SKILL.md',
        content: 'older content',
        invokedAt: 1,
      },
      {
        name: 'newer',
        path: '/skills/newer/SKILL.md',
        content: 'newer content',
        invokedAt: 2,
      },
    ]);

    expect(attachment?.skills.map((skill) => skill.name)).toEqual([
      'newer',
      'older',
    ]);
  });

  it('marks per-skill truncation without exceeding the budget', () => {
    const attachment = createSkillAttachmentIfNeeded([
      {
        name: 'large-skill',
        path: '/skills/large/SKILL.md',
        content: 'x'.repeat(PER_SKILL_BUDGET_CHARS + 1_000),
        invokedAt: 1,
      },
    ]);

    const content = attachment?.skills[0]?.content ?? '';
    expect(content).toHaveLength(PER_SKILL_BUDGET_CHARS);
    expect(content.endsWith(`\n\n${TRUNCATION_NOTICE}`)).toBe(true);
  });

  it('keeps restored skill content within the total budget', () => {
    const attachment = createSkillAttachmentIfNeeded(
      Array.from({ length: 6 }, (_, index) => ({
        name: `skill-${index}`,
        path: `/skills/${index}/SKILL.md`,
        content: 'x'.repeat(PER_SKILL_BUDGET_CHARS + 1_000),
        invokedAt: index,
      })),
    );

    const totalChars =
      attachment?.skills.reduce(
        (total, skill) => total + skill.content.length,
        0,
      ) ?? 0;
    expect(attachment?.skills).toHaveLength(5);
    expect(totalChars).toBeLessThanOrEqual(TOTAL_BUDGET_CHARS);
  });

  it('skips a skill that cannot fit and restores an older, shorter one', () => {
    const records = [
      ['short', 400],
      ['skipped', 11_000],
      ['retained-body', 11_000],
      ...Array.from({ length: 5 }, (_, i) => [`recent-${i}`, 18_000] as const),
    ] as const;
    const invoked = records.map(([name, size], invokedAt) => ({
      name,
      path: name,
      content: name.padEnd(size, 'x'),
      invokedAt,
    }));
    const update = vi.fn();
    const retained = createUserMessage(invoked[2].content, { isMeta: true });
    const attachment = createSkillAttachmentIfNeeded(
      invoked,
      [retained],
      update,
    );
    expect(attachment?.skills.map((skill) => skill.name)).toEqual([
      'recent-4',
      'recent-3',
      'recent-2',
      'recent-1',
      'recent-0',
      'short',
    ]);
    expect(update.mock.calls).toEqual([['skipped', '']]);
  });

  it('keeps an exact fit and includes the notice in the weighted truncation budget', () => {
    const record = { name: 'mixed', path: '/mixed', invokedAt: 1 };
    // 3,000 Chinese characters use 3,000 estimated tokens, leaving 2,000 for ASCII.
    const exact = '中'.repeat(3_000) + 'a'.repeat(8_000);
    for (const content of [exact, exact + 'a']) {
      const restored = createSkillAttachmentIfNeeded([{ ...record, content }])!
        .skills[0].content;
      expect(estimateTextTokens(restored)).toBe(5_000);
      if (content === exact) {
        expect(restored).toBe(exact);
      } else {
        const suffix = `\n\n${TRUNCATION_NOTICE}`;
        expect(restored).toBe(exact.slice(0, -suffix.length) + suffix);
      }
    }
  });

  it('keeps an emoji intact when the remaining prefix budget fits only one UTF-16 unit', () => {
    const suffix = `\n\n${TRUNCATION_NOTICE}`;
    const head = 'a'.repeat(PER_SKILL_BUDGET_CHARS - suffix.length - 4);
    const attachment = createSkillAttachmentIfNeeded([
      {
        name: 'emoji',
        path: '/emoji',
        content: head + '😀'.repeat(100),
        invokedAt: 1,
      },
    ]);
    expect(attachment?.skills[0].content).toBe(head + suffix);
  });

  it('charges the total budget for Chinese bodies and continues past an oversized candidate', () => {
    const bodies = [
      ...Array<string>(4).fill('a'.repeat(PER_SKILL_BUDGET_CHARS)),
      '中'.repeat(3_900), // 3,900 tokens
      '文'.repeat(1_170), // 1,170 tokens exceed the remaining 1,100
      'x'.repeat(4_400), // exactly 1,100 tokens
    ];
    const invoked = bodies.map((content, i) => ({
      name: String(i),
      path: String(i),
      content,
      invokedAt: -i,
    }));
    const update = vi.fn();
    const restored = createSkillAttachmentIfNeeded(invoked, [], update)!.skills;
    expect(restored.map((s) => s.name)).toEqual(['0', '1', '2', '3', '4', '6']);
    expect(
      restored.reduce((sum, s) => sum + estimateTextTokens(s.content), 0),
    ).toBe(25_000);
    expect(update.mock.calls).toEqual([['5', '']]);
  });

  it('matches retained attachments by exact content and gives a retained invocation body precedence', () => {
    const content = 'first paragraph\n\nsecond paragraph';
    const record = { name: 'one', path: '/one', content, invokedAt: 1 };
    const reminder = createAttachmentMessage(
      createSkillAttachmentIfNeeded([record])!,
    );
    const alias = { ...record, name: 'two', path: '/two' };
    expect(createSkillAttachmentIfNeeded([alias], [reminder])).toBeNull();
    expect(
      createSkillAttachmentIfNeeded([{ ...alias, content: '' }]),
    ).toBeNull();
    const changed = { ...alias, content: content + '!' };
    expect(
      createSkillAttachmentIfNeeded([changed], [reminder])?.skills[0].content,
    ).toBe(changed.content);

    const body = createUserMessage(
      [
        { type: 'text', text: 'first paragraph' },
        { type: 'text', text: 'second paragraph' },
      ],
      { isMeta: true },
    );
    expect(
      createSkillAttachmentIfNeeded([alias], [body, reminder])?.skills[0].name,
    ).toBe('two');
  });
});
