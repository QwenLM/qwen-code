/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSkillContent } from '../../skill-load.js';

describe('coordinate bundled skill', () => {
  it('keeps one homogeneous Leader-owned workflow', () => {
    const skillPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'SKILL.md',
    );
    const skill = parseSkillContent(
      fs.readFileSync(skillPath, 'utf8'),
      skillPath,
    );

    expect(skill.name).toBe('coordinate');
    expect(skill.disableModelInvocation).toBe(true);
    expect(skill.allowedTools).toBeUndefined();
    expect(skill.body).toContain('up to three');
    expect(skill.body).toContain('run_in_background: false');
    expect(skill.body).toContain('current Qwen model');
    expect(skill.body).toContain('implement the smallest correct change');
    expect(skill.body).not.toContain('coordinator-write');
  });
});
