/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { CompletionItem } from '../../types/completionItemTypes.js';
import {
  isSkillsSecondaryQuery,
  shouldOpenSkillsSecondaryPicker,
} from './completionUtils.js';

const skillsCommandItem: CompletionItem = {
  id: 'skills',
  label: '/skills',
  type: 'command',
  value: 'skills',
};

describe('completionUtils', () => {
  describe('isSkillsSecondaryQuery', () => {
    it('matches /skills subqueries with trailing space', () => {
      expect(isSkillsSecondaryQuery('skills ')).toBe(true);
      expect(isSkillsSecondaryQuery('skills review')).toBe(true);
      expect(isSkillsSecondaryQuery('skills code review')).toBe(true);
    });

    it('does not treat bare /skills as a secondary query', () => {
      expect(isSkillsSecondaryQuery('skills')).toBe(false);
      expect(isSkillsSecondaryQuery('compress')).toBe(false);
    });
  });

  describe('shouldOpenSkillsSecondaryPicker', () => {
    it('opens the secondary picker only when skills are available', () => {
      expect(
        shouldOpenSkillsSecondaryPicker(skillsCommandItem, ['review', 'test']),
      ).toBe(true);
      expect(shouldOpenSkillsSecondaryPicker(skillsCommandItem, [])).toBe(
        false,
      );
    });

    it('does not open for non-/skills commands', () => {
      expect(
        shouldOpenSkillsSecondaryPicker(
          {
            id: 'compress',
            label: '/compress',
            type: 'command',
            value: 'compress',
          },
          ['review'],
        ),
      ).toBe(false);
    });
  });
});
