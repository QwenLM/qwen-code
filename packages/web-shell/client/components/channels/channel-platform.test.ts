/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { DaemonChannelTypeDescriptor } from '@qwen-code/sdk/daemon';
import {
  githubEventNumber,
  githubEventWebUrl,
  isChannelPlatformAvailable,
  isPrivateOnlyChannelType,
  isSupportedChannelType,
} from './channel-platform';

function descriptor(
  type: string,
  manageable = true,
): DaemonChannelTypeDescriptor {
  return { type, displayName: type, manageable, fields: [] };
}

describe('Channel platform availability', () => {
  it('only exposes manageable built-in channel editors', () => {
    expect(
      [
        descriptor('dingtalk'),
        descriptor('dws'),
        descriptor('wecom'),
        descriptor('wecom-callback'),
        descriptor('feishu'),
        descriptor('github'),
        descriptor('gitlab'),
        descriptor('email'),
        descriptor('telegram'),
        descriptor('weixin'),
        descriptor('qqbot'),
        descriptor('dingtalk', false),
        descriptor('github', false),
        descriptor('gitlab', false),
        descriptor('email', false),
      ]
        .filter(isChannelPlatformAvailable)
        .map((item) => item.type),
    ).toEqual([
      'dingtalk',
      'dws',
      'wecom',
      'wecom-callback',
      'feishu',
      'github',
      'gitlab',
      'email',
    ]);
  });

  it('uses the same allowlist for configured Channel instances', () => {
    expect(isSupportedChannelType('dingtalk')).toBe(true);
    expect(isSupportedChannelType('dws')).toBe(true);
    expect(isSupportedChannelType('wecom')).toBe(true);
    expect(isSupportedChannelType('wecom-callback')).toBe(true);
    expect(isSupportedChannelType('feishu')).toBe(true);
    expect(isSupportedChannelType('github')).toBe(true);
    expect(isSupportedChannelType('gitlab')).toBe(true);
    expect(isSupportedChannelType('email')).toBe(true);
    expect(isSupportedChannelType('telegram')).toBe(false);
    expect(isSupportedChannelType('weixin')).toBe(false);
    expect(isSupportedChannelType('qqbot')).toBe(false);
    expect(isSupportedChannelType(undefined)).toBe(false);
  });
});

describe('Private-only channel types', () => {
  it('classifies Email as private-only', () => {
    expect(isPrivateOnlyChannelType('email')).toBe(true);
  });

  it('leaves every group-capable platform outside the set', () => {
    // A leak here would hide the group controls on a platform that needs them,
    // which is the same defect in the opposite direction.
    for (const type of [
      'dingtalk',
      'dws',
      'wecom',
      'wecom-callback',
      'feishu',
      'github',
      'gitlab',
      'telegram',
      'weixin',
      'qqbot',
    ]) {
      expect(isPrivateOnlyChannelType(type)).toBe(false);
    }
    expect(isPrivateOnlyChannelType(undefined)).toBe(false);
    expect(isPrivateOnlyChannelType(42)).toBe(false);
  });
});

describe('githubEventWebUrl', () => {
  const githubConfig = { type: 'github' };

  it('builds a pull URL for a PR thread and an issues URL for an issue thread', () => {
    expect(
      githubEventWebUrl(
        { repository: 'owner/repo', number: 42, thread: 'pr:42' },
        githubConfig,
      ),
    ).toBe('https://github.com/owner/repo/pull/42');
    expect(
      githubEventWebUrl(
        { repository: 'owner/repo', number: 7, thread: 'issue:7' },
        githubConfig,
      ),
    ).toBe('https://github.com/owner/repo/issues/7');
  });

  it('falls back to the issues path when the thread kind is unknown', () => {
    // GitHub redirects /issues/<n> to /pull/<n> for PR numbers.
    expect(
      githubEventWebUrl({ repository: 'owner/repo', number: 42 }, githubConfig),
    ).toBe('https://github.com/owner/repo/issues/42');
  });

  it('derives the number from the thread when it is absent', () => {
    expect(
      githubEventWebUrl(
        { repository: 'owner/repo', thread: 'pr:42' },
        githubConfig,
      ),
    ).toBe('https://github.com/owner/repo/pull/42');
  });

  it('maps GitHub Enterprise and data-residency API roots to the web origin', () => {
    expect(
      githubEventWebUrl(
        { repository: 'owner/repo', number: 1, thread: 'pr:1' },
        { type: 'github', baseUrl: 'https://ghe.example.com/api/v3' },
      ),
    ).toBe('https://ghe.example.com/owner/repo/pull/1');
    expect(
      githubEventWebUrl(
        { repository: 'owner/repo', number: 1, thread: 'pr:1' },
        { type: 'github', baseUrl: 'https://api.tenant.ghe.com' },
      ),
    ).toBe('https://tenant.ghe.com/owner/repo/pull/1');
  });

  it('strips trailing slashes so links never double the path separator', () => {
    for (const baseUrl of [
      'https://api.github.com/',
      'https://ghe.example.com/',
      'https://ghe.example.com/api/v3/',
      'https://api.tenant.ghe.com/',
    ]) {
      const url = githubEventWebUrl(
        { repository: 'owner/repo', number: 42, thread: 'pr:42' },
        { type: 'github', baseUrl },
      );
      expect(url).toBeDefined();
      expect(url).not.toContain('//owner');
      expect(url?.endsWith('/owner/repo/pull/42')).toBe(true);
    }
    expect(
      githubEventWebUrl(
        { repository: 'owner/repo', number: 42, thread: 'pr:42' },
        { type: 'github', baseUrl: 'https://api.github.com/' },
      ),
    ).toBe('https://github.com/owner/repo/pull/42');
  });

  it('returns undefined for non-GitHub channels or missing config', () => {
    expect(
      githubEventWebUrl(
        { repository: 'owner/repo', number: 42 },
        { type: 'gitlab' },
      ),
    ).toBeUndefined();
    expect(
      githubEventWebUrl({ repository: 'owner/repo', number: 42 }, undefined),
    ).toBeUndefined();
  });

  it('returns undefined when the repository or number cannot be trusted', () => {
    expect(githubEventWebUrl({ number: 42 }, githubConfig)).toBeUndefined();
    expect(
      githubEventWebUrl({ repository: 'owner/repo' }, githubConfig),
    ).toBeUndefined();
    expect(
      githubEventWebUrl({ repository: 'not-a-repo', number: 42 }, githubConfig),
    ).toBeUndefined();
    expect(
      githubEventWebUrl({ repository: 'owner/repo', number: -1 }, githubConfig),
    ).toBeUndefined();
    expect(
      githubEventWebUrl(
        { repository: 'owner/repo', number: 1.5 },
        githubConfig,
      ),
    ).toBeUndefined();
  });
});

describe('githubEventWebUrl emitted-origin consumption', () => {
  it('concatenates the daemon-emitted origin without re-deriving it', () => {
    // The emitted origin wins even when baseUrl would map somewhere else:
    // the daemon is the single owner of the mapping.
    expect(
      githubEventWebUrl(
        { repository: 'owner/repo', number: 42, thread: 'pr:42' },
        {
          type: 'github',
          webOrigin: 'https://ghe.resolved.example',
          baseUrl: 'https://api.github.com',
        },
      ),
    ).toBe('https://ghe.resolved.example/owner/repo/pull/42');
  });

  it('falls back to the baseUrl derivation when no origin is emitted', () => {
    // Older daemons (and the scope-local listing) carry no webOrigin.
    expect(
      githubEventWebUrl(
        { repository: 'owner/repo', number: 42, thread: 'pr:42' },
        { type: 'github', baseUrl: 'https://ghe.example.com/api/v3' },
      ),
    ).toBe('https://ghe.example.com/owner/repo/pull/42');
    expect(
      githubEventWebUrl(
        { repository: 'owner/repo', number: 42, thread: 'pr:42' },
        { type: 'github', webOrigin: '   ' },
      ),
    ).toBe('https://github.com/owner/repo/pull/42');
  });
});

describe('githubEventNumber', () => {
  it('prefers the explicit number and falls back to the thread', () => {
    expect(githubEventNumber({ number: 42, thread: 'pr:42' })).toBe(42);
    expect(githubEventNumber({ thread: 'pr:42' })).toBe(42);
    expect(githubEventNumber({ thread: 'issue:7' })).toBe(7);
  });

  it('returns undefined without a trustworthy number', () => {
    expect(githubEventNumber({})).toBeUndefined();
    expect(githubEventNumber({ thread: 'group-42' })).toBeUndefined();
    expect(githubEventNumber({ number: 0 })).toBeUndefined();
    expect(githubEventNumber({ number: -1 })).toBeUndefined();
    expect(githubEventNumber({ number: 1.5 })).toBeUndefined();
    expect(githubEventNumber({ thread: 'pr:abc' })).toBeUndefined();
  });
});
