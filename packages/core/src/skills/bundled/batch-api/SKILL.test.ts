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

describe('bundled batch-api skill', () => {
  it('requires user invocation and grants only workspace reads', () => {
    const config = loadSkill();
    expect(config.disableModelInvocation).toBe(true);
    expect(config.allowedTools).toEqual(['glob', 'grep_search', 'read_file']);
  });

  it.each([
    [
      '"${QWEN_CODE_CLI:-qwen}" batch --help',
      '"${QWEN_CODE_CLI:-qwen}" batch check',
    ],
    ['## 0. Check readiness', '## 4. Submit through the executor'],
    ['--dry-run', '--expect <digest>'],
  ])('keeps %s before %s', (before, after) => {
    const { body } = loadSkill();
    const start = body.indexOf(before);
    expect(start).toBeGreaterThan(-1);
    expect(body.indexOf(after)).toBeGreaterThan(start);
  });

  it('keeps billed execution on the selected CLI without automatic retries', () => {
    const { body } = loadSkill();
    expect(body).toContain('"${QWEN_CODE_CLI:-qwen}" batch run');
    expect(body).toContain('Never fall back to doing the transform yourself');
    expect(body).toContain('Never retry automatically');
  });
});
