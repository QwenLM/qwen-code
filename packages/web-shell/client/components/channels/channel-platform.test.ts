/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { DaemonChannelTypeDescriptor } from '@qwen-code/sdk/daemon';
import {
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
  it('only exposes manageable DingTalk, WeCom, and Feishu channels', () => {
    expect(
      [
        descriptor('dingtalk'),
        descriptor('wecom'),
        descriptor('feishu'),
        descriptor('telegram'),
        descriptor('weixin'),
        descriptor('dingtalk', false),
      ]
        .filter(isChannelPlatformAvailable)
        .map((item) => item.type),
    ).toEqual(['dingtalk', 'wecom', 'feishu']);
  });

  it('uses the same allowlist for configured Channel instances', () => {
    expect(isSupportedChannelType('dingtalk')).toBe(true);
    expect(isSupportedChannelType('wecom')).toBe(true);
    expect(isSupportedChannelType('feishu')).toBe(true);
    expect(isSupportedChannelType('telegram')).toBe(false);
    expect(isSupportedChannelType(undefined)).toBe(false);
  });
});
