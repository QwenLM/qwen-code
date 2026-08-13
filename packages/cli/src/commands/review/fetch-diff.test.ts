/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dirname, resolve } from 'node:path';

const {
  ghRawMock,
  ensureAuthenticatedMock,
  setGhHostMock,
  writeStdoutLineMock,
  writeFileSyncMock,
  mkdirSyncMock,
} = vi.hoisted(() => ({
  ghRawMock: vi.fn(),
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
    ghRaw: ghRawMock,
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

import { fetchDiffCommand, runFetchDiff } from './fetch-diff.js';

const OUT = '/tmp/diff.txt';

describe('runFetchDiff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureAuthenticatedMock.mockReturnValue(undefined);
  });

  it('writes the diff and reports its size', () => {
    ghRawMock.mockReturnValue('diff --git a/x b/x\n+one\n+two\n');
    const result = runFetchDiff({
      prNumber: 8981,
      repo: 'QwenLM/qwen-code',
      out: OUT,
    });
    expect(ghRawMock).toHaveBeenCalledWith(
      'pr',
      'diff',
      '8981',
      '--repo',
      'QwenLM/qwen-code',
    );
    expect(mkdirSyncMock).toHaveBeenCalledWith(dirname(resolve(OUT)), {
      recursive: true,
    });
    // resolve()d on both sides: a literal '/tmp/...' fails on Windows.
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      resolve(OUT),
      'diff --git a/x b/x\n+one\n+two\n',
    );
    expect(result).toEqual({
      diffPath: resolve(OUT),
      lines: 3,
      chars: 28,
    });
  });

  it('keeps a trailing whitespace-only context line (no trim)', () => {
    ghRawMock.mockReturnValue('diff --git a/x b/x\n@@ -1 +1 @@\n ctx\n   \n');
    runFetchDiff({ prNumber: 1, repo: 'QwenLM/qwen-code', out: OUT });
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      resolve(OUT),
      'diff --git a/x b/x\n@@ -1 +1 @@\n ctx\n   \n',
    );
  });

  it('reports an empty diff as zero lines', () => {
    ghRawMock.mockReturnValue('');
    const result = runFetchDiff({
      prNumber: 1,
      repo: 'QwenLM/qwen-code',
      out: OUT,
    });
    expect(result.lines).toBe(0);
    expect(result.chars).toBe(0);
  });
});

describe('fetchDiffCommand handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureAuthenticatedMock.mockReturnValue(undefined);
    process.exitCode = undefined;
  });

  it('prints the JSON result', () => {
    ghRawMock.mockReturnValue('d');
    (fetchDiffCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      pr_number: 1,
      repo: 'QwenLM/qwen-code',
      out: OUT,
    });
    expect(process.exitCode).toBeUndefined();
    expect(writeStdoutLineMock).toHaveBeenCalledWith(
      JSON.stringify({
        diffPath: resolve(OUT),
        lines: 1,
        chars: 1,
      }),
    );
  });

  it('threads --host to setGhHost before the first gh call', () => {
    ghRawMock.mockReturnValue('d');
    (fetchDiffCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      pr_number: 1,
      repo: 'QwenLM/qwen-code',
      out: OUT,
      host: 'ghe.example.com',
    });
    expect(setGhHostMock).toHaveBeenCalledWith('ghe.example.com');
    const ghOrder = ghRawMock.mock.invocationCallOrder[0];
    const authOrder = ensureAuthenticatedMock.mock.invocationCallOrder[0];
    const hostOrder = setGhHostMock.mock.invocationCallOrder[0];
    // ensureAuthenticated spawns the first real gh process (`gh auth
    // status`), so the ordering must hold against it too, not just the
    // data call.
    expect(hostOrder).toBeLessThan(Math.min(authOrder, ghOrder));
  });

  it('exits 1 when the fetch fails', () => {
    ghRawMock.mockImplementation(() => {
      throw new Error('HTTP 404');
    });
    (fetchDiffCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      pr_number: 1,
      repo: 'QwenLM/qwen-code',
      out: OUT,
    });
    expect(process.exitCode).toBe(1);
  });

  it('exits 2 on a usage error (malformed --repo)', () => {
    (fetchDiffCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      pr_number: 1,
      repo: '../escape',
      out: OUT,
    });
    expect(process.exitCode).toBe(2);
    expect(ghRawMock).not.toHaveBeenCalled();
  });
});
