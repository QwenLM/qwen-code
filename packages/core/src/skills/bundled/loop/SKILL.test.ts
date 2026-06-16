/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const skillPath = join(dirname(fileURLToPath(import.meta.url)), 'SKILL.md');

function readSkill(): string {
  return readFileSync(skillPath, 'utf8');
}

describe('/loop bundled skill instructions', () => {
  it('documents fixed-interval scheduling forms', () => {
    const skill = readSkill();

    expect(skill).toContain('`5m /babysit-prs`');
    expect(skill).toContain('`check the deploy every 20m`');
    expect(skill).toContain('`run tests every 5 minutes`');
    expect(skill).toContain('`check the deploy`');
    expect(skill).toContain('interval is `10m`');
  });

  it('documents list and clear management forms', () => {
    const skill = readSkill();

    expect(skill).toContain('**`list`**');
    expect(skill).toContain('call CronList');
    expect(skill).toContain('**`clear`**');
    expect(skill).toContain('call CronDelete for every job returned');
  });

  it('keeps bare and interval-only input as usage-only for this slice', () => {
    const skill = readSkill();

    expect(skill).toContain('If the resulting prompt is empty');
    expect(skill).toContain('show usage `/loop [interval] <prompt>`');
    expect(skill).toContain('do not call CronCreate');
    expect(skill).toContain('`5m` → empty prompt → show usage');
  });

  it('advertises required prompt metadata while preserving current empty-prompt behavior', () => {
    const skill = readSkill();

    expect(skill).toContain(
      "argument-hint: '[interval] <prompt> | list | clear'",
    );
    expect(skill).toContain(
      'after stripping the `/loop` or `/proactive` prefix',
    );
    expect(skill).toContain('show usage `/loop [interval] <prompt>`');
  });
});
