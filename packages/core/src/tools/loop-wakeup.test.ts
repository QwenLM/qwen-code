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
  });

  afterEach(async () => {
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
    // Registered as a wakeup (holds the session open) — not a cron job.
    expect(scheduler.sessionSize).toBe(1);
    expect(scheduler.list()).toHaveLength(0);
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
        scheduleWakeup: () => {
          throw new Error('scheduler boom');
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

    expect(result.error?.message).toBe('scheduler boom');
    expect(result.llmContent).toContain('Error scheduling loop wakeup:');
  });
});
