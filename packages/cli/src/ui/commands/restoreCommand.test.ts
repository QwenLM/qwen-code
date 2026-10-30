/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { useLayoutEffect, useRef } from 'react';
import { renderHook, act } from '@testing-library/react';
import { useHistory } from '../hooks/useHistoryManager.js';
import type { ConfirmationRequest, HistoryItem } from '../types.js';
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
import { LlmClient } from '@qwen-code/qwen-code-core/core/client.js';
import { LlmChat } from '@qwen-code/qwen-code-core/core/llm-chat.js';
import { makeFakeConfig } from '@qwen-code/qwen-code-core/test-utils/config.js';
import {
  getApiHistoryPromptId,
  markApiHistoryPrompt,
} from '@qwen-code/qwen-code-core/utils/api-history-metadata.js';
import { PermissionManager } from '@qwen-code/qwen-code-core/permissions/permission-manager.js';
import { ToolRegistry } from '@qwen-code/qwen-code-core/tools/tool-registry.js';
import { ReadFileTool } from '@qwen-code/qwen-code-core/tools/read-file.js';
import { EditTool } from '@qwen-code/qwen-code-core/tools/edit.js';
import { ApprovalMode } from '@qwen-code/qwen-code-core/config/approval-mode.js';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { computeApiTruncationIndex } from '../utils/historyMapping.js';
import { InteractiveModToolScheduler } from '../../services/interactive-mod-tool-scheduler.js';

// Loader fixtures follow the existing Ink use-llm-stream checkpoint payload;
// they do not exercise or depend on the future OpenTUI checkpoint writer.
async function writeInkCheckpointFixture(input: {
  directory: string;
  request: {
    name: string;
    args: Record<string, unknown>;
    prompt_id: string;
  };
  snapshot: () => {
    history: HistoryItem[];
    clientHistory: Content[];
    promptIds: Array<string | null>;
  };
}): Promise<string> {
  const { history, clientHistory, promptIds } = input.snapshot();
  const filePath = (input.request.args['file_path'] ??
    input.request.args['notebook_path']) as string;
  const timestamp = new Date()
    .toISOString()
    .replace(/:/g, '-')
    .replace(/\./g, '_');
  const file = path.join(
    input.directory,
    `${timestamp}-${path.basename(filePath)}-${input.request.name}.json`,
  );
  await fs.writeFile(
    file,
    JSON.stringify(
      {
        history,
        clientHistory,
        ...(promptIds.some(Boolean) ? { promptIds } : {}),
        toolCall: { name: input.request.name, args: input.request.args },
        promptId: input.request.prompt_id,
        filePath,
      },
      null,
      2,
    ),
  );
  return file;
}

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
      getFileReadCacheDisabled: vi.fn().mockReturnValue(false),
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

  it.each([
    'yes',
    'no',
    'abort',
    'current loss',
    'API replacement',
    'API args mutation',
    'API id mutation',
    'deny',
    'missing',
    'cache disabled',
  ] as const)(
    'uses actual read permissions before replay: %s',
    async (mode) => {
      const file = path.join(testRootDir, 'owned.txt');
      if (mode !== 'missing') await fs.writeFile(file, 'A');
      const other = path.join(testRootDir, 'unread.txt');
      // Keep a distinct inode alive before the edit atomically replaces owned.txt.
      if (mode === 'yes') await fs.writeFile(other, 'SECRET');
      const config = makeFakeConfig({
        targetDir: testRootDir,
        cwd: testRootDir,
        trustedFolder: true,
        interactive: true,
        approvalMode: ApprovalMode.DEFAULT,
        fileCheckpointingEnabled: true,
        fileReadCacheDisabled: mode === 'cache disabled',
        chatRecording: false,
        disableAllHooks: true,
        usageStatisticsEnabled: false,
        permissions: mode === 'deny' ? { deny: ['Read'] } : { ask: ['Read'] },
      });
      expect(config.isInteractive()).toBe(true);
      const pm = new PermissionManager(config);
      pm.initialize();
      vi.spyOn(config, 'getPermissionManager').mockReturnValue(pm);
      const registry = new ToolRegistry(config);
      const read = new ReadFileTool(config);
      const edit = new EditTool(config);
      registry.registerTool(read);
      registry.registerTool(edit);
      vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
      const readInvocations: Array<ReturnType<ReadFileTool['build']>> = [];
      const buildRead = read.build.bind(read);
      const readExecute = vi
        .spyOn(read, 'build')
        .mockImplementation((params) => {
          const invocation = buildRead(params);
          vi.spyOn(invocation, 'execute');
          readInvocations.push(invocation);
          return invocation;
        });
      expect(await pm.evaluate({ toolName: 'read_file' })).toBe(
        mode === 'deny' ? 'deny' : 'ask',
      );
      const chat = new LlmChat(config);
      const client = new LlmClient(config);
      vi.spyOn(client, 'getChat').mockReturnValue(chat);
      vi.spyOn(config, 'getLlmClient').mockReturnValue(client);
      vi.spyOn(config.storage, 'getProjectTempCheckpointsDir').mockReturnValue(
        checkpointsDir,
      );
      mockContext.services.config = config;
      const controller = new AbortController();
      mockContext.abortSignal = controller.signal;
      const requests: ConfirmationRequest[] = [];
      mockContext.ui.addConfirmUpdateExtensionRequest = (request) =>
        requests.push(request);
      await fs.writeFile(
        path.join(checkpointsDir, 'permission.json'),
        JSON.stringify({
          clientHistory: [
            'API replacement',
            'API args mutation',
            'API id mutation',
          ].includes(mode)
            ? [
                {
                  role: 'model',
                  parts: [
                    {
                      functionCall: {
                        id: 'original-pending-edit',
                        name: 'edit',
                        args: {
                          file_path: file,
                          old_string: 'A',
                          new_string: 'B',
                        },
                      },
                    },
                  ],
                },
              ]
            : [],
          toolCall: {
            name: 'edit',
            args: { file_path: file, old_string: 'A', new_string: 'B' },
          },
        }),
      );
      const pending = restoreCommand(config)!.action!(
        mockContext,
        'permission',
      );
      let expectedMutatedHistory: Content[] | undefined;
      try {
        if (
          [
            'yes',
            'no',
            'abort',
            'current loss',
            'API replacement',
            'API args mutation',
            'API id mutation',
          ].includes(mode)
        ) {
          await vi.waitFor(() => expect(requests).toHaveLength(1));
          expect(requests[0].signal).toBeDefined();
          expect(requests[0].isCurrent?.()).toBe(true);
          // Real PM ask must actually park the scheduler, not auto-allow a workspace read.
          expect(await fs.readFile(file, 'utf8')).toBe('A');
          if (mode === 'abort') controller.abort();
          if (mode === 'current loss') mockContext.ui.isIdleRef.current = false;
          if (mode === 'API replacement') {
            client.setHistory([
              {
                role: 'model',
                parts: [
                  {
                    functionCall: {
                      id: 'healthy-successor-edit',
                      name: 'edit',
                      args: {
                        file_path: file,
                        old_string: 'A',
                        new_string: 'B',
                      },
                    },
                  },
                ],
              },
            ]);
            expect(requests[0].isCurrent?.()).toBe(false);
          }
          if (mode === 'API args mutation' || mode === 'API id mutation') {
            const revision = chat.getHistoryReplacementRevision();
            const call = chat.peekLastHistoryEntry()!.parts![0].functionCall!;
            if (mode === 'API args mutation')
              call.args = {
                file_path: file,
                old_string: 'A',
                new_string: 'SUCCESSOR_CONTENT',
              };
            else call.id = 'healthy-in-place-id';
            expect(chat.getHistoryReplacementRevision()).toBe(revision);
            expectedMutatedHistory = client.getHistory();
            expect(requests[0].isCurrent?.()).toBe(false);
          }
          requests[0].onConfirm(mode !== 'no');
        }
        const result = await pending;
        if (expectedMutatedHistory)
          expect(client.getHistory()).toEqual(expectedMutatedHistory);
        if (mode === 'API replacement') {
          expect(client.getHistoryShallow()).toEqual([
            {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    id: 'healthy-successor-edit',
                    name: 'edit',
                    args: { file_path: file, old_string: 'A', new_string: 'B' },
                  },
                },
              ],
            },
          ]);
        }

        if (mode === 'yes' || mode === 'missing' || mode === 'cache disabled') {
          expect(result?.type).toBe('tool');
          if (mode === 'yes') {
            const checks = config.getFileReadCache().check(await fs.stat(file));
            expect(checks.state).toBe('fresh');
            if (checks.state !== 'fresh')
              throw new Error('Real Read did not seed the cache.');
            expect(checks.entry.lastReadWasFull).toBe(true);
            expect(checks.entry.lastReadAt).toBeGreaterThan(0);
            expect(readInvocations).toHaveLength(1);
            expect(readInvocations[0].execute).toHaveBeenCalledTimes(1);
            const readResult = await vi.mocked(readInvocations[0].execute).mock
              .results[0].value;
            expect(readResult.error).toBeUndefined();
            const edited = await edit
              .build({ file_path: file, old_string: 'A', new_string: 'B' })
              .execute(new AbortController().signal);
            expect(edited.error).toBeUndefined();
            expect(await fs.readFile(file, 'utf8')).toBe('B');
            const denied = await edit
              .build({
                file_path: other,
                old_string: 'SECRET',
                new_string: 'CHANGED',
              })
              .execute(new AbortController().signal);
            expect(denied.error?.message).toMatch(
              /has not been read in this session/,
            );
            expect(await fs.readFile(other, 'utf8')).toBe('SECRET');
          }
        } else {
          expect(result?.type).not.toBe('tool');
          expect(await fs.readFile(file, 'utf8')).toBe('A');
        }
        if (mode === 'deny')
          expect(
            readInvocations.every(
              (call) => vi.mocked(call.execute).mock.calls.length === 0,
            ),
          ).toBe(true);
        if (mode === 'deny' || mode === 'missing' || mode === 'cache disabled')
          expect(requests).toHaveLength(0);
        if (mode === 'missing' || mode === 'cache disabled')
          expect(readExecute).not.toHaveBeenCalled();
      } finally {
        controller.abort();
        await pending.catch(() => undefined);
        await config.shutdown({ strictResourceCleanup: true });
      }
    },
  );

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

    it('joins real client Symbol identity through checkpoint JSON, restore and rewind indexing', async () => {
      const clientConfig = makeFakeConfig({
        targetDir: testRootDir,
        cwd: testRootDir,
        disableAllHooks: true,
        usageStatisticsEnabled: false,
      });
      const chat = new LlmChat(clientConfig);
      const client = new LlmClient(clientConfig);
      // Connect the existing chat without starting a provider; setHistory and
      // getHistoryShallow remain the real client and chat implementations.
      vi.spyOn(client, 'getChat').mockReturnValue(chat);
      vi.mocked(mockConfig.getLlmClient).mockReturnValue(client);
      const firstId = 'original########0';
      const secondId = 'original########1';
      const api: Content[] = [
        { role: 'user', parts: [{ text: 'same input' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'read-one',
                name: 'read_file',
                args: { file_path: '/owned/a' },
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'read-one',
                name: 'read_file',
                response: { output: 'A' },
              },
            },
          ],
        },
        { role: 'model', parts: [{ text: 'first answer' }] },
        { role: 'user', parts: [{ text: 'same input' }] },
        { role: 'model', parts: [{ text: 'second answer' }] },
      ];
      markApiHistoryPrompt(api[0], firstId);
      markApiHistoryPrompt(api[4], secondId);
      const history: HistoryItem[] = [
        {
          id: 10,
          type: 'user',
          text: 'same input',
          promptId: firstId,
          sentToModel: true,
        },
        { id: 11, type: 'gemini', text: 'first answer' },
        {
          id: 12,
          type: 'user',
          text: 'same input',
          promptId: secondId,
          sentToModel: true,
        },
        { id: 13, type: 'gemini', text: 'second answer' },
      ];
      try {
        client.setHistory(api);
        const original = client.getHistoryShallow();
        expect(getApiHistoryPromptId(original[0])).toBe(firstId);
        expect(getApiHistoryPromptId(original[4])).toBe(secondId);
        const checkpoint = await writeInkCheckpointFixture({
          directory: checkpointsDir,
          request: {
            name: 'replace',
            args: { file_path: path.join(testRootDir, 'a.ts') },
            prompt_id: secondId,
          },
          snapshot: () => {
            const clientHistory = client.getHistoryShallow();
            return {
              history,
              clientHistory,
              promptIds: clientHistory.map(
                (content) => getApiHistoryPromptId(content) ?? null,
              ),
            };
          },
        });
        expect(checkpoint).toBeDefined();
        const persisted = JSON.parse(
          await fs.readFile(checkpoint!, 'utf8'),
        ) as {
          history: HistoryItem[];
          clientHistory: Content[];
          promptIds: Array<string | null>;
        };
        expect(persisted.promptIds).toEqual([
          firstId,
          null,
          null,
          null,
          secondId,
          null,
        ]);
        expect(
          persisted.clientHistory.every(
            (content) => getApiHistoryPromptId(content) === undefined,
          ),
        ).toBe(true);
        // A positional/text fallback must not accidentally make this pass.
        expect(
          computeApiTruncationIndex(history, 12, persisted.clientHistory),
        ).toBe(-1);
        client.setHistory([]);
        expect(
          await restoreCommand(mockConfig)!.action!(
            mockContext,
            path.basename(checkpoint!, '.json'),
          ),
        ).toEqual({
          type: 'tool',
          toolName: 'replace',
          toolArgs: { file_path: path.join(testRootDir, 'a.ts') },
        });
        const restored = client.getHistoryShallow();
        expect(restored.map(getApiHistoryPromptId)).toEqual([
          firstId,
          undefined,
          undefined,
          undefined,
          secondId,
          undefined,
        ]);
        expect(findApiHistoryPromptIndex(restored, secondId)).toBe(4);
        expect(computeApiTruncationIndex(persisted.history, 12, restored)).toBe(
          4,
        );
        expect(computeApiTruncationIndex(persisted.history, 10, restored)).toBe(
          0,
        );
        expect(restored).toEqual(original);
        expect(mockSetHistory).not.toHaveBeenCalled();
      } finally {
        await clientConfig.shutdown({ strictResourceCleanup: true });
      }
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
  describe('durable checkpoint admission before restore effects', () => {
    it('does not touch file/history/read/scheduling when the real recorder admission seam rejects', async () => {
      const file = path.join(testRootDir, 'owned.txt');
      await fs.writeFile(file, 'CURRENT_BYTES');
      const config = makeFakeConfig({
        targetDir: testRootDir,
        cwd: testRootDir,
        trustedFolder: true,
        interactive: true,
        fileCheckpointingEnabled: true,
        disableAllHooks: true,
        usageStatisticsEnabled: false,
      });
      const client = new LlmClient(config);
      const chat = new LlmChat(config);
      vi.spyOn(client, 'getChat').mockReturnValue(chat);
      vi.spyOn(config, 'getLlmClient').mockReturnValue(client);
      vi.spyOn(config.storage, 'getProjectTempCheckpointsDir').mockReturnValue(
        checkpointsDir,
      );
      vi.spyOn(config, 'getFileHistoryService').mockReturnValue({
        rewind: mockRewind,
      } as unknown as ReturnType<Config['getFileHistoryService']>);
      const promptId = `${config.getSessionId()}########0`;
      const args = { file_path: file, old_string: 'A', new_string: 'B' };
      const tail: Content = {
        role: 'model',
        parts: [{ functionCall: { id: 'original-edit', name: 'edit', args } }],
      };
      const user: Content = {
        role: 'user',
        parts: [{ text: 'CHECKPOINT_USER' }],
      };
      markApiHistoryPrompt(user, promptId);
      client.setHistory([user, tail]);
      const checkpointApi = client.getHistoryShallow();
      const history: HistoryItem[] = [
        { id: 1, type: 'user', text: 'CHECKPOINT_USER', promptId },
      ];
      const checkpointPath = await writeInkCheckpointFixture({
        directory: checkpointsDir,
        request: { name: 'edit', args, prompt_id: promptId },
        snapshot: () => ({
          history,
          clientHistory: checkpointApi,
          promptIds: checkpointApi.map(
            (content) => getApiHistoryPromptId(content) ?? null,
          ),
        }),
      });
      expect(checkpointPath).toBeDefined();
      const originalCheckpoint = await fs.readFile(checkpointPath!);
      client.setHistory([
        { role: 'user', parts: [{ text: 'CURRENT_LIVE_USER' }] },
      ]);
      const liveBefore = client.getHistoryShallow();
      const setHistory = vi.spyOn(client, 'setHistory');
      const assertAnchor = vi.fn(() => {
        throw new Error('RECORDER_REFUSED_CURRENT_ANCHOR');
      });
      const restoreBranch = vi.fn();
      const recorder = {
        assertRestoreToolBranchAnchor: assertAnchor,
        restoreToolBranch: restoreBranch,
      } as unknown as NonNullable<
        ReturnType<Config['getChatRecordingService']>
      >;
      vi.spyOn(config, 'getChatRecordingService').mockReturnValue(recorder);
      mockContext.services.config = config;
      const schedule = vi.spyOn(
        InteractiveModToolScheduler.prototype,
        'schedule',
      );
      const buildRead = vi.spyOn(ReadFileTool.prototype, 'build');
      const result = await restoreCommand(config)?.action?.(
        mockContext,
        path.basename(checkpointPath!),
      );
      expect(result).toMatchObject({ type: 'message', messageType: 'error' });
      expect(assertAnchor).toHaveBeenCalledTimes(1);
      expect(assertAnchor).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: config.getSessionId(),
          originalCallId: 'original-edit',
          name: 'edit',
          args,
          promptId,
        }),
      );
      expect(mockRewind).not.toHaveBeenCalled();
      expect(mockContext.ui.clearPendingState).not.toHaveBeenCalled();
      expect(mockContext.ui.loadHistory).not.toHaveBeenCalled();
      expect(setHistory).not.toHaveBeenCalled();
      expect(buildRead).not.toHaveBeenCalled();
      expect(schedule).not.toHaveBeenCalled();
      expect(restoreBranch).not.toHaveBeenCalled();
      expect(client.getHistoryShallow()).toEqual(liveBefore);
      expect(await fs.readFile(file, 'utf8')).toBe('CURRENT_BYTES');
      expect(await fs.readFile(checkpointPath!)).toEqual(originalCheckpoint);
    });

    it('preserves legacy local tool return without inventing a pending API/recorder requirement', async () => {
      const file = path.join(checkpointsDir, 'legacy-local.json');
      await fs.writeFile(
        file,
        JSON.stringify({
          toolCall: {
            name: 'run_shell_command',
            args: { command: 'printf legacy' },
          },
        }),
      );
      const recorderLookup = vi.fn(() => {
        throw new Error('LEGACY_MUST_NOT_REQUIRE_RECORDER');
      });
      Object.assign(mockConfig, { getChatRecordingService: recorderLookup });
      const schedule = vi.spyOn(
        InteractiveModToolScheduler.prototype,
        'schedule',
      );
      expect(
        await restoreCommand(mockConfig)?.action?.(mockContext, 'legacy-local'),
      ).toEqual({
        type: 'tool',
        toolName: 'run_shell_command',
        toolArgs: { command: 'printf legacy' },
      });
      expect(recorderLookup).not.toHaveBeenCalled();
      expect(mockRewind).not.toHaveBeenCalled();
      expect(mockContext.ui.loadHistory).not.toHaveBeenCalled();
      expect(mockSetHistory).not.toHaveBeenCalled();
      expect(schedule).not.toHaveBeenCalled();
    });
  });
  it('keeps a real pending checkpoint hot-restorable when chat recording is explicitly disabled', async () => {
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(
      path.join(testRootDir, 'owned-home'),
    );
    const config = makeFakeConfig({
      targetDir: testRootDir,
      cwd: testRootDir,
      trustedFolder: true,
      interactive: true,
      fileCheckpointingEnabled: true,
      chatRecording: false,
      disableAllHooks: true,
      usageStatisticsEnabled: false,
    });
    const client = new LlmClient(config);
    const chat = new LlmChat(config);
    vi.spyOn(client, 'getChat').mockReturnValue(chat);
    vi.spyOn(config, 'getLlmClient').mockReturnValue(client);
    vi.spyOn(config.storage, 'getProjectTempCheckpointsDir').mockReturnValue(
      checkpointsDir,
    );
    const lookup = vi.spyOn(config, 'getChatRecordingService');
    expect(config.getChatRecordingService()).toBeUndefined();
    lookup.mockClear();
    const args = {
      file_path: path.join(testRootDir, 'not-yet-created.txt'),
      old_string: '',
      new_string: 'LEGACY_NEW_FILE',
    };
    const user: Content = { role: 'user', parts: [{ text: 'PENDING_USER' }] };
    const promptId = `${config.getSessionId()}########0`;
    markApiHistoryPrompt(user, promptId);
    const tail: Content = {
      role: 'model',
      parts: [
        { functionCall: { id: 'original-local-tool', name: 'edit', args } },
      ],
    };
    await config.getFileHistoryService().makeSnapshot(promptId);
    client.setHistory([user, tail]);
    const checkpointApi = client.getHistoryShallow();
    const snapshot: HistoryItem[] = [
      { id: 42, type: 'user', text: 'PENDING_USER', promptId },
    ];
    const saved = await writeInkCheckpointFixture({
      directory: checkpointsDir,
      request: { name: 'edit', args, prompt_id: promptId },
      snapshot: () => ({
        history: snapshot,
        clientHistory: checkpointApi,
        promptIds: checkpointApi.map(
          (content) => getApiHistoryPromptId(content) ?? null,
        ),
      }),
    });
    if (!saved) throw new Error('Missing actual checkpoint');
    client.setHistory([
      { role: 'user', parts: [{ text: 'LATER_LIVE_HISTORY' }] },
    ]);
    mockContext.services.config = config;
    const result = await restoreCommand(config)?.action?.(
      mockContext,
      path.basename(saved),
    );
    expect(result).toMatchObject({ type: 'tool', toolName: 'edit' });
    expect(mockContext.ui.loadHistory).toHaveBeenCalledWith(snapshot);
    expect(client.getHistoryShallow()).toEqual(checkpointApi);
    await expect(fs.stat(args.file_path)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(
      result && result.type === 'tool'
        ? result.restoreResponseBinding?.durability
        : undefined,
    ).toBeUndefined();
  });
});
