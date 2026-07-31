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

  it('installs without the selected runner npm prefix', () => {
    expect(workflow).toContain('cd "${RUNNER_TEMP:?}"');
    expect(workflow).toContain('sudo env -u NPM_CONFIG_PREFIX npm install -g');
  });
});
