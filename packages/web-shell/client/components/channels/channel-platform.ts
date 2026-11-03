/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonChannelTypeDescriptor } from '@qwen-code/sdk/daemon';

export const PLATFORM_MARKS: Record<string, string> = {
  dingtalk: 'D',
  dws: 'DWS',
  wecom: 'W',
  'wecom-callback': 'WC',
  feishu: 'F',
  github: 'GH',
  gitlab: 'GL',
};

const SUPPORTED_CHANNEL_TYPES = new Set([
  'dingtalk',
  'dws',
  'wecom',
  'wecom-callback',
  'feishu',
  'github',
  'gitlab',
]);

export function isSupportedChannelType(
  type: unknown,
): type is
  | 'dingtalk'
  | 'dws'
  | 'wecom'
  | 'wecom-callback'
  | 'feishu'
  | 'github'
  | 'gitlab' {
  return typeof type === 'string' && SUPPORTED_CHANNEL_TYPES.has(type);
}

export function isChannelPlatformAvailable(
  descriptor: DaemonChannelTypeDescriptor,
): boolean {
  return descriptor.manageable && isSupportedChannelType(descriptor.type);
}

/**
 * Channels whose traffic is always repository-scoped group traffic. Every
 * envelope sets `isGroup`, so the direct-message policy never gates them, and
 * their group IDs are repository full names (`owner/repo`).
 */
const REPOSITORY_ONLY_CHANNEL_TYPES = new Set(['github']);

export function isRepositoryOnlyChannelType(type: unknown): boolean {
  return typeof type === 'string' && REPOSITORY_ONLY_CHANNEL_TYPES.has(type);
}

const GITHUB_REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Web URL for a GitHub channel journal event, or undefined when the event
 * cannot be linked. The origin mapping mirrors GithubAdapter.connect's
 * `webOrigin` derivation and must stay in sync with it.
 */
export function githubEventWebUrl(
  event: { repository?: string; number?: number; thread?: string },
  config: Record<string, unknown> | undefined,
): string | undefined {
  if (config?.['type'] !== 'github') return undefined;
  const repository = event.repository;
  if (!repository || !GITHUB_REPOSITORY_RE.test(repository)) return undefined;
  const thread = /^(pr|issue):(\d+)$/.exec(event.thread ?? '');
  const number = event.number ?? (thread ? Number(thread[2]) : undefined);
  if (number === undefined || !Number.isSafeInteger(number) || number <= 0) {
    return undefined;
  }
  // Without a thread kind, /issues/<n> still works: GitHub redirects PR
  // numbers to /pull/<n>.
  const path = thread?.[1] === 'pr' ? 'pull' : 'issues';
  const configuredBaseUrl = config['baseUrl'];
  const baseUrl =
    typeof configuredBaseUrl === 'string' && configuredBaseUrl.trim()
      ? configuredBaseUrl.trim()
      : 'https://api.github.com';
  const origin = baseUrl
    .replace(/\/api\/v3\/?$/, '')
    .replace(/^https:\/\/api\.github\.com/, 'https://github.com')
    .replace(/^https:\/\/api\.([^./]+\.ghe\.com)/i, 'https://$1');
  return `${origin}/${repository}/${path}/${number}`;
}
