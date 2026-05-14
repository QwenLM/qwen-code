/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { selfImproveCommand } from './selfImproveCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import type { CommandContext } from './types.js';

const execFileAsync = promisify(execFile);

describe('selfImproveCommand', () => {
  let tempDir: string;
  let context: CommandContext;
  const scheduler = {
    create: vi.fn(() => ({ id: 'job-1' })),
    list: vi.fn(() => [{ id: 'job-1' }]),
    delete: vi.fn(() => true),
  };

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'self-improve-test-'));
    await execFileAsync('git', ['init'], { cwd: tempDir });
    scheduler.create.mockClear();
    scheduler.list.mockClear();
    scheduler.delete.mockClear();
    context = createMockCommandContext({
      executionMode: 'interactive',
      services: {
        config: {
          getWorkingDir: () => tempDir,
          getProjectRoot: () => tempDir,
          isCronEnabled: () => true,
          getCronScheduler: () => scheduler,
        } as never,
      },
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('opens the source dialog in interactive mode', async () => {
    const result = await selfImproveCommand.action?.(context, 'source');
    expect(result).toEqual({
      type: 'dialog',
      dialog: 'self-improve-source',
    });
  });

  it('rejects source configuration outside interactive mode', async () => {
    context.executionMode = 'non_interactive';
    const result = await selfImproveCommand.action?.(context, 'source');
    expect(result).toMatchObject({
      type: 'message',
      messageType: 'error',
    });
  });

  it('declares public subcommands and argument hints for completion', () => {
    expect(selfImproveCommand.argumentHint).toBe('source|start|status|stop');
    expect(
      selfImproveCommand.subCommands?.map((command) => command.name),
    ).toEqual(['source', 'start', 'status', 'stop', 'tick']);
    expect(
      selfImproveCommand.subCommands?.find(
        (command) => command.name === 'start',
      )?.argumentHint,
    ).toBe('--every <interval> [prompt]');
    expect(
      selfImproveCommand.subCommands?.find((command) => command.name === 'tick')
        ?.hidden,
    ).toBe(true);
  });

  it('starts a session loop and submits the first tick prompt', async () => {
    const result = await selfImproveCommand.action?.(
      context,
      'start --every 2h prefer small fixes',
    );

    expect(result).toMatchObject({ type: 'submit_prompt' });
    expect(scheduler.create).toHaveBeenCalledWith(
      '7 */2 * * *',
      expect.stringMatching(/^\/self-improve tick /),
      true,
    );

    const activeRaw = await fs.readFile(
      path.join(tempDir, '.qwen', 'self-improve', 'active.json'),
      'utf8',
    );
    const active = JSON.parse(activeRaw) as { activeLoopId: string };
    const stateRaw = await fs.readFile(
      path.join(
        tempDir,
        '.qwen',
        'self-improve',
        'loops',
        active.activeLoopId,
        'state.json',
      ),
      'utf8',
    );
    const state = JSON.parse(stateRaw) as { prompt: string; cronJobId: string };
    expect(state.prompt).toBe('prefer small fixes');
    expect(state.cronJobId).toBe('job-1');
    expect(
      path.join(
        tempDir,
        '.qwen',
        'self-improve',
        'loops',
        active.activeLoopId,
        'summary.md',
      ),
    ).toBeTruthy();
  });

  it('reports active loop status', async () => {
    await selfImproveCommand.action?.(context, 'start --every 30m');
    const result = await selfImproveCommand.action?.(context, 'status');
    expect(result).toMatchObject({
      type: 'message',
      messageType: 'info',
    });
    expect((result as { content: string }).content).toContain(
      'Status: running',
    );
    expect((result as { content: string }).content).toContain('Cadence: 30m');
  });
});
