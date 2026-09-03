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

function loadSkill() {
  const skillPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'SKILL.md',
  );
  return parseSkillContent(fs.readFileSync(skillPath, 'utf8'), skillPath);
}

describe('bundled workflow-creator skill', () => {
  it('targets saved Dynamic Workflow scripts instead of Task Flow YAML', () => {
    const { body } = loadSkill();

    expect(body).toContain('`.qwen/workflows/<name>.js`');
    expect(body).toContain(
      'Do not create or edit `qwen-workflow-design/*.yaml`',
    );
  });

  it('preserves the workflow sandbox execution contract', () => {
    const { body } = loadSkill();

    expect(body).toContain('export const meta = {');
    expect(body).toContain('`parallel([() => agent(...), () => agent(...)])`');
    expect(body).toContain('explicit `return` of the final result');
    expect(body).toContain('Do not use `node --check`');
  });
});
