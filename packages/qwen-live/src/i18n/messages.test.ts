/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  LIVE_MESSAGES,
  displayLiveMessage,
  liveMessage,
  liveText,
} from './messages.js';

describe('Live display text catalogue', () => {
  it('keeps English and Chinese placeholders in sync for every text', () => {
    for (const pair of Object.values(LIVE_MESSAGES)) {
      expect(pair.en.trim()).not.toBe('');
      expect(pair['zh-CN'].trim()).not.toBe('');
      const placeholders = (value: string) =>
        (value.match(/\{\w+\}/g) ?? []).sort();
      expect(placeholders(pair.en)).toEqual(placeholders(pair['zh-CN']));
    }
  });

  it('renders stable messages and safe Electron wrappers without translating user content', () => {
    const marker = liveMessage('host.device.fallback', { index: 2 });
    expect(displayLiveMessage('zh-CN', marker)).toBe('麦克风 2');
    expect(
      displayLiveMessage(
        'en',
        `Error invoking remote method 'live:set-language': Error: ${marker}`,
      ),
    ).toBe('Microphone 2');
    expect(displayLiveMessage('zh-CN', `My named library ${marker}`)).toBe(
      `My named library ${marker}`,
    );
    expect(displayLiveMessage('zh-CN', 'User-supplied library')).toBe(
      'User-supplied library',
    );
    expect(
      displayLiveMessage('zh-CN', 'qwen-live-ui:{"key":"unknown","params":{}}'),
    ).toContain('unknown');
    expect(
      displayLiveMessage('zh-CN', 'camera_snapshot_resolution_unavailable'),
    ).toBe(liveText('zh-CN', 'code.camera_snapshot_resolution_unavailable'));
  });

  it('points config-file recovery at the standalone Live initializer', () => {
    for (const language of ['en', 'zh-CN'] as const) {
      expect(liveText(language, 'host.config.inaccessible')).toContain(
        'qwen-live init',
      );
      expect(liveText(language, 'host.config.inaccessible')).not.toContain(
        'qwen live init',
      );
    }
  });

  it('warns about sensitive debug recordings in both languages', () => {
    expect(liveText('en', 'cli.usage')).toContain(
      'save sensitive visual Monitor archives',
    );
    expect(liveText('zh-CN', 'cli.usage')).toContain(
      '保存含敏感内容的视觉 Monitor 归档',
    );
    expect(liveText('en', 'cli.debugNotice')).toContain(
      'archives contain real screen/camera frames, audio and prompt/response text',
    );
    expect(liveText('zh-CN', 'cli.debugNotice')).toContain(
      '归档包含真实屏幕／摄像头画面、音频和提示词／回复文本',
    );
  });

  it('bounds encoded details without emitting truncated JSON', () => {
    for (const detail of [
      'large '.repeat(2000),
      '\u0000'.repeat(300),
      '\\"\n'.repeat(300),
    ]) {
      const message = liveMessage('host.error.requiredMessage', {
        messageType: detail,
      });
      expect(message.length).toBeLessThanOrEqual(512);
      expect(displayLiveMessage('en', message)).toContain(
        'Required Live message',
      );
      expect(displayLiveMessage('zh-CN', message)).not.toContain(
        'qwen-live-ui:',
      );
    }
  });

  it('resolves a nested owned message while retaining external detail', () => {
    const message = liveMessage('host.error.requiredMessage', {
      messageType: liveMessage('ui.settings'),
    });
    expect(displayLiveMessage('zh-CN', message)).toContain('“设置”');
  });
});
