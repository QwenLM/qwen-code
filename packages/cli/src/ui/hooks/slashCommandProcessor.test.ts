/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import process from 'node:process';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import {
  useSlashCommandProcessor,
  type SlashCommandProcessorActions,
} from './slashCommandProcessor.js';
import type {
  AgentViewIdleGateState,
  CommandContext,
  ConfirmActionReturn,
  ConfirmShellCommandsActionReturn,
  SlashCommand,
} from '../commands/types.js';
import { CommandKind } from '../commands/types.js';
import type { LoadedSettings } from '../../config/settings.js';
import type { HistoryItemBtw } from '../types.js';
import { MessageType } from '../types.js';
import { BuiltinCommandLoader } from '../../services/BuiltinCommandLoader.js';
import { FileCommandLoader } from '../../services/FileCommandLoader.js';
import { McpPromptLoader } from '../../services/McpPromptLoader.js';
import { ExtensionRefreshState } from '../../config/extension-refresh-state.js';
import { refreshExtensionContentRuntime } from '../../config/extension-runtime-reload.js';
import {
  type LlmClient,
  SlashCommandStatus,
  ToolConfirmationOutcome,
  makeFakeConfig,
  MCPServerStatus,
  updateMCPServerStatus,
  recordSkillInvocation,
} from '@qwen-code/qwen-code-core';

const {
  logSlashCommand,
  recordSkillInvocationMock,
  recordAutoSkillUsageMock,
  debugLoggerMock,
} = vi.hoisted(() => ({
  logSlashCommand: vi.fn(),
  recordSkillInvocationMock: vi.fn(),
  recordAutoSkillUsageMock: vi.fn(),
  debugLoggerMock: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...original,
    logSlashCommand,
    recordSkillInvocation: recordSkillInvocationMock,
    recordAutoSkillUsage: recordAutoSkillUsageMock,
    createDebugLogger: () => debugLoggerMock,
    getIdeInstaller: vi.fn().mockReturnValue(null),
  };
});

const { mockProcessExit } = vi.hoisted(() => ({
  mockProcessExit: vi.fn((_code?: number): never => undefined as never),
}));

vi.mock('node:process', () => {
  const mockProcess: Partial<NodeJS.Process> = {
    exit: mockProcessExit,
    platform: 'sunos',
    cwd: () => '/fake/dir',
    env: {},
  } as unknown as NodeJS.Process;
  return {
    ...mockProcess,
    default: mockProcess,
  };
});

const mockBuiltinLoadCommands = vi.fn();
vi.mock('../../services/BuiltinCommandLoader.js', () => ({
  BuiltinCommandLoader: vi.fn().mockImplementation(() => ({
    loadCommands: mockBuiltinLoadCommands,
  })),
}));

const mockFileLoadCommands = vi.fn();
vi.mock('../../services/FileCommandLoader.js', () => ({
  FileCommandLoader: vi.fn().mockImplementation(() => ({
    loadCommands: mockFileLoadCommands,
  })),
}));

const mockMcpLoadCommands = vi.fn();
vi.mock('../../services/McpPromptLoader.js', () => ({
  McpPromptLoader: vi.fn().mockImplementation(() => ({
    loadCommands: mockMcpLoadCommands,
  })),
}));

vi.mock('../contexts/SessionContext.js', () => ({
  useSessionStats: vi.fn(() => ({ stats: {} })),
}));

const { mockRunExitCleanup } = vi.hoisted(() => ({
  mockRunExitCleanup: vi.fn(),
}));

vi.mock('../../utils/cleanup.js', () => ({
  runExitCleanup: mockRunExitCleanup,
}));

vi.mock('./useKeypress.js', () => ({
  useKeypress: vi.fn(),
}));

vi.mock('../../config/extension-runtime-reload.js', () => ({
  refreshExtensionContentRuntime: vi.fn(async () => undefined),
}));

function createTestCommand(
  overrides: Partial<SlashCommand>,
  kind: CommandKind = CommandKind.BUILT_IN,
): SlashCommand {
  return {
    name: 'test',
    description: 'a test command',
    kind,
    ...overrides,
  };
}

function createTestCommandPath(path: string): SlashCommand {
  const names = path.split(' ');
  let command = createTestCommand({
    name: names.at(-1) ?? path,
    action: vi.fn(),
  });

  for (let index = names.length - 2; index >= 0; index--) {
    command = createTestCommand({
      name: names[index],
      subCommands: [command],
    });
  }

  return command;
}

describe('useSlashCommandProcessor', () => {
  const mockAddItem = vi.fn();
  const mockUpdateItem = vi.fn();
  const mockClearItems = vi.fn();
  const mockLoadHistory = vi.fn();
  const mockOpenThemeDialog = vi.fn();
  const mockOpenAuthDialog = vi.fn();
  const mockOpenSettingsDialog = vi.fn();
  const mockOpenMemoryDialog = vi.fn();
  const mockOpenModelDialog = vi.fn();
  const mockOpenHelpDialog = vi.fn();
  const mockSetQuittingMessages = vi.fn();
  const mockClearPendingState = vi.fn();

  const mockConfig = makeFakeConfig({});
  mockConfig.getChatRecordingService = vi.fn().mockReturnValue({
    recordSlashCommand: vi.fn(),
  });
  const mockFireUserPromptExpansionEvent = vi.fn();
  const mockSettings = { merged: {} } as LoadedSettings;

  const createMockActions = (): SlashCommandProcessorActions => ({
    openAuthDialog: mockOpenAuthDialog,
    openArenaDialog: vi.fn(),
    openThemeDialog: mockOpenThemeDialog,
    openEditorDialog: vi.fn(),
    openMemoryDialog: mockOpenMemoryDialog,
    openSettingsDialog: mockOpenSettingsDialog,
    openStatusLineDialog: vi.fn(),
    openModelDialog: mockOpenModelDialog,
    openTrustDialog: vi.fn(),
    openPermissionsDialog: vi.fn(),
    openApprovalModeDialog: vi.fn(),
    openHelpDialog: mockOpenHelpDialog,
    openResumeDialog: vi.fn(),
    handleResume: vi.fn(),
    handleBranch: vi.fn().mockResolvedValue(undefined),
    openDeleteDialog: vi.fn(),
    openDiffDialog: vi.fn(),
    quit: mockSetQuittingMessages,
    setDebugMessage: vi.fn(),
    dispatchExtensionStateUpdate: vi.fn(),
    addConfirmUpdateExtensionRequest: vi.fn(),
    openSubagentCreateDialog: vi.fn(),
    openAgentsManagerDialog: vi.fn(),
    openExtensionsManagerDialog: vi.fn(),
    openMcpDialog: vi.fn(),
    openHooksDialog: vi.fn(),
    openRewindSelector: vi.fn(),
    clearPendingState: mockClearPendingState,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    let nextHistoryItemId = 1;
    mockAddItem.mockImplementation(() => nextHistoryItemId++);
    vi.mocked(BuiltinCommandLoader).mockClear();
    mockBuiltinLoadCommands.mockResolvedValue([]);
    mockFileLoadCommands.mockResolvedValue([]);
    mockMcpLoadCommands.mockResolvedValue([]);
    mockOpenModelDialog.mockClear();
    mockOpenMemoryDialog.mockClear();
    mockFireUserPromptExpansionEvent.mockResolvedValue(undefined);
    vi.mocked(refreshExtensionContentRuntime).mockResolvedValue(undefined);
    mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
    mockConfig.hasHooksForEvent = vi.fn().mockReturnValue(true);
    mockConfig.getHookSystem = vi.fn().mockReturnValue({
      addFunctionHook: vi.fn().mockReturnValue('goal-hook-id'),
      removeFunctionHook: vi.fn().mockReturnValue(true),
      fireUserPromptExpansionEvent: mockFireUserPromptExpansionEvent,
    });
  });

  const setupProcessorHook = (
    builtinCommands: SlashCommand[] = [],
    fileCommands: SlashCommand[] = [],
    mcpCommands: SlashCommand[] = [],
    setIsProcessing = vi.fn(),
    settings: LoadedSettings = mockSettings,
    extensionRefreshState?: ExtensionRefreshState,
    isIdleRef = { current: true },
    actions: SlashCommandProcessorActions = createMockActions(),
    agentViewIdleGateStateRef?: { current: AgentViewIdleGateState },
  ) => {
    mockBuiltinLoadCommands.mockResolvedValue(Object.freeze(builtinCommands));
    mockFileLoadCommands.mockResolvedValue(Object.freeze(fileCommands));
    mockMcpLoadCommands.mockResolvedValue(Object.freeze(mcpCommands));

    const { result } = renderHook(() =>
      useSlashCommandProcessor(
        mockConfig,
        settings,
        [], // mock history array
        mockAddItem,
        mockClearItems,
        mockLoadHistory,
        vi.fn(), // refreshStatic
        vi.fn(), // toggleVimEnabled
        false, // isProcessing
        setIsProcessing,
        isIdleRef,
        vi.fn(), // setMemoryFileCount
        actions,
        new Map(), // extensionsUpdateState
        true, // isConfigInitialized
        null, // logger
        mockUpdateItem,
        undefined, // setSessionName
        extensionRefreshState,
        agentViewIdleGateStateRef,
      ),
    );

    return result;
  };

  describe('Initialization and Command Loading', () => {
    it('should initialize CommandService with all required loaders', async () => {
      const result = setupProcessorHook();
      await waitFor(() => {
        expect(result.current.slashCommands).toBeDefined();
      });
      expect(BuiltinCommandLoader).toHaveBeenCalledWith(mockConfig);
      expect(FileCommandLoader).toHaveBeenCalledWith(mockConfig);
      expect(McpPromptLoader).toHaveBeenCalledWith(mockConfig);
    });

    it('plumbs Agent View idle gate state into the command context', async () => {
      const agentViewIdleGateStateRef = {
        current: { hasQueuedPrompt: true },
      };
      const result = setupProcessorHook(
        [],
        [],
        [],
        vi.fn(),
        mockSettings,
        undefined,
        { current: true },
        createMockActions(),
        agentViewIdleGateStateRef,
      );

      await waitFor(() => {
        expect(result.current.slashCommands).toBeDefined();
      });

      expect(result.current.commandContext.ui.agentViewIdleGateStateRef).toBe(
        agentViewIdleGateStateRef,
      );
    });

    it('rebuilds commands when an MCP server connects (surfaces MCP prompts in /)', async () => {
      const result = setupProcessorHook();
      await waitFor(() => {
        expect(result.current.slashCommands).toBeDefined();
      });
      const before = vi.mocked(McpPromptLoader).mock.calls.length;

      // A server reaching CONNECTED fires the real status listener the hook
      // registered; after the debounce it rebuilds the command tree so a
      // progressively-discovered MCP prompt appears as a /<prompt> command.
      // Use a fresh server name so the global status registry actually
      // transitions (undefined -> CONNECTED).
      act(() => {
        updateMCPServerStatus('srv-reload-test', MCPServerStatus.CONNECTED);
      });

      await waitFor(
        () => {
          expect(vi.mocked(McpPromptLoader).mock.calls.length).toBeGreaterThan(
            before,
          );
        },
        { timeout: 2000 },
      );
    });

    it('ignores non-connected MCP status changes (no rebuild)', async () => {
      const result = setupProcessorHook();
      await waitFor(() => {
        expect(result.current.slashCommands).toBeDefined();
      });
      const before = vi.mocked(McpPromptLoader).mock.calls.length;

      act(() => {
        updateMCPServerStatus('srv-noreload-test', MCPServerStatus.CONNECTING);
      });
      // Wait past the 250ms debounce window: CONNECTING must not reload.
      await new Promise((r) => setTimeout(r, 400));
      expect(vi.mocked(McpPromptLoader).mock.calls.length).toBe(before);
    });

    it('should call loadCommands and populate state after mounting', async () => {
      const testCommand = createTestCommand({ name: 'test' });
      const result = setupProcessorHook([testCommand]);

      await waitFor(() => {
        expect(result.current.slashCommands).toHaveLength(1);
      });

      expect(result.current.slashCommands[0]?.name).toBe('test');
      expect(mockBuiltinLoadCommands).toHaveBeenCalledTimes(1);
      expect(mockFileLoadCommands).toHaveBeenCalledTimes(1);
      expect(mockMcpLoadCommands).toHaveBeenCalledTimes(1);
    });

    it('should provide an immutable array of commands to consumers', async () => {
      const testCommand = createTestCommand({ name: 'test' });
      const result = setupProcessorHook([testCommand]);

      await waitFor(() => {
        expect(result.current.slashCommands).toHaveLength(1);
      });

      const commands = result.current.slashCommands;

      expect(() => {
        // @ts-expect-error - We are intentionally testing a violation of the readonly type.
        commands.push(createTestCommand({ name: 'rogue' }));
      }).toThrow(TypeError);
    });

    it('should override built-in commands with file-based commands of the same name', async () => {
      const builtinAction = vi.fn();
      const fileAction = vi.fn();

      const builtinCommand = createTestCommand({
        name: 'override',
        description: 'builtin',
        action: builtinAction,
      });
      const fileCommand = createTestCommand(
        { name: 'override', description: 'file', action: fileAction },
        CommandKind.FILE,
      );

      const result = setupProcessorHook([builtinCommand], [fileCommand]);

      await waitFor(() => {
        // The service should only return one command with the name 'override'
        expect(result.current.slashCommands).toHaveLength(1);
      });

      await act(async () => {
        await result.current.handleSlashCommand('/override');
      });

      // Only the file-based command's action should be called.
      expect(fileAction).toHaveBeenCalledTimes(1);
      expect(builtinAction).not.toHaveBeenCalled();
    });
  });

  describe('Command Execution Logic', () => {
    it('should display an error for an unknown command', async () => {
      const result = setupProcessorHook();
      await waitFor(() => expect(result.current.slashCommands).toBeDefined());

      await act(async () => {
        await result.current.handleSlashCommand('/nonexistent');
      });

      // Expect 2 calls: one for the user's input, one for the error message.
      expect(mockAddItem).toHaveBeenCalledTimes(2);
      expect(mockAddItem).toHaveBeenLastCalledWith(
        {
          type: MessageType.ERROR,
          text: 'Unknown command: /nonexistent',
        },
        expect.any(Number),
      );
    });

    it('should let slash-prefixed file paths fall through to the model', async () => {
      const result = setupProcessorHook();
      await waitFor(() => expect(result.current.slashCommands).toBeDefined());

      let actionResult;
      await act(async () => {
        actionResult = await result.current.handleSlashCommand(
          '/api/apiFunction/接口的实现',
        );
      });

      expect(actionResult).toBe(false);

      let absPathResult;
      await act(async () => {
        absPathResult = await result.current.handleSlashCommand(
          '/Users/zhoushuo/Desktop/dw-operator-skill 帮我安装',
        );
      });

      expect(absPathResult).toBe(false);
      expect(mockAddItem).not.toHaveBeenCalled();
    });

    it('should display help for a parent command invoked without a subcommand', async () => {
      const parentCommand: SlashCommand = {
        name: 'parent',
        description: 'a parent command',
        kind: CommandKind.BUILT_IN,
        subCommands: [
          {
            name: 'child1',
            description: 'First child.',
            kind: CommandKind.BUILT_IN,
          },
        ],
      };
      const result = setupProcessorHook([parentCommand]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      await act(async () => {
        await result.current.handleSlashCommand('/parent');
      });

      expect(mockAddItem).toHaveBeenCalledTimes(2);
      expect(mockAddItem).toHaveBeenLastCalledWith(
        {
          type: MessageType.INFO,
          text: expect.stringContaining(
            "Command '/parent' requires a subcommand.",
          ),
        },
        expect.any(Number),
      );
    });

    it('should display warning message command results as warnings', async () => {
      const command = createTestCommand({
        name: 'warn',
        action: vi.fn().mockResolvedValue({
          type: 'message',
          messageType: 'warning',
          content: 'Check diagnostics.',
        }),
      });
      const result = setupProcessorHook([command]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      await act(async () => {
        await result.current.handleSlashCommand('/warn');
      });

      expect(mockAddItem).toHaveBeenCalledWith(
        { type: MessageType.WARNING, text: 'Check diagnostics.' },
        expect.any(Number),
      );
    });

    it('renders an idle Goal control response as a Goal state item', async () => {
      const snapshot = {
        v: 2 as const,
        activity: 'running' as const,
        goal: {
          goalId: 'goal-ui',
          revision: 1,
          objective: 'Ship the TUI',
          status: 'active' as const,
          evidenceCursor: { recordId: 'record-ui' },
          turnCount: 0,
          activeTimeMs: 0,
          tokensUsed: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      };
      const command = createTestCommand({
        name: 'goal',
        action: vi.fn().mockResolvedValue({
          type: 'goal_control',
          operation: { kind: 'set', objective: 'Ship the TUI' },
          response: { snapshot },
          cause: 'create',
        }),
      });
      const result = setupProcessorHook([command]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      await act(async () => {
        await result.current.handleSlashCommand('/goal Ship the TUI');
      });

      expect(mockAddItem).toHaveBeenCalledWith(
        {
          type: MessageType.GOAL_STATE,
          snapshot,
          cause: 'create',
        },
        expect.any(Number),
      );
    });

    it('leaves a mid-turn Goal control response to the active stream', async () => {
      const snapshot = {
        v: 2 as const,
        activity: 'idle' as const,
        goal: null,
      };
      const command = createTestCommand({
        name: 'goal',
        action: vi.fn().mockResolvedValue({
          type: 'goal_control',
          operation: { kind: 'clear' },
          response: { snapshot },
          cause: 'clear',
        }),
      });
      const result = setupProcessorHook(
        [command],
        [],
        [],
        vi.fn(),
        mockSettings,
        undefined,
        { current: false },
      );
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      await act(async () => {
        await result.current.handleSlashCommand('/goal clear');
      });

      expect(mockAddItem).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: MessageType.GOAL_STATE }),
        expect.any(Number),
      );
    });

    it('renders a mid-turn /goal status card since it emits no broadcast', async () => {
      const snapshot = {
        v: 2 as const,
        activity: 'idle' as const,
        goal: {
          goalId: 'goal-status',
          revision: 2,
          objective: 'Ship the TUI',
          status: 'active' as const,
          evidenceCursor: { recordId: 'record-status' },
          turnCount: 1,
          activeTimeMs: 5,
          tokensUsed: 0,
          createdAt: 1,
          updatedAt: 2,
        },
      };
      const command = createTestCommand({
        name: 'goal',
        action: vi.fn().mockResolvedValue({
          type: 'goal_control',
          operation: { kind: 'status' },
          response: { snapshot },
        }),
      });
      const result = setupProcessorHook(
        [command],
        [],
        [],
        vi.fn(),
        mockSettings,
        undefined,
        { current: false },
      );
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      await act(async () => {
        await result.current.handleSlashCommand('/goal');
      });

      expect(mockAddItem).toHaveBeenCalledWith(
        {
          type: MessageType.GOAL_STATE,
          snapshot,
        },
        expect.any(Number),
      );
    });

    it('renders a mid-turn causeless /goal clear with no active goal', async () => {
      const snapshot = {
        v: 2 as const,
        activity: 'idle' as const,
        goal: null,
      };
      const command = createTestCommand({
        name: 'goal',
        action: vi.fn().mockResolvedValue({
          type: 'goal_control',
          operation: { kind: 'clear' },
          response: { snapshot },
        }),
      });
      const result = setupProcessorHook(
        [command],
        [],
        [],
        vi.fn(),
        mockSettings,
        undefined,
        { current: false },
      );
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      await act(async () => {
        await result.current.handleSlashCommand('/goal clear');
      });

      expect(mockAddItem).toHaveBeenCalledWith(
        { type: MessageType.INFO, text: 'No Goal set.' },
        expect.any(Number),
      );
    });

    it('should correctly find and execute a nested subcommand', async () => {
      const childAction = vi.fn();
      const parentCommand: SlashCommand = {
        name: 'parent',
        description: 'a parent command',
        kind: CommandKind.BUILT_IN,
        subCommands: [
          {
            name: 'child',
            description: 'a child command',
            kind: CommandKind.BUILT_IN,
            action: childAction,
          },
        ],
      };
      const result = setupProcessorHook([parentCommand]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      await act(async () => {
        await result.current.handleSlashCommand('/parent child with args');
      });

      expect(childAction).toHaveBeenCalledTimes(1);

      expect(childAction).toHaveBeenCalledWith(
        expect.objectContaining({
          invocation: expect.objectContaining({
            name: 'child',
            args: 'with args',
          }),
          services: expect.objectContaining({
            config: mockConfig,
          }),
          ui: expect.objectContaining({
            addItem: expect.any(Function),
          }),
        }),
        'with args',
      );
    });

    it('sets isProcessing to false if the the input is not a command', async () => {
      const setMockIsProcessing = vi.fn();
      const result = setupProcessorHook([], [], [], setMockIsProcessing);

      await act(async () => {
        await result.current.handleSlashCommand('imnotacommand');
      });

      expect(setMockIsProcessing).not.toHaveBeenCalled();
    });

    it('sets isProcessing to false if the command has an error', async () => {
      const setMockIsProcessing = vi.fn();
      const failCommand = createTestCommand({
        name: 'fail',
        action: vi.fn().mockRejectedValue(new Error('oh no!')),
      });

      const result = setupProcessorHook(
        [failCommand],
        [],
        [],
        setMockIsProcessing,
      );

      await act(async () => {
        await result.current.handleSlashCommand('/fail');
      });

      expect(setMockIsProcessing).toHaveBeenNthCalledWith(1, true);
      expect(setMockIsProcessing).toHaveBeenNthCalledWith(2, false);
    });

    it('should set isProcessing to true during execution and false afterwards', async () => {
      const mockSetIsProcessing = vi.fn();
      const command = createTestCommand({
        name: 'long-running',
        action: () => new Promise((resolve) => setTimeout(resolve, 50)),
      });

      const result = setupProcessorHook([command], [], [], mockSetIsProcessing);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      const executionPromise = act(async () => {
        await result.current.handleSlashCommand('/long-running');
      });

      // It should be true immediately after starting
      expect(mockSetIsProcessing).toHaveBeenNthCalledWith(1, true);
      // It should not have been called with false yet
      expect(mockSetIsProcessing).not.toHaveBeenCalledWith(false);

      await executionPromise;

      // After the promise resolves, it should be called with false
      expect(mockSetIsProcessing).toHaveBeenNthCalledWith(2, false);
      expect(mockSetIsProcessing).toHaveBeenCalledTimes(2);
    });
  });

  describe('Action Result Handling', () => {
    it('should handle "agent_view_detach" action', async () => {
      const command = createTestCommand({
        name: 'background',
        action: vi.fn().mockResolvedValue({ type: 'agent_view_detach' }),
      });
      const actions = createMockActions();
      actions.detachAgentViewSession = vi.fn();
      const result = setupProcessorHook(
        [command],
        [],
        [],
        vi.fn(),
        mockSettings,
        undefined,
        { current: true },
        actions,
      );
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      await act(async () => {
        await result.current.handleSlashCommand('/background');
      });

      expect(actions.detachAgentViewSession).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['/auth status', 'auth', ['connect', 'login'], 'auth'],
      ['/connect', 'auth', ['connect', 'login'], 'auth'],
      ['/settings', 'settings', undefined, 'settings'],
    ] as const)(
      'handles %s without adding the invocation to TUI history',
      async (input, name, altNames, dialog) => {
        const command = createTestCommand({
          name,
          altNames: altNames ? [...altNames] : undefined,
          action: vi.fn().mockResolvedValue({ type: 'dialog', dialog }),
        });
        const result = setupProcessorHook([command]);
        await waitFor(() =>
          expect(result.current.slashCommands).toHaveLength(1),
        );

        await act(async () => {
          await result.current.handleSlashCommand(input);
        });

        expect(mockAddItem).not.toHaveBeenCalled();
        expect(
          name === 'auth' ? mockOpenAuthDialog : mockOpenSettingsDialog,
        ).toHaveBeenCalledTimes(1);
        expect(
          mockConfig.getChatRecordingService()?.recordSlashCommand,
        ).toHaveBeenCalledWith({
          phase: 'invocation',
          rawCommand: input,
          sentToModel: false,
          hiddenInvocation: true,
        });
      },
    );

    it.each(['/help', '/?'])(
      'opens %s without adding the invocation to TUI history',
      async (input) => {
        const command = createTestCommand({
          name: 'help',
          altNames: ['?'],
          action: vi.fn().mockResolvedValue({
            type: 'dialog',
            dialog: 'help',
          }),
        });
        const result = setupProcessorHook([command]);
        await waitFor(() =>
          expect(result.current.slashCommands).toHaveLength(1),
        );

        await act(async () => {
          await result.current.handleSlashCommand(input);
        });

        expect(mockAddItem).not.toHaveBeenCalled();
        expect(mockOpenHelpDialog).toHaveBeenCalledTimes(1);
      },
    );

    it.each(['/diff', '/editor', '/theme'])(
      'hides the invocation for the %s panel',
      async (input) => {
        const command = createTestCommandPath(input.slice(1));
        const result = setupProcessorHook([command]);
        await waitFor(() =>
          expect(result.current.slashCommands).toHaveLength(1),
        );

        await act(async () => {
          await result.current.handleSlashCommand(input);
        });

        expect(mockAddItem).not.toHaveBeenCalled();
      },
    );

    it.each(['/effort', '/model', '/stats', '/statusline'])(
      'hides the invocation for the bare %s picker',
      async (input) => {
        const [name] = input.slice(1).split(' ');
        const command = createTestCommand({ name, action: vi.fn() });
        const result = setupProcessorHook([command]);
        await waitFor(() =>
          expect(result.current.slashCommands).toHaveLength(1),
        );

        await act(async () => {
          await result.current.handleSlashCommand(input);
        });

        expect(mockAddItem).not.toHaveBeenCalled();
      },
    );

    it.each([
      '/model --fast',
      '/model --voice --project',
      '/model --vision --global',
      '/model --compaction',
      '/model --image',
      '/stats 2026-01',
    ])('hides the invocation for the picker-only form %s', async (input) => {
      const [name] = input.slice(1).split(' ');
      const command = createTestCommand({ name, action: vi.fn() });
      const result = setupProcessorHook([command]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      await act(async () => {
        await result.current.handleSlashCommand(input);
      });

      expect(mockAddItem).not.toHaveBeenCalled();
      expect(
        mockConfig.getChatRecordingService()?.recordSlashCommand,
      ).toHaveBeenCalledWith({
        phase: 'invocation',
        rawCommand: input,
        sentToModel: false,
        hiddenInvocation: true,
      });
    });

    it('reveals a picker-shaped invocation when argument validation fails', async () => {
      const input = '/model --project --global';
      const command = createTestCommand({
        name: 'model',
        action: vi.fn().mockResolvedValue({
          type: 'message',
          messageType: 'error',
          content: 'Cannot use both --project and --global',
        }),
      });
      const result = setupProcessorHook([command]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      await act(async () => {
        await result.current.handleSlashCommand(input);
      });

      expect(mockAddItem).toHaveBeenNthCalledWith(
        1,
        { type: MessageType.USER, text: input, sentToModel: false },
        expect.any(Number),
      );
      expect(
        mockConfig.getChatRecordingService()?.recordSlashCommand,
      ).toHaveBeenCalledWith({
        phase: 'invocation',
        rawCommand: input,
        sentToModel: false,
        hiddenInvocation: false,
      });
    });

    it('keeps the invocation for /theme when NO_COLOR blocks the dialog', async () => {
      process.env['NO_COLOR'] = '1';
      try {
        const command = createTestCommand({
          name: 'theme',
          action: vi.fn().mockResolvedValue({
            type: 'message',
            messageType: 'info',
            content:
              'Theme configuration unavailable due to NO_COLOR env variable.',
          }),
        });
        const result = setupProcessorHook([command]);
        await waitFor(() =>
          expect(result.current.slashCommands).toHaveLength(1),
        );

        await act(async () => {
          await result.current.handleSlashCommand('/theme');
        });

        expect(mockAddItem).toHaveBeenCalledWith(
          { type: MessageType.USER, text: '/theme', sentToModel: false },
          expect.any(Number),
        );
        expect(
          mockConfig.getChatRecordingService()?.recordSlashCommand,
        ).toHaveBeenCalledWith({
          phase: 'invocation',
          rawCommand: '/theme',
          sentToModel: false,
          hiddenInvocation: false,
        });
      } finally {
        delete process.env['NO_COLOR'];
      }
    });

    it('records the rejection message in the result record for resume', async () => {
      const input = '/model --project --global';
      const command = createTestCommand({
        name: 'model',
        action: vi.fn().mockResolvedValue({
          type: 'message',
          messageType: 'error',
          content: 'Cannot use both --project and --global',
        }),
      });
      const result = setupProcessorHook([command]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      await act(async () => {
        await result.current.handleSlashCommand(input);
      });

      expect(
        mockConfig.getChatRecordingService()?.recordSlashCommand,
      ).toHaveBeenCalledWith({
        phase: 'result',
        rawCommand: input,
        outputHistoryItems: [
          {
            type: MessageType.ERROR,
            text: 'Cannot use both --project and --global',
          },
        ],
      });
    });

    it('hides the invocation for the /usage alias', async () => {
      const command = createTestCommand({
        name: 'stats',
        altNames: ['usage'],
        action: vi.fn(),
      });
      const result = setupProcessorHook([command]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      await act(async () => {
        await result.current.handleSlashCommand('/usage');
      });

      expect(mockAddItem).not.toHaveBeenCalled();
    });

    it.each([
      ['/effort high', 'effort'],
      ['/model qwen3-max', 'model'],
      ['/statusline make it compact', 'statusline'],
      ['/stats export', 'stats export'],
    ])(
      'keeps the invocation for the direct action %s',
      async (input, canonicalPath) => {
        const command = createTestCommandPath(canonicalPath);
        const result = setupProcessorHook([command]);
        await waitFor(() =>
          expect(result.current.slashCommands).toHaveLength(1),
        );

        await act(async () => {
          await result.current.handleSlashCommand(input);
        });

        expect(mockAddItem).toHaveBeenCalledTimes(1);
        expect(mockAddItem).toHaveBeenCalledWith(
          { type: MessageType.USER, text: input, sentToModel: false },
          expect.any(Number),
        );
      },
    );

    it.each(['/status paths', '/stats model'])(
      'keeps the invocation for the %s subcommand',
      async (input) => {
        const command = createTestCommandPath(input.slice(1));
        const result = setupProcessorHook([command]);
        await waitFor(() =>
          expect(result.current.slashCommands).toHaveLength(1),
        );

        await act(async () => {
          await result.current.handleSlashCommand(input);
        });

        expect(mockAddItem).toHaveBeenCalledTimes(1);
        expect(mockAddItem).toHaveBeenCalledWith(
          { type: MessageType.USER, text: input, sentToModel: false },
          expect.any(Number),
        );
        expect(
          mockConfig.getChatRecordingService()?.recordSlashCommand,
        ).toHaveBeenCalledWith({
          phase: 'invocation',
          rawCommand: input,
          sentToModel: false,
          hiddenInvocation: false,
        });
      },
    );

    it('shows status output without adding the invocation to TUI history', async () => {
      const command = createTestCommand({
        name: 'status',
        altNames: ['about'],
        action: vi.fn().mockResolvedValue({
          type: 'message',
          messageType: 'info',
          content: 'status output',
        }),
      });
      const result = setupProcessorHook([command]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      await act(async () => {
        await result.current.handleSlashCommand('/about');
      });

      expect(mockAddItem).toHaveBeenCalledTimes(1);
      expect(mockAddItem).toHaveBeenCalledWith(
        { type: MessageType.INFO, text: 'status output' },
        expect.any(Number),
      );
    });

    it('keeps the invocation for a file command that overrides status', async () => {
      const builtinStatus = createTestCommand({
        name: 'status',
        action: vi.fn().mockResolvedValue({
          type: 'message',
          messageType: 'info',
          content: 'builtin status output',
        }),
      });
      const command = createTestCommand(
        {
          name: 'status',
          action: vi.fn().mockResolvedValue({
            type: 'message',
            messageType: 'info',
            content: 'custom status output',
          }),
        },
        CommandKind.FILE,
      );
      const result = setupProcessorHook([builtinStatus], [command]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      await act(async () => {
        await result.current.handleSlashCommand('/status');
      });

      expect(command.action).toHaveBeenCalledTimes(1);
      expect(builtinStatus.action).not.toHaveBeenCalled();
      expect(mockAddItem).toHaveBeenNthCalledWith(
        1,
        { type: MessageType.USER, text: '/status', sentToModel: false },
        expect.any(Number),
      );
      expect(mockAddItem).toHaveBeenNthCalledWith(
        2,
        { type: MessageType.INFO, text: 'custom status output' },
        expect.any(Number),
      );
    });

    it('should handle "dialog: theme" action', async () => {
      const command = createTestCommand({
        name: 'themecmd',
        action: vi.fn().mockResolvedValue({ type: 'dialog', dialog: 'theme' }),
      });
      const result = setupProcessorHook([command]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      await act(async () => {
        await result.current.handleSlashCommand('/themecmd');
      });

      expect(mockOpenThemeDialog).toHaveBeenCalled();
    });

    it('should handle "dialog: model" action', async () => {
      const command = createTestCommand({
        name: 'modelcmd',
        action: vi.fn().mockResolvedValue({ type: 'dialog', dialog: 'model' }),
      });
      const result = setupProcessorHook([command]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      await act(async () => {
        await result.current.handleSlashCommand('/modelcmd');
      });

      expect(mockOpenModelDialog).toHaveBeenCalled();
    });

    it('should handle "dialog: voice-model" action', async () => {
      const command = createTestCommand({
        name: 'voicemodelcmd',
        action: vi
          .fn()
          .mockResolvedValue({ type: 'dialog', dialog: 'voice-model' }),
      });
      const result = setupProcessorHook([command]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      await act(async () => {
        await result.current.handleSlashCommand('/voicemodelcmd');
      });

      expect(mockOpenModelDialog).toHaveBeenCalledWith({
        voiceModelMode: true,
      });
    });

    it('should handle "dialog: vision-model" action', async () => {
      const command = createTestCommand({
        name: 'visionmodelcmd',
        action: vi
          .fn()
          .mockResolvedValue({ type: 'dialog', dialog: 'vision-model' }),
      });
      const result = setupProcessorHook([command]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      await act(async () => {
        await result.current.handleSlashCommand('/visionmodelcmd');
      });

      expect(mockOpenModelDialog).toHaveBeenCalledWith({
        visionModelMode: true,
      });
    });

    it('should handle "dialog: image-model" action', async () => {
      const command = createTestCommand({
        name: 'imagemodelcmd',
        action: vi
          .fn()
          .mockResolvedValue({ type: 'dialog', dialog: 'image-model' }),
      });
      const result = setupProcessorHook([command]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      await act(async () => {
        await result.current.handleSlashCommand('/imagemodelcmd');
      });

      expect(mockOpenModelDialog).toHaveBeenCalledWith({
        imageModelMode: true,
      });
    });

    it('should handle "dialog: compaction-model" action', async () => {
      const command = createTestCommand({
        name: 'compactionmodelcmd',
        action: vi
          .fn()
          .mockResolvedValue({ type: 'dialog', dialog: 'compaction-model' }),
      });
      const result = setupProcessorHook([command]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      await act(async () => {
        await result.current.handleSlashCommand('/compactionmodelcmd');
      });

      expect(mockOpenModelDialog).toHaveBeenCalledWith({
        compactionModelMode: true,
      });
    });

    it('awaits direct resume session switching before returning handled', async () => {
      const actions = createMockActions();
      let resolveResume: (() => void) | undefined;
      actions.handleResume = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveResume = resolve;
          }),
      );

      const resumeCommand = createTestCommand({
        name: 'resume-direct',
        action: vi.fn().mockResolvedValue({
          type: 'dialog',
          dialog: 'resume',
          sessionId: 'session-123',
        }),
      });
      mockBuiltinLoadCommands.mockResolvedValue(Object.freeze([resumeCommand]));

      const { result } = renderHook(() =>
        useSlashCommandProcessor(
          mockConfig,
          mockSettings,
          [],
          mockAddItem,
          mockClearItems,
          mockLoadHistory,
          vi.fn(),
          vi.fn(),
          false,
          vi.fn(),
          { current: true },
          vi.fn(),
          actions,
          new Map(),
          true,
          null,
          mockUpdateItem,
        ),
      );

      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      let settled = false;
      const promise = result.current
        .handleSlashCommand('/resume-direct')
        .then(() => {
          settled = true;
        });

      await waitFor(() => {
        expect(actions.handleResume).toHaveBeenCalledWith('session-123');
      });
      expect(settled).toBe(false);

      resolveResume?.();
      await act(async () => {
        await promise;
      });
      expect(settled).toBe(true);
    });

    it('shows info feedback for collapse-on-resume command', async () => {
      const historyCmd = createTestCommand({
        name: 'history',
        action: vi.fn().mockResolvedValue({
          type: 'message',
          messageType: 'info',
          content:
            'History will be collapsed by default for future resumed sessions.',
        }),
      });
      const result = setupProcessorHook([historyCmd]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      await act(async () => {
        await result.current.handleSlashCommand('/history collapse-on-resume');
      });

      // Should have 2 calls: user message + info feedback
      expect(mockAddItem).toHaveBeenCalledTimes(2);
      expect(mockAddItem).toHaveBeenNthCalledWith(
        1,
        {
          type: MessageType.USER,
          text: '/history collapse-on-resume',
          sentToModel: false,
        },
        expect.any(Number),
      );
      expect(mockAddItem).toHaveBeenNthCalledWith(
        2,
        {
          type: MessageType.INFO,
          text: 'History will be collapsed by default for future resumed sessions.',
        },
        expect.any(Number),
      );
    });

    it('expand-now command updates history without info feedback', async () => {
      const historyCmd = createTestCommand({
        name: 'history',
        subCommands: [
          {
            name: 'expand-now',
            description: 'Expand collapsed history',
            kind: CommandKind.BUILT_IN,
            action: vi.fn().mockResolvedValue(undefined),
          },
        ],
      });
      const result = setupProcessorHook([historyCmd]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      await act(async () => {
        await result.current.handleSlashCommand('/history expand-now');
      });

      // User message added, no info feedback (action returns void)
      expect(mockAddItem).toHaveBeenCalledTimes(1);
      expect(mockAddItem).toHaveBeenCalledWith(
        {
          type: MessageType.USER,
          text: '/history expand-now',
          sentToModel: false,
        },
        expect.any(Number),
      );
    });

    it('opens memory dialog when command returns dialog:memory', async () => {
      const actions = createMockActions();
      const memoryCommand = createTestCommand({
        name: 'memorycmd',
        action: vi.fn().mockResolvedValue({ type: 'dialog', dialog: 'memory' }),
      });
      mockBuiltinLoadCommands.mockResolvedValue(Object.freeze([memoryCommand]));

      const { result } = renderHook(() =>
        useSlashCommandProcessor(
          mockConfig,
          mockSettings,
          [],
          mockAddItem,
          mockClearItems,
          mockLoadHistory,
          vi.fn(),
          vi.fn(),
          false,
          vi.fn(),
          { current: true },
          vi.fn(),
          actions,
          new Map(),
          true,
          null,
          mockUpdateItem,
        ),
      );

      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      await act(async () => {
        await result.current.handleSlashCommand('/memorycmd');
      });

      expect(actions.openMemoryDialog).toHaveBeenCalled();
    });

    it('should pass interactive execution mode to command actions', async () => {
      const action = vi.fn().mockResolvedValue({
        type: 'message',
        messageType: 'info',
        content: 'ok',
      });
      const command = createTestCommand({
        name: 'interactivecmd',
        action,
      });
      const result = setupProcessorHook([command]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      await act(async () => {
        await result.current.handleSlashCommand('/interactivecmd');
      });

      expect(action).toHaveBeenCalledWith(
        expect.objectContaining({ executionMode: 'interactive' }),
        '',
      );
    });

    it('should handle "load_history" action', async () => {
      const mockClient = {
        setHistory: vi.fn(),
      } as unknown as LlmClient;
      vi.spyOn(mockConfig, 'getLlmClient').mockReturnValue(mockClient);

      const command = createTestCommand({
        name: 'load',
        action: vi.fn().mockResolvedValue({
          type: 'load_history',
          history: [{ type: MessageType.USER, text: 'old prompt' }],
          clientHistory: [{ role: 'user', parts: [{ text: 'old prompt' }] }],
        }),
      });
      const result = setupProcessorHook([command]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      await act(async () => {
        await result.current.handleSlashCommand('/load');
      });

      expect(mockClearItems).toHaveBeenCalledTimes(1);
      expect(mockAddItem).toHaveBeenCalledWith(
        { type: 'user', text: 'old prompt' },
        expect.any(Number),
      );
    });

    it('should preserve thoughts when handling "load_history" action', async () => {
      const mockClient = {
        setHistory: vi.fn(),
      } as unknown as LlmClient;
      vi.spyOn(mockConfig, 'getLlmClient').mockReturnValue(mockClient);

      const historyWithThoughts = [
        {
          role: 'model',
          parts: [{ text: 'response', thoughtSignature: 'CikB...' }],
        },
      ];
      const command = createTestCommand({
        name: 'loadwiththoughts',
        action: vi.fn().mockResolvedValue({
          type: 'load_history',
          history: [{ type: MessageType.GEMINI, text: 'response' }],
          clientHistory: historyWithThoughts,
        }),
      });

      const result = setupProcessorHook([command]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      await act(async () => {
        await result.current.handleSlashCommand('/loadwiththoughts');
      });

      expect(mockClient.setHistory).toHaveBeenCalledTimes(1);
      expect(mockClient.setHistory).toHaveBeenCalledWith(historyWithThoughts);
    });

    it('should handle a "quit" action', async () => {
      const quitAction = vi
        .fn()
        .mockResolvedValue({ type: 'quit', messages: ['bye'] });
      const command = createTestCommand({
        name: 'exit',
        action: quitAction,
      });
      const result = setupProcessorHook([command]);

      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      await act(async () => {
        await result.current.handleSlashCommand('/exit');
      });

      expect(mockSetQuittingMessages).toHaveBeenCalledWith(['bye']);
    });
    it('should handle "submit_prompt" action returned from a file-based command', async () => {
      const fileCommand = createTestCommand(
        {
          name: 'filecmd',
          description: 'A command from a file',
          action: async () => ({
            type: 'submit_prompt',
            content: [{ text: 'The actual prompt from the TOML file.' }],
          }),
        },
        CommandKind.FILE,
      );

      const result = setupProcessorHook([], [fileCommand]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      let actionResult;
      await act(async () => {
        actionResult = await result.current.handleSlashCommand('/filecmd');
      });

      expect(actionResult).toEqual({
        type: 'submit_prompt',
        content: [{ text: 'The actual prompt from the TOML file.' }],
      });

      expect(mockAddItem).toHaveBeenCalledWith(
        { type: MessageType.USER, text: '/filecmd', sentToModel: false },
        expect.any(Number),
      );
      expect(mockFireUserPromptExpansionEvent).toHaveBeenCalledWith(
        'filecmd',
        '',
        'The actual prompt from the TOML file.',
        expect.any(AbortSignal),
      );
      expect(mockUpdateItem).toHaveBeenCalledWith(1, { sentToModel: true });
      expect(debugLoggerMock.debug).toHaveBeenCalledWith(
        'Marked slash command invocation as model-sent: /filecmd',
      );
      const recorder = mockConfig.getChatRecordingService() as unknown as {
        recordSlashCommand: ReturnType<typeof vi.fn>;
      };
      expect(recorder.recordSlashCommand).toHaveBeenCalledWith({
        phase: 'invocation',
        rawCommand: '/filecmd',
        sentToModel: true,
        hiddenInvocation: false,
      });
    });

    it('classifies a hidden invocation as model-sent when it submits a prompt', async () => {
      const command = createTestCommand({
        name: 'status',
        action: vi.fn().mockResolvedValue({
          type: 'submit_prompt',
          content: [{ text: 'hidden but submitted' }],
        }),
      });

      const result = setupProcessorHook([command]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      let actionResult;
      await act(async () => {
        actionResult = await result.current.handleSlashCommand('/status');
      });

      expect(actionResult).toEqual({
        type: 'submit_prompt',
        content: [{ text: 'hidden but submitted' }],
      });
      expect(mockAddItem).not.toHaveBeenCalled();
      expect(mockUpdateItem).not.toHaveBeenCalled();
      const recorder = mockConfig.getChatRecordingService() as unknown as {
        recordSlashCommand: ReturnType<typeof vi.fn>;
      };
      expect(recorder.recordSlashCommand).toHaveBeenCalledWith({
        phase: 'invocation',
        rawCommand: '/status',
        sentToModel: true,
        hiddenInvocation: true,
      });
    });

    it('should preserve context-file refresh intent from submit_prompt actions', async () => {
      const fileCommand = createTestCommand(
        {
          name: 'rememberfile',
          description: 'A command that writes project context',
          action: async () => ({
            type: 'submit_prompt',
            content: [{ text: 'Remember this fact.' }],
            refreshContextFilesOnWrite: true,
          }),
        },
        CommandKind.FILE,
      );

      const result = setupProcessorHook([], [fileCommand]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      let actionResult;
      await act(async () => {
        actionResult = await result.current.handleSlashCommand('/rememberfile');
      });

      expect(actionResult).toEqual({
        type: 'submit_prompt',
        content: [{ text: 'Remember this fact.' }],
        refreshContextFilesOnWrite: true,
      });
    });

    it('should append UserPromptExpansion additional context to submit_prompt actions', async () => {
      mockFireUserPromptExpansionEvent.mockResolvedValue({
        getBlockingError: () => ({ blocked: false }),
        shouldStopExecution: () => false,
        getAdditionalContext: () => 'Hook context',
      });
      const fileCommand = createTestCommand(
        {
          name: 'filecmd',
          description: 'A command from a file',
          action: async () => ({
            type: 'submit_prompt',
            content: [{ text: 'The actual prompt from the TOML file.' }],
          }),
        },
        CommandKind.FILE,
      );

      const result = setupProcessorHook([], [fileCommand]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      let actionResult;
      await act(async () => {
        actionResult = await result.current.handleSlashCommand('/filecmd');
      });

      expect(actionResult).toEqual({
        type: 'submit_prompt',
        content: [
          { text: 'The actual prompt from the TOML file.' },
          { text: '\n\nHook context' },
        ],
      });
    });

    it('should not submit a prompt cancelled while UserPromptExpansion hook is in flight', async () => {
      let resolveHook: (() => void) | undefined;
      mockFireUserPromptExpansionEvent.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveHook = () =>
              resolve({
                getBlockingError: () => ({ blocked: false }),
                shouldStopExecution: () => false,
                getAdditionalContext: () => undefined,
              });
          }),
      );
      const fileCommand = createTestCommand(
        {
          name: 'filecmd',
          description: 'A command from a file',
          action: async () => ({
            type: 'submit_prompt',
            content: [{ text: 'The actual prompt from the TOML file.' }],
          }),
        },
        CommandKind.FILE,
      );

      const result = setupProcessorHook([], [fileCommand]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      let actionResult;
      const pending = act(async () => {
        actionResult = await result.current.handleSlashCommand('/filecmd');
      });
      await waitFor(() =>
        expect(mockFireUserPromptExpansionEvent).toHaveBeenCalled(),
      );

      act(() => {
        result.current.cancelSlashCommand();
        resolveHook?.();
      });
      await pending;

      expect(actionResult).toEqual({ type: 'handled' });
      expect(mockUpdateItem).not.toHaveBeenCalledWith(1, {
        sentToModel: true,
      });
      expect(logSlashCommand).not.toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          command: 'filecmd',
          status: SlashCommandStatus.SUCCESS,
        }),
      );
    });

    it('should block submit_prompt actions when UserPromptExpansion blocks', async () => {
      mockFireUserPromptExpansionEvent.mockResolvedValue({
        getBlockingError: () => ({
          blocked: true,
          reason: 'Blocked by policy',
        }),
        shouldStopExecution: () => false,
      });
      const fileCommand = createTestCommand(
        {
          name: 'filecmd',
          description: 'A command from a file',
          action: async () => ({
            type: 'submit_prompt',
            content: 'The actual prompt from the TOML file.',
          }),
        },
        CommandKind.FILE,
      );

      const result = setupProcessorHook([], [fileCommand]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      let actionResult;
      await act(async () => {
        actionResult = await result.current.handleSlashCommand('/filecmd');
      });

      expect(actionResult).toEqual({ type: 'handled' });
      expect(mockAddItem).toHaveBeenCalledWith(
        {
          type: MessageType.ERROR,
          text: 'UserPromptExpansion blocked: Blocked by policy',
        },
        expect.any(Number),
      );
    });

    it('should handle "submit_prompt" action returned from a mcp-based command', async () => {
      const mcpCommand = createTestCommand(
        {
          name: 'mcpcmd',
          description: 'A command from mcp',
          action: async () => ({
            type: 'submit_prompt',
            content: [{ text: 'The actual prompt from the mcp command.' }],
          }),
        },
        CommandKind.MCP_PROMPT,
      );

      const result = setupProcessorHook([], [], [mcpCommand]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      let actionResult;
      await act(async () => {
        actionResult = await result.current.handleSlashCommand('/mcpcmd');
      });

      expect(actionResult).toEqual({
        type: 'submit_prompt',
        content: [{ text: 'The actual prompt from the mcp command.' }],
      });

      expect(mockFireUserPromptExpansionEvent).toHaveBeenCalledWith(
        'mcpcmd',
        '',
        'The actual prompt from the mcp command.',
        expect.any(AbortSignal),
      );

      expect(mockAddItem).toHaveBeenCalledWith(
        { type: MessageType.USER, text: '/mcpcmd', sentToModel: false },
        expect.any(Number),
      );
      expect(mockUpdateItem).toHaveBeenCalledWith(1, { sentToModel: true });
    });

    it('should fire UserPromptExpansion hooks for model-invocable command execution', async () => {
      mockFireUserPromptExpansionEvent.mockResolvedValue({
        getBlockingError: () => ({ blocked: false }),
        shouldStopExecution: () => false,
        getAdditionalContext: () => 'Hook context',
      });
      const fileCommand = createTestCommand(
        {
          name: 'filecmd',
          description: 'A command from a file',
          modelInvocable: true,
          action: async () => ({
            type: 'submit_prompt',
            content: [{ text: 'The actual prompt from the TOML file.' }],
          }),
        },
        CommandKind.FILE,
      );

      const result = setupProcessorHook([], [fileCommand]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      const executor = mockConfig.getModelInvocableCommandsExecutor?.();
      expect(executor).toBeDefined();
      const content = await executor?.('filecmd', 'with args');

      expect(mockFireUserPromptExpansionEvent).toHaveBeenCalledWith(
        'filecmd',
        'with args',
        'The actual prompt from the TOML file.',
        expect.any(AbortSignal),
      );
      expect(content).toBe(
        'The actual prompt from the TOML file.\n\nHook context',
      );
    });

    it('should return the block reason for blocked model-invocable command execution', async () => {
      mockFireUserPromptExpansionEvent.mockResolvedValue({
        getBlockingError: () => ({
          blocked: true,
          reason: 'Blocked by policy',
        }),
        shouldStopExecution: () => false,
        getEffectiveReason: () => 'fallback reason',
      });
      const fileCommand = createTestCommand(
        {
          name: 'filecmd',
          description: 'A command from a file',
          modelInvocable: true,
          action: async () => ({
            type: 'submit_prompt',
            content: 'The actual prompt from the TOML file.',
          }),
        },
        CommandKind.FILE,
      );

      const result = setupProcessorHook([], [fileCommand]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      const executor = mockConfig.getModelInvocableCommandsExecutor?.();
      expect(executor).toBeDefined();
      const content = await executor?.('filecmd', 'with args');

      expect(content).toEqual({
        error: 'UserPromptExpansion blocked: Blocked by policy',
      });
    });

    it('should stop model-invocable command execution when hook unmounts', async () => {
      let resolveHook: (() => void) | undefined;
      mockFireUserPromptExpansionEvent.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveHook = () =>
              resolve({
                getBlockingError: () => ({ blocked: false }),
                shouldStopExecution: () => false,
                getAdditionalContext: () => 'Hook context',
              });
          }),
      );
      const fileCommand = createTestCommand(
        {
          name: 'filecmd',
          description: 'A command from a file',
          modelInvocable: true,
          action: async () => ({
            type: 'submit_prompt',
            content: 'The actual prompt from the TOML file.',
          }),
        },
        CommandKind.FILE,
      );

      mockFileLoadCommands.mockResolvedValue(Object.freeze([fileCommand]));
      const { result, unmount } = renderHook(() =>
        useSlashCommandProcessor(
          mockConfig,
          mockSettings,
          mockAddItem,
          mockClearItems,
          mockLoadHistory,
          vi.fn(),
          vi.fn(),
          false,
          vi.fn(),
          { current: true },
          vi.fn(),
          createMockActions(),
          new Map(),
          true,
          null,
          mockUpdateItem,
        ),
      );
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      const executor = mockConfig.getModelInvocableCommandsExecutor?.();
      const pendingContent = executor?.('filecmd', 'with args');
      await waitFor(() =>
        expect(mockFireUserPromptExpansionEvent).toHaveBeenCalled(),
      );

      unmount();
      resolveHook?.();

      await expect(pendingContent).resolves.toEqual({
        error: 'Skill execution cancelled by user.',
      });
    });
  });

  describe('Shell Command Confirmation Flow', () => {
    // Use a generic vi.fn() for the action. We will change its behavior in each test.
    const mockCommandAction = vi.fn();

    const shellCommand = createTestCommand({
      name: 'shellcmd',
      action: mockCommandAction,
    });

    beforeEach(() => {
      // Reset the mock before each test
      mockCommandAction.mockClear();

      // Default behavior: request confirmation
      mockCommandAction.mockResolvedValue({
        type: 'confirm_shell_commands',
        commandsToConfirm: ['rm -rf /'],
        originalInvocation: { raw: '/shellcmd' },
      } as ConfirmShellCommandsActionReturn);
    });

    it('should set confirmation request when action returns confirm_shell_commands', async () => {
      const result = setupProcessorHook([shellCommand]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      // This is intentionally not awaited, because the promise it returns
      // will not resolve until the user responds to the confirmation.
      act(() => {
        result.current.handleSlashCommand('/shellcmd');
      });

      // We now wait for the state to be updated with the request.
      await waitFor(() => {
        expect(result.current.shellConfirmationRequest).not.toBeNull();
      });

      expect(result.current.shellConfirmationRequest?.commands).toEqual([
        'rm -rf /',
      ]);
    });

    it('should do nothing if user cancels confirmation', async () => {
      const result = setupProcessorHook([shellCommand]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      act(() => {
        result.current.handleSlashCommand('/shellcmd');
      });

      // Wait for the confirmation dialog to be set
      await waitFor(() => {
        expect(result.current.shellConfirmationRequest).not.toBeNull();
      });

      const onConfirm = result.current.shellConfirmationRequest?.onConfirm;
      expect(onConfirm).toBeDefined();

      // Change the mock action's behavior for a potential second run.
      // If the test is flawed, this will be called, and we can detect it.
      mockCommandAction.mockResolvedValue({
        type: 'message',
        messageType: 'info',
        content: 'This should not be called',
      });

      await act(async () => {
        onConfirm!(ToolConfirmationOutcome.Cancel, []); // Pass empty array for safety
      });

      expect(result.current.shellConfirmationRequest).toBeNull();
      // Verify the action was only called the initial time.
      expect(mockCommandAction).toHaveBeenCalledTimes(1);
    });

    it('should re-run command with one-time allowlist on "Proceed Once"', async () => {
      const result = setupProcessorHook([shellCommand]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      act(() => {
        result.current.handleSlashCommand('/shellcmd');
      });
      await waitFor(() => {
        expect(result.current.shellConfirmationRequest).not.toBeNull();
      });

      const onConfirm = result.current.shellConfirmationRequest?.onConfirm;

      // **Change the mock's behavior for the SECOND run.**
      // This is the key to testing the outcome.
      mockCommandAction.mockResolvedValue({
        type: 'message',
        messageType: 'info',
        content: 'Success!',
      });

      await act(async () => {
        onConfirm!(ToolConfirmationOutcome.ProceedOnce, ['rm -rf /']);
      });

      expect(result.current.shellConfirmationRequest).toBeNull();

      // The action should have been called twice (initial + re-run).
      await waitFor(() => {
        expect(mockCommandAction).toHaveBeenCalledTimes(2);
      });

      // We can inspect the context of the second call to ensure the one-time list was used.
      const secondCallContext = mockCommandAction.mock
        .calls[1][0] as CommandContext;
      expect(
        secondCallContext.session.sessionShellAllowlist.has('rm -rf /'),
      ).toBe(true);

      // Verify the final success message was added.
      expect(mockAddItem).toHaveBeenCalledWith(
        { type: MessageType.INFO, text: 'Success!' },
        expect.any(Number),
      );

      // Verify the session-wide allowlist was NOT permanently updated.
      // Re-render the hook by calling a no-op command to get the latest context.
      await act(async () => {
        result.current.handleSlashCommand('/no-op');
      });
      const finalContext = result.current.commandContext;
      expect(finalContext.session.sessionShellAllowlist.size).toBe(0);
    });

    it('should not duplicate user history when a confirmed command submits a prompt', async () => {
      mockCommandAction
        .mockResolvedValueOnce({
          type: 'confirm_shell_commands',
          commandsToConfirm: ['rm -rf /'],
          originalInvocation: { raw: '/shellcmd' },
        } as ConfirmShellCommandsActionReturn)
        .mockResolvedValueOnce({
          type: 'submit_prompt',
          content: [{ text: 'run approved command' }],
        });

      const result = setupProcessorHook([shellCommand]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      act(() => {
        result.current.handleSlashCommand('/shellcmd');
      });
      await waitFor(() => {
        expect(result.current.shellConfirmationRequest).not.toBeNull();
      });

      await act(async () => {
        result.current.shellConfirmationRequest?.onConfirm(
          ToolConfirmationOutcome.ProceedOnce,
          ['rm -rf /'],
        );
      });

      await waitFor(() => {
        expect(mockCommandAction).toHaveBeenCalledTimes(2);
      });
      const userInvocationCalls = mockAddItem.mock.calls.filter(
        ([item]) => item.type === MessageType.USER && item.text === '/shellcmd',
      );
      expect(userInvocationCalls).toHaveLength(1);
      expect(mockUpdateItem).toHaveBeenCalledWith(1, { sentToModel: true });

      const recorder = mockConfig.getChatRecordingService() as unknown as {
        recordSlashCommand: ReturnType<typeof vi.fn>;
      };
      expect(recorder.recordSlashCommand).toHaveBeenCalledTimes(2);
      expect(recorder.recordSlashCommand).toHaveBeenCalledWith({
        phase: 'invocation',
        rawCommand: '/shellcmd',
        sentToModel: true,
        hiddenInvocation: false,
      });
    });

    it('should not duplicate user history when a confirmed action submits a prompt', async () => {
      const action = vi
        .fn()
        .mockResolvedValueOnce({
          type: 'confirm_action',
          prompt: 'Continue?',
          originalInvocation: { raw: '/actioncmd' },
        } as ConfirmActionReturn)
        .mockResolvedValueOnce({
          type: 'submit_prompt',
          content: [{ text: 'run confirmed action' }],
        });
      const command = createTestCommand({
        name: 'actioncmd',
        action,
      });

      const result = setupProcessorHook([command]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      act(() => {
        result.current.handleSlashCommand('/actioncmd');
      });
      await waitFor(() => {
        expect(result.current.confirmationRequest).not.toBeNull();
      });

      await act(async () => {
        result.current.confirmationRequest?.onConfirm(true);
      });

      await waitFor(() => {
        expect(action).toHaveBeenCalledTimes(2);
      });
      const userInvocationCalls = mockAddItem.mock.calls.filter(
        ([item]) =>
          item.type === MessageType.USER && item.text === '/actioncmd',
      );
      expect(userInvocationCalls).toHaveLength(1);
      expect(mockUpdateItem).toHaveBeenCalledWith(1, { sentToModel: true });

      const recorder = mockConfig.getChatRecordingService() as unknown as {
        recordSlashCommand: ReturnType<typeof vi.fn>;
      };
      expect(recorder.recordSlashCommand).toHaveBeenCalledTimes(2);
      expect(recorder.recordSlashCommand).toHaveBeenCalledWith({
        phase: 'invocation',
        rawCommand: '/actioncmd',
        sentToModel: true,
        hiddenInvocation: false,
      });
    });

    it('should re-run command and update session allowlist on "Proceed Always"', async () => {
      const result = setupProcessorHook([shellCommand]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      act(() => {
        result.current.handleSlashCommand('/shellcmd');
      });
      await waitFor(() => {
        expect(result.current.shellConfirmationRequest).not.toBeNull();
      });

      const onConfirm = result.current.shellConfirmationRequest?.onConfirm;
      mockCommandAction.mockResolvedValue({
        type: 'message',
        messageType: 'info',
        content: 'Success!',
      });

      await act(async () => {
        onConfirm!(ToolConfirmationOutcome.ProceedAlways, ['rm -rf /']);
      });

      expect(result.current.shellConfirmationRequest).toBeNull();
      await waitFor(() => {
        expect(mockCommandAction).toHaveBeenCalledTimes(2);
      });

      expect(mockAddItem).toHaveBeenCalledWith(
        { type: MessageType.INFO, text: 'Success!' },
        expect.any(Number),
      );

      // Check that the session-wide allowlist WAS updated.
      await waitFor(() => {
        const finalContext = result.current.commandContext;
        expect(finalContext.session.sessionShellAllowlist.has('rm -rf /')).toBe(
          true,
        );
      });
    });
  });

  describe('Command Parsing and Matching', () => {
    it('should be case-sensitive', async () => {
      const command = createTestCommand({ name: 'test' });
      const result = setupProcessorHook([command]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      await act(async () => {
        // Use uppercase when command is lowercase
        await result.current.handleSlashCommand('/Test');
      });

      // It should fail and call addItem with an error
      expect(mockAddItem).toHaveBeenCalledWith(
        {
          type: MessageType.ERROR,
          text: 'Unknown command: /Test',
        },
        expect.any(Number),
      );
    });

    it('should correctly match an altName', async () => {
      const action = vi.fn();
      const command = createTestCommand({
        name: 'main',
        altNames: ['alias'],
        description: 'a command with an alias',
        action,
      });
      const result = setupProcessorHook([command]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      await act(async () => {
        await result.current.handleSlashCommand('/alias');
      });

      expect(action).toHaveBeenCalledTimes(1);
      expect(mockAddItem).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: MessageType.ERROR }),
      );
    });

    it('should handle extra whitespace around the command', async () => {
      const action = vi.fn();
      const command = createTestCommand({ name: 'test', action });
      const result = setupProcessorHook([command]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      await act(async () => {
        await result.current.handleSlashCommand('  /test  with-args  ');
      });

      expect(action).toHaveBeenCalledWith(expect.anything(), 'with-args');
    });

    it('should handle `?` as a command prefix', async () => {
      const action = vi.fn();
      const command = createTestCommand({ name: 'help', action });
      const result = setupProcessorHook([command]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      await act(async () => {
        await result.current.handleSlashCommand('?help');
      });

      expect(action).toHaveBeenCalledTimes(1);
    });
  });

  describe('Command Precedence', () => {
    it('should override mcp-based commands with file-based commands of the same name', async () => {
      const mcpAction = vi.fn();
      const fileAction = vi.fn();

      const mcpCommand = createTestCommand(
        {
          name: 'override',
          description: 'mcp',
          action: mcpAction,
        },
        CommandKind.MCP_PROMPT,
      );
      const fileCommand = createTestCommand(
        { name: 'override', description: 'file', action: fileAction },
        CommandKind.FILE,
      );

      const result = setupProcessorHook([], [fileCommand], [mcpCommand]);

      await waitFor(() => {
        // The service should only return one command with the name 'override'
        expect(result.current.slashCommands).toHaveLength(1);
      });

      await act(async () => {
        await result.current.handleSlashCommand('/override');
      });

      // Only the file-based command's action should be called.
      expect(fileAction).toHaveBeenCalledTimes(1);
      expect(mcpAction).not.toHaveBeenCalled();
    });

    it('should prioritize a command with a primary name over a command with a matching alias', async () => {
      const quitAction = vi.fn();
      const exitAction = vi.fn();

      const quitCommand = createTestCommand({
        name: 'quit',
        altNames: ['exit'],
        action: quitAction,
      });

      const exitCommand = createTestCommand(
        {
          name: 'exit',
          action: exitAction,
        },
        CommandKind.FILE,
      );

      // The order of commands in the final loaded array is not guaranteed,
      // so the test must work regardless of which comes first.
      const result = setupProcessorHook([quitCommand], [exitCommand]);

      await waitFor(() => {
        expect(result.current.slashCommands).toHaveLength(2);
      });

      await act(async () => {
        await result.current.handleSlashCommand('/exit');
      });

      // The action for the command whose primary name is 'exit' should be called.
      expect(exitAction).toHaveBeenCalledTimes(1);
      // The action for the command that has 'exit' as an alias should NOT be called.
      expect(quitAction).not.toHaveBeenCalled();
    });

    it('should add an overridden command to the history', async () => {
      const quitCommand = createTestCommand({
        name: 'quit',
        altNames: ['exit'],
        action: vi.fn(),
      });
      const exitCommand = createTestCommand(
        { name: 'exit', action: vi.fn() },
        CommandKind.FILE,
      );

      const result = setupProcessorHook([quitCommand], [exitCommand]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(2));

      await act(async () => {
        await result.current.handleSlashCommand('/exit');
      });

      // It should be added to the history.
      expect(mockAddItem).toHaveBeenCalledWith(
        { type: MessageType.USER, text: '/exit', sentToModel: false },
        expect.any(Number),
      );
    });
  });

  describe('Lifecycle', () => {
    it('should abort command loading when the hook unmounts', () => {
      const abortSpy = vi.spyOn(AbortController.prototype, 'abort');
      const { unmount } = renderHook(() =>
        useSlashCommandProcessor(
          mockConfig,
          mockSettings,
          [], // mock history array
          mockAddItem,
          mockClearItems,
          mockLoadHistory,
          vi.fn(), // refreshStatic
          vi.fn(), // toggleVimEnabled
          false, // isProcessing
          vi.fn(), // setIsProcessing
          { current: true }, // isIdleRef
          vi.fn(), // setMemoryFileCount
          createMockActions(),
          new Map(), // extensionsUpdateState
          true, // isConfigInitialized
          null, // logger
          mockUpdateItem,
        ),
      );

      unmount();

      expect(abortSpy).toHaveBeenCalledTimes(1);
    });

    it('auto-refreshes extension content changes after debounce', async () => {
      const extensionRefreshState = new ExtensionRefreshState();
      const result = setupProcessorHook(
        [],
        [],
        [],
        vi.fn(),
        mockSettings,
        extensionRefreshState,
      );
      await waitFor(() => {
        expect(result.current.slashCommands).toBeDefined();
      });

      act(() => {
        extensionRefreshState.markExtensionContentChanged('content changed');
      });

      await waitFor(() => {
        expect(refreshExtensionContentRuntime).toHaveBeenCalledOnce();
      });
      expect(refreshExtensionContentRuntime).toHaveBeenCalledWith({
        config: mockConfig,
        reloadCommands: expect.any(Function),
      });
    });

    it('shows an error when extension content auto-refresh fails', async () => {
      vi.mocked(refreshExtensionContentRuntime).mockRejectedValueOnce(
        new Error('refresh failed'),
      );
      const extensionRefreshState = new ExtensionRefreshState();
      const result = setupProcessorHook(
        [],
        [],
        [],
        vi.fn(),
        mockSettings,
        extensionRefreshState,
      );
      await waitFor(() => {
        expect(result.current.slashCommands).toBeDefined();
      });

      act(() => {
        extensionRefreshState.markExtensionContentChanged('content changed');
      });

      await waitFor(() => {
        expect(mockAddItem).toHaveBeenCalledWith(
          {
            type: MessageType.ERROR,
            text: 'Failed to refresh extension content: refresh failed. Run /reload-plugins to apply updates.',
          },
          expect.any(Number),
        );
      });
    });

    it('skips content auto-refresh while package reload is needed', async () => {
      const extensionRefreshState = new ExtensionRefreshState();
      const result = setupProcessorHook(
        [],
        [],
        [],
        vi.fn(),
        mockSettings,
        extensionRefreshState,
      );
      await waitFor(() => {
        expect(result.current.slashCommands).toBeDefined();
      });

      act(() => {
        extensionRefreshState.markExtensionsChanged('manifest changed');
        extensionRefreshState.markExtensionContentChanged('content changed');
      });

      await new Promise((resolve) => setTimeout(resolve, 350));

      expect(refreshExtensionContentRuntime).not.toHaveBeenCalled();
      expect(mockAddItem).toHaveBeenCalledWith(
        {
          type: MessageType.INFO,
          text: 'Extensions changed on disk. Run /reload-plugins to apply updates.',
        },
        expect.any(Number),
      );
    });

    it('shows a retry message when extension reload fails', async () => {
      const extensionRefreshState = new ExtensionRefreshState();
      const result = setupProcessorHook(
        [],
        [],
        [],
        vi.fn(),
        mockSettings,
        extensionRefreshState,
      );
      await waitFor(() => {
        expect(result.current.slashCommands).toBeDefined();
      });

      act(() => {
        extensionRefreshState.markExtensionsReloadFailed();
      });

      expect(mockAddItem).toHaveBeenCalledWith(
        {
          type: MessageType.INFO,
          text: 'Extension reload did not complete. Run /reload-plugins to try again.',
        },
        expect.any(Number),
      );
    });

    it('cancels pending content auto-refresh when manual reload starts', async () => {
      const extensionRefreshState = new ExtensionRefreshState();
      const result = setupProcessorHook(
        [],
        [],
        [],
        vi.fn(),
        mockSettings,
        extensionRefreshState,
      );
      await waitFor(() => {
        expect(result.current.slashCommands).toBeDefined();
      });

      act(() => {
        extensionRefreshState.markExtensionContentChanged('content changed');
        extensionRefreshState.notifyExtensionsReloadStarted();
      });

      await new Promise((resolve) => setTimeout(resolve, 350));

      expect(refreshExtensionContentRuntime).not.toHaveBeenCalled();
    });

    it('should reload commands when SkillManager fires a change event', async () => {
      const removeListener = vi.fn();
      const addChangeListener = vi.fn().mockReturnValue(removeListener);
      // The slashCommandProcessor change-listener calls
      // `consumeSlashReloadSuppression()` on every fire to honor the
      // dialog-driven one-shot suppression flag. Tests that drive the
      // listener directly need this method on the fake; default
      // (false) just preserves the pre-suppression behavior.
      const fakeSkillManager = {
        addChangeListener,
        consumeSlashReloadSuppression: vi.fn(() => false),
      };
      const skillManagerSpy = vi
        .spyOn(mockConfig, 'getSkillManager')
        .mockReturnValue(
          fakeSkillManager as unknown as ReturnType<
            typeof mockConfig.getSkillManager
          >,
        );

      try {
        mockBuiltinLoadCommands.mockResolvedValue([]);
        mockFileLoadCommands.mockResolvedValue([]);
        mockMcpLoadCommands.mockResolvedValue([]);

        const { unmount } = renderHook(() =>
          useSlashCommandProcessor(
            mockConfig,
            mockSettings,
            [], // mock history array
            mockAddItem,
            mockClearItems,
            mockLoadHistory,
            vi.fn(),
            vi.fn(),
            false,
            vi.fn(),
            { current: true },
            vi.fn(),
            createMockActions(),
            new Map(),
            true,
            null,
            mockUpdateItem,
          ),
        );

        await waitFor(() => expect(addChangeListener).toHaveBeenCalledTimes(1));
        // Initial CommandService.create() pass: BuiltinCommandLoader is
        // constructed once. Firing the SkillManager listener bumps the
        // reloadTrigger and the loader effect re-runs, constructing the
        // builtin loader a second time — that is the observable signal
        // that a reload happened.
        await waitFor(() =>
          expect(BuiltinCommandLoader).toHaveBeenCalledTimes(1),
        );

        const listener = addChangeListener.mock.calls[0][0] as () => void;
        await act(async () => {
          listener();
        });

        await waitFor(() =>
          expect(BuiltinCommandLoader).toHaveBeenCalledTimes(2),
        );

        unmount();
        expect(removeListener).toHaveBeenCalledTimes(1);
      } finally {
        skillManagerSpy.mockRestore();
      }
    });

    it('should skip reload when consumeSlashReloadSuppression returns true', async () => {
      const removeListener = vi.fn();
      const addChangeListener = vi.fn().mockReturnValue(removeListener);
      const fakeSkillManager = {
        addChangeListener,
        consumeSlashReloadSuppression: vi.fn(() => true),
      };
      const skillManagerSpy = vi
        .spyOn(mockConfig, 'getSkillManager')
        .mockReturnValue(
          fakeSkillManager as unknown as ReturnType<
            typeof mockConfig.getSkillManager
          >,
        );
      try {
        mockBuiltinLoadCommands.mockResolvedValue([]);
        mockFileLoadCommands.mockResolvedValue([]);
        mockMcpLoadCommands.mockResolvedValue([]);

        const { unmount } = renderHook(() =>
          useSlashCommandProcessor(
            mockConfig,
            mockSettings,
            [], // mock history array
            mockAddItem,
            mockClearItems,
            mockLoadHistory,
            vi.fn(),
            vi.fn(),
            false,
            vi.fn(),
            { current: true },
            vi.fn(),
            createMockActions(),
            new Map(),
            true,
            null,
          ),
        );

        await waitFor(() => expect(addChangeListener).toHaveBeenCalledTimes(1));
        await waitFor(() =>
          expect(BuiltinCommandLoader).toHaveBeenCalledTimes(1),
        );

        const listener = addChangeListener.mock.calls[0][0] as () => void;
        await act(async () => {
          listener();
        });

        // When suppression is consumed, the listener should NOT trigger
        // a second load — BuiltinCommandLoader stays at 1 call.
        expect(BuiltinCommandLoader).toHaveBeenCalledTimes(1);

        unmount();
      } finally {
        skillManagerSpy.mockRestore();
      }
    });

    it('should register SkillManager listener after config initialization', async () => {
      const removeListener = vi.fn();
      const addChangeListener = vi.fn().mockReturnValue(removeListener);
      // The slashCommandProcessor change-listener calls
      // `consumeSlashReloadSuppression()` on every fire to honor the
      // dialog-driven one-shot suppression flag. Tests that drive the
      // listener directly need this method on the fake; default
      // (false) just preserves the pre-suppression behavior.
      const fakeSkillManager = {
        addChangeListener,
        consumeSlashReloadSuppression: vi.fn(() => false),
      };
      let initializedForConfig = false;
      const skillManagerSpy = vi
        .spyOn(mockConfig, 'getSkillManager')
        .mockImplementation(() =>
          initializedForConfig
            ? (fakeSkillManager as unknown as ReturnType<
                typeof mockConfig.getSkillManager
              >)
            : null,
        );

      try {
        mockBuiltinLoadCommands.mockResolvedValue([]);
        mockFileLoadCommands.mockResolvedValue([]);
        mockMcpLoadCommands.mockResolvedValue([]);

        const { rerender, unmount } = renderHook(
          ({ isConfigInitialized }) => {
            initializedForConfig = isConfigInitialized;
            return useSlashCommandProcessor(
              mockConfig,
              mockSettings,
              [], // mock history array
              mockAddItem,
              mockClearItems,
              mockLoadHistory,
              vi.fn(),
              vi.fn(),
              false,
              vi.fn(),
              { current: true },
              vi.fn(),
              createMockActions(),
              new Map(),
              isConfigInitialized,
              null,
              mockUpdateItem,
            );
          },
          { initialProps: { isConfigInitialized: false } },
        );

        expect(addChangeListener).not.toHaveBeenCalled();

        rerender({ isConfigInitialized: true });

        await waitFor(() => expect(addChangeListener).toHaveBeenCalledTimes(1));

        unmount();
        expect(removeListener).toHaveBeenCalledTimes(1);
      } finally {
        skillManagerSpy.mockRestore();
      }
    });

    it('should not publish model-invocable commands from an aborted reload', async () => {
      const staleCommand = createTestCommand({
        name: 'stale',
        modelInvocable: true,
      });
      const freshCommand = createTestCommand({
        name: 'fresh',
        modelInvocable: true,
      });
      let resolveStaleLoad!: (commands: SlashCommand[]) => void;

      mockBuiltinLoadCommands
        .mockImplementationOnce(
          () =>
            new Promise<SlashCommand[]>((resolve) => {
              resolveStaleLoad = resolve;
            }),
        )
        .mockResolvedValueOnce([freshCommand]);
      mockFileLoadCommands.mockResolvedValue([]);
      mockMcpLoadCommands.mockResolvedValue([]);

      const { rerender } = renderHook(
        ({ isConfigInitialized }) =>
          useSlashCommandProcessor(
            mockConfig,
            mockSettings,
            [], // mock history array
            mockAddItem,
            mockClearItems,
            mockLoadHistory,
            vi.fn(),
            vi.fn(),
            false,
            vi.fn(),
            { current: true },
            vi.fn(),
            createMockActions(),
            new Map(),
            isConfigInitialized,
            null,
            mockUpdateItem,
          ),
        { initialProps: { isConfigInitialized: false } },
      );

      rerender({ isConfigInitialized: true });

      await waitFor(() =>
        expect(
          mockConfig
            .getModelInvocableCommandsProvider?.()?.()
            .map((c) => c.name),
        ).toEqual(['fresh']),
      );

      await act(async () => {
        resolveStaleLoad([staleCommand]);
      });

      await waitFor(() =>
        expect(
          mockConfig
            .getModelInvocableCommandsProvider?.()?.()
            .map((c) => c.name),
        ).toEqual(['fresh']),
      );
    });
  });

  describe('Slash Command Logging', () => {
    const mockCommandAction = vi.fn().mockResolvedValue({ type: 'handled' });
    const loggingTestCommands: SlashCommand[] = [
      createTestCommand({
        name: 'logtest',
        action: vi
          .fn()
          .mockResolvedValue({ type: 'message', content: 'hello world' }),
      }),
      createTestCommand({
        name: 'logwithsub',
        subCommands: [
          createTestCommand({
            name: 'sub',
            action: mockCommandAction,
          }),
        ],
      }),
      createTestCommand({
        name: 'fail',
        action: vi.fn().mockRejectedValue(new Error('oh no!')),
      }),
      createTestCommand({
        name: 'logalias',
        altNames: ['la'],
        action: mockCommandAction,
      }),
    ];

    beforeEach(() => {
      mockCommandAction.mockClear();
      vi.mocked(logSlashCommand).mockClear();
      vi.mocked(recordSkillInvocation).mockClear();
    });

    it('should log a simple slash command', async () => {
      const result = setupProcessorHook(loggingTestCommands);
      await waitFor(() =>
        expect(result.current.slashCommands.length).toBeGreaterThan(0),
      );
      await act(async () => {
        await result.current.handleSlashCommand('/logtest');
      });

      expect(logSlashCommand).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          command: 'logtest',
          subcommand: undefined,
          status: SlashCommandStatus.SUCCESS,
        }),
      );
    });

    it('logs nothing for a bogus command', async () => {
      const result = setupProcessorHook(loggingTestCommands);
      await waitFor(() =>
        expect(result.current.slashCommands.length).toBeGreaterThan(0),
      );
      await act(async () => {
        await result.current.handleSlashCommand('/bogusbogusbogus');
      });

      expect(logSlashCommand).not.toHaveBeenCalled();
    });

    it('logs a failure event for a failed command', async () => {
      const result = setupProcessorHook(loggingTestCommands);
      await waitFor(() =>
        expect(result.current.slashCommands.length).toBeGreaterThan(0),
      );
      await act(async () => {
        await result.current.handleSlashCommand('/fail');
      });

      expect(logSlashCommand).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          command: 'fail',
          status: 'error',
          subcommand: undefined,
        }),
      );
    });

    it('should log a slash command with a subcommand', async () => {
      const result = setupProcessorHook(loggingTestCommands);
      await waitFor(() =>
        expect(result.current.slashCommands.length).toBeGreaterThan(0),
      );
      await act(async () => {
        await result.current.handleSlashCommand('/logwithsub sub');
      });

      expect(logSlashCommand).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          command: 'logwithsub',
          subcommand: 'sub',
        }),
      );
    });

    it('should log the command path when an alias is used', async () => {
      const result = setupProcessorHook(loggingTestCommands);
      await waitFor(() =>
        expect(result.current.slashCommands.length).toBeGreaterThan(0),
      );
      await act(async () => {
        await result.current.handleSlashCommand('/la');
      });
      expect(logSlashCommand).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          command: 'logalias',
        }),
      );
    });

    it('records successful skill slash commands when they submit a prompt', async () => {
      vi.spyOn(mockConfig, 'getProjectRoot').mockReturnValueOnce(
        '/test/project',
      );
      const skillCmd = createTestCommand(
        {
          name: 'review-skill',
          skillDetail: {
            name: 'review-skill',
            level: 'project',
            filePath: '/test/project/.qwen/skills/auto-skill-review/SKILL.md',
          },
          action: vi.fn().mockResolvedValue({
            type: 'submit_prompt',
            content: [{ text: 'skill body' }],
          }),
        },
        CommandKind.SKILL,
      );
      const result = setupProcessorHook([skillCmd]);
      await waitFor(() =>
        expect(result.current.slashCommands.length).toBeGreaterThan(0),
      );

      await act(async () => {
        await result.current.handleSlashCommand('/review-skill');
      });

      expect(recordSkillInvocation).toHaveBeenCalledWith(mockConfig, {
        skillName: 'review-skill',
        success: true,
      });
      expect(recordAutoSkillUsageMock).toHaveBeenCalledWith('/test/project', {
        name: 'review-skill',
        level: 'project',
        filePath: '/test/project/.qwen/skills/auto-skill-review/SKILL.md',
      });
    });

    it('records failed skill slash commands when the action throws', async () => {
      const skillCmd = createTestCommand(
        {
          name: 'review-skill',
          action: vi.fn().mockRejectedValue(new Error('skill failed')),
        },
        CommandKind.SKILL,
      );
      const result = setupProcessorHook([skillCmd]);
      await waitFor(() =>
        expect(result.current.slashCommands.length).toBeGreaterThan(0),
      );

      await act(async () => {
        await result.current.handleSlashCommand('/review-skill');
      });

      expect(recordSkillInvocation).toHaveBeenCalledWith(mockConfig, {
        skillName: 'review-skill',
        success: false,
      });
      expect(recordAutoSkillUsageMock).not.toHaveBeenCalled();
    });

    it('records blocked skill slash commands as failures', async () => {
      mockFireUserPromptExpansionEvent.mockResolvedValue({
        getBlockingError: () => ({
          blocked: true,
          reason: 'Blocked by policy',
        }),
        shouldStopExecution: () => false,
      });
      const skillCmd = createTestCommand(
        {
          name: 'review-skill',
          action: vi.fn().mockResolvedValue({
            type: 'submit_prompt',
            content: [{ text: 'skill body' }],
          }),
        },
        CommandKind.SKILL,
      );
      const result = setupProcessorHook([skillCmd]);
      await waitFor(() =>
        expect(result.current.slashCommands.length).toBeGreaterThan(0),
      );

      await act(async () => {
        await result.current.handleSlashCommand('/review-skill');
      });

      expect(recordSkillInvocation).toHaveBeenCalledWith(mockConfig, {
        skillName: 'review-skill',
        success: false,
      });
      expect(recordAutoSkillUsageMock).not.toHaveBeenCalled();
    });

    it('records confirmed skill slash commands only once', async () => {
      vi.spyOn(mockConfig, 'getProjectRoot').mockReturnValueOnce(
        '/test/project',
      );
      const action = vi
        .fn()
        .mockResolvedValueOnce({
          type: 'confirm_action',
          prompt: 'Run skill?',
          originalInvocation: { raw: '/review-skill' },
        } as ConfirmActionReturn)
        .mockResolvedValueOnce({
          type: 'submit_prompt',
          content: [{ text: 'skill body' }],
        });
      const skillCmd = createTestCommand(
        {
          name: 'review-skill',
          skillDetail: {
            name: 'review-skill',
            level: 'project',
            filePath: '/test/project/.qwen/skills/auto-skill-review/SKILL.md',
          },
          action,
        },
        CommandKind.SKILL,
      );
      const result = setupProcessorHook([skillCmd]);
      await waitFor(() =>
        expect(result.current.slashCommands.length).toBeGreaterThan(0),
      );

      act(() => {
        void result.current.handleSlashCommand('/review-skill');
      });
      await waitFor(() => {
        expect(result.current.confirmationRequest).not.toBeNull();
      });

      await act(async () => {
        result.current.confirmationRequest?.onConfirm(true);
      });

      await waitFor(() => {
        expect(action).toHaveBeenCalledTimes(2);
      });
      expect(recordSkillInvocation).toHaveBeenCalledTimes(1);
      expect(recordAutoSkillUsageMock).toHaveBeenCalledTimes(1);
      expect(recordSkillInvocation).toHaveBeenCalledWith(mockConfig, {
        skillName: 'review-skill',
        success: true,
      });
    });

    it('does not record non-skill submit-prompt slash commands as skills', async () => {
      const fileCmd = createTestCommand(
        {
          name: 'filecmd',
          action: vi.fn().mockResolvedValue({
            type: 'submit_prompt',
            content: [{ text: 'custom prompt' }],
          }),
        },
        CommandKind.FILE,
      );
      const result = setupProcessorHook([], [fileCmd]);
      await waitFor(() =>
        expect(result.current.slashCommands.length).toBeGreaterThan(0),
      );

      await act(async () => {
        await result.current.handleSlashCommand('/filecmd');
      });

      expect(recordSkillInvocation).not.toHaveBeenCalled();
    });

    it('should not log for unknown commands', async () => {
      const result = setupProcessorHook(loggingTestCommands);
      await waitFor(() =>
        expect(result.current.slashCommands.length).toBeGreaterThan(0),
      );
      await act(async () => {
        await result.current.handleSlashCommand('/unknown');
      });
      expect(logSlashCommand).not.toHaveBeenCalled();
    });
  });

  describe('ui.clear and /btw dialog', () => {
    it('should discard pending Gemini state when ui.clear is called', async () => {
      const result = setupProcessorHook();
      await waitFor(() => expect(result.current.commandContext).toBeDefined());

      act(() => {
        result.current.commandContext.ui.clear();
      });

      expect(mockClearPendingState).toHaveBeenCalledTimes(1);
      expect(mockClearItems).toHaveBeenCalledTimes(1);
    });

    it('should dismiss an active btw dialog when ui.clear is called', async () => {
      const result = setupProcessorHook();
      await waitFor(() => expect(result.current.commandContext).toBeDefined());

      const btwItem: HistoryItemBtw = {
        type: MessageType.BTW,
        btw: { question: 'why?', answer: '', isPending: true },
      };

      act(() => {
        result.current.commandContext.ui.setBtwItem(btwItem);
      });
      await waitFor(() => {
        expect(result.current.commandContext.ui.btwItem).toEqual(btwItem);
      });

      act(() => {
        result.current.commandContext.ui.clear();
      });

      await waitFor(() => {
        expect(result.current.commandContext.ui.btwItem).toBeNull();
      });
    });

    it('should abort the in-flight btw request when ui.clear is called', async () => {
      const result = setupProcessorHook();
      await waitFor(() => expect(result.current.commandContext).toBeDefined());

      const abortController = new AbortController();
      const abortSpy = vi.spyOn(abortController, 'abort');

      act(() => {
        result.current.commandContext.ui.btwAbortControllerRef.current =
          abortController;
      });

      act(() => {
        result.current.commandContext.ui.clear();
      });

      expect(abortSpy).toHaveBeenCalledTimes(1);
      expect(
        result.current.commandContext.ui.btwAbortControllerRef.current,
      ).toBeNull();
    });
  });

  describe('SLASH_COMMANDS_SKIP_RECORDING', () => {
    // Why these live in the skip set: the fork itself is the side effect
    // (new JSONL file with full parent history), so also writing a
    // `/branch <name>` slash-command record into the parent session would
    // bleed into the fork's tail as a trailing user input — user-visible
    // noise with no semantic value. Same rationale for /new, /resume,
    // /delete, /clear: session-level commands whose outcome is the new
    // session state, not a conversation turn.
    it('does not record /branch via the chat recorder', async () => {
      const branchCmd = createTestCommand({
        name: 'branch',
        action: vi.fn().mockResolvedValue({ type: 'dialog', dialog: 'branch' }),
      });
      const result = setupProcessorHook([branchCmd]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      const recorder = mockConfig.getChatRecordingService() as unknown as {
        recordSlashCommand: ReturnType<typeof vi.fn>;
      };
      recorder.recordSlashCommand.mockClear();

      await act(async () => {
        await result.current.handleSlashCommand('/branch my-branch');
      });

      expect(recorder.recordSlashCommand).not.toHaveBeenCalled();
    });

    it('does not record /advisor via the chat recorder', async () => {
      const advisorCmd = createTestCommand({
        name: 'advisor',
        action: vi.fn().mockResolvedValue(undefined),
      });
      const result = setupProcessorHook([advisorCmd]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      const recorder = mockConfig.getChatRecordingService() as unknown as {
        recordSlashCommand: ReturnType<typeof vi.fn>;
      };
      recorder.recordSlashCommand.mockClear();

      await act(async () => {
        await result.current.handleSlashCommand('/advisor check my work');
      });

      expect(advisorCmd.action).toHaveBeenCalled();
      expect(recorder.recordSlashCommand).not.toHaveBeenCalled();
    });

    it('records a user command shadowing the advisor name', async () => {
      const shadowCmd = createTestCommand(
        {
          name: 'advisor',
          action: vi.fn().mockResolvedValue(undefined),
        },
        CommandKind.FILE,
      );
      const result = setupProcessorHook([shadowCmd]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      const recorder = mockConfig.getChatRecordingService() as unknown as {
        recordSlashCommand: ReturnType<typeof vi.fn>;
      };
      recorder.recordSlashCommand.mockClear();

      await act(async () => {
        await result.current.handleSlashCommand('/advisor check my work');
      });

      expect(shadowCmd.action).toHaveBeenCalled();
      expect(recorder.recordSlashCommand).toHaveBeenCalledTimes(2);
    });

    it('still records unrelated commands via the chat recorder (control)', async () => {
      const testCmd = createTestCommand({
        name: 'regular',
        action: vi.fn().mockResolvedValue(undefined),
      });
      const result = setupProcessorHook([testCmd]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      const recorder = mockConfig.getChatRecordingService() as unknown as {
        recordSlashCommand: ReturnType<typeof vi.fn>;
      };
      recorder.recordSlashCommand.mockClear();

      await act(async () => {
        await result.current.handleSlashCommand('/regular');
      });

      expect(recorder.recordSlashCommand).toHaveBeenCalled();
    });
  });

  describe('Stacked Skill Invocations', () => {
    const createSkillCommand = (name: string, body: string): SlashCommand =>
      createTestCommand(
        {
          name,
          description: `Skill ${name}`,
          action: vi.fn().mockResolvedValue({
            type: 'submit_prompt',
            content: [{ text: `SKILL_BODY:${name}:${body}` }],
          }),
        },
        CommandKind.SKILL,
      );

    it('dispatches a single skill through normal path (not stacked)', async () => {
      const skillA = createSkillCommand('feat-dev', 'feature workflow');
      const result = setupProcessorHook([skillA]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      let actionResult;
      await act(async () => {
        actionResult =
          await result.current.handleSlashCommand('/feat-dev build X');
      });

      // Normal dispatch: single skill action was called
      expect(skillA.action).toHaveBeenCalled();
      expect(actionResult).toBeDefined();
    });

    it('combines two stacked skills into a single submit_prompt', async () => {
      const skillA = createSkillCommand('feat-dev', 'feature workflow');
      const skillB = createSkillCommand('e2e-testing', 'e2e workflow');
      const result = setupProcessorHook([skillA, skillB]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(2));

      let actionResult;
      await act(async () => {
        actionResult = await result.current.handleSlashCommand(
          '/feat-dev /e2e-testing implement X',
        );
      });

      expect(actionResult).toEqual({
        type: 'submit_prompt',
        content: expect.arrayContaining([
          { text: 'SKILL_BODY:feat-dev:feature workflow' },
          { text: 'SKILL_BODY:e2e-testing:e2e workflow' },
          { text: 'implement X' },
        ]),
      });
    });

    it('preserves context-file refresh intent from stacked skills', async () => {
      const skillA: SlashCommand = createTestCommand(
        {
          name: 'remember-skill',
          description: 'Skill that writes project context',
          action: vi.fn().mockResolvedValue({
            type: 'submit_prompt',
            content: [{ text: 'SKILL_BODY:remember-skill' }],
            refreshContextFilesOnWrite: true,
          }),
        },
        CommandKind.SKILL,
      );
      const skillB = createSkillCommand('e2e-testing', 'e2e workflow');
      const result = setupProcessorHook([skillA, skillB]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(2));

      let actionResult;
      await act(async () => {
        actionResult = await result.current.handleSlashCommand(
          '/remember-skill /e2e-testing implement X',
        );
      });

      expect(actionResult).toEqual({
        type: 'submit_prompt',
        content: expect.arrayContaining([
          { text: 'SKILL_BODY:remember-skill' },
          { text: 'SKILL_BODY:e2e-testing:e2e workflow' },
          { text: 'implement X' },
        ]),
        refreshContextFilesOnWrite: true,
      });
    });

    it('calls recordSkillInvocation for each stacked skill', async () => {
      const skillA = createSkillCommand('feat-dev', 'a');
      const skillB = createSkillCommand('bugfix', 'b');
      const result = setupProcessorHook([skillA, skillB]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(2));

      recordSkillInvocationMock.mockClear();
      await act(async () => {
        await result.current.handleSlashCommand('/feat-dev /bugfix fix login');
      });

      const recordedNames = recordSkillInvocationMock.mock.calls.map(
        (call: unknown[]) => (call[1] as { skillName: string }).skillName,
      );
      expect(recordedNames).toContain('feat-dev');
      expect(recordedNames).toContain('bugfix');
    });

    it('records successful stacked project auto-skills as used', async () => {
      vi.spyOn(mockConfig, 'getProjectRoot').mockReturnValue('/test/project');
      const skillA = {
        ...createSkillCommand('feat-dev', 'a'),
        skillDetail: {
          name: 'feat-dev',
          level: 'project',
          filePath: '/test/project/.qwen/skills/auto-skill-feat-dev/SKILL.md',
        },
      };
      const skillB = {
        ...createSkillCommand('review', 'b'),
        skillDetail: {
          name: 'review',
          level: 'project',
          filePath: '/test/project/.qwen/skills/auto-skill-review/SKILL.md',
        },
      };
      const result = setupProcessorHook([skillA, skillB]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(2));

      recordAutoSkillUsageMock.mockClear();
      await act(async () => {
        await result.current.handleSlashCommand('/feat-dev /review do stuff');
      });

      expect(recordAutoSkillUsageMock).toHaveBeenCalledTimes(2);
      expect(recordAutoSkillUsageMock).toHaveBeenCalledWith('/test/project', {
        name: 'feat-dev',
        level: 'project',
        filePath: '/test/project/.qwen/skills/auto-skill-feat-dev/SKILL.md',
      });
      expect(recordAutoSkillUsageMock).toHaveBeenCalledWith('/test/project', {
        name: 'review',
        level: 'project',
        filePath: '/test/project/.qwen/skills/auto-skill-review/SKILL.md',
      });
    });

    it('appends remaining text after all skill bodies', async () => {
      const skillA = createSkillCommand('feat-dev', 'a');
      const skillB = createSkillCommand('review', 'b');
      const result = setupProcessorHook([skillA, skillB]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(2));

      let actionResult;
      await act(async () => {
        actionResult = await result.current.handleSlashCommand(
          '/feat-dev /review please review the auth module',
        );
      });

      const content = (actionResult as { content: Array<{ text: string }> })
        .content;
      const texts = content.map((c) => c.text);
      // Remaining text should be the last element
      expect(texts[texts.length - 1]).toBe('please review the auth module');
    });

    it('shows a warning when stacked skills exceed the maximum', async () => {
      const skills = Array.from({ length: 6 }, (_, i) =>
        createSkillCommand(`skill-${i}`, `body-${i}`),
      );
      const result = setupProcessorHook(skills);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(6));

      await act(async () => {
        await result.current.handleSlashCommand(
          '/skill-0 /skill-1 /skill-2 /skill-3 /skill-4 /skill-5 do it',
        );
      });

      // Should have emitted a warning message
      const warningCalls = mockAddItem.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as { type: number }).type === MessageType.WARNING,
      );
      expect(warningCalls.length).toBeGreaterThan(0);
      expect((warningCalls[0][0] as { text: string }).text).toContain(
        'Only the first 5',
      );
    });

    it('handles stacked skills with no remaining text', async () => {
      const skillA = createSkillCommand('feat-dev', 'a');
      const skillB = createSkillCommand('e2e-testing', 'b');
      const result = setupProcessorHook([skillA, skillB]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(2));

      let actionResult;
      await act(async () => {
        actionResult = await result.current.handleSlashCommand(
          '/feat-dev /e2e-testing',
        );
      });

      const content = (actionResult as { content: Array<{ text: string }> })
        .content;
      const texts = content.map((c) => c.text);
      expect(texts).toContain('SKILL_BODY:feat-dev:a');
      expect(texts).toContain('SKILL_BODY:e2e-testing:b');
      // No remaining text appended
      expect(texts).toHaveLength(2);
    });

    it('skips skill commands whose action is undefined', async () => {
      const skillA = createSkillCommand('feat-dev', 'a');
      const skillB = createTestCommand(
        {
          name: 'no-action-skill',
          description: 'Skill without action',
          kind: CommandKind.SKILL,
          action: undefined,
        },
        CommandKind.SKILL,
      );
      const skillC = createSkillCommand('review', 'c');
      const result = setupProcessorHook([skillA, skillB, skillC]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(3));

      let actionResult;
      await act(async () => {
        actionResult = await result.current.handleSlashCommand(
          '/feat-dev /no-action-skill /review do it',
        );
      });

      // All three skills should be in the result, but the one without action
      // simply doesn't contribute content
      const content = (actionResult as { content: Array<{ text: string }> })
        .content;
      const texts = content.map((c) => c.text);
      expect(texts).toContain('SKILL_BODY:feat-dev:a');
      expect(texts).toContain('SKILL_BODY:review:c');
    });

    it('excludes non-submit_prompt results from combined content', async () => {
      const skillA = createSkillCommand('feat-dev', 'a');
      const skillB: SlashCommand = createTestCommand(
        {
          name: 'error-skill',
          description: 'Skill that returns error',
          action: vi.fn().mockResolvedValue({
            type: 'message',
            messageType: 'error',
            content: 'Something went wrong',
          }),
        },
        CommandKind.SKILL,
      );
      const skillC = createSkillCommand('review', 'c');
      const result = setupProcessorHook([skillA, skillB, skillC]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(3));

      let actionResult;
      await act(async () => {
        actionResult = await result.current.handleSlashCommand(
          '/feat-dev /error-skill /review do it',
        );
      });

      // Error message should be surfaced via addMessage
      const errorCalls = mockAddItem.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as { type: number }).type === MessageType.ERROR,
      );
      expect(errorCalls.length).toBeGreaterThan(0);
      expect((errorCalls[0][0] as { text: string }).text).toContain(
        'Something went wrong',
      );

      // Combined content should only contain submit_prompt results
      const content = (actionResult as { content: Array<{ text: string }> })
        .content;
      const texts = content.map((c) => c.text);
      expect(texts).toContain('SKILL_BODY:feat-dev:a');
      expect(texts).toContain('SKILL_BODY:review:c');
      expect(texts).not.toContain('Something went wrong');
    });

    it('records telemetry success=false for non-submit_prompt skill results', async () => {
      const skillA = createSkillCommand('feat-dev', 'a');
      const skillB: SlashCommand = createTestCommand(
        {
          name: 'error-skill',
          description: 'Skill that returns error',
          action: vi.fn().mockResolvedValue({
            type: 'message',
            messageType: 'error',
            content: 'fail',
          }),
        },
        CommandKind.SKILL,
      );
      const result = setupProcessorHook([skillA, skillB]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(2));

      recordSkillInvocationMock.mockClear();
      await act(async () => {
        await result.current.handleSlashCommand('/feat-dev /error-skill do it');
      });

      const records = recordSkillInvocationMock.mock.calls.map(
        (call: unknown[]) => call[1] as { skillName: string; success: boolean },
      );
      const featRecord = records.find((r) => r.skillName === 'feat-dev');
      const errorRecord = records.find((r) => r.skillName === 'error-skill');
      expect(featRecord?.success).toBe(true);
      expect(errorRecord?.success).toBe(false);
    });

    it('propagates modelOverride from first submit_prompt skill', async () => {
      const skillA: SlashCommand = createTestCommand(
        {
          name: 'feat-dev',
          description: 'Skill with model override',
          action: vi.fn().mockResolvedValue({
            type: 'submit_prompt',
            content: [{ text: 'SKILL_BODY:feat-dev' }],
            modelOverride: 'gemini-2.5-pro',
          }),
        },
        CommandKind.SKILL,
      );
      const skillB = createSkillCommand('review', 'b');
      const result = setupProcessorHook([skillA, skillB]);
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(2));

      let actionResult;
      await act(async () => {
        actionResult = await result.current.handleSlashCommand(
          '/feat-dev /review do it',
        );
      });

      expect(actionResult).toEqual({
        type: 'submit_prompt',
        content: expect.anything(),
        modelOverride: 'gemini-2.5-pro',
      });
    });
  });
});
