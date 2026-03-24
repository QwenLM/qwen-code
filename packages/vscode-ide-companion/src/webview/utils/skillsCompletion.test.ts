/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { CompletionItem } from '../../types/completionItemTypes.js';
import {
  buildSkillCompletionItems,
  getSkillsSecondaryQuery,
  shouldOpenSkillsSecondaryPicker,
} from './skillsCompletion.js';

describe('skillsCompletion', () => {
  it('detects secondary /skills queries after a trailing space', () => {
    expect(getSkillsSecondaryQuery('skills ')).toBe('');
    expect(getSkillsSecondaryQuery('skills review')).toBe('review');
    expect(getSkillsSecondaryQuery('skills')).toBeNull();
    expect(getSkillsSecondaryQuery('summary')).toBeNull();
  });

  it('builds filtered completion items from skill names', () => {
    const items = buildSkillCompletionItems(
      ['code-review-expert', 'verification-pack'],
      'skills review',
    );

    expect(items).toEqual<CompletionItem[]>([
      {
        id: 'skill:code-review-expert',
        label: 'code-review-expert',
        type: 'command',
        group: 'Skills',
        value: 'skills code-review-expert',
      },
    ]);
  });

  it('marks /skills as requiring a secondary picker reopen', () => {
    expect(
      shouldOpenSkillsSecondaryPicker({
        id: 'skills',
        label: '/skills',
        type: 'command',
      }),
    ).toBe(true);
    expect(
      shouldOpenSkillsSecondaryPicker({
        id: 'summary',
        label: '/summary',
        type: 'command',
      }),
    ).toBe(false);
  });
});
