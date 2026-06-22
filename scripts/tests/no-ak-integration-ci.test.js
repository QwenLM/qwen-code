/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');
const NO_AK_SCRIPT = 'test:integration:no-ak:sandbox:none';

describe('no-AK integration CI wiring', () => {
  it('defines a focused no-AK integration script', () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
    );

    expect(packageJson.scripts[NO_AK_SCRIPT]).toBe(
      [
        'cross-env QWEN_SANDBOX=false vitest run --root ./integration-tests',
        './fake-openai-server.test.ts',
        './cli/qwen-serve-routes.test.ts',
        './cli/qwen-serve-streaming.test.ts',
      ].join(' '),
    );
  });

  it('runs the no-AK integration script on pull requests without model secrets', () => {
    const workflow = readFileSync(
      path.join(ROOT, '.github/workflows/ci.yml'),
      'utf8',
    );
    const job = workflow.slice(
      workflow.indexOf('  integration_no_ak:'),
      workflow.indexOf('  integration_cli:'),
    );

    expect(job).toContain("name: 'Integration Tests (No-AK Smoke)'");
    expect(job).toContain("github.event_name == 'pull_request'");
    expect(job).toContain(`npm run ${NO_AK_SCRIPT}`);
    expect(job).not.toContain('secrets.OPENAI_API_KEY');
    expect(job).not.toContain('secrets.OPENAI_BASE_URL');
    expect(job).not.toContain('secrets.OPENAI_MODEL');
  });
});
