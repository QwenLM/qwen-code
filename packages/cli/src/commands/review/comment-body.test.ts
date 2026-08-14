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
  writeStderrLineSafeMock,
  writeFileSyncMock,
  mkdirSyncMock,
} = vi.hoisted(() => ({
  ghRawMock: vi.fn(),
  ensureAuthenticatedMock: vi.fn(),
  setGhHostMock: vi.fn(),
  writeStdoutLineMock: vi.fn(),
  writeStderrLineSafeMock: vi.fn(),
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
  writeStderrLineSafe: writeStderrLineSafeMock,
}));

import { commentBodyCommand, runCommentBody } from './comment-body.js';

describe('runCommentBody', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureAuthenticatedMock.mockReturnValue(undefined);
  });

  it('fetches an inline comment body as raw text (no JSON.parse)', () => {
    // The body is markdown, not JSON — the seam is `ghRaw`, and the mock
    // returns raw text precisely because that is what reaches JSON.parse
    // nowhere.
    ghRawMock.mockReturnValue('**[Suggestion]** the inline body');
    const { body } = runCommentBody({
      id: 3773970278,
      kind: 'inline',
      repo: 'QwenLM/qwen-code',
    });
    expect(ghRawMock).toHaveBeenCalledWith(
      'api',
      'repos/QwenLM/qwen-code/pulls/comments/3773970278',
      '--jq',
      '.body // ""',
    );
    expect(body).toBe('**[Suggestion]** the inline body');
  });

  it('keeps a leading indent (no trim) — it is what puts a log paste in its code block', () => {
    ghRawMock.mockReturnValue('    indented first line\nrest\n');
    const { body } = runCommentBody({
      id: 1,
      kind: 'inline',
      repo: 'QwenLM/qwen-code',
    });
    expect(body).toBe('    indented first line\nrest\n');
  });

  it('fetches an issue comment body', () => {
    ghRawMock.mockReturnValue('the issue body');
    runCommentBody({
      id: 5277891862,
      kind: 'issue',
      repo: 'QwenLM/qwen-code',
    });
    expect(ghRawMock).toHaveBeenCalledWith(
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
    ghRawMock.mockReturnValue('review body');
    runCommentBody({
      id: 99,
      kind: 'review',
      repo: 'QwenLM/qwen-code',
      prNumber: 9073,
    });
    expect(ghRawMock).toHaveBeenCalledWith(
      'api',
      'repos/QwenLM/qwen-code/pulls/9073/reviews/99',
      '--jq',
      '.body // ""',
    );
  });

  it('writes --out instead of returning the body inline', () => {
    ghRawMock.mockReturnValue('long tail');
    const result = runCommentBody({
      id: 1,
      kind: 'inline',
      repo: 'QwenLM/qwen-code',
      out: '/tmp/body.md',
    });
    // resolve()d on both sides: a literal '/tmp/...' fails on Windows.
    expect(mkdirSyncMock).toHaveBeenCalledWith(
      dirname(resolve('/tmp/body.md')),
      { recursive: true },
    );
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      resolve('/tmp/body.md'),
      'long tail',
    );
    expect(result.outPath).toBe(resolve('/tmp/body.md'));
  });
});

describe('commentBodyCommand handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureAuthenticatedMock.mockReturnValue(undefined);
    process.exitCode = undefined;
  });

  it('prints the body verbatim on stdout', () => {
    ghRawMock.mockReturnValue('the body');
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

  it('threads --host to setGhHost before the first gh call', () => {
    ghRawMock.mockReturnValue('the body');
    (commentBodyCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      id: 5,
      kind: 'inline',
      repo: 'QwenLM/qwen-code',
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

  it('exits 2 for --kind review without --pr', () => {
    (commentBodyCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      id: 5,
      kind: 'review',
      repo: 'QwenLM/qwen-code',
    });
    expect(process.exitCode).toBe(2);
    expect(ghRawMock).not.toHaveBeenCalled();
    // The usage error must preempt the auth check — on an unauthenticated
    // machine "log in" can never fix a missing --pr.
    expect(ensureAuthenticatedMock).not.toHaveBeenCalled();
  });

  it('exits 2 on a malformed --repo (usage error, not a fetch failure)', () => {
    (commentBodyCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      id: 5,
      kind: 'inline',
      repo: '../escape',
    });
    expect(process.exitCode).toBe(2);
    expect(ghRawMock).not.toHaveBeenCalled();
    // The usage error must preempt the auth gate — `gh auth login` can
    // never repair the invocation.
    expect(ensureAuthenticatedMock).not.toHaveBeenCalled();
  });

  it('--out prints the JSON marker, not the raw body', () => {
    ghRawMock.mockReturnValue('raw markdown body');
    (commentBodyCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      id: 5,
      kind: 'inline',
      repo: 'QwenLM/qwen-code',
      out: '/tmp/body.md',
    });
    expect(writeStdoutLineMock).toHaveBeenCalledWith(
      JSON.stringify({
        outPath: resolve('/tmp/body.md'),
        chars: 'raw markdown body'.length,
      }),
    );
    expect(writeStdoutLineMock).not.toHaveBeenCalledWith('raw markdown body');
    expect(process.exitCode).toBeUndefined();
  });

  it('exits 1 when the fetch fails', () => {
    ghRawMock.mockImplementation(() => {
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
