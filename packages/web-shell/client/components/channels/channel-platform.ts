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
  feishu: 'F',
  github: 'GH',
  gitlab: 'GL',
};

const SUPPORTED_CHANNEL_TYPES = new Set([
  'dingtalk',
  'dws',
  'wecom',
  'feishu',
  'github',
  'gitlab',
]);

export function isSupportedChannelType(
  type: unknown,
): type is 'dingtalk' | 'dws' | 'wecom' | 'feishu' | 'github' | 'gitlab' {
  return typeof type === 'string' && SUPPORTED_CHANNEL_TYPES.has(type);
}

export function isChannelPlatformAvailable(
  descriptor: DaemonChannelTypeDescriptor,
): boolean {
  return descriptor.manageable && isSupportedChannelType(descriptor.type);
}
