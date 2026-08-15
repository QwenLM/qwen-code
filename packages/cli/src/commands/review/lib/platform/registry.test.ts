/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
}));

// The cwd-origin probe shells out to `git remote get-url origin`; mocking it
// keeps these tests independent of the machine's actual clone origin. The
// builtin needs both a named and a default export mocked for the graph.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const mocked = { ...actual, execFileSync: execFileSyncMock };
  return { ...mocked, default: mocked };
});

import { detectPlatformKind } from './registry.js';
import { parseRemoteUrl } from './aone.js';

describe('detectPlatformKind', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
  });

  it('detects Aone from an Aone --host (trimmed, port-bearing, cased)', () => {
    expect(detectPlatformKind({ host: 'gitlab.alibaba-inc.com' })).toBe('aone');
    expect(detectPlatformKind({ host: 'code.alibaba-inc.com' })).toBe('aone');
    expect(detectPlatformKind({ host: 'GHE.Alibaba-Inc.com:8443' })).toBe(
      'aone',
    );
    expect(detectPlatformKind({ host: ' gitlab.alibaba-inc.com ' })).toBe(
      'aone',
    );
  });

  it('detects Aone from an Aone remote URL', () => {
    expect(
      detectPlatformKind({
        remoteUrl: 'git@gitlab.alibaba-inc.com:maxcompute/odps_src.git',
      }),
    ).toBe('aone');
  });

  it('an explicit non-Aone host/remote beats the cwd probe', () => {
    // Regression guard: from an Aone-origin clone, an explicitly-GitHub
    // target must stay GitHub, not be hijacked to Aone by the cwd probe.
    execFileSyncMock.mockReturnValue(
      'git@gitlab.alibaba-inc.com:maxcompute/odps_src.git',
    );
    expect(detectPlatformKind({ host: 'github.com' })).toBe('github');
    expect(
      detectPlatformKind({ remoteUrl: 'git@github.com:QwenLM/qwen-code.git' }),
    ).toBe('github');
  });

  it('falls back to the cwd origin when there is no explicit signal', () => {
    execFileSyncMock.mockReturnValue(
      'git@gitlab.alibaba-inc.com:maxcompute/odps_src.git',
    );
    expect(detectPlatformKind({})).toBe('aone');
    execFileSyncMock.mockReturnValue('git@github.com:QwenLM/qwen-code.git');
    expect(detectPlatformKind({})).toBe('github');
  });

  it('an unreadable origin falls back to github without throwing', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('not a git repository');
    });
    expect(detectPlatformKind({})).toBe('github');
  });
});

describe('parseRemoteUrl', () => {
  it('parses the scp-like ssh form', () => {
    expect(
      parseRemoteUrl('git@gitlab.alibaba-inc.com:maxcompute/odps_src.git'),
    ).toEqual({
      host: 'gitlab.alibaba-inc.com',
      owner: 'maxcompute',
      repo: 'odps_src',
    });
  });

  it('parses a USER-LESS scp-like remote (ssh-config / insteadOf)', () => {
    expect(
      parseRemoteUrl('gitlab.alibaba-inc.com:maxcompute/odps_src.git'),
    ).toEqual({
      host: 'gitlab.alibaba-inc.com',
      owner: 'maxcompute',
      repo: 'odps_src',
    });
  });

  it('parses the https form (with and without .git)', () => {
    expect(
      parseRemoteUrl('https://gitlab.alibaba-inc.com/maxcompute/odps_src.git'),
    ).toEqual({
      host: 'gitlab.alibaba-inc.com',
      owner: 'maxcompute',
      repo: 'odps_src',
    });
    expect(
      parseRemoteUrl('https://gitlab.alibaba-inc.com/maxcompute/odps_src'),
    ).toEqual({
      host: 'gitlab.alibaba-inc.com',
      owner: 'maxcompute',
      repo: 'odps_src',
    });
  });

  it('parses ssh:// with a user@ prefix', () => {
    expect(
      parseRemoteUrl(
        'ssh://git@gitlab.alibaba-inc.com/maxcompute/odps_src.git',
      ),
    ).toEqual({
      host: 'gitlab.alibaba-inc.com',
      owner: 'maxcompute',
      repo: 'odps_src',
    });
  });

  it('lowercases the host and keeps the last two path segments (nested groups)', () => {
    expect(
      parseRemoteUrl('https://GitLab.Alibaba-Inc.com/sub/maxcompute/odps_src'),
    ).toEqual({
      host: 'gitlab.alibaba-inc.com',
      owner: 'maxcompute',
      repo: 'odps_src',
    });
  });

  it('strips a trailing slash and a .git/ suffix', () => {
    expect(
      parseRemoteUrl('https://gitlab.alibaba-inc.com/maxcompute/odps_src.git/'),
    ).toEqual({
      host: 'gitlab.alibaba-inc.com',
      owner: 'maxcompute',
      repo: 'odps_src',
    });
    expect(
      parseRemoteUrl('git@gitlab.alibaba-inc.com:maxcompute/odps_src/'),
    ).toEqual({
      host: 'gitlab.alibaba-inc.com',
      owner: 'maxcompute',
      repo: 'odps_src',
    });
  });

  it('returns null for unparseable URLs', () => {
    expect(parseRemoteUrl('not-a-url')).toBeNull();
    expect(parseRemoteUrl('https://host/onlyone')).toBeNull();
  });
});
