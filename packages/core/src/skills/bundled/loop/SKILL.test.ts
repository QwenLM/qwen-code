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

function loadLoopSkill() {
  const skillPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'SKILL.md',
  );
  const content = fs.readFileSync(skillPath, 'utf8');
  const config = parseSkillContent(content, skillPath);
  return { config, body: config.body };
}

describe('bundled loop skill', () => {
  it('allows both cron tools and the loop wakeup primitive', () => {
    const { config } = loadLoopSkill();

    expect(config.allowedTools).toEqual([
      'cron_create',
      'cron_list',
      'cron_delete',
      'loop_wakeup',
    ]);
  });

  it('documents prompt-only input as self-paced and non-recurring', () => {
    const { body } = loadLoopSkill();

    expect(body).toContain('## Prompt-only self-paced path');
    expect(body).toContain('Do not call CronCreate for this path.');
    expect(body).toContain('Run the parsed prompt immediately now.');
    expect(body).toContain(
      'Call LoopWakeup only if continued follow-up is useful.',
    );
    expect(body).toContain('`prompt`: `/loop ${original prompt}`');
    // Drives the second-resolution wakeup engine — seconds, not minutes.
    expect(body).toContain('`delaySeconds`');
    expect(body).not.toContain('delayMinutes');
  });

  it('keeps fixed-interval inputs on the recurring cron path', () => {
    const { body } = loadLoopSkill();

    expect(body).toContain('## Fixed-interval recurring path');
    expect(body).toContain('Leading interval token');
    expect(body).toContain('Trailing "every" clause');
    expect(body).toContain('Call CronCreate with:');
    expect(body).toContain('recurring`: `true`');
  });

  it('keeps list and clear as management subcommands', () => {
    const { body } = loadLoopSkill();

    expect(body).toContain('**`list`** — call CronList');
    expect(body).toContain('**`clear`** — call CronList');
    expect(body).toContain('call CronDelete for every job returned');
  });
});
