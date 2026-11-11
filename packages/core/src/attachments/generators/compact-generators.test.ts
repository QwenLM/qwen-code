/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
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
});
