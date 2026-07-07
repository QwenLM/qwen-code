/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { presubmitCommand } from './presubmit.js';

const {
  ghMock,
  ghApiMock,
  ghApiAllMock,
  currentUserMock,
  ensureAuthenticatedMock,
  readFileSyncMock,
  writeFileSyncMock,
  writeStdoutLineMock,
} = vi.hoisted(() => ({
  ghMock: vi.fn(),
  ghApiMock: vi.fn(),
  ghApiAllMock: vi.fn(),
  currentUserMock: vi.fn(),
  ensureAuthenticatedMock: vi.fn(),
  readFileSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  writeStdoutLineMock: vi.fn(),
}));

vi.mock('./lib/gh.js', () => ({
  gh: ghMock,
  ghApi: ghApiMock,
  ghApiAll: ghApiAllMock,
  currentUser: currentUserMock,
  ensureAuthenticated: ensureAuthenticatedMock,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const mock = {
    ...actual,
    readFileSync: readFileSyncMock,
    writeFileSync: writeFileSyncMock,
  };
  return { ...mock, default: mock };
});

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: writeStdoutLineMock,
}));

describe('presubmitCommand', () => {
  const baseArgs = {
    _: [],
    $0: 'qwen',
    pr_number: '6387',
    commit_sha: 'abc123',
    owner_repo: 'QwenLM/qwen-code',
    out_path: '/tmp/presubmit.json',
  };

  const originalGithubRunId = process.env['GITHUB_RUN_ID'];

  beforeEach(() => {
    vi.clearAllMocks();
    ensureAuthenticatedMock.mockReturnValue(undefined);
    currentUserMock.mockReturnValue('qwen-code-ci-bot');
    ghMock.mockReturnValue('contributor');
    ghApiAllMock.mockReturnValue([]);
    readFileSyncMock.mockReturnValue('[]');
    process.env['GITHUB_RUN_ID'] = '28788268483';
  });

  afterEach(() => {
    if (originalGithubRunId === undefined) {
      delete process.env['GITHUB_RUN_ID'];
    } else {
      process.env['GITHUB_RUN_ID'] = originalGithubRunId;
    }
  });

  it('ignores the running Qwen PR review check when deciding whether CI is still pending', async () => {
    ghApiMock.mockImplementation((path: string) => {
      if (path.endsWith('/check-runs')) {
        return {
          check_runs: [
            {
              name: 'Test (ubuntu-latest, Node 22.x)',
              status: 'completed',
              conclusion: 'success',
            },
            {
              name: 'review-pr',
              status: 'in_progress',
              conclusion: null,
              details_url:
                'https://github.com/QwenLM/qwen-code/actions/runs/28788268483/job/85362025778',
            },
          ],
        };
      }
      if (path.endsWith('/status')) {
        return { statuses: [] };
      }
      return null;
    });

    const handler = presubmitCommand.handler;
    if (!handler) throw new Error('presubmit handler missing');

    await handler(baseArgs as Parameters<typeof handler>[0]);

    const [, content] = writeFileSyncMock.mock.calls.find(
      ([path]) => path === '/tmp/presubmit.json',
    ) ?? [null, null];
    const result = JSON.parse(String(content));

    expect(result.ciStatus.class).toBe('all_pass');
    expect(result.downgradeApprove).toBe(false);
    expect(result.downgradeReasons).not.toContain('CI still running');
  });
});
