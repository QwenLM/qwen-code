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

  it('marks a persistent run as reusing the task conversation', () => {
    const prompt = buildScheduledTaskRunPrompt({
      id: 'task-3',
      name: 'Daily restart',
      cron: '0 9 * * *',
      prompt: 'restart the server',
      triggeredAt: 0,
      trigger: 'scheduled',
      sessionMode: 'persistent',
    });

    expect(prompt).toContain('Session: reuse the task conversation\n');
    expect(prompt).toMatch(/\n\nrestart the server$/);
  });

  it("heads an unnamed task's card with a prompt-derived label, not its id", () => {
    const prompt = buildScheduledTaskRunPrompt({
      id: 'k3j9x0ab',
      cron: '0 9 * * *',
      prompt: 'Summarize the overnight alerts and post to #ops',
      triggeredAt: 0,
      trigger: 'scheduled',
    });
    expect(prompt).toContain(
      'Scheduled task: Summarize the overnight alerts and post to #ops\n',
    );
    expect(prompt).toContain('Task ID: k3j9x0ab\n');
    expect(prompt).not.toContain('Scheduled task: k3j9x0ab');
  });

  it('cuts a long prompt-derived heading on a code-point boundary', () => {
    const prompt = buildScheduledTaskRunPrompt({
      id: 'k3j9x0ab',
      cron: '0 9 * * *',
      prompt: 'x'.repeat(59) + '\u{1F600}tail',
      triggeredAt: 0,
      trigger: 'scheduled',
    });
    const heading = prompt.split('\n', 1)[0]!;
    expect(heading).toBe(`Scheduled task: ${'x'.repeat(59)}…`);
    expect(heading).not.toContain('\uFFFD');
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

  it('names sentinel-prompt run sessions after what they run, not the raw marker', () => {
    // Mirrors the controller namer: a durable /loop task converted to per-run
    // must not title its child sessions with the literal internal sentinel.
    const at = new Date(2026, 8, 13, 12, 0).getTime();
    expect(scheduledTaskRunSessionName('<<loop.md>>', at)).toBe(
      'Loop (loop.md) · 09-13 12:00',
    );
    expect(scheduledTaskRunSessionName('<<autonomous-loop-dynamic>>', at)).toBe(
      'Autonomous loop · 09-13 12:00',
    );
    // An ordinary prompt that merely mentions a marker is not a sentinel.
    expect(scheduledTaskRunSessionName('check <<loop.md>> coverage', at)).toBe(
      'check <<loop.md>> coverage · 09-13 12:00',
    );
  });

  it('builds a stable source id for the run session', () => {
    expect(scheduledTaskRunSourceId('task-3')).toBe(
      'scheduled_task_run:task-3',
    );
  });
});
