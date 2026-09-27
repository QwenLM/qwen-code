/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSkillContent } from '../../skill-load.js';

describe('bundled loop skill', () => {
  it('grants only scheduling tools', () => {
    const file = fileURLToPath(new URL('./SKILL.md', import.meta.url));
    const skill = parseSkillContent(fs.readFileSync(file, 'utf8'), file);
    expect(skill.allowedTools).toEqual([
      'cron_create',
      'cron_list',
      'cron_delete',
      'loop_wakeup',
    ]);
  });
});
