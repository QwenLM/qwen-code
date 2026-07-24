/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('ECS runner qwen update workflow', () => {
  const workflow = readFileSync(
    '.github/workflows/update-ecs-runner-qwen.yml',
    'utf8',
  );

  it('updates the npm prefix used by the selected runner', () => {
    expect(workflow).toContain('global_prefix="$(npm prefix -g)"');
    expect(workflow).toContain('if [[ -w "${global_prefix}" ]]');
    expect(workflow).toContain(
      'sudo env "NPM_CONFIG_PREFIX=${global_prefix}" npm install -g',
    );
    expect(workflow).toMatch(
      /if \[\[ -w "\$\{global_prefix\}" \]\][\s\S]*?then\s*\n\s*npm install -g/,
    );
  });
});
