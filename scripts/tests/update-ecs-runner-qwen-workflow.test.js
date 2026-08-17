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

  it('runs only when this workflow changes on main', () => {
    expect(workflow).toContain(
      "  push:\n    branches: ['main']\n    paths: ['.github/workflows/update-ecs-runner-qwen.yml']",
    );
  });

  it('annotates a retry and a terminal failure distinctly', () => {
    // The final attempt must not log a "retrying" warning that never
    // retries; a sustained failure ends with an explicit exhausted error.
    expect(workflow).toContain(
      'echo "::warning::npm install attempt ${attempt} failed; retrying"',
    );
    expect(workflow).toContain(
      'echo "::error::npm install of @qwen-code/qwen-code@${VERSION} failed after 3 attempts"',
    );
    expect(workflow).toContain('for attempt in 1 2 3; do');
    expect(workflow).toContain('if [[ "${attempt}" -lt 3 ]]; then');
    expect(workflow).toContain('sudo rm -rf "${PKG_DIR}"/.qwen-code-*');
  });
});
