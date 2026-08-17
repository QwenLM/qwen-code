/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { ghMock, ensureAuthenticatedMock, setGhHostMock, writeStdoutLineMock } =
  vi.hoisted(() => ({
    ghMock: vi.fn(),
    ensureAuthenticatedMock: vi.fn(),
    setGhHostMock: vi.fn(),
    writeStdoutLineMock: vi.fn(),
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

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: writeStdoutLineMock,
  writeStderrLineSafe: vi.fn(),
}));

import { metaCommand, runMeta } from './meta.js';

// GH_HOST leaks into these tests from the operator environment otherwise —
// resolveGhHost is the real function (the mock factory spreads `...actual`),
// so save/delete/restore it per test, the directory's established pattern.
let savedGhHost: string | undefined;

function saveAndClearGhHost(): void {
  savedGhHost = process.env['GH_HOST'];
  delete process.env['GH_HOST'];
}

function restoreGhHost(): void {
  if (savedGhHost === undefined) {
    delete process.env['GH_HOST'];
  } else {
    process.env['GH_HOST'] = savedGhHost;
  }
}

describe('runMeta', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureAuthenticatedMock.mockReturnValue(undefined);
    saveAndClearGhHost();
  });

  afterEach(restoreGhHost);

  it('resolves the cwd repository (upstream in a fork clone) with host from the URL', () => {
    ghMock.mockReturnValue(
      '{"owner":{"login":"QwenLM"},"name":"qwen-code","url":"https://github.com/QwenLM/qwen-code"}',
    );
    const result = runMeta({});
    expect(ghMock).toHaveBeenCalledWith(
      'repo',
      'view',
      '--json',
      'owner,name,url,parent',
    );
    expect(result).toEqual({
      platform: 'github',
      host: 'github.com',
      ownerRepo: 'QwenLM/qwen-code',
    });
  });

  it('resolves a fork clone to its PARENT, where the PR actually lives', () => {
    // gh's default-repo preference is a remote literally named `upstream`, not
    // an API fork check — an origin-only fork clone resolves to the fork.
    // resolveRepo fetches `parent` and prefers it, so a bare PR number never
    // targets a fork's same-numbered PR.
    // gh's `parent` field carries id/name/owner only — NO url (real gh
    // shape). resolveRepo reads the host from the repo's own url, never
    // parent.url.
    ghMock.mockReturnValue(
      '{"owner":{"login":"contributor"},"name":"qwen-code","url":"https://github.com/contributor/qwen-code","parent":{"owner":{"login":"QwenLM"},"name":"qwen-code"}}',
    );
    const result = runMeta({});
    expect(result.ownerRepo).toBe('QwenLM/qwen-code');
    expect(result.host).toBe('github.com');
  });

  it('keeps an explicit port in the derived host', () => {
    ghMock.mockReturnValue(
      '{"owner":{"login":"o"},"name":"r","url":"https://ghe.example.com:8443/o/r"}',
    );
    expect(runMeta({}).host).toBe('ghe.example.com:8443');
  });

  it('aligns gh routing with the discovered host before the PR call', () => {
    ghMock
      .mockReturnValueOnce(
        '{"owner":{"login":"o"},"name":"r","url":"https://ghe.example.com/o/r"}',
      )
      .mockReturnValueOnce('{"headRefOid":"abc","url":"u"}');
    runMeta({ prNumber: 1 });
    // The discovered host is applied as routing (the handler's flag/env
    // would win if set — neither is set here).
    expect(setGhHostMock).toHaveBeenLastCalledWith('ghe.example.com');
    const authOrder = ensureAuthenticatedMock.mock.invocationCallOrder[0];
    const repoViewOrder = ghMock.mock.invocationCallOrder[0];
    const hostOrder = setGhHostMock.mock.invocationCallOrder[0];
    const prViewOrder = ghMock.mock.invocationCallOrder[1];
    expect(authOrder).toBeLessThan(repoViewOrder);
    expect(authOrder).toBeLessThan(prViewOrder);
    expect(hostOrder).toBeLessThan(prViewOrder);
  });

  it('an explicit --host flag wins over the discovered host in the cwd branch', () => {
    ghMock
      .mockReturnValueOnce(
        '{"owner":{"login":"o"},"name":"r","url":"https://github.com/o/r"}',
      )
      .mockReturnValueOnce('{"headRefOid":"abc","url":"u"}');
    runMeta({ prNumber: 1, host: 'ghe.example.com' });
    // A dropped args.host here would route the PR call at the discovered
    // github.com instead — the operator's Enterprise host silently ignored.
    expect(setGhHostMock).toHaveBeenLastCalledWith('ghe.example.com');
  });

  it('an operator-exported GH_HOST keeps precedence over the discovered host', () => {
    process.env['GH_HOST'] = 'ghe.example.com';
    ghMock.mockReturnValue(
      '{"owner":{"login":"o"},"name":"r","url":"https://other.example.com/o/r"}',
    );
    const result = runMeta({});
    expect(setGhHostMock).toHaveBeenLastCalledWith('ghe.example.com');
    // The label stays the discovered URL host — the routing won, not the URL.
    expect(result.host).toBe('other.example.com');
  });

  it('explicit-branch: an unroutable GH_HOST env value throws naming the env (exit-1 class)', () => {
    // resolveGhHost reads the env too and never validates; the explicit-repo
    // branch must gate the emitted host with HOSTNAME_RE, else a
    // gh-tolerated underscore alias is emitted and dies downstream when
    // welded back as --host. A plain Error (not TypeError) keeps the
    // environmental exit-1 class.
    process.env['GH_HOST'] = 'my_ghe';
    ghMock.mockReturnValue('{"headRefOid":"abc","url":"u"}');
    expect(() => runMeta({ prNumber: 1, repo: 'o/r' })).toThrow(
      /GH_HOST environment.*my_ghe/,
    );
    expect(() => runMeta({ prNumber: 1, repo: 'o/r' })).not.toThrow(TypeError);
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

  it('labels an explicit --host (port survives), and an empty flag falls through', () => {
    ghMock.mockReturnValue('{"headRefOid":"abc","url":"u"}');
    expect(
      runMeta({ prNumber: 1, repo: 'o/r', host: 'ghe.example.com:8443' }).host,
    ).toBe('ghe.example.com:8443');
    expect(runMeta({ prNumber: 1, repo: 'o/r', host: '' }).host).toBe(
      'github.com',
    );
  });

  it('labels the env GH_HOST for an explicit --repo (the documented inherit)', () => {
    process.env['GH_HOST'] = 'ghe.example.com';
    ghMock.mockReturnValue('{"headRefOid":"abc","url":"u"}');
    expect(runMeta({ prNumber: 1, repo: 'o/r' }).host).toBe('ghe.example.com');
  });

  it('rejects a malformed --repo before any gh call, with or without a number', () => {
    expect(() => runMeta({ prNumber: 1, repo: '../escape' })).toThrow(
      TypeError,
    );
    expect(() => runMeta({ repo: 'o/r/extra' })).toThrow(TypeError);
    expect(ghMock).not.toHaveBeenCalled();
  });
});

describe('metaCommand handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureAuthenticatedMock.mockReturnValue(undefined);
    process.exitCode = undefined;
    saveAndClearGhHost();
  });

  afterEach(restoreGhHost);

  it('exits 2 on a non-positive or non-integer PR number without calling gh', () => {
    (metaCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      pr_number: 0,
    });
    expect(process.exitCode).toBe(2);
    // Reset so the second assertion verifies the guard assigns the code,
    // not that it rides the first invocation's residue. A non-integer must
    // also be rejected (yargs coerces 'abc' to NaN; NaN <= 0 is false).
    process.exitCode = undefined;
    (metaCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      pr_number: 1.5,
    });
    expect(process.exitCode).toBe(2);
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('exits 2 on a malformed --repo (usage error, not a fetch failure)', () => {
    (metaCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      pr_number: 1,
      repo: '../escape',
    });
    expect(process.exitCode).toBe(2);
    expect(ghMock).not.toHaveBeenCalled();
    // The usage error must preempt the auth gate — `gh auth login` can
    // never repair the invocation.
    expect(ensureAuthenticatedMock).not.toHaveBeenCalled();
  });

  it('exits 2 on a malformed --host (setGhHost TypeError → usage class)', () => {
    setGhHostMock.mockImplementationOnce(() => {
      throw new TypeError('--host must be a hostname');
    });
    (metaCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      pr_number: 1,
      repo: 'o/r',
      host: 'bad host; rm -rf /',
    });
    expect(process.exitCode).toBe(2);
    expect(ghMock).not.toHaveBeenCalled();
    expect(ensureAuthenticatedMock).not.toHaveBeenCalled();
  });

  it('threads --host to setGhHost before the first gh call', () => {
    ghMock.mockReturnValue('{"headRefOid":"abc","url":"u"}');
    (metaCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      pr_number: 1,
      repo: 'o/r',
      host: 'ghe.example.com',
    });
    expect(setGhHostMock).toHaveBeenCalledWith('ghe.example.com');
    const ghOrder = ghMock.mock.invocationCallOrder[0];
    const authOrder = ensureAuthenticatedMock.mock.invocationCallOrder[0];
    const hostOrder = setGhHostMock.mock.invocationCallOrder[0];
    // ensureAuthenticated spawns the first real gh process (`gh auth
    // status`), so the ordering must hold against it too, not just the
    // data call.
    expect(hostOrder).toBeLessThan(Math.min(authOrder, ghOrder));
    expect(authOrder).toBeLessThan(ghOrder);
  });

  it('prints the result as one JSON object', () => {
    ghMock.mockReturnValue(
      '{"owner":{"login":"QwenLM"},"name":"qwen-code","url":"https://github.com/QwenLM/qwen-code"}',
    );
    (metaCommand.handler as (a: unknown) => void)({ _: [], $0: 'qwen' });
    expect(process.exitCode).toBeUndefined();
    expect(setGhHostMock).toHaveBeenCalledWith(undefined);
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
