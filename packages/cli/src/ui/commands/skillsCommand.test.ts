/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect } from 'vitest';
import { skillsCommand } from './skillsCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { MessageType } from '../types.js';

interface FakeSkill {
  name: string;
  priority?: number;
}

function contextWithSkills(skills: FakeSkill[]): CommandContext {
  const skillManager = {
    listSkills: vi.fn().mockResolvedValue(skills),
  };
  return createMockCommandContext({
    services: {
      // Only getSkillManager is exercised by the list path.
      config: {
        getSkillManager: () => skillManager,
      } as never,
    },
  });
}

describe('skillsCommand display ordering', () => {
  it('sorts the /skills listing by priority desc, then name asc (unset/invalid treated as 0)', async () => {
    if (!skillsCommand.action) {
      throw new Error('skillsCommand must have an action.');
    }

    // listSkills() returns a stable name-asc order; the display layer is
    // responsible for the priority sort.
    const context = contextWithSkills([
      { name: 'alpha-unset' },
      { name: 'beta-unset' },
      { name: 'high', priority: 100 },
      { name: 'invalid', priority: 'nope' as unknown as number },
      { name: 'low', priority: -5 },
      { name: 'mid', priority: 10 },
    ]);

    await skillsCommand.action(context, '');

    expect(context.ui.addItem).toHaveBeenCalledWith(
      {
        type: MessageType.SKILLS_LIST,
        skills: [
          { name: 'high' },
          { name: 'mid' },
          { name: 'alpha-unset' },
          { name: 'beta-unset' },
          { name: 'invalid' },
          { name: 'low' },
        ],
      },
      expect.any(Number),
    );
  });
});
