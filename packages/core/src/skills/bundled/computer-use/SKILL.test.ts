/**
 * @license
 * Copyright 2026 Qwen
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

describe('bundled computer-use skill', () => {
  it('adds no tool approval grants', () => {
    expect(loadSkill().allowedTools).toBeUndefined();
  });

  it('requires current observations and keeps uncertain actions from blind retry', () => {
    const { body } = loadSkill();
    expect(body).toContain('Only currently captured actionable IDs');
    expect(body).toContain(
      'Partial, unconfirmed or cancelled actions must not be blindly repeated',
    );
    expect(body).toContain('Observe state before');
    expect(body).toContain('ambiguous matches fail');
    expect(body).toContain('newer external clipboard change');
  });
});
