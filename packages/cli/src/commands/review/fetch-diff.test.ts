/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { ghMock, ensureAuthenticatedMock, writeFileSyncMock, mkdirSyncMock } =
  vi.hoisted(() => ({
    ghMock: vi.fn(),
    ensureAuthenticatedMock: vi.fn(),
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
  writeStdoutLine: vi.fn(),
  writeStderrLineSafe: vi.fn(),
}));

import { runFetchDiff } from './fetch-diff.js';

describe('runFetchDiff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureAuthenticatedMock.mockReturnValue(undefined);
  });

  it('writes the diff and reports its size', () => {
    ghMock.mockReturnValue('diff --git a/x b/x\n+one\n+two');
    const result = runFetchDiff({
      prNumber: 8981,
      repo: 'QwenLM/qwen-code',
      out: '/tmp/diff.txt',
    });
    expect(ghMock).toHaveBeenCalledWith(
      'pr',
      'diff',
      '8981',
      '--repo',
      'QwenLM/qwen-code',
    );
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      '/tmp/diff.txt',
      'diff --git a/x b/x\n+one\n+two\n',
    );
    expect(result).toEqual({
      diffPath: '/tmp/diff.txt',
      lines: 3,
      chars: 28,
    });
  });

  it('reports an empty diff as zero lines', () => {
    ghMock.mockReturnValue('');
    const result = runFetchDiff({
      prNumber: 1,
      repo: 'QwenLM/qwen-code',
      out: '/tmp/diff.txt',
    });
    expect(result.lines).toBe(0);
    expect(result.chars).toBe(0);
  });
});
