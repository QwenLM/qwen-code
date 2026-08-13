/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  ghMock,
  ensureAuthenticatedMock,
  writeStdoutLineMock,
  writeFileSyncMock,
  mkdirSyncMock,
} = vi.hoisted(() => ({
  ghMock: vi.fn(),
  ensureAuthenticatedMock: vi.fn(),
  writeStdoutLineMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
}));

vi.mock('./lib/gh.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    gh: ghMock,
    ensureAuthenticated: ensureAuthenticatedMock,
    setGhHost: vi.fn(),
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const mock = {
    ...actual,
    mkdirSync: mkdirSyncMock,
    writeFileSync: writeFileSyncMock,
  };
  return { ...mock, default: mock };
});

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: writeStdoutLineMock,
  writeStderrLineSafe: vi.fn(),
}));

import { runIssueContext } from './issue-context.js';

const ARGS = {
  prNumber: 9077,
  repo: 'QwenLM/qwen-code',
  out: '/tmp/issue-context.md',
  extraIssues: [],
};

function mockClosing(refs: unknown[]): void {
  ghMock.mockReturnValueOnce(JSON.stringify({ closingIssuesReferences: refs }));
}

describe('runIssueContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureAuthenticatedMock.mockReturnValue(undefined);
  });

  it('fetches each closing issue from its own repository and renders body + comments', () => {
    mockClosing([
      {
        number: 9078,
        title: 'the bug',
        url: 'https://github.com/QwenLM/qwen-code/issues/9078',
        repository: { name: 'qwen-code', owner: { login: 'QwenLM' } },
      },
    ]);
    ghMock.mockReturnValueOnce(
      JSON.stringify({
        title: 'the bug',
        body: 'repro steps',
        comments: [
          {
            author: { login: 'maintainer' },
            body: 'confirmed',
            createdAt: '2026-08-01',
          },
        ],
      }),
    );

    const result = runIssueContext(ARGS);

    expect(ghMock).toHaveBeenNthCalledWith(
      1,
      'pr',
      'view',
      '9077',
      '--repo',
      'QwenLM/qwen-code',
      '--json',
      'closingIssuesReferences',
    );
    expect(ghMock).toHaveBeenNthCalledWith(
      2,
      'issue',
      'view',
      '9078',
      '--repo',
      'QwenLM/qwen-code',
      '--json',
      'title,body,comments',
    );
    const written = writeFileSyncMock.mock.calls[0][1] as string;
    expect(written).toContain('untrusted user input');
    expect(written).toContain('## Issue #9078 of QwenLM/qwen-code: the bug');
    expect(written).toContain('repro steps');
    expect(written).toContain('**maintainer** (2026-08-01):');
    expect(written).toContain('confirmed');
    expect(result.closingIssues).toEqual([
      { number: 9078, ownerRepo: 'QwenLM/qwen-code', title: 'the bug' },
    ]);
    expect(result.outPath).toBe('/tmp/issue-context.md');
  });

  it('uses the reference repository, not the PR repo, for cross-repo issues', () => {
    mockClosing([
      {
        number: 42,
        title: 'elsewhere',
        url: '',
        repository: { name: 'other', owner: { login: 'acme' } },
      },
    ]);
    ghMock.mockReturnValueOnce(
      JSON.stringify({ title: 'elsewhere', body: '', comments: [] }),
    );

    runIssueContext(ARGS);

    expect(ghMock).toHaveBeenNthCalledWith(
      2,
      'issue',
      'view',
      '42',
      '--repo',
      'acme/other',
      '--json',
      'title,body,comments',
    );
  });

  it('writes an explicit empty-statement when no closing issues are linked', () => {
    mockClosing([]);
    const result = runIssueContext(ARGS);
    const written = writeFileSyncMock.mock.calls[0][1] as string;
    expect(written).toContain('No closing issues are linked');
    expect(result.closingIssues).toEqual([]);
  });

  it('fetches --issue extras from the PR repo, marks them as not-closing, and dedups closing numbers', () => {
    mockClosing([
      {
        number: 9078,
        title: 'closing one',
        url: '',
        repository: { name: 'qwen-code', owner: { login: 'QwenLM' } },
      },
    ]);
    ghMock.mockReturnValueOnce(
      JSON.stringify({ title: 'closing one', body: '', comments: [] }),
    );
    ghMock.mockReturnValueOnce(
      JSON.stringify({ title: 'referenced only', body: 'ev', comments: [] }),
    );

    runIssueContext({ ...ARGS, extraIssues: [555, 9078] });

    // 9078 is already in the closing set — only 555 is fetched on top.
    expect(ghMock).toHaveBeenCalledTimes(3);
    expect(ghMock).toHaveBeenNthCalledWith(
      3,
      'issue',
      'view',
      '555',
      '--repo',
      'QwenLM/qwen-code',
      '--json',
      'title,body,comments',
    );
    const written = writeFileSyncMock.mock.calls[0][1] as string;
    expect(written).toContain('Additionally fetched issues');
    expect(written).toContain(
      '## Issue #555 of QwenLM/qwen-code: referenced only',
    );
  });
});
