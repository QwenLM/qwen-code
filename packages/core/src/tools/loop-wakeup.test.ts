/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Storage } from '../config/storage.js';
import { CronScheduler } from '../services/cronScheduler.js';
import type { Config } from '../config/config.js';
import { LoopWakeupTool } from './loop-wakeup.js';

// The scheduling math (clamp / wasClamped / second-precise fire time) is
// covered in cronScheduler.test.ts `session wakeups`. These tests cover the
// tool surface: it delegates to scheduleWakeup and reports the outcome.
describe('LoopWakeupTool', () => {
  let tmpDir: string;
  let scheduler: CronScheduler;
  let tool: LoopWakeupTool;

  function makeConfig(): Config {
    scheduler = new CronScheduler(tmpDir);
    return {
      getCronScheduler: () => scheduler,
      getProjectRoot: () => tmpDir,
    } as unknown as Config;
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loop-wakeup-test-'));
    Storage.setRuntimeBaseDir(tmpDir);
    tool = new LoopWakeupTool(makeConfig());
    scheduler.start(() => {});
  });

  afterEach(async () => {
    scheduler.destroy();
    Storage.setRuntimeBaseDir(null);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('has the correct name', () => {
    expect(tool.name).toBe('loop_wakeup');
  });

  it('uses ask permission because it schedules future model input', async () => {
    const invocation = tool.build({
      delaySeconds: 300,
      prompt: 'continue loop',
    });
    await expect(invocation.getDefaultPermission()).resolves.toBe('ask');
  });

  it('shows the clamped delay in the permission description', () => {
    const invocation = tool.build({ delaySeconds: 5, prompt: 'continue loop' });

    expect(invocation.getDescription()).toBe(
      '60s (requested 5s): continue loop',
    );
  });

  it('shows the plain delay in the permission description when in range', () => {
    const invocation = tool.build({
      delaySeconds: 300,
      prompt: 'continue loop',
    });

    expect(invocation.getDescription()).toBe('300s: continue loop');
  });

  it('does not show rounded in-range delays as requested values', () => {
    const invocation = tool.build({
      delaySeconds: 60.4,
      prompt: 'continue loop',
    });

    expect(invocation.getDescription()).toBe('60s: continue loop');
  });

  it('schedules a session-only one-shot wakeup on the scheduler', async () => {
    const invocation = tool.build({
      delaySeconds: 300,
      prompt: 'continue loop',
      reason: 'CI is still running',
    });

    const result = await invocation.execute(new AbortController().signal);

    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('Session-only one-shot');
    expect(result.llmContent).toContain('Scheduled for:');
    // Registered as a wakeup: it holds the session open and is manageable
    // through CronList/CronDelete, but does not count against cron capacity.
    expect(scheduler.sessionSize).toBe(1);
    expect(scheduler.list()[0]).toMatchObject({
      cronExpr: '@wakeup',
      prompt: 'continue loop',
    });
    expect(scheduler.size).toBe(1);
  });

  it('rejects scheduling when the scheduler is disabled', async () => {
    scheduler.disable();
    const invocation = tool.build({
      delaySeconds: 300,
      prompt: 'continue loop',
    });

    const result = await invocation.execute(new AbortController().signal);

    expect(result.error?.message).toBe(
      'Loop wakeups are disabled for the rest of this session ' +
        '(token limit reached). Restart the session to re-enable.',
    );
    expect(scheduler.sessionSize).toBe(0);
  });

  it('schedules even when the scheduler is stopped but not disabled', async () => {
    // The first self-paced /loop in a session with no cron jobs arms a
    // wakeup before the scheduler has started — the post-prompt hook starts
    // the tick afterwards. A merely-stopped scheduler must not reject.
    scheduler.stop();
    const invocation = tool.build({
      delaySeconds: 300,
      prompt: 'continue loop',
    });

    const result = await invocation.execute(new AbortController().signal);

    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('Scheduled loop wakeup');
    expect(scheduler.sessionSize).toBe(1);
  });

  it('tells the model to re-arm to keep the loop alive', async () => {
    const invocation = tool.build({
      delaySeconds: 300,
      prompt: 'continue loop',
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.llmContent).toContain('keep the loop alive');
  });

  it('reports the clamp when the requested delay is out of range', async () => {
    const invocation = tool.build({ delaySeconds: 5, prompt: 'continue loop' });
    const result = await invocation.execute(new AbortController().signal);

    expect(result.llmContent).toContain('clamped');
    expect(result.llmContent).toContain('Scheduled for:');
    expect(result.llmContent).toContain('(in 60s).');
    expect(result.llmContent).toContain(
      'Requested 5s was clamped to the [60, 3600] s range.',
    );
  });

  it('reports when a wakeup replaces an earlier pending wakeup', async () => {
    const first = await tool
      .build({ delaySeconds: 300, prompt: 'first' })
      .execute(new AbortController().signal);
    const firstId = String(first.llmContent).match(/wakeup ([a-z0-9]+)\./)?.[1];

    const second = await tool
      .build({ delaySeconds: 300, prompt: 'second' })
      .execute(new AbortController().signal);

    expect(firstId).toBeDefined();
    expect(second.llmContent).toContain(`Replaced pending wakeup ${firstId}.`);
  });

  it('does not report a clamp when the delay is in range', async () => {
    const invocation = tool.build({
      delaySeconds: 300,
      prompt: 'continue loop',
    });
    const result = await invocation.execute(new AbortController().signal);

    expect(result.llmContent).not.toContain('clamped');
  });

  it('echoes the reason back to the user', async () => {
    const invocation = tool.build({
      delaySeconds: 300,
      prompt: 'continue loop',
      reason: 'waiting on the deploy',
    });
    const result = await invocation.execute(new AbortController().signal);

    expect(result.llmContent).toContain('waiting on the deploy');
    expect(result.returnDisplay).toContain('waiting on the deploy');
  });

  it('rejects an empty continuation prompt', async () => {
    const invocation = tool.build({ delaySeconds: 300, prompt: '   ' });
    const result = await invocation.execute(new AbortController().signal);

    expect(result.error?.message).toBe('Loop wakeup prompt must not be empty.');
    expect(scheduler.sessionSize).toBe(0);
  });

  it('projects scheduling details into AUTO classifier input', () => {
    expect(
      tool.toAutoClassifierInput({
        delaySeconds: 300,
        prompt: 'continue loop',
        reason: 'CI is still running',
      }),
    ).toEqual({
      delaySeconds: 300,
      prompt: 'continue loop',
      reason: 'CI is still running',
    });
  });

  it('projects the clamped delay into AUTO classifier input', () => {
    expect(
      tool.toAutoClassifierInput({
        delaySeconds: 5,
        prompt: 'continue loop',
      }),
    ).toMatchObject({
      delaySeconds: 60,
      prompt: 'continue loop',
    });
  });

  it('defaults reason to an empty string in classifier input when omitted', () => {
    expect(
      tool.toAutoClassifierInput({
        delaySeconds: 300,
        prompt: 'continue loop',
      }),
    ).toEqual({
      delaySeconds: 300,
      prompt: 'continue loop',
      reason: '',
    });
  });

  it('surfaces a scheduler failure as a structured tool error', async () => {
    const failingConfig = {
      getCronScheduler: () => ({
        disabled: false,
        scheduleWakeup: () => {
          throw new Error('scheduler boom', {
            cause: new Error('clock unavailable'),
          });
        },
      }),
      getProjectRoot: () => tmpDir,
    } as unknown as Config;
    const failingTool = new LoopWakeupTool(failingConfig);
    const invocation = failingTool.build({
      delaySeconds: 300,
      prompt: 'continue loop',
    });

    const result = await invocation.execute(new AbortController().signal);

    expect(result.error?.message).toBe(
      'scheduler boom (cause: clock unavailable)',
    );
    expect(result.llmContent).toContain('Error scheduling loop wakeup:');
  });
});
