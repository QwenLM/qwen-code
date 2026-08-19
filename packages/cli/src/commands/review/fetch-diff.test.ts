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
    // assertWritableOutPath must not consult AMBIENT filesystem state through
    // the partial mock: a stray directory at the shared /tmp path would fail
    // the suite for a reason invisible in the repo.
    existsSync: () => false,
    statSync: () => {
      throw new Error('statSync: path does not exist (mocked)');
    },
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
    // latin1 write preserves ghRaw's byte fidelity (Latin-1/Shift-JIS diffs).
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      resolve(OUT),
      'diff --git a/x b/x\n+one\n+two\n',
      'latin1',
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
      'latin1',
    );
  });

  it('reports an empty diff as zero lines and writes a 0-byte file', () => {
    ghRawMock.mockReturnValue('');
    const result = runFetchDiff({
      prNumber: 1,
      repo: 'QwenLM/qwen-code',
      out: OUT,
    });
    expect(result.lines).toBe(0);
    expect(result.chars).toBe(0);
    // Never '\n': plan-diff parses a one-blank-line file as 1 line with zero
    // files and dies with a coverage error instead of the empty-plan branch.
    expect(writeFileSyncMock).toHaveBeenCalledWith(resolve(OUT), '', 'latin1');
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
    expect(setGhHostMock).toHaveBeenCalledWith(undefined);
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
    // The other half of the invariant (#9194): the data fetch must not
    // precede authentication — a gh call that beats `gh auth status` races
    // the very credential it depends on.
    expect(authOrder).toBeLessThan(ghOrder);
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
    // The usage error must preempt the auth gate — `gh auth login` can
    // never repair the invocation.
    expect(ensureAuthenticatedMock).not.toHaveBeenCalled();
  });

  it('exits 2 on a non-positive or non-integer pr_number, without calling gh or auth', () => {
    (fetchDiffCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      pr_number: 0,
      repo: 'QwenLM/qwen-code',
      out: OUT,
    });
    expect(process.exitCode).toBe(2);
    // Reset so the second assertion verifies the guard assigns the code,
    // not that it rides the first invocation's residue.
    process.exitCode = undefined;
    (fetchDiffCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      pr_number: 1.5,
      repo: 'QwenLM/qwen-code',
      out: OUT,
    });
    expect(process.exitCode).toBe(2);
    expect(ghRawMock).not.toHaveBeenCalled();
    expect(ensureAuthenticatedMock).not.toHaveBeenCalled();
  });

  it('exits 2 on an empty --out (classified before any fetch)', () => {
    (fetchDiffCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      pr_number: 1,
      repo: 'QwenLM/qwen-code',
      out: '',
    });
    expect(process.exitCode).toBe(2);
    expect(ghRawMock).not.toHaveBeenCalled();
    expect(ensureAuthenticatedMock).not.toHaveBeenCalled();
  });

  it('exits 2 on a whitespace-only --out', () => {
    (fetchDiffCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      pr_number: 1,
      repo: 'QwenLM/qwen-code',
      out: ' ',
    });
    expect(process.exitCode).toBe(2);
    expect(ghRawMock).not.toHaveBeenCalled();
    expect(ensureAuthenticatedMock).not.toHaveBeenCalled();
  });

  it('exits 2 on a malformed --host (setGhHost TypeError → usage class)', () => {
    setGhHostMock.mockImplementationOnce(() => {
      throw new TypeError('--host must be a hostname');
    });
    (fetchDiffCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      pr_number: 1,
      repo: 'QwenLM/qwen-code',
      out: OUT,
      host: 'bad host; rm -rf /',
    });
    expect(process.exitCode).toBe(2);
    expect(ghRawMock).not.toHaveBeenCalled();
    expect(ensureAuthenticatedMock).not.toHaveBeenCalled();
  });
});
