/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  isChannelPlatformAvailable,
  suggestChannelName,
} from './channel-platform';

describe('suggestChannelName', () => {
  it('creates a portable name from the platform label', () => {
    expect(suggestChannelName('WeChat', 'weixin', [])).toBe('wechat');
    expect(suggestChannelName('Ding Talk', 'dingtalk', [])).toBe('ding-talk');
  });

  it('increments without reusing an existing case-insensitive name', () => {
    expect(
      suggestChannelName('WeChat', 'weixin', [
        'wechat',
        'WECHAT-2',
        'wechat-4',
      ]),
    ).toBe('wechat-3');
  });

  it('falls back to the type and then a generic channel name', () => {
    expect(suggestChannelName('微信', 'weixin', [])).toBe('weixin');
    expect(suggestChannelName('微信', '微信', [])).toBe('channel');
  });
});

describe('isChannelPlatformAvailable', () => {
  it.each(['dingtalk', 'feishu', 'wecom'])(
    'exposes %s when daemon management is enabled',
    (type) => {
      expect(
        isChannelPlatformAvailable({
          type,
          displayName: type,
          manageable: true,
          fields: [],
          auth: ['credentials'],
        }),
      ).toBe(true);
    },
  );

  it('hides all other and unmanageable channel types', () => {
    expect(
      isChannelPlatformAvailable({
        type: 'telegram',
        displayName: 'Telegram',
        manageable: true,
        fields: [],
        auth: ['credentials'],
      }),
    ).toBe(false);
    expect(
      isChannelPlatformAvailable({
        type: 'dingtalk',
        displayName: 'DingTalk',
        manageable: false,
        fields: [],
        auth: ['credentials'],
      }),
    ).toBe(false);
  });
});
