/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dirname, resolve } from 'node:path';

const {
  ghApiMock,
  ensureAuthenticatedMock,
  setGhHostMock,
  writeStdoutLineMock,
  writeStderrLineSafeMock,
  writeFileSyncMock,
  mkdirSyncMock,
} = vi.hoisted(() => ({
  ghApiMock: vi.fn(),
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
    // getCommentBody reads `.body` off the JSON-parsed response (the ghApi
    // seam) — NOT a `--jq` raw-text fetch, which appends a trailing newline.
    ghApi: ghApiMock,
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
  writeStderrLineSafe: writeStderrLineSafeMock,
}));

import { commentBodyCommand, runCommentBody } from './comment-body.js';

describe('runCommentBody', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureAuthenticatedMock.mockReturnValue(undefined);
  });

  it('fetches an inline comment body from the parsed JSON (no --jq newline)', () => {
    ghApiMock.mockReturnValue({ body: '**[Suggestion]** the inline body' });
    const { body } = runCommentBody({
      id: 3773970278,
      kind: 'inline',
      repo: 'QwenLM/qwen-code',
    });
    expect(ghApiMock).toHaveBeenCalledWith(
      'repos/QwenLM/qwen-code/pulls/comments/3773970278',
    );
    expect(body).toBe('**[Suggestion]** the inline body');
  });

  it('keeps both edges exactly — leading indent AND no invented trailing newline', () => {
    // A leading indent puts a pasted log inside its code block; a body that
    // does not end in '\n' must not gain one (the --jq form appended it).
    ghApiMock.mockReturnValue({ body: '    indented first line\nrest' });
    const { body } = runCommentBody({
      id: 1,
      kind: 'inline',
      repo: 'QwenLM/qwen-code',
    });
    expect(body).toBe('    indented first line\nrest');
  });

  it('returns an empty string for a null body', () => {
    ghApiMock.mockReturnValue({ body: null });
    expect(
      runCommentBody({ id: 1, kind: 'inline', repo: 'QwenLM/qwen-code' }).body,
    ).toBe('');
  });

  it('fetches an issue comment body', () => {
    ghApiMock.mockReturnValue({ body: 'the issue body' });
    runCommentBody({
      id: 5277891862,
      kind: 'issue',
      repo: 'QwenLM/qwen-code',
    });
    expect(ghApiMock).toHaveBeenCalledWith(
      'repos/QwenLM/qwen-code/issues/comments/5277891862',
    );
  });

  it('addresses review bodies per-PR and refuses without one', () => {
    expect(() =>
      runCommentBody({ id: 1, kind: 'review', repo: 'QwenLM/qwen-code' }),
    ).toThrow(TypeError);
    ghApiMock.mockReturnValue({ body: 'review body' });
    runCommentBody({
      id: 99,
      kind: 'review',
      repo: 'QwenLM/qwen-code',
      prNumber: 9073,
    });
    expect(ghApiMock).toHaveBeenCalledWith(
      'repos/QwenLM/qwen-code/pulls/9073/reviews/99',
    );
  });

  it('writes --out instead of returning the body inline', () => {
    ghApiMock.mockReturnValue({ body: 'long tail' });
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

  it('prints the body byte-exact on stdout (no invented trailing newline)', () => {
    // The stdout path uses process.stdout.write, not writeStdoutLine — a body
    // without a trailing newline must not gain one (an empty body would
    // otherwise print exactly '\n').
    ghApiMock.mockReturnValue({ body: 'the body' });
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      (commentBodyCommand.handler as (a: unknown) => void)({
        _: [],
        $0: 'qwen',
        id: 5,
        kind: 'inline',
        repo: 'QwenLM/qwen-code',
      });
      expect(stdoutSpy).toHaveBeenCalledWith('the body');
      expect(setGhHostMock).toHaveBeenCalledWith(undefined);
      // And never the newline-appending line writer for the body.
      expect(writeStdoutLineMock).not.toHaveBeenCalledWith('the body');
      expect(process.exitCode).toBeUndefined();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('threads --host to setGhHost before the first gh call', () => {
    ghApiMock.mockReturnValue({ body: 'the body' });
    (commentBodyCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      id: 5,
      kind: 'inline',
      repo: 'QwenLM/qwen-code',
      host: 'ghe.example.com',
    });
    expect(setGhHostMock).toHaveBeenCalledWith('ghe.example.com');
    const ghOrder = ghApiMock.mock.invocationCallOrder[0];
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

  it('exits 2 for --kind review without --pr', () => {
    (commentBodyCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      id: 5,
      kind: 'review',
      repo: 'QwenLM/qwen-code',
    });
    expect(process.exitCode).toBe(2);
    expect(ghApiMock).not.toHaveBeenCalled();
    // The usage error must preempt the auth check — on an unauthenticated
    // machine "log in" can never fix a missing --pr.
    expect(ensureAuthenticatedMock).not.toHaveBeenCalled();
  });

  it('threads --pr through to the review-body fetch on the success path', () => {
    ghApiMock.mockReturnValue({ body: 'review body' });
    (commentBodyCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      id: 99,
      kind: 'review',
      repo: 'QwenLM/qwen-code',
      pr: 9073,
    });
    expect(ghApiMock).toHaveBeenCalledWith(
      'repos/QwenLM/qwen-code/pulls/9073/reviews/99',
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('exits 2 on a non-positive id or --pr, without calling gh or auth', () => {
    (commentBodyCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      id: 0,
      kind: 'inline',
      repo: 'QwenLM/qwen-code',
    });
    expect(process.exitCode).toBe(2);
    // Reset so the second assertion verifies the guard assigns the code,
    // not that it rides the first invocation's residue.
    process.exitCode = undefined;
    (commentBodyCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      id: 5,
      kind: 'review',
      repo: 'QwenLM/qwen-code',
      pr: -3,
    });
    expect(process.exitCode).toBe(2);
    expect(ghApiMock).not.toHaveBeenCalled();
    expect(ensureAuthenticatedMock).not.toHaveBeenCalled();
  });

  it('exits 2 on a fractional id or --pr — the isInteger half of the guard (#9194)', () => {
    // The non-positive cases above exercise `<= 0`; the `Number.isInteger`
    // half used to be untested, so a guard that only checked positivity
    // would ship green and let `1.5` reach the gh call.
    (commentBodyCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      id: 1.5,
      kind: 'inline',
      repo: 'QwenLM/qwen-code',
    });
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;
    (commentBodyCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      id: 5,
      kind: 'review',
      repo: 'QwenLM/qwen-code',
      pr: 9073.25,
    });
    expect(process.exitCode).toBe(2);
    expect(ghApiMock).not.toHaveBeenCalled();
    expect(ensureAuthenticatedMock).not.toHaveBeenCalled();
  });

  it('exits 2 on an empty --out (classified before any fetch)', () => {
    (commentBodyCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      id: 5,
      kind: 'inline',
      repo: 'QwenLM/qwen-code',
      out: '',
    });
    expect(process.exitCode).toBe(2);
    expect(ghApiMock).not.toHaveBeenCalled();
    expect(ensureAuthenticatedMock).not.toHaveBeenCalled();
  });

  it('exits 2 on a whitespace-only --out', () => {
    (commentBodyCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      id: 5,
      kind: 'inline',
      repo: 'QwenLM/qwen-code',
      out: ' ',
    });
    expect(process.exitCode).toBe(2);
    expect(ghApiMock).not.toHaveBeenCalled();
    expect(ensureAuthenticatedMock).not.toHaveBeenCalled();
  });

  it('exits 2 on a malformed --host (setGhHost TypeError → usage class)', () => {
    setGhHostMock.mockImplementationOnce(() => {
      throw new TypeError('--host must be a hostname');
    });
    (commentBodyCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      id: 5,
      kind: 'inline',
      repo: 'QwenLM/qwen-code',
      host: 'bad host; rm -rf /',
    });
    expect(process.exitCode).toBe(2);
    expect(ghApiMock).not.toHaveBeenCalled();
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
    expect(ghApiMock).not.toHaveBeenCalled();
    // The usage error must preempt the auth gate — `gh auth login` can
    // never repair the invocation.
    expect(ensureAuthenticatedMock).not.toHaveBeenCalled();
  });

  it('--out prints the JSON marker, not the raw body', () => {
    ghApiMock.mockReturnValue({ body: 'raw markdown body' });
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
    ghApiMock.mockImplementation(() => {
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
