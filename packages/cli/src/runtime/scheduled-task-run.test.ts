/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildScheduledTaskRunPrompt,
  scheduledTaskRunSessionName,
  scheduledTaskRunSourceId,
} from './scheduled-task-run.js';

describe('scheduled task run metadata', () => {
  it('builds visible execution context ahead of the original prompt', () => {
    expect(
      buildScheduledTaskRunPrompt({
        id: 'task-1',
        name: 'Hourly review',
        cron: '0 * * * *',
        prompt: 'review the next PR',
        triggeredAt: 123,
        trigger: 'scheduled',
      }),
    ).toBe(
      'Scheduled task: Hourly review\n' +
        'Task ID: task-1\n' +
        'Schedule: 0 * * * *\n' +
        'Triggered at: 1970-01-01T00:00:00.123Z\n' +
        'Trigger: scheduled\n' +
        'Session: new chat for this run\n\n' +
        'This is a scheduled task run. Execute the instructions below now. Do not create or modify a schedule unless the instructions explicitly ask you to.\n\n' +
        'review the next PR',
    );
  });

  it('keeps metadata on one line without changing the task prompt', () => {
    const prompt = buildScheduledTaskRunPrompt({
      id: 'task-2',
      name: '  Daily\x1b[31m\n digest  ',
      cron: '30 9 * * *',
      prompt: 'line one\nline two',
      triggeredAt: 0,
      trigger: 'manual',
    });
    expect(prompt).toContain('Scheduled task: Daily digest\n');
    expect(prompt).toContain('Trigger: manual\n');
    expect(prompt).toMatch(/\n\nline one\nline two$/);
  });

  it('titles a run session with the task label and local trigger time', () => {
    const at = new Date(2026, 7, 26, 16, 0);
    expect(
      scheduledTaskRunSessionName('  Hourly\x1b[31m  review ', at.getTime()),
    ).toBe('Hourly review · 08-26 16:00');
  });

  it('keeps the time suffix when a long label is cut to the title ceiling', () => {
    const at = new Date(2026, 0, 5, 9, 7);
    const name = scheduledTaskRunSessionName('x'.repeat(80), at.getTime());
    expect(name).toHaveLength(60);
    expect(name.endsWith('… · 01-05 09:07')).toBe(true);
  });

  it('builds a stable source id for the run session', () => {
    expect(scheduledTaskRunSourceId('task-3')).toBe(
      'scheduled_task_run:task-3',
    );
  });
});
