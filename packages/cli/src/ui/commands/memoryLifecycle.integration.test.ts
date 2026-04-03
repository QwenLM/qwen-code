/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyExtractedMemoryPatches,
  ensureAutoMemoryScaffold,
  getAutoMemoryTopicPath,
  resetManagedAutoMemoryExtractRuntimeForTests,
  resetAutoMemoryStateForTests,
} from '@qwen-code/qwen-code-core';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { forgetCommand } from './forgetCommand.js';
import { memoryCommand } from './memoryCommand.js';
import type { SlashCommand, CommandContext } from './types.js';

describe('managed memory CLI integration', () => {
  let tempDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-cli-int-'));
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
    await ensureAutoMemoryScaffold(projectRoot, new Date('2026-04-01T00:00:00.000Z'));
  });

  afterEach(async () => {
    resetAutoMemoryStateForTests();
    resetManagedAutoMemoryExtractRuntimeForTests();
    await fs.rm(tempDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 10,
    });
  });

  function getMemorySubCommand(name: string): SlashCommand {
    const subCommand = memoryCommand.subCommands?.find((command) => command.name === name);
    if (!subCommand) {
      throw new Error(`Missing /memory ${name} command`);
    }
    return subCommand;
  }

  function createContext(history: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = []): CommandContext {
    return createMockCommandContext({
      services: {
        config: {
          getProjectRoot: vi.fn().mockReturnValue(projectRoot),
          getSessionId: vi.fn().mockReturnValue('session-1'),
          getGeminiClient: vi.fn().mockReturnValue({
            getChat: vi.fn().mockReturnValue({
              getHistory: vi.fn().mockReturnValue(history),
            }),
          }),
        },
      },
    });
  }

  it('surfaces extraction, status, tasks, inspect, review, and forget flows through CLI commands', async () => {
    const extractContext = createContext([
      { role: 'user', parts: [{ text: 'I prefer terse responses.' }] },
      {
        role: 'user',
        parts: [{ text: 'The latency dashboard is https://grafana.example/d/api-latency' }],
      },
    ]);

    await getMemorySubCommand('extract-now').action?.(extractContext, '');
    const extractText = (extractContext.ui.addItem as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]?.text;
    expect(extractText).toContain('Managed auto-memory updated');

    const statusContext = createContext();
    await getMemorySubCommand('status').action?.(statusContext, '');
    const statusText = (statusContext.ui.addItem as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]?.text;
    expect(statusText).toContain(`Managed auto-memory root: ${projectRoot}/.qwen/memory`);
    expect(statusText).toContain('Extraction tasks: active=0, tracked=1');

    const tasksContext = createContext();
    await getMemorySubCommand('tasks').action?.(tasksContext, '');
    const tasksText = (tasksContext.ui.addItem as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]?.text;
    expect(tasksText).toContain('Managed auto-memory background tasks:');
    expect(tasksText).toContain('Extraction timeline:');

    const inspectContext = createContext();
    await getMemorySubCommand('inspect').action?.(inspectContext, 'user');
    const inspectText = (inspectContext.ui.addItem as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]?.text;
    expect(inspectText).toContain('I prefer terse responses.');

    await applyExtractedMemoryPatches(projectRoot, [
      {
        topic: 'project',
        summary: 'This is temporary for this task.',
        sourceOffset: 10,
      },
    ]);

    const reviewContext = createContext();
    await getMemorySubCommand('review').action?.(reviewContext, '');
    const reviewText = (reviewContext.ui.addItem as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]?.text;
    expect(reviewText).toContain('Managed auto-memory governance review');
    expect(reviewText).toMatch(/\[(forget|promote)\]/);

    const memoryForgetContext = createContext();
    await getMemorySubCommand('forget').action?.(memoryForgetContext, 'temporary for this task');
    const previewText = (memoryForgetContext.ui.addItem as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]?.text;
    expect(previewText).toContain('Forget preview');
    expect(previewText).toContain('/memory forget --apply temporary for this task');

    await getMemorySubCommand('forget').action?.(memoryForgetContext, '--apply temporary for this task');
    const memoryForgetApplyText = (memoryForgetContext.ui.addItem as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]?.text;
    expect(memoryForgetApplyText).toContain('Managed auto-memory forgot 1 entry');

    const forgetContext = createContext();
    const topLevelPreview = await forgetCommand.action?.(
      forgetContext,
      'terse responses',
    );
    expect(topLevelPreview).toEqual(
      expect.objectContaining({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('Forget preview'),
      }),
    );
    expect((topLevelPreview as { content: string }).content).toContain(
      '/forget --apply terse responses',
    );

    const topLevelApply = await forgetCommand.action?.(
      forgetContext,
      '--apply terse responses',
    );
    expect(topLevelApply).toEqual(
      expect.objectContaining({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('Managed auto-memory forgot 1 entry'),
      }),
    );

    const userContentAfterForget = await fs.readFile(
      getAutoMemoryTopicPath(projectRoot, 'user'),
      'utf-8',
    );
    expect(userContentAfterForget).not.toContain('I prefer terse responses.');
  });
});