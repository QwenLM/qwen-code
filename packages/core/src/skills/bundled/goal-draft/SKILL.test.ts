/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSkillContent } from '../../skill-load.js';

const loadSkill = () => {
  const file = fileURLToPath(new URL('./SKILL.md', import.meta.url));
  return parseSkillContent(fs.readFileSync(file, 'utf8'), file);
};

describe('bundled goal-draft skill', () => {
  it('grants only Goal and workspace reads', () => {
    expect(loadSkill().allowedTools).toEqual([
      'get_goal',
      'read_file',
      'glob',
      'grep_search',
    ]);
  });

  it('keeps drafting separate from approving and starting the task', () => {
    const { body } = loadSkill();
    const upFront = body.indexOf(
      'You are NOT doing the work the goal describes.',
    );
    expect(upFront).toBeGreaterThanOrEqual(0);
    expect(body.indexOf('## Step 0')).toBeGreaterThan(upFront);
    expect(body).toContain('only their approval sets the Goal');
    expect(body).toContain(
      'do not propose the same or a reworded objective again',
    );
    expect(body).toContain(
      'do not audit the implementation, reproduce failures, run builds or tests, install dependencies, or start services',
    );
    expect(body).toContain('Irreversible actions (push, delete, publish)');
    expect(body.trimEnd().split('\n').pop()).toBe(
      'Do not run /goal yourself. Do not begin the task. Stop and wait for the user.',
    );
  });
});
