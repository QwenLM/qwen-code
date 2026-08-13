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
  writeStderrLineSafeMock,
  writeFileSyncMock,
  mkdirSyncMock,
} = vi.hoisted(() => ({
  ghMock: vi.fn(),
  ensureAuthenticatedMock: vi.fn(),
  writeStdoutLineMock: vi.fn(),
  writeStderrLineSafeMock: vi.fn(),
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
  writeStderrLineSafe: writeStderrLineSafeMock,
}));

import { commentBodyCommand, runCommentBody } from './comment-body.js';

describe('runCommentBody', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureAuthenticatedMock.mockReturnValue(undefined);
  });

  it('fetches an inline comment body as raw text (no JSON.parse)', () => {
    // The body is markdown, not JSON — the seam is `gh`, and the mock returns
    // raw text precisely because that is what reaches JSON.parse nowhere.
    ghMock.mockReturnValue('**[Suggestion]** the inline body');
    const { body } = runCommentBody({
      id: 3773970278,
      kind: 'inline',
      repo: 'QwenLM/qwen-code',
    });
    expect(ghMock).toHaveBeenCalledWith(
      'api',
      'repos/QwenLM/qwen-code/pulls/comments/3773970278',
      '--jq',
      '.body // ""',
    );
    expect(body).toBe('**[Suggestion]** the inline body');
  });

  it('fetches an issue comment body', () => {
    ghMock.mockReturnValue('the issue body');
    runCommentBody({
      id: 5277891862,
      kind: 'issue',
      repo: 'QwenLM/qwen-code',
    });
    expect(ghMock).toHaveBeenCalledWith(
      'api',
      'repos/QwenLM/qwen-code/issues/comments/5277891862',
      '--jq',
      '.body // ""',
    );
  });

  it('addresses review bodies per-PR and refuses without one', () => {
    expect(() =>
      runCommentBody({ id: 1, kind: 'review', repo: 'QwenLM/qwen-code' }),
    ).toThrow(TypeError);
    ghMock.mockReturnValue('review body');
    runCommentBody({
      id: 99,
      kind: 'review',
      repo: 'QwenLM/qwen-code',
      prNumber: 9073,
    });
    expect(ghMock).toHaveBeenCalledWith(
      'api',
      'repos/QwenLM/qwen-code/pulls/9073/reviews/99',
      '--jq',
      '.body // ""',
    );
  });

  it('writes --out instead of returning the body inline', () => {
    ghMock.mockReturnValue('long tail');
    const result = runCommentBody({
      id: 1,
      kind: 'inline',
      repo: 'QwenLM/qwen-code',
      out: '/tmp/body.md',
    });
    expect(writeFileSyncMock).toHaveBeenCalledWith('/tmp/body.md', 'long tail');
    expect(result.outPath).toBe('/tmp/body.md');
  });
});

describe('commentBodyCommand handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureAuthenticatedMock.mockReturnValue(undefined);
    process.exitCode = undefined;
  });

  it('prints the body verbatim on stdout', () => {
    ghMock.mockReturnValue('the body');
    (commentBodyCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      id: 5,
      kind: 'inline',
      repo: 'QwenLM/qwen-code',
    });
    expect(writeStdoutLineMock).toHaveBeenCalledWith('the body');
    expect(process.exitCode).toBeUndefined();
  });

  it('exits 2 for --kind review without --pr', () => {
    (commentBodyCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      id: 5,
      kind: 'review',
      repo: 'QwenLM/qwen-code',
    });
    expect(process.exitCode).toBe(2);
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('exits 1 when the fetch fails', () => {
    ghMock.mockImplementation(() => {
      throw new Error('HTTP 404');
    });
    (commentBodyCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      id: 5,
      kind: 'inline',
      repo: 'QwenLM/qwen-code',
    });
    expect(process.exitCode).toBe(1);
    expect(writeStderrLineSafeMock).toHaveBeenCalled();
  });
});
