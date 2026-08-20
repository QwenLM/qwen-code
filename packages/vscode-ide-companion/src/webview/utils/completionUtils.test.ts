/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { CompletionItem } from '../../types/completionItemTypes.js';
import {
  isSkillsSecondaryQuery,
  resolveCompletionTrigger,
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

  describe('resolveCompletionTrigger', () => {
    const at = (text: string) => resolveCompletionTrigger(text, text.length);

    it('falls back to a valid / when the last @ is inside a word (e.g. email)', () => {
      // Regression: a non-boundary @ (inside "foo@bar.com") must not suppress
      // the slash-command menu for a later, valid / trigger.
      const text = 'contact foo@bar.com /he';
      expect(at(text)).toEqual({ char: '/', pos: 20, query: 'he' });
    });

    it('keeps a / that is part of an @ mention path inside the mention', () => {
      // The @ is at a word boundary, so it wins and the path-like / is not
      // treated as a slash command.
      expect(at('@src/components/Bu')).toEqual({
        char: '@',
        pos: 0,
        query: 'src/components/Bu',
      });
    });

    it('resolves an @ mention after a space', () => {
      expect(at('hello @wor')).toEqual({ char: '@', pos: 6, query: 'wor' });
    });

    it('treats a newline as a word boundary for @', () => {
      expect(at('hello\n@wor')).toEqual({ char: '@', pos: 6, query: 'wor' });
    });

    it('resolves a / slash command at the start of input', () => {
      expect(at('/he')).toEqual({ char: '/', pos: 0, query: 'he' });
    });

    it('returns null when the only @ is inside a word and there is no /', () => {
      expect(at('email foo@bar.com')).toBeNull();
    });

    it('returns null when / is not at a word boundary and no valid @ exists', () => {
      expect(at('foo/bar')).toBeNull();
    });

    it('returns null when neither trigger is present', () => {
      expect(at('just some text')).toBeNull();
    });

    it('resolves the trigger relative to the cursor, ignoring text after it', () => {
      // Cursor sits right after "/he" in "/help world".
      expect(resolveCompletionTrigger('/help world', 3)).toEqual({
        char: '/',
        pos: 0,
        query: 'he',
      });
    });

    it('gives @ priority over / when both are at word boundaries', () => {
      // Both triggers are valid (/ at pos 0, @ after a space); @ wins by design.
      expect(at('/cmd @user')).toEqual({ char: '@', pos: 5, query: 'user' });
    });
  });
});
