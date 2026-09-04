/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const updateDependencyAuditIssue = require('../../.github/scripts/update-dependency-audit-issue.cjs');

describe('update dependency audit issue', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('creates, updates, and closes the deduplicated tracking issue', async () => {
    vi.stubEnv('GITHUB_SERVER_URL', 'https://github.com');
    vi.stubEnv('GITHUB_REPOSITORY', 'QwenLM/qwen-code');
    vi.stubEnv('GITHUB_RUN_ID', '123');

    const api = {
      listForRepo: vi.fn(),
      createComment: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    };
    const github = {
      paginate: vi.fn(),
      rest: { issues: api },
    };
    const context = {
      repo: { owner: 'QwenLM', repo: 'qwen-code' },
      runId: 123,
    };

    vi.stubEnv('AUDIT_RESULT', 'failure');
    github.paginate.mockResolvedValueOnce([]);
    await updateDependencyAuditIssue({ github, context });
    expect(api.create).toHaveBeenCalledOnce();
    expect(api.create.mock.calls[0][0]).toMatchObject({
      title: 'Daily dependency CVE audit failed',
      labels: ['scope/ci-cd', 'status/needs-triage'],
    });

    const issue = {
      number: 42,
      body: '<!-- qwen-dependency-cve-audit-failure -->',
    };
    github.paginate.mockResolvedValueOnce([issue]);
    await updateDependencyAuditIssue({ github, context });
    expect(api.createComment).toHaveBeenLastCalledWith(
      expect.objectContaining({ issue_number: 42 }),
    );

    vi.stubEnv('AUDIT_RESULT', 'success');
    github.paginate.mockResolvedValueOnce([issue]);
    await updateDependencyAuditIssue({ github, context });
    expect(api.update).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 42, state: 'closed' }),
    );
  });
});
