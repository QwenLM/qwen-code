/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonChannelTypeDescriptor } from '@qwen-code/sdk/daemon';

const AVAILABLE_CHANNEL_TYPES = new Set(['dingtalk', 'feishu', 'wecom']);

export function isChannelPlatformAvailable(
  descriptor: DaemonChannelTypeDescriptor,
): boolean {
  return descriptor.manageable && AVAILABLE_CHANNEL_TYPES.has(descriptor.type);
}

export function suggestChannelName(
  displayName: string,
  type: string,
  existingNames: readonly string[],
): string {
  const base =
    displayName
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') ||
    type
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') ||
    'channel';
  const used = new Set(existingNames.map((name) => name.toLowerCase()));
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}
