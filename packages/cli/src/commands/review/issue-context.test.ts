/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dirname, resolve } from 'node:path';

const {
  ghMock,
  ensureAuthenticatedMock,
  setGhHostMock,
  writeStdoutLineMock,
  writeFileSyncMock,
  mkdirSyncMock,
} = vi.hoisted(() => ({
  ghMock: vi.fn(),
  ensureAuthenticatedMock: vi.fn(),
  setGhHostMock: vi.fn(),
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
    setGhHost: setGhHostMock,
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

import { issueContextCommand, runIssueContext } from './issue-context.js';

const ARGS = {
  prNumber: 9077,
  repo: 'QwenLM/qwen-code',
  out: '/tmp/issue-context.md',
  extraIssues: [],
};

function mockClosing(refs: unknown[]): void {
  ghMock.mockReturnValueOnce(JSON.stringify({ closingIssuesReferences: refs }));
}

function mockIssue(title: string, comments: unknown[] = []): void {
  ghMock.mockReturnValueOnce(JSON.stringify({ title, body: '', comments }));
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
    expect(mkdirSyncMock).toHaveBeenCalledWith(
      dirname(resolve('/tmp/issue-context.md')),
      { recursive: true },
    );
    expect(written).toContain('untrusted user input');
    expect(written).toContain('## Issue #9078 of QwenLM/qwen-code: the bug');
    expect(written).toContain('repro steps');
    expect(written).toContain('**maintainer** (2026-08-01):');
    expect(written).toContain('confirmed');
    // The placeholder never accompanies a rendered thread.
    expect(written).not.toContain('_(no comments)_');
    expect(result.closingIssues).toEqual([
      { number: 9078, ownerRepo: 'QwenLM/qwen-code', title: 'the bug' },
    ]);
    expect(result.unfetchable).toEqual([]);
    expect(result.outPath).toBe(resolve('/tmp/issue-context.md'));
  });

  it('uses the reference repository, not the PR repo, for cross-repo issues', () => {
    mockClosing([
      {
        number: 42,
        repository: { name: 'other', owner: { login: 'acme' } },
      },
    ]);
    mockIssue('elsewhere');

    const result = runIssueContext(ARGS);

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
    const written = writeFileSyncMock.mock.calls[0][1] as string;
    expect(written).toContain('_(no comments)_');
    expect(result.unfetchable).toEqual([]);
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
        repository: { name: 'qwen-code', owner: { login: 'QwenLM' } },
      },
    ]);
    mockIssue('closing one');
    mockIssue('referenced only');

    runIssueContext({ ...ARGS, extraIssues: [555, 9078] });

    // 9078 is already in the same-repo closing set — only 555 is fetched.
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

  it('a cross-repo closing number does not shadow a same-numbered extra', () => {
    mockClosing([
      {
        number: 42,
        repository: { name: 'other', owner: { login: 'acme' } },
      },
    ]);
    mockIssue('closing elsewhere');
    mockIssue('our own 42');

    runIssueContext({ ...ARGS, extraIssues: [42] });

    // The extra targets the PR repo's own #42 — a different issue from the
    // acme/other#42 closing ref, so both fetches must happen.
    expect(ghMock).toHaveBeenNthCalledWith(
      3,
      'issue',
      'view',
      '42',
      '--repo',
      'QwenLM/qwen-code',
      '--json',
      'title,body,comments',
    );
    const written = writeFileSyncMock.mock.calls[0][1] as string;
    expect(written).toContain('## Issue #42 of acme/other: closing elsewhere');
    expect(written).toContain('## Issue #42 of QwenLM/qwen-code: our own 42');
  });

  it('dedups repeated --issue values', () => {
    mockClosing([]);
    mockIssue('five');
    runIssueContext({ ...ARGS, extraIssues: [5, 5] });
    // one closing-issues call + exactly one issue fetch
    expect(ghMock).toHaveBeenCalledTimes(2);
  });

  it('an unreadable issue degrades to an explicit section, not an abort', () => {
    mockClosing([
      {
        number: 1,
        repository: { name: 'qwen-code', owner: { login: 'QwenLM' } },
      },
      {
        number: 2,
        repository: { name: 'restricted', owner: { login: 'acme' } },
      },
    ]);
    mockIssue('readable');
    ghMock.mockImplementationOnce(() => {
      throw new Error('HTTP 404: Not Found');
    });

    const result = runIssueContext(ARGS);

    const written = writeFileSyncMock.mock.calls[0][1] as string;
    expect(written).toContain('## Issue #1 of QwenLM/qwen-code: readable');
    expect(written).toContain(
      '## Issue #2 of acme/restricted — could not be fetched',
    );
    expect(written).toContain('HTTP 404');
    expect(result.closingIssues).toEqual([
      { number: 1, ownerRepo: 'QwenLM/qwen-code', title: 'readable' },
    ]);
    expect(result.unfetchable).toEqual([
      {
        number: 2,
        ownerRepo: 'acme/restricted',
        error: 'HTTP 404: Not Found',
      },
    ]);
  });

  it('surfaces the gh-version floor for closingIssuesReferences', () => {
    ghMock.mockImplementationOnce(() => {
      throw new Error(
        'Unknown JSON field: "closingIssuesReferences"\navailable fields: …',
      );
    });
    expect(() => runIssueContext(ARGS)).toThrow(/gh >= 2\.72\.0/);
  });
});

describe('issueContextCommand handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureAuthenticatedMock.mockReturnValue(undefined);
    process.exitCode = undefined;
  });

  it('threads --host to setGhHost before the first gh call', () => {
    mockClosing([]);
    (issueContextCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      pr_number: 1,
      repo: 'QwenLM/qwen-code',
      out: '/tmp/ic.md',
      host: 'ghe.example.com',
    });
    expect(setGhHostMock).toHaveBeenCalledWith('ghe.example.com');
    const ghOrder = ghMock.mock.invocationCallOrder[0];
    const hostOrder = setGhHostMock.mock.invocationCallOrder[0];
    expect(hostOrder).toBeLessThan(ghOrder);
  });

  it('exits 2 on a usage error (malformed --repo)', () => {
    (issueContextCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      pr_number: 1,
      repo: '../escape',
      out: '/tmp/ic.md',
    });
    expect(process.exitCode).toBe(2);
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('exits 1 when the closing-issue fetch fails', () => {
    ghMock.mockImplementationOnce(() => {
      throw new Error('HTTP 500');
    });
    (issueContextCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      pr_number: 1,
      repo: 'QwenLM/qwen-code',
      out: '/tmp/ic.md',
    });
    expect(process.exitCode).toBe(1);
  });
});
