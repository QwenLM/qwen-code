/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { detectProactiveRepairIntent } from './tool-repair.js';

describe('Proactive missing-tool repair detection', () => {
  it.each([
    '好的，我会一直帮你盯着锅，冒烟就通知你。',
    '我来继续听着，听到咳嗽就提醒你。',
    '奴才遵旨，只要听到您咳嗽，奴才立马就提醒您。',
    '我会在五分钟后提醒你喝水。',
  ])('detects an assistant promise: %s', (text) => {
    expect(detectProactiveRepairIntent(text)).toBe('mutation');
  });

  it.each([
    '好的，已经停止手部动作描述了。',
    '画面解说已取消。',
    '可以，我为你关闭这个监控任务。',
  ])('detects an unsupported cancellation claim: %s', (text) => {
    expect(detectProactiveRepairIntent(text)).toBe('cancel');
  });

  it.each([
    '帮我盯着锅，冒烟了告诉我。',
    '有变化告诉我。',
    '别让我走神。',
    '提醒我五分钟后喝水。',
    '我不会持续监测这个画面。',
    '奴才建议您设置一个咳嗽提醒。',
    '奴才不会在后台监听或提醒您。',
    '我会尝试，但无法在回复结束后继续提醒。',
    '抱歉，这次没能停止画面解说。',
  ])(
    'does not infer a repair from requests or negative replies: %s',
    (text) => {
      expect(detectProactiveRepairIntent(text)).toBeUndefined();
    },
  );
});
