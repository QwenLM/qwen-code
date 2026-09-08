/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildMonitorInstruction,
  formatProactiveEvent,
  parseMonitorAction,
} from './monitor-protocol.js';

describe('Proactive monitor protocol', () => {
  it('uses only the condition as the event standing instruction', () => {
    expect(
      buildMonitorInstruction({
        title: 'Tea',
        taskDescription: 'The kettle starts boiling',
        monitorMode: 'event',
        narrationStyle: 'Do not leak this response guidance',
      }),
    ).toBe('The kettle starts boiling');
  });

  it('appends narration style only for always mode', () => {
    expect(
      buildMonitorInstruction({
        title: 'Narrate',
        taskDescription: 'Describe meaningful changes',
        monitorMode: 'always',
        narrationStyle: 'Use concise Chinese.',
      }),
    ).toBe('Describe meaningful changes\nUse concise Chinese.');
  });

  it('accepts only the trained action head', () => {
    expect(parseMonitorAction('wait', 'event').triggered).toBe(false);
    expect(parseMonitorAction('Reply: 水开了', 'event')).toMatchObject({
      triggered: true,
      summary: '水开了',
    });
    expect(parseMonitorAction('Func_call:好的\n{}', 'event').triggered).toBe(
      false,
    );
    expect(() => parseMonitorAction('水开了', 'event')).toThrow(
      'Monitor action',
    );
    expect(() =>
      parseMonitorAction('<think>secret</think>\nReply: 水开了', 'event'),
    ).toThrow('Monitor action');
  });

  it('normalizes narration wrappers but leaves event evidence unchanged', () => {
    expect(
      parseMonitorAction('Reply: 好的，我现在看到一只猫进来了', 'always'),
    ).toMatchObject({ summary: '一只猫进来了', currentState: '一只猫进来了' });
    expect(
      parseMonitorAction('Reply: 我现在看到一只猫进来了', 'event').summary,
    ).toBe('我现在看到一只猫进来了');
  });

  it('formats a generation-bearing foreground event', () => {
    const event = formatProactiveEvent({
      taskId: 'task_1',
      deliveryId: 'delivery_1',
      title: 'Tea',
      taskType: 'perception_monitor',
      summary: 'The kettle is boiling.',
      sourceModalities: ['vision', 'audio'],
      interventionText: 'Tell me to turn it off.',
      monitorMode: 'event',
    });
    expect(event).toContain('[PROACTIVE_EVENT]');
    expect(event).toContain('"delivery_id": "delivery_1"');
    expect(event).toContain('Tell me to turn it off.');
  });
});
