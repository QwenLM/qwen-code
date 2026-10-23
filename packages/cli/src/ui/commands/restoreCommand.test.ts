/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { useLayoutEffect, useRef } from 'react';
import { renderHook, act } from '@testing-library/react';
import { useHistory } from '../hooks/useHistoryManager.js';
import type { HistoryItem } from '../types.js';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { restoreCommand } from './restoreCommand.js';
import { type CommandContext, type SlashCommandActionReturn } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import {
  findApiHistoryPromptIndex,
  type Config,
} from '@qwen-code/qwen-code-core';
import type { Content } from '@google/genai';

describe('restoreCommand', () => {
  let mockContext: CommandContext;
  let mockConfig: Config;
  let mockSetHistory: ReturnType<typeof vi.fn>;
  let mockRewind: ReturnType<typeof vi.fn>;
  let testRootDir: string;
  let geminiTempDir: string;
  let checkpointsDir: string;

  beforeEach(async () => {
    testRootDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'restore-command-test-'),
    );
    geminiTempDir = path.join(testRootDir, '.gemini');
    checkpointsDir = path.join(geminiTempDir, 'checkpoints');
    // The command itself creates this, but for tests it's easier to have it ready.
    // Some tests might remove it to test error paths.
    await fs.mkdir(checkpointsDir, { recursive: true });

    mockSetHistory = vi.fn().mockResolvedValue(undefined);
    mockRewind = vi
      .fn()
      .mockResolvedValue({ filesChanged: [], filesFailed: [] });

    mockConfig = {
      getSessionId: vi.fn().mockReturnValue('original'),
      getFileCheckpointingEnabled: vi.fn().mockReturnValue(true),
      getFileHistoryService: vi.fn().mockReturnValue({ rewind: mockRewind }),
      storage: {
        getProjectTempCheckpointsDir: vi.fn().mockReturnValue(checkpointsDir),
        getProjectTempDir: vi.fn().mockReturnValue(geminiTempDir),
      },
      getLlmClient: vi.fn().mockReturnValue({
        setHistory: mockSetHistory,
      }),
    } as unknown as Config;

    mockContext = createMockCommandContext({
      services: {
        config: mockConfig,
      },
    });
    mockContext.ui.clearPendingState = vi.fn();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(testRootDir, { recursive: true, force: true });
  });

  it.each(['', 'missing'])(
    'does not return an old checkpoint listing or lookup after a session change: %s',
    async (args) => {
      const pending = restoreCommand(mockConfig)!.action!(mockContext, args);
      vi.mocked(mockConfig.getSessionId).mockReturnValue('successor');
      expect(await pending).toBeUndefined();
      expect(mockRewind).not.toHaveBeenCalled();
      expect(mockSetHistory).not.toHaveBeenCalled();
      expect(mockContext.ui.addItem).not.toHaveBeenCalled();
    },
  );

  it.each(['session', 'same-session-history', 'new-turn', 'cancel'] as const)(
    'keeps late file restoration from replaying into %s',
    async (change) => {
      const checkpoint = {
        promptId: 'old-prompt',
        toolCall: { name: 'write_file', args: { file_path: 'old.txt' } },
        history: [{ id: 1, type: 'user', text: 'old' }],
        clientHistory: [{ role: 'user', parts: [{ text: 'old' }] }],
      };
      await fs.writeFile(
        path.join(checkpointsDir, 'old.json'),
        JSON.stringify(checkpoint),
      );
      let release!: () => void;
      const didRestore = vi.fn();
      mockRewind.mockImplementation(async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        didRestore();
        return { filesChanged: ['old.txt'], filesFailed: [] };
      });
      const controller = new AbortController();
      mockContext.abortSignal = controller.signal;
      const pending = restoreCommand(mockConfig)!.action!(mockContext, 'old');
      await vi.waitFor(() => expect(mockRewind).toHaveBeenCalledOnce());
      if (change === 'session')
        vi.mocked(mockConfig.getSessionId).mockReturnValue('successor');
      if (change === 'same-session-history')
        mockContext.ui.history = [{ id: 2, type: 'user', text: 'successor' }];
      if (change === 'new-turn') mockContext.ui.isIdleRef.current = false;
      if (change === 'cancel') controller.abort();
      release();
      expect(await pending).toBeUndefined();
      expect(didRestore).toHaveBeenCalledOnce();
      expect(mockSetHistory).not.toHaveBeenCalled();
      expect(mockContext.ui.loadHistory).not.toHaveBeenCalled();
      expect(mockContext.ui.addItem).not.toHaveBeenCalled();
    },
  );

  it.each([
    'owned',
    'wrong-id',
    'wrong-text',
    'later-item',
    'replaced-prefix',
    'cancel',
  ] as const)(
    'accepts only its own newly published invocation during restore: %s',
    async (change) => {
      const original: HistoryItem = { id: 1, type: 'user', text: 'old' };
      mockContext.ui.history = [original];
      mockContext.invocation = {
        raw: '/restore owned',
        name: 'restore',
        args: 'owned',
        historyItemId: 2,
      };
      const controller = new AbortController();
      mockContext.abortSignal = controller.signal;
      await fs.writeFile(
        path.join(checkpointsDir, 'owned.json'),
        JSON.stringify({
          promptId: 'old-prompt',
          clientHistory: [{ role: 'user', parts: [{ text: 'old' }] }],
          toolCall: { name: 'run_shell_command', args: { command: 'pwd' } },
        }),
      );
      let release!: () => void;
      mockRewind.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ filesChanged: [], filesFailed: [] });
          }),
      );
      mockContext.ui.addItem = vi.fn((item) => {
        mockContext.ui.history = [
          ...mockContext.ui.history,
          { ...item, id: 3 } as HistoryItem,
        ];
        return 3;
      });
      const pending = restoreCommand(mockConfig)!.action!(mockContext, 'owned');
      try {
        await vi.waitFor(() => expect(mockRewind).toHaveBeenCalledOnce());
        mockContext.ui.history = [
          change === 'replaced-prefix' ? { ...original } : original,
          {
            id: change === 'wrong-id' ? 4 : 2,
            type: 'user',
            text: change === 'wrong-text' ? 'successor' : '/restore owned',
          },
          ...(change === 'later-item'
            ? [{ id: 5, type: 'info' as const, text: 'new activity' }]
            : []),
        ];
        if (change === 'cancel') controller.abort();
        release();
        expect(await pending).toEqual(
          change === 'owned'
            ? {
                type: 'tool',
                toolName: 'run_shell_command',
                toolArgs: { command: 'pwd' },
              }
            : undefined,
        );
        expect(mockSetHistory).toHaveBeenCalledTimes(
          change === 'owned' ? 1 : 0,
        );
        expect(mockContext.ui.addItem).toHaveBeenCalledTimes(
          change === 'owned' ? 1 : 0,
        );
      } finally {
        release?.();
        await pending;
      }
    },
  );

  it.each(['loaded', 'notice-only', 'successor'] as const)(
    'guards deferred tool replay across the real Ink history publication: %s',
    async (change) => {
      const loaded: HistoryItem[] = [
        { id: 9, type: 'user', text: 'checkpoint' },
      ];
      const checkpoint = {
        promptId: 'checkpoint-prompt',
        toolCall: { name: 'write_file', args: { file_path: 'owned.txt' } },
        ...(change === 'notice-only' ? {} : { history: loaded }),
        clientHistory: [{ role: 'user', parts: [{ text: 'checkpoint' }] }],
      };
      await fs.writeFile(
        path.join(checkpointsDir, 'render.json'),
        JSON.stringify(checkpoint),
      );
      const view = renderHook(() => {
        const manager = useHistory();
        const historyRef = useRef(manager.history);
        useLayoutEffect(() => {
          historyRef.current = manager.history;
        }, [manager.history]);
        return { ...manager, historyRef };
      });
      Object.defineProperty(mockContext.ui, 'history', {
        get: () => view.result.current.historyRef.current,
      });
      mockContext.ui.addItem = view.result.current.addItem;
      let beforeLoad!: readonly HistoryItem[];
      mockContext.ui.loadHistory = (history) => {
        beforeLoad = mockContext.ui.history;
        view.result.current.loadHistory(history);
        expect(mockContext.ui.history).toBe(beforeLoad);
      };
      let release!: () => void;
      mockSetHistory.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      let pending!:
        | void
        | SlashCommandActionReturn
        | Promise<void | SlashCommandActionReturn>;
      try {
        await act(async () => {
          pending = restoreCommand(mockConfig)!.action!(mockContext, 'render');
          await vi.waitFor(() => expect(mockSetHistory).toHaveBeenCalledOnce());
        });
        if (change === 'notice-only') {
          expect(view.result.current.history).toEqual([
            expect.objectContaining({ type: 'info' }),
          ]);
        } else {
          expect(view.result.current.history).toEqual(loaded);
          expect(mockContext.ui.history).not.toBe(beforeLoad);
        }
        if (change === 'successor')
          act(() =>
            view.result.current.loadHistory([
              { id: 10, type: 'user', text: 'successor' },
            ]),
          );
        release();
        const result = await pending;
        expect(result).toEqual(
          change === 'successor'
            ? undefined
            : {
                type: 'tool',
                toolName: 'write_file',
                toolArgs: { file_path: 'owned.txt' },
              },
        );
      } finally {
        release?.();
        view.unmount();
      }
    },
  );

  it('should return null if checkpointing is not enabled', () => {
    vi.mocked(mockConfig.getFileCheckpointingEnabled).mockReturnValue(false);

    expect(restoreCommand(mockConfig)).toBeNull();
  });

  it('should return the command if checkpointing is enabled', () => {
    expect(restoreCommand(mockConfig)).toEqual(
      expect.objectContaining({
        name: 'restore',
        description: expect.any(String),
        action: expect.any(Function),
        completion: expect.any(Function),
      }),
    );
  });

  it('rejects direct restore before creating directories or restoring files in tool sandbox', async () => {
    const command = restoreCommand(mockConfig);
    mockConfig.getShellExecutionSandbox = vi
      .fn()
      .mockReturnValue({ backend: 'bwrap' });
    await fs.rm(checkpointsDir, { recursive: true, force: true });

    expect(await command?.action?.(mockContext, 'checkpoint')).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'File restore is unavailable in tool sandbox.',
    });
    expect(
      mockConfig.storage.getProjectTempCheckpointsDir,
    ).not.toHaveBeenCalled();
    expect(mockRewind).not.toHaveBeenCalled();
    await expect(fs.stat(checkpointsDir)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  describe('action', () => {
    it('should return an error if temp dir is not found', async () => {
      vi.mocked(
        mockConfig.storage.getProjectTempCheckpointsDir,
      ).mockReturnValue('');

      expect(
        await restoreCommand(mockConfig)?.action?.(mockContext, ''),
      ).toEqual({
        type: 'message',
        messageType: 'error',
        content: 'Could not determine the .qwen directory path.',
      });
    });

    it('should inform when no checkpoints are found if no args are passed', async () => {
      // Remove the directory to ensure the command creates it.
      await fs.rm(checkpointsDir, { recursive: true, force: true });
      const command = restoreCommand(mockConfig);

      expect(await command?.action?.(mockContext, '')).toEqual({
        type: 'message',
        messageType: 'info',
        content: 'No restorable tool calls found.',
      });
      // Verify the directory was created by the command.
      await expect(fs.stat(checkpointsDir)).resolves.toBeDefined();
    });

    it('should list available checkpoints if no args are passed', async () => {
      await fs.writeFile(path.join(checkpointsDir, 'test1.json'), '{}');
      await fs.writeFile(path.join(checkpointsDir, 'test2.json'), '{}');
      const command = restoreCommand(mockConfig);

      expect(await command?.action?.(mockContext, '')).toEqual({
        type: 'message',
        messageType: 'info',
        content: 'Available tool calls to restore:\n\ntest1\ntest2',
      });
    });

    it('should return an error if the specified file is not found', async () => {
      await fs.writeFile(path.join(checkpointsDir, 'test1.json'), '{}');
      const command = restoreCommand(mockConfig);

      expect(await command?.action?.(mockContext, 'test2')).toEqual({
        type: 'message',
        messageType: 'error',
        content: 'File not found: test2.json',
      });
    });

    it('should handle file read errors gracefully', async () => {
      const checkpointName = 'test1';
      const checkpointPath = path.join(
        checkpointsDir,
        `${checkpointName}.json`,
      );
      // Create a directory instead of a file to cause a read error.
      await fs.mkdir(checkpointPath);
      const command = restoreCommand(mockConfig);

      expect(await command?.action?.(mockContext, checkpointName)).toEqual({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining(
          'Could not read restorable tool calls.',
        ),
      });
    });

    it('should restore a tool call and project state', async () => {
      const toolCallData = {
        history: [
          {
            type: 'user',
            text: 'do a thing',
            promptId: 'prompt-abc123',
          },
        ],
        clientHistory: [{ role: 'user', parts: [{ text: 'do a thing' }] }],
        promptId: 'prompt-abc123',
        toolCall: { name: 'run_shell_command', args: 'ls' },
      };
      await fs.writeFile(
        path.join(checkpointsDir, 'my-checkpoint.json'),
        JSON.stringify(toolCallData),
      );
      const command = restoreCommand(mockConfig);

      expect(await command?.action?.(mockContext, 'my-checkpoint')).toEqual({
        type: 'tool',
        toolName: 'run_shell_command',
        toolArgs: 'ls',
      });
      expect(mockContext.ui.loadHistory).toHaveBeenCalledWith(
        toolCallData.history,
      );
      expect(mockContext.ui.clearPendingState).toHaveBeenCalledTimes(1);
      expect(mockSetHistory).toHaveBeenCalledWith(toolCallData.clientHistory);
      expect(mockRewind).toHaveBeenCalledWith(toolCallData.promptId, true);
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: 'info',
          text: 'Restored project to the state at the start of this turn.',
        },
        expect.any(Number),
      );
    });

    it('re-marks the restored model history so rewind can resolve it', async () => {
      const toolCallData = {
        history: [
          {
            type: 'user',
            text: 'do a thing',
            promptId: 'prompt-abc123',
          },
        ],
        clientHistory: [{ role: 'user', parts: [{ text: 'do a thing' }] }],
        promptIds: ['prompt-abc123'],
        promptId: 'prompt-abc123',
        toolCall: { name: 'run_shell_command', args: 'ls' },
      };
      await fs.writeFile(
        path.join(checkpointsDir, 'marked-checkpoint.json'),
        JSON.stringify(toolCallData),
      );
      const command = restoreCommand(mockConfig);

      await command?.action?.(mockContext, 'marked-checkpoint');

      // JSON cannot carry the Symbol-keyed identity, so the restored entries
      // only become rewindable through the persisted parallel array.
      const installed = mockSetHistory.mock.calls[0]?.[0] as Content[];
      expect(installed).toHaveLength(1);
      expect(findApiHistoryPromptIndex(installed, 'prompt-abc123')).toBe(0);
    });

    it('should restore even if only toolCall is present', async () => {
      const toolCallData = {
        toolCall: { name: 'run_shell_command', args: 'ls' },
      };
      await fs.writeFile(
        path.join(checkpointsDir, 'my-checkpoint.json'),
        JSON.stringify(toolCallData),
      );

      const command = restoreCommand(mockConfig);

      expect(await command?.action?.(mockContext, 'my-checkpoint')).toEqual({
        type: 'tool',
        toolName: 'run_shell_command',
        toolArgs: 'ls',
      });

      expect(mockContext.ui.loadHistory).not.toHaveBeenCalled();
      expect(mockSetHistory).not.toHaveBeenCalled();
      expect(mockRewind).not.toHaveBeenCalled();
    });
  });

  it('should reject legacy checkpoint format with commitHash', async () => {
    const toolCallData = {
      commitHash: 'abc123',
      toolCall: { name: 'run_shell_command', args: 'ls' },
    };
    await fs.writeFile(
      path.join(checkpointsDir, 'legacy.json'),
      JSON.stringify(toolCallData),
    );
    const command = restoreCommand(mockConfig);

    expect(await command?.action?.(mockContext, 'legacy')).toEqual({
      type: 'message',
      messageType: 'error',
      content: expect.stringContaining('legacy format'),
    });
    expect(mockRewind).not.toHaveBeenCalled();
    expect(mockContext.ui.loadHistory).not.toHaveBeenCalled();
  });

  it('should abort tool replay when rewind has partial failures', async () => {
    mockRewind.mockResolvedValue({
      filesChanged: ['a.ts'],
      filesFailed: ['b.ts'],
    });
    const toolCallData = {
      promptId: 'prompt-abc',
      toolCall: { name: 'edit', args: { file_path: 'a.ts' } },
    };
    await fs.writeFile(
      path.join(checkpointsDir, 'partial.json'),
      JSON.stringify(toolCallData),
    );
    const command = restoreCommand(mockConfig);

    const result = await command?.action?.(mockContext, 'partial');
    expect(result).toBeUndefined();
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'warning',
        text: expect.stringContaining('Partially restored'),
      }),
      expect.any(Number),
    );
    expect(mockContext.ui.loadHistory).not.toHaveBeenCalled();
  });

  it('should abort tool replay when rewind throws', async () => {
    mockRewind.mockRejectedValue(
      new Error('The selected snapshot was not found'),
    );
    const toolCallData = {
      promptId: 'prompt-missing',
      toolCall: { name: 'edit', args: { file_path: 'a.ts' } },
    };
    await fs.writeFile(
      path.join(checkpointsDir, 'missing-snapshot.json'),
      JSON.stringify(toolCallData),
    );
    const command = restoreCommand(mockConfig);

    const result = await command?.action?.(mockContext, 'missing-snapshot');
    expect(result).toBeUndefined();
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'warning',
        text: expect.stringContaining('Could not restore files'),
      }),
      expect.any(Number),
    );
    expect(mockContext.ui.loadHistory).not.toHaveBeenCalled();
  });

  it('should not mutate state for a checkpoint file missing the toolCall property', async () => {
    const checkpointName = 'missing-toolcall';
    const toolCallData = {
      history: [{ type: 'user', text: 'do a thing' }],
      clientHistory: [{ role: 'user', parts: [{ text: 'do a thing' }] }],
      promptId: 'prompt-abc123',
    };
    await fs.writeFile(
      path.join(checkpointsDir, `${checkpointName}.json`),
      JSON.stringify(toolCallData),
    );
    const command = restoreCommand(mockConfig);

    expect(await command?.action?.(mockContext, checkpointName)).toEqual({
      type: 'message',
      messageType: 'error',
      content: expect.stringContaining(
        'Checkpoint is missing a valid toolCall.',
      ),
    });
    expect(mockRewind).not.toHaveBeenCalled();
    expect(mockContext.ui.loadHistory).not.toHaveBeenCalled();
    expect(mockSetHistory).not.toHaveBeenCalled();
  });

  describe('completion', () => {
    it('should return an empty array if temp dir is not found', async () => {
      vi.mocked(mockConfig.storage.getProjectTempDir).mockReturnValue('');
      const command = restoreCommand(mockConfig);

      expect(await command?.completion?.(mockContext, '')).toEqual([]);
    });

    it('should return an empty array on readdir error', async () => {
      await fs.rm(checkpointsDir, { recursive: true, force: true });
      const command = restoreCommand(mockConfig);

      expect(await command?.completion?.(mockContext, '')).toEqual([]);
    });

    it('should return a list of checkpoint names', async () => {
      await fs.writeFile(path.join(checkpointsDir, 'test1.json'), '{}');
      await fs.writeFile(path.join(checkpointsDir, 'test2.json'), '{}');
      await fs.writeFile(
        path.join(checkpointsDir, 'not-a-checkpoint.txt'),
        '{}',
      );
      const command = restoreCommand(mockConfig);

      expect(await command?.completion?.(mockContext, '')).toEqual([
        'test1',
        'test2',
      ]);
    });
  });
});
