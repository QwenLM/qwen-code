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
