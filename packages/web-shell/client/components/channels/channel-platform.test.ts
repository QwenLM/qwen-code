/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DaemonChannelTypeDescriptor } from '@qwen-code/sdk/daemon';
import {
  githubEventWebUrl,
  isChannelPlatformAvailable,
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
        descriptor('telegram'),
        descriptor('weixin'),
        descriptor('dingtalk', false),
        descriptor('github', false),
        descriptor('gitlab', false),
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
    expect(isSupportedChannelType('telegram')).toBe(false);
    expect(isSupportedChannelType(undefined)).toBe(false);
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

/**
 * The client cannot import the Node-only GitHub adapter, so the origin
 * mapping is a deliberate copy. This contract ties the two sources together:
 * any change to either `.replace()` chain fails here until the other side is
 * updated to match.
 */
describe('githubEventWebUrl origin mapping mirrors the GitHub adapter', () => {
  function replaceChain(source: string, anchor: RegExp): string {
    const block = anchor.exec(source)?.[1];
    expect(block, `anchor ${anchor} not found`).toBeDefined();
    const chain = (block ?? '')
      .split('\n')
      .map((line) => line.trim().replace(/;$/, ''))
      .filter((line) => line.startsWith('.replace('))
      .join('');
    expect(chain).not.toBe('');
    return chain;
  }

  it('keeps the client chain byte-identical to the adapter webOrigin chain', () => {
    const clientSource = readFileSync(
      fileURLToPath(new URL('./channel-platform.ts', import.meta.url)),
      'utf8',
    );
    const adapterSource = readFileSync(
      fileURLToPath(
        new URL(
          '../../../../channels/github/src/GithubAdapter.ts',
          import.meta.url,
        ),
      ),
      'utf8',
    );

    const clientChain = replaceChain(
      clientSource,
      /const origin = baseUrl([\s\S]*?);/,
    );
    const adapterChain = replaceChain(
      adapterSource,
      /this\.webOrigin = baseUrl([\s\S]*?);/,
    );

    expect(clientChain).toBe(adapterChain);
    expect(clientChain.match(/\.replace\(/g)).toHaveLength(3);
  });
});
