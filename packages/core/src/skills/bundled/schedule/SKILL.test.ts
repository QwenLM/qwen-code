/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSkillContent } from '../../skill-load.js';

function loadScheduleSkill() {
  const skillPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'SKILL.md',
  );
  const content = fs.readFileSync(skillPath, 'utf8');
  const config = parseSkillContent(content, skillPath);
  return { config, body: config.body };
}

describe('bundled schedule skill', () => {
  it('is named schedule and allows the four schedule tools', () => {
    const { config } = loadScheduleSkill();
    expect(config.name).toBe('schedule');
    expect(config.allowedTools).toEqual([
      'schedule_create',
      'schedule_list',
      'schedule_run',
      'schedule_delete',
    ]);
  });

  it('documents the deterministic subcommands', () => {
    const { body } = loadScheduleSkill();
    expect(body).toContain('**`list`**');
    expect(body).toContain('**`run <id>`**');
    expect(body).toContain('**`delete <id>`**');
    expect(body).toContain('ScheduleCreate');
  });

  it('tells the model prompts must be self-contained and to start the daemon', () => {
    const { body } = loadScheduleSkill();
    expect(body).toContain('self-contained');
    expect(body).toContain('qwen schedule daemon');
  });
});
