/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { detectPlatformKind } from './registry.js';
import { parseRemoteUrl } from './aone.js';

describe('detectPlatformKind', () => {
  it('honors an explicit platform hint above all inference', () => {
    expect(detectPlatformKind({ platform: 'aone' })).toBe('aone');
    expect(
      detectPlatformKind({
        platform: 'github',
        host: 'gitlab.alibaba-inc.com',
      }),
    ).toBe('github');
  });

  it('detects Aone from an Aone --host', () => {
    expect(detectPlatformKind({ host: 'gitlab.alibaba-inc.com' })).toBe('aone');
    expect(detectPlatformKind({ host: 'code.alibaba-inc.com' })).toBe('aone');
    expect(detectPlatformKind({ host: 'GHE.Alibaba-Inc.com:8443' })).toBe(
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

  it('falls back to github for non-Aone hosts and no hint', () => {
    expect(detectPlatformKind({ host: 'github.com' })).toBe('github');
    expect(detectPlatformKind({})).toBe('github');
    expect(
      detectPlatformKind({ remoteUrl: 'git@github.com:QwenLM/qwen-code.git' }),
    ).toBe('github');
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

  it('lowercases the host and keeps the last two path segments', () => {
    expect(
      parseRemoteUrl('https://GitLab.Alibaba-Inc.com/sub/maxcompute/odps_src'),
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
