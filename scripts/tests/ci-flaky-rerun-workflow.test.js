/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  '.github/workflows/qwen-ci-flaky-rerun.yml',
  'utf8',
);

describe('ci flaky rerun workflow', () => {
  it('runs every ten minutes and only needs PR/action write permissions', () => {
    expect(workflow).toContain("cron: '*/10 * * * *'");
    expect(workflow).toContain("pull-requests: 'write'");
    expect(workflow).toContain("actions: 'write'");
    expect(workflow).not.toContain("issues: 'write'");
    expect(workflow).not.toContain('scan-main');
    expect(workflow).not.toContain('update-branch');
  });

  it('delegates flaky judgment to the project skill', () => {
    expect(workflow).toContain('.qwen/skills/ci-flaky-patrol/SKILL.md');
    expect(workflow).toContain('ci-flaky-decision.json');
    expect(workflow).toContain(
      "OPENAI_API_KEY: '${{ secrets.OPENAI_API_KEY }}'",
    );
    expect(workflow).toContain('"read_file"');
    expect(workflow).toContain('"write_file"');
    expect(workflow).toContain('ci-flaky-rerun.mjs act');
  });
});
