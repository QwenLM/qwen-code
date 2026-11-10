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
  email: 'E',
};

const SUPPORTED_CHANNEL_TYPES = new Set([
  'dingtalk',
  'dws',
  'wecom',
  'wecom-callback',
  'feishu',
  'github',
  'gitlab',
  'email',
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
  | 'gitlab'
  | 'email' {
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

/**
 * The mirror of repository-only: channels whose traffic is always a direct
 * conversation. Email builds every envelope with `isGroup: false`, so no group
 * gate is ever consulted and the injected group controls cannot do anything.
 */
const PRIVATE_ONLY_CHANNEL_TYPES = new Set(['email']);

export function isPrivateOnlyChannelType(type: unknown): boolean {
  return typeof type === 'string' && PRIVATE_ONLY_CHANNEL_TYPES.has(type);
}

const GITHUB_REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface GithubEventRef {
  repository?: string;
  number?: number;
  thread?: string;
}

/**
 * The issue/PR number a journal event refers to: the explicit `number`
 * field, else the one carried by `thread` (`pr:42` / `issue:42`). The shared
 * inbound path journals without `number`, so display and URL must derive it
 * the same way or they would name different destinations.
 */
export function githubEventNumber(event: GithubEventRef): number | undefined {
  const thread = /^(pr|issue):(\d+)$/.exec(event.thread ?? '');
  const number = event.number ?? (thread ? Number(thread[2]) : undefined);
  if (number === undefined || !Number.isSafeInteger(number) || number <= 0) {
    return undefined;
  }
  return number;
}

/**
 * Web URL for a GitHub channel journal event, or undefined when the event
 * cannot be linked. The daemon emits the resolved web origin
 * (`channelLinkMeta.webOrigin`, single owner: the channel package's
 * resolveGithubWebOrigin); this client only concatenates it. The baseUrl
 * derivation below is a compatibility fallback for daemons that predate the
 * emitted origin (including the scope-local listing, which never carries
 * one).
 */
export function githubEventWebUrl(
  event: GithubEventRef,
  config:
    | { type?: unknown; baseUrl?: unknown; webOrigin?: unknown }
    | undefined,
): string | undefined {
  if (config?.['type'] !== 'github') return undefined;
  const repository = event.repository;
  if (!repository || !GITHUB_REPOSITORY_RE.test(repository)) return undefined;
  const number = githubEventNumber(event);
  if (number === undefined) return undefined;
  // Without a thread kind, /issues/<n> still works: GitHub redirects PR
  // numbers to /pull/<n>.
  const path = event.thread?.startsWith('pr:') ? 'pull' : 'issues';
  const emittedOrigin = config['webOrigin'];
  if (typeof emittedOrigin === 'string' && emittedOrigin.trim()) {
    return `${emittedOrigin}/${repository}/${path}/${number}`;
  }
  const configuredBaseUrl = config['baseUrl'];
  const baseUrl =
    typeof configuredBaseUrl === 'string' && configuredBaseUrl.trim()
      ? configuredBaseUrl.trim()
      : 'https://api.github.com';
  const origin = baseUrl
    .replace(/\/api\/v3\/?$/, '')
    .replace(/^https:\/\/api\.github\.com/, 'https://github.com')
    .replace(/^https:\/\/api\.([^./]+\.ghe\.com)/i, 'https://$1')
    .replace(/\/+$/, '');
  return `${origin}/${repository}/${path}/${number}`;
}
