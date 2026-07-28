/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonChannelTypeDescriptor } from '@qwen-code/sdk/daemon';

const SUPPORTED_CHANNEL_TYPES = new Set(['dingtalk', 'wecom', 'feishu']);

export function isSupportedChannelType(
  type: unknown,
): type is 'dingtalk' | 'wecom' | 'feishu' {
  return typeof type === 'string' && SUPPORTED_CHANNEL_TYPES.has(type);
}

export function isChannelPlatformAvailable(
  descriptor: DaemonChannelTypeDescriptor,
): boolean {
  return descriptor.manageable && isSupportedChannelType(descriptor.type);
}
