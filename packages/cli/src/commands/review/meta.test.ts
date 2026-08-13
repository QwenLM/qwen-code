/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { ghMock, ghApiMock, ensureAuthenticatedMock, writeStdoutLineMock } =
  vi.hoisted(() => ({
    ghMock: vi.fn(),
    ghApiMock: vi.fn(),
    ensureAuthenticatedMock: vi.fn(),
    writeStdoutLineMock: vi.fn(),
  }));

vi.mock('./lib/gh.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    gh: ghMock,
    ghApi: ghApiMock,
    ensureAuthenticated: ensureAuthenticatedMock,
    setGhHost: vi.fn(),
  };
});

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: writeStdoutLineMock,
  writeStderrLineSafe: vi.fn(),
}));

import { metaCommand, runMeta } from './meta.js';

describe('runMeta', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureAuthenticatedMock.mockReturnValue(undefined);
  });

  afterEach(() => {
    delete process.env['GH_HOST'];
  });

  it('resolves the cwd repository (upstream in a fork clone) with host from the URL', () => {
    ghMock.mockReturnValue(
      '{"owner":{"login":"QwenLM"},"name":"qwen-code","url":"https://github.com/QwenLM/qwen-code"}',
    );
    const result = runMeta({});
    expect(ghMock).toHaveBeenCalledWith(
      'repo',
      'view',
      '--json',
      'owner,name,url',
    );
    expect(result).toEqual({
      platform: 'github',
      host: 'github.com',
      ownerRepo: 'QwenLM/qwen-code',
    });
  });

  it('keeps an explicit port in the derived host', () => {
    ghMock.mockReturnValue(
      '{"owner":{"login":"o"},"name":"r","url":"https://ghe.example.com:8443/o/r"}',
    );
    expect(runMeta({}).host).toBe('ghe.example.com:8443');
  });

  it('adds headSha and webUrl when a PR number is given', () => {
    ghMock.mockReturnValue(
      '{"headRefOid":"2d71a0f851c8c18462cc85b60d90973e132274d8","url":"https://github.com/QwenLM/qwen-code/pull/8981"}',
    );
    const result = runMeta({ prNumber: 8981, repo: 'QwenLM/qwen-code' });
    expect(ghMock).toHaveBeenCalledWith(
      'pr',
      'view',
      '8981',
      '--repo',
      'QwenLM/qwen-code',
      '--json',
      'headRefOid,url',
    );
    expect(result.headSha).toBe('2d71a0f851c8c18462cc85b60d90973e132274d8');
    expect(result.webUrl).toBe('https://github.com/QwenLM/qwen-code/pull/8981');
    expect(result.host).toBe('github.com');
  });

  it('rejects a malformed --repo before any gh call', () => {
    expect(() => runMeta({ prNumber: 1, repo: '../escape' })).toThrow(
      TypeError,
    );
    expect(ghMock).not.toHaveBeenCalled();
  });
});

describe('metaCommand handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureAuthenticatedMock.mockReturnValue(undefined);
    process.exitCode = undefined;
  });

  it('exits 2 on a non-positive PR number without calling gh', () => {
    (metaCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      pr_number: 0,
    });
    expect(process.exitCode).toBe(2);
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('prints the result as one JSON object', () => {
    ghMock.mockReturnValue(
      '{"owner":{"login":"QwenLM"},"name":"qwen-code","url":"https://github.com/QwenLM/qwen-code"}',
    );
    (metaCommand.handler as (a: unknown) => void)({ _: [], $0: 'qwen' });
    expect(process.exitCode).toBeUndefined();
    expect(writeStdoutLineMock).toHaveBeenCalledWith(
      '{"platform":"github","host":"github.com","ownerRepo":"QwenLM/qwen-code"}',
    );
  });

  it('exits 1 when gh fails', () => {
    ghMock.mockImplementation(() => {
      throw new Error('not a git repository');
    });
    (metaCommand.handler as (a: unknown) => void)({ _: [], $0: 'qwen' });
    expect(process.exitCode).toBe(1);
    expect(writeStdoutLineMock).not.toHaveBeenCalled();
  });
});
