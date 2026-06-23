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

function getWorkflowJob(workflow, jobName) {
  const marker = `  ${jobName}:`;
  const start = workflow.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);

  const afterMarker = workflow.slice(start + marker.length);
  const nextJob = afterMarker.match(/\n {2}[a-zA-Z0-9_-]+:\n/);

  return workflow.slice(
    start,
    nextJob ? start + marker.length + nextJob.index : undefined,
  );
}

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

  it('runs the no-AK integration script in the Ubuntu gate only', () => {
    const workflow = readFileSync(
      path.join(ROOT, '.github/workflows/ci.yml'),
      'utf8',
    );
    const ubuntuJob = getWorkflowJob(workflow, 'test');
    const platformJob = getWorkflowJob(workflow, 'test_platforms');

    expect(workflow).not.toContain('  integration_no_ak:');
    expect(workflow.split(`npm run ${NO_AK_SCRIPT}`).length - 1).toBe(1);

    expect(ubuntuJob).toContain("name: 'Run no-AK integration smoke tests'");
    expect(ubuntuJob).toContain("github.event_name == 'pull_request'");
    expect(ubuntuJob).toContain(`npm run ${NO_AK_SCRIPT}`);
    expect(ubuntuJob).not.toContain('secrets.OPENAI_API_KEY');
    expect(ubuntuJob).not.toContain('secrets.OPENAI_BASE_URL');
    expect(ubuntuJob).not.toContain('secrets.OPENAI_MODEL');

    expect(platformJob).not.toContain(NO_AK_SCRIPT);
  });

  it('refreshes and verifies the Ubuntu self-hosted PR refs', () => {
    const workflow = readFileSync(
      path.join(ROOT, '.github/workflows/ci.yml'),
      'utf8',
    );
    const ubuntuJob = getWorkflowJob(workflow, 'test');

    expect(ubuntuJob).toContain(
      "name: 'Refresh PR refs after cached checkout'",
    );
    expect(ubuntuJob).toContain('https://github.com:443/');
    expect(ubuntuJob).toContain('git fetch --no-tags "${github_url}"');
    expect(ubuntuJob).toContain('"+${GITHUB_REF}:${merge_ref}"');
    expect(ubuntuJob).toContain('git checkout --force "${merge_ref}"');
    expect(ubuntuJob).toContain(
      "name: 'Verify PR checkout includes head commit'",
    );
    expect(ubuntuJob).toContain('git merge-base --is-ancestor');
    expect(ubuntuJob).toContain('github.event.pull_request.head.sha');
  });
});
