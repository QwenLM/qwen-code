/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, type ReactNode } from 'react';
import { renderHook } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';
import type { SessionHandle } from '../../session/session.js';
import { useSlashCommandProcessor } from './slashCommandProcessor.js';
import { createAppPluginFixture } from '../../test-utils/appPluginFixture.js';
import {
  CommandKind,
  type CommandContext,
  type SlashCommand,
} from '../commands/types.js';
import { SettingScope } from '../../config/settings.js';
import { createMockSettings } from '../../test-utils/settings.js';
import { SettingsContext } from '../contexts/SettingsContext.js';
import { I18nTestProvider as UiI18nProvider } from '../../test-utils/I18nTestProvider.js';
import { MessageType } from '../types.js';
import { BuiltinCommandLoader } from '../../services/BuiltinCommandLoader.js';
import { McpPromptLoader } from '../../services/McpPromptLoader.js';
import { PluginCommandLoader } from '../../services/PluginCommandLoader.js';
import { WorkflowCommandLoader } from '../../services/WorkflowCommandLoader.js';
import {
  MCPDiscoveryState,
  CoreEvent,
  makeFakeConfig,
  createUserMessage,
  coreEvents,
  type McpClient,
  type Message,
  type LoadHistoryActionReturn,
  runLogger,
} from '@qwen-code/core';

const {
  mockBuiltinLoadCommands,
  mockMcpLoadCommands,
  mockPluginLoadCommands,
  mockWorkflowLoadCommands,
  mockSkillLoadCommands,
  mockUseAlternateBuffer,
} = vi.hoisted(() => ({
  mockBuiltinLoadCommands: vi.fn().mockResolvedValue([]),
  mockMcpLoadCommands: vi.fn().mockResolvedValue([]),
  mockPluginLoadCommands: vi.fn().mockResolvedValue([]),
  mockWorkflowLoadCommands: vi.fn().mockResolvedValue([]),
  mockSkillLoadCommands: vi.fn().mockResolvedValue([]),
  mockUseAlternateBuffer: vi.fn().mockReturnValue(false),
}));

vi.mock('./useAlternateBuffer.js', () => ({
  useAlternateBuffer: mockUseAlternateBuffer,
}));

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

vi.mock('../../services/BuiltinCommandLoader.js', () => ({
  BuiltinCommandLoader: vi.fn(() => ({
    loadCommands: mockBuiltinLoadCommands,
  })),
}));

vi.mock('../../services/McpPromptLoader.js', () => ({
  McpPromptLoader: vi.fn(() => ({
    loadCommands: mockMcpLoadCommands,
  })),
}));

vi.mock('../../services/PluginCommandLoader.js', () => ({
  PluginCommandLoader: vi.fn(() => ({
    loadCommands: mockPluginLoadCommands,
  })),
}));

vi.mock('../../services/WorkflowCommandLoader.js', () => ({
  WorkflowCommandLoader: vi.fn(() => ({
    loadCommands: mockWorkflowLoadCommands,
  })),
}));

vi.mock('../../services/SkillCommandLoader.js', () => ({
  SkillCommandLoader: vi.fn(() => ({
    loadCommands: mockSkillLoadCommands,
  })),
}));

vi.mock('../contexts/SessionContext.js', () => ({
  useSessionStats: vi.fn(() => ({ stats: {} })),
}));

const { mockGracefulExit } = vi.hoisted(() => ({
  mockGracefulExit: vi.fn(),
}));

vi.mock('../../utils/cleanup.js', () => ({
  gracefulExit: mockGracefulExit,
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

const emitMcpUpdate = () => {
  coreEvents.emit(CoreEvent.McpClientUpdate, {
    sessionId: 'test-session',
    clients: new Map<string, McpClient>(),
  });
};

describe('useSlashCommandProcessor', () => {
  const mockAddItem = vi.fn();
  const mockClearItems = vi.fn();
  const mockLoadHistory = vi.fn();
  const mockReplaceMessages =
    vi.fn<NonNullable<Parameters<typeof useSlashCommandProcessor>[6]>>();
  const mockOpenThemeDialog = vi.fn();
  const mockSetQuittingMessages = vi.fn();

  const mockConfig = makeFakeConfig({});
  let mockSettings = createMockSettings();

  let unmountHook: (() => Promise<void>) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSettings = createMockSettings({
      user: {
        path: '/read-only/settings.json',
        settings: {},
        originalSettings: {},
        readOnly: true,
      },
    });
    vi.mocked(BuiltinCommandLoader).mockClear();
    vi.mocked(PluginCommandLoader).mockClear();
    vi.mocked(WorkflowCommandLoader).mockClear();
    mockBuiltinLoadCommands.mockResolvedValue([]);
    mockMcpLoadCommands.mockResolvedValue([]);
    mockPluginLoadCommands.mockResolvedValue([]);
    mockWorkflowLoadCommands.mockResolvedValue([]);
    mockSkillLoadCommands.mockResolvedValue([]);
    mockConfig.getStartupRuntime().reset('base');
    mockConfig.getStartupRuntime().reset('commands');
    mockConfig.getStartupRuntime().reset('memory');
    mockConfig.getStartupRuntime().reset('mcp-budget');
    mockConfig.getStartupRuntime().markReady('base');
    mockConfig.getStartupRuntime().markReady('commands');
    mockUseAlternateBuffer.mockReturnValue(false);
    vi.spyOn(console, 'clear').mockImplementation(() => {});
  });

  afterEach(async () => {
    if (unmountHook) {
      await unmountHook();
      unmountHook = undefined;
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const setupProcessorHook = async (
    options: {
      sessionHandle?: SessionHandle;
      builtinCommands?: SlashCommand[];
      mcpCommands?: SlashCommand[];
      setIsProcessing?: (isProcessing: boolean) => void;
      clearConversation?: () => void;
      setMessages?: CommandContext['setMessages'];
      requestViewportReset?: () => void;
      openAgentConfigDialog?: (name: string, definition: unknown) => void;
      viewMainSession?: () => void;
      setCustomDialog?: (dialog: ReactNode | null) => void;
      // Tests that exercise the pre-catalog window must render without waiting
      // for the catalog, which is the whole point of the scenario.
      waitForCommands?: boolean;
      config?: typeof mockConfig | null;
    } = {},
  ) => {
    const {
      builtinCommands = [],
      mcpCommands = [],
      setIsProcessing = vi.fn(),
      clearConversation = vi.fn(),
      setMessages,
      requestViewportReset = vi.fn(),
      openAgentConfigDialog = vi.fn(),
      viewMainSession = vi.fn(),
      setCustomDialog = vi.fn(),
      waitForCommands = true,
      config = mockConfig,
    } = options;

    mockBuiltinLoadCommands.mockResolvedValue(Object.freeze(builtinCommands));
    mockMcpLoadCommands.mockResolvedValue(Object.freeze(mcpCommands));

    let result!: { current: ReturnType<typeof useSlashCommandProcessor> };
    let unmount!: () => void;
    let rerender!: (props?: unknown) => void;

    await act(async () => {
      const hook = await renderHook(
        () =>
          useSlashCommandProcessor(
            config,
            mockSettings,
            mockAddItem,
            vi.fn(), // updateItem
            mockClearItems,
            mockLoadHistory,
            mockReplaceMessages,
            vi.fn(),
            clearConversation,
            requestViewportReset,
            vi.fn(), // toggleVimEnabled
            setIsProcessing,
            {
              openThemeDialog: mockOpenThemeDialog,
              openEditorDialog: vi.fn(),
              openSettingsDialog: vi.fn(),
              openAgentBrowser: vi.fn(),
              openSkillBrowser: vi.fn(),
              openPluginBrowser: vi.fn(),
              openMcpBrowser: vi.fn(),
              openMcpApprovalDialog: vi.fn(),
              openHookBrowser: vi.fn(),
              openSessionBrowser: vi.fn(),
              openRewindDialog: vi.fn(),
              openAgentConfigDialog,
              quit: mockSetQuittingMessages,
              setDebugMessage: vi.fn(),
              toggleCorgiMode: vi.fn(),
              toggleDebugProfiler: vi.fn(),
              dispatchExtensionStateUpdate: vi.fn(),
              addConfirmUpdateExtensionRequest: vi.fn(),
              toggleShortcutsHelp: vi.fn(),
              setText: vi.fn(),
              viewWorkflowSessions: vi.fn(),
              viewMainSession,
            },
            new Map(), // extensionsUpdateState
            true, // isConfigInitialized
            setCustomDialog,
            vi.fn(), // setFullScreenDialog
            undefined, // getMessages
            setMessages,
            undefined, // clearAssemblerCache
            undefined, // recordMessage
            undefined, // runManualCompress
            undefined, // ensurePromptBuildResult
            undefined, // queueHookContext
            options.sessionHandle,
          ),
        {
          wrapper: ({ children }) => (
            <SettingsContext.Provider value={mockSettings}>
              <UiI18nProvider systemLocale="zh-CN">{children}</UiI18nProvider>
            </SettingsContext.Provider>
          ),
        },
      );
      result = hook.result;
      unmount = hook.unmount;
      rerender = hook.rerender;
    });

    unmountHook = async () => {
      unmount();
    };

    if (waitForCommands) {
      await waitFor(() => {
        expect(result.current.slashCommands).toBeDefined();
      });
    }

    return {
      get current() {
        return result.current;
      },
      unmount,
      rerender: async () => {
        rerender();
      },
    };
  };

  describe('Command catalog readiness', () => {
    const closeCommandsGate = () => {
      mockConfig.getStartupRuntime().reset('commands');
    };
    const openCommandsGate = () => {
      mockConfig.getStartupRuntime().markReady('commands');
    };

    // Returns the in-flight dispatch boxed in an object. Returning the promise
    // bare from an async helper would flatten it, so `await` here would block on
    // the dispatch itself and the test could never open the gate.
    const dispatchWhilePending = async (
      result: { current: ReturnType<typeof useSlashCommandProcessor> },
      input: string,
    ) => {
      const promise = result.current.handleSlashCommand(input);
      await act(async () => {
        await Promise.resolve();
      });
      return { promise };
    };

    it('runs a command dispatched before the catalog finished loading', async () => {
      closeCommandsGate();
      const action = vi.fn();
      const result = await setupProcessorHook({
        builtinCommands: [createTestCommand({ name: 'model', action })],
        waitForCommands: false,
      });

      const dispatch = await dispatchWhilePending(result, '/model');
      expect(action).not.toHaveBeenCalled();

      openCommandsGate();
      await act(async () => {
        await dispatch.promise;
      });

      expect(action).toHaveBeenCalled();
      expect(mockAddItem).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: MessageType.ERROR }),
        expect.anything(),
      );
    });

    it('still runs the command when the loader effect is re-armed mid-wait', async () => {
      // Opening the `commands` gate also emits a skill change, which reloads
      // the catalog and aborts the arming that just passed the gate. The wait
      // must outlive that, not be released by it.
      closeCommandsGate();
      const action = vi.fn();
      const result = await setupProcessorHook({
        builtinCommands: [createTestCommand({ name: 'model', action })],
        waitForCommands: false,
      });

      const dispatch = await dispatchWhilePending(result, '/model');

      await act(async () => {
        result.current.reloadCommands();
        await Promise.resolve();
      });
      expect(action).not.toHaveBeenCalled();

      openCommandsGate();
      await act(async () => {
        await dispatch.promise;
      });

      expect(action).toHaveBeenCalled();
    });

    it('runs a question-mark-prefixed command dispatched before the catalog loaded', async () => {
      closeCommandsGate();
      const action = vi.fn();
      const result = await setupProcessorHook({
        builtinCommands: [createTestCommand({ name: 'help', action })],
        waitForCommands: false,
      });

      const dispatch = await dispatchWhilePending(result, '?help');

      openCommandsGate();
      await act(async () => {
        await dispatch.promise;
      });

      expect(action).toHaveBeenCalled();
    });

    it('does not wait for path-like input that merely starts with a slash', async () => {
      closeCommandsGate();
      const result = await setupProcessorHook({
        builtinCommands: [
          createTestCommand({ name: 'model', action: vi.fn() }),
        ],
        waitForCommands: false,
      });

      let handled: unknown;
      await act(async () => {
        handled = await result.current.handleSlashCommand('/etc/hosts');
      });

      expect(handled).toBe(false);
      expect(mockAddItem).not.toHaveBeenCalled();
    });

    it('waits for command discovery with a supplied session before loading all command sources', async () => {
      closeCommandsGate();
      const handle = {} as SessionHandle;
      const action = vi.fn();
      const wait = vi.spyOn(mockConfig, 'waitForStartupGate');
      const result = await setupProcessorHook({
        sessionHandle: handle,
        builtinCommands: [createTestCommand({ name: 'model', action })],
        waitForCommands: false,
      });
      expect(wait).toHaveBeenCalledWith('commands', expect.anything());
      expect(result.current.slashCommands).toBeUndefined();
      expect(mockSkillLoadCommands).not.toHaveBeenCalled();
      expect(mockPluginLoadCommands).not.toHaveBeenCalled();
      expect(mockWorkflowLoadCommands).not.toHaveBeenCalled();
      expect(mockMcpLoadCommands).not.toHaveBeenCalled();
      openCommandsGate();
      await waitFor(() => expect(result.current.slashCommands).toBeDefined());
      expect(mockSkillLoadCommands).toHaveBeenCalled();
      expect(mockPluginLoadCommands).toHaveBeenCalled();
      expect(mockWorkflowLoadCommands).toHaveBeenCalled();
      expect(mockMcpLoadCommands).toHaveBeenCalled();
      await act(async () => {
        await result.current.handleSlashCommand('/model');
      });
      expect(action).toHaveBeenCalledOnce();
      expect(action.mock.calls[0][0].services.sessionHandle).toBe(handle);
    });

    it('keeps all four discovered command sources in the supplied-session catalog', async () => {
      const skill = createTestCommand(
        { name: 'local-skill', action: vi.fn() },
        CommandKind.SKILL,
      );
      const plugin = createTestCommand(
        { name: 'local-plugin', action: vi.fn() },
        CommandKind.PLUGIN,
      );
      const workflow = createTestCommand(
        { name: 'local-workflow', action: vi.fn() },
        CommandKind.WORKFLOW,
      );
      const prompt = createTestCommand(
        { name: 'local-prompt', action: vi.fn() },
        CommandKind.MCP_PROMPT,
      );
      mockSkillLoadCommands.mockResolvedValue([skill]);
      mockPluginLoadCommands.mockResolvedValue([plugin]);
      mockWorkflowLoadCommands.mockResolvedValue([workflow]);
      const result = await setupProcessorHook({
        sessionHandle: {} as SessionHandle,
        mcpCommands: [prompt],
      });
      expect(result.current.slashCommands).toEqual(
        expect.arrayContaining([skill, plugin, workflow, prompt]),
      );
    });

    it('cancels the catalog wait without reporting an error', async () => {
      closeCommandsGate();
      const action = vi.fn();
      const setIsProcessing = vi.fn();
      const result = await setupProcessorHook({
        builtinCommands: [createTestCommand({ name: 'model', action })],
        setIsProcessing,
        waitForCommands: false,
      });

      const dispatch = await dispatchWhilePending(result, '/model');
      expect(setIsProcessing).toHaveBeenCalledWith(true);

      let handled: unknown;
      await act(async () => {
        result.current.triggerCancellableCallbacks();
        handled = await dispatch.promise;
      });

      expect(handled).toEqual({ type: 'handled' });
      expect(action).not.toHaveBeenCalled();
      expect(setIsProcessing).toHaveBeenCalledWith(false);
      expect(mockAddItem).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: MessageType.ERROR }),
        expect.anything(),
      );
    });

    it('reports that commands are still loading when the wait times out', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        closeCommandsGate();
        const action = vi.fn();
        const result = await setupProcessorHook({
          builtinCommands: [createTestCommand({ name: 'model', action })],
          waitForCommands: false,
        });

        const dispatch = await dispatchWhilePending(result, '/model');

        let handled: unknown;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10_000);
          handled = await dispatch.promise;
        });

        expect(handled).toEqual({ type: 'handled' });
        expect(action).not.toHaveBeenCalled();
        expect(mockAddItem).toHaveBeenCalledWith(
          expect.objectContaining({
            type: MessageType.ERROR,
            text: 'Commands are still loading \u2014 /model is not available yet.',
          }),
          expect.anything(),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not wait when there is no config', async () => {
      const result = await setupProcessorHook({
        config: null,
        waitForCommands: false,
      });

      let handled: unknown;
      await act(async () => {
        handled = await result.current.handleSlashCommand('/model');
      });

      expect(handled).toBe(false);
    });
  });

  describe('Console Clear Safety', () => {
    it('returns to the main session before clearing the conversation', async () => {
      const viewMainSession = vi.fn();
      const clearCommand = createTestCommand({
        name: 'clear',
        action: async (context) => {
          context.ui.clear();
        },
      });
      const result = await setupProcessorHook({
        builtinCommands: [clearCommand],
        viewMainSession,
      });

      await act(async () => {
        await result.current.handleSlashCommand('/clear');
      });

      expect(viewMainSession).toHaveBeenCalledTimes(1);
      expect(mockClearItems).toHaveBeenCalledTimes(1);
    });

    it('should not call console.clear if alternate buffer is active', async () => {
      mockUseAlternateBuffer.mockReturnValue(true);
      const clearCommand = createTestCommand({
        name: 'clear',
        action: async (context) => {
          context.ui.clear();
        },
      });
      const result = await setupProcessorHook({
        builtinCommands: [clearCommand],
      });

      await act(async () => {
        await result.current.handleSlashCommand('/clear');
      });

      expect(mockClearItems).toHaveBeenCalled();
    });

    it('should call console.clear if alternate buffer is not active', async () => {
      mockUseAlternateBuffer.mockReturnValue(false);
      const clearCommand = createTestCommand({
        name: 'clear',
        action: async (context) => {
          context.ui.clear();
        },
      });
      const result = await setupProcessorHook({
        builtinCommands: [clearCommand],
      });

      await act(async () => {
        await result.current.handleSlashCommand('/clear');
      });

      expect(mockClearItems).toHaveBeenCalled();
    });
  });

  it('runs a confirmed action callback without rerunning the command', async () => {
    const onConfirm = vi.fn();
    const action = vi.fn(async () => ({
      type: 'confirm_action' as const,
      prompt: 'Claim benefit?',
      showCancelOption: false,
      hideTitle: true,
      originalInvocation: { raw: '/claim' },
      onConfirm,
    }));
    const result = await setupProcessorHook({
      builtinCommands: [createTestCommand({ name: 'claim', action })],
    });
    let handlePromise: Promise<unknown> | undefined;

    await act(async () => {
      handlePromise = result.current.handleSlashCommand('/claim');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current.confirmationRequest).not.toBeNull();
      expect(result.current.confirmationRequest?.hideTitle).toBe(true);
    });

    await act(async () => {
      result.current.confirmationRequest?.onConfirm(true);
      await handlePromise;
    });

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('cancels a confirmed action when the dialog is closed with Escape', async () => {
    const onConfirm = vi.fn();
    const action = vi.fn(async () => ({
      type: 'confirm_action' as const,
      prompt: 'Claim benefit?',
      showCancelOption: false,
      originalInvocation: { raw: '/claim' },
      onConfirm,
    }));
    const result = await setupProcessorHook({
      builtinCommands: [createTestCommand({ name: 'claim', action })],
    });
    let handlePromise: Promise<unknown> | undefined;

    await act(async () => {
      handlePromise = result.current.handleSlashCommand('/claim');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current.confirmationRequest?.onCancel).toBeDefined();
      expect(result.current.confirmationRequest?.showCancelOption).toBe(false);
    });

    await act(async () => {
      result.current.confirmationRequest?.onCancel?.();
      await handlePromise;
    });

    expect(onConfirm).not.toHaveBeenCalled();
    expect(action).toHaveBeenCalledTimes(1);
    expect(result.current.confirmationRequest).toBeNull();
  });

  describe('Initialization and Command Loading', () => {
    it('passes the effective display locale to command actions', async () => {
      const action = vi.fn();
      const result = await setupProcessorHook({
        builtinCommands: [createTestCommand({ name: 'probe-locale', action })],
      });
      await act(async () => {
        await result.current.handleSlashCommand('/probe-locale');
      });
      expect(action).toHaveBeenLastCalledWith(
        expect.objectContaining({
          ui: expect.objectContaining({ locale: 'en' }),
        }),
        '',
      );
      await act(async () => {
        mockSettings.setValue(SettingScope.User, 'ui.language', 'zh-CN');
      });
      await act(async () => {
        await result.current.handleSlashCommand('/probe-locale');
      });
      expect(action).toHaveBeenLastCalledWith(
        expect.objectContaining({
          ui: expect.objectContaining({ locale: 'zh-CN' }),
        }),
        '',
      );
      await act(async () => {
        mockSettings.setValue(SettingScope.User, 'ui.language', 'en');
      });
      await act(async () => {
        await result.current.handleSlashCommand('/probe-locale');
      });
      expect(action).toHaveBeenLastCalledWith(
        expect.objectContaining({
          ui: expect.objectContaining({ locale: 'en' }),
        }),
        '',
      );
    });

    it('reloads plugin command visibility when contributions change', async () => {
      const claim = createTestCommand({ name: 'claim', hidden: false });
      const bonus = createTestCommand({
        name: 'bonus',
        kind: CommandKind.DYNAMIC,
      });
      const result = await setupProcessorHook({ builtinCommands: [claim] });
      expect(result.current.slashCommands).toEqual([claim]);
      mockBuiltinLoadCommands.mockResolvedValue([
        bonus,
        { ...claim, hidden: true },
      ]);
      act(() => coreEvents.emit(CoreEvent.DynamicCommandsChanged));
      await waitFor(() =>
        expect(result.current.slashCommands).toEqual([
          bonus,
          expect.objectContaining({ name: 'claim', hidden: true }),
        ]),
      );
      mockBuiltinLoadCommands.mockResolvedValue([claim]);
      act(() => coreEvents.emit(CoreEvent.DynamicCommandsChanged));
      await waitFor(() =>
        expect(result.current.slashCommands).toEqual([claim]),
      );
    });

    it('excludes unvalidated dynamic commands when installing a fallback catalog', async () => {
      vi.spyOn(mockConfig, 'waitForStartupGate').mockRejectedValue(
        new Error('Catalog unavailable'),
      );
      const result = await setupProcessorHook({
        builtinCommands: [
          createTestCommand({ name: 'help' }),
          createTestCommand(
            {
              name: 'help',
              pluginName: 'owner',
            },
            CommandKind.DYNAMIC,
          ),
          createTestCommand(
            {
              name: 'bad/name',
              pluginName: 'owner',
            },
            CommandKind.DYNAMIC,
          ),
        ],
      });
      expect(
        result.current.slashCommands?.map((command) => command.name),
      ).toEqual(['help']);
    });

    it('keeps the previous catalog when a reload fails', async () => {
      const result = await setupProcessorHook({
        builtinCommands: [
          createTestCommand(
            {
              name: 'reward',
              pluginName: 'owner',
            },
            CommandKind.DYNAMIC,
          ),
        ],
      });
      const error = new Error('Reload unavailable');
      const warn = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
      vi.spyOn(mockConfig, 'waitForStartupGate').mockRejectedValue(error);
      await act(async () => {
        result.current.reloadCommands();
      });
      await waitFor(() =>
        expect(warn).toHaveBeenCalledWith(
          'Failed to load slash commands:',
          error,
        ),
      );
      expect(
        result.current.slashCommands?.map((command) => command.name),
      ).toEqual(['reward']);
    });

    it('should initialize CommandService with all required loaders', async () => {
      await setupProcessorHook();
      expect(BuiltinCommandLoader).toHaveBeenCalledWith(mockConfig);
      expect(McpPromptLoader).toHaveBeenCalledWith(mockConfig);
    });

    it('loads commands from this session registry rather than a module global', async () => {
      const fixture = createAppPluginFixture();
      fixture.registerAppPlugins([
        {
          apiVersion: 1,
          id: 'session-plugin',
          initialize: async () => {},
          dispose: async () => {},
          getSlashCommands: () => [
            createTestCommand({ name: 'session-command' }),
          ],
        },
      ]);
      await fixture.initializeAppPlugins({});
      const read = vi
        .spyOn(mockConfig, 'getBuiltinPluginContributions')
        .mockReturnValue(fixture.getAppPluginRegistry());
      try {
        const result = await setupProcessorHook();
        await waitFor(() =>
          expect(
            result.current.slashCommands?.some(
              (command) => command.name === 'session-command',
            ),
          ).toBe(true),
        );
      } finally {
        read.mockRestore();
        await fixture.disposeAppPlugins();
      }
    });

    it('should call loadCommands and populate state after mounting', async () => {
      const testCommand = createTestCommand({ name: 'test' });
      const result = await setupProcessorHook({
        builtinCommands: [testCommand],
      });

      await waitFor(() => {
        expect(result.current.slashCommands).toHaveLength(1);
      });

      expect(result.current.slashCommands?.[0]?.name).toBe('test');
      expect(mockBuiltinLoadCommands).toHaveBeenCalledTimes(1);
      expect(mockMcpLoadCommands).toHaveBeenCalledTimes(1);
    });

    it('keeps built-in commands available when the commands startup gate fails', async () => {
      const action = vi.fn();
      const recoveryCommand = createTestCommand({
        name: 'auth',
        action,
      });
      mockConfig.getStartupRuntime().reset('commands');
      mockConfig.getStartupRuntime().markFailed('commands', {
        code: 'config-initialization-failed',
        message: 'commands failed',
      });

      const result = await setupProcessorHook({
        builtinCommands: [recoveryCommand],
      });

      await waitFor(() =>
        expect(result.current.slashCommands).toEqual([recoveryCommand]),
      );

      await act(async () => {
        await result.current.handleSlashCommand('/auth');
      });

      expect(action).toHaveBeenCalledTimes(1);
      expect(mockAddItem).not.toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.ERROR,
          text: expect.stringContaining('Slash commands are unavailable'),
        }),
        expect.any(Number),
      );
    });

    it('preserves the previous command catalog when a reload fails', async () => {
      const stableAction = vi.fn();
      const stableCommand = createTestCommand({
        name: 'stable',
        action: stableAction,
      });
      const result = await setupProcessorHook({
        builtinCommands: [stableCommand],
      });
      await waitFor(() =>
        expect(result.current.slashCommands).toEqual([stableCommand]),
      );

      mockBuiltinLoadCommands.mockResolvedValue([]);
      mockConfig.getStartupRuntime().reset('commands');
      mockConfig.getStartupRuntime().markFailed('commands', {
        code: 'config-initialization-failed',
        message: 'reload failed',
      });

      act(() => {
        coreEvents.emit('extensionsStarting', { total: 1, completed: 1 });
      });

      await waitFor(() =>
        expect(mockBuiltinLoadCommands).toHaveBeenCalledTimes(2),
      );
      expect(result.current.slashCommands).toEqual([stableCommand]);

      await act(async () => {
        await result.current.handleSlashCommand('/stable');
      });

      expect(stableAction).toHaveBeenCalledTimes(1);
    });
  });

  describe('Command Execution Logic', () => {
    it('keeps display history but omits navigation input from transcripts', async () => {
      const command = createTestCommand({
        name: 'resume',
        omitInputFromTranscript: true,
        action: vi.fn(),
      });
      const result = await setupProcessorHook({
        builtinCommands: [command],
      });

      await act(async () => {
        await result.current.handleSlashCommand('/resume');
      });

      expect(mockAddItem).toHaveBeenCalledWith(
        {
          type: MessageType.USER,
          text: '/resume',
          omitFromTranscript: true,
        },
        expect.any(Number),
      );
    });

    it('should treat unknown commands as regular input', async () => {
      const result = await setupProcessorHook();
      await waitFor(() => expect(result.current.slashCommands).toBeDefined());

      let handled: Awaited<
        ReturnType<typeof result.current.handleSlashCommand>
      >;
      await act(async () => {
        handled = await result.current.handleSlashCommand('/nonexistent');
      });

      // Unknown commands should return false so the input is sent to the model
      expect(handled!).toBe(false);
      // Should not add anything to history (the regular flow will handle it)
      expect(mockAddItem).not.toHaveBeenCalled();
    });

    it('should show MCP loading warning for unknown commands when MCP is loading', async () => {
      vi.spyOn(mockConfig, 'getMcpClientManager').mockReturnValue({
        getDiscoveryState: () => MCPDiscoveryState.IN_PROGRESS,
      } as ReturnType<typeof mockConfig.getMcpClientManager>);

      const result = await setupProcessorHook();
      await waitFor(() => expect(result.current.slashCommands).toBeDefined());

      let handled: Awaited<
        ReturnType<typeof result.current.handleSlashCommand>
      >;
      await act(async () => {
        handled = await result.current.handleSlashCommand('/mcp-command');
      });

      // When MCP is loading, should handle the command (show warning)
      expect(handled!).not.toBe(false);
      // Should add user input and error message to history
      expect(mockAddItem).toHaveBeenCalledWith(
        { type: MessageType.USER, text: '/mcp-command' },
        expect.any(Number),
      );
      expect(mockAddItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.ERROR,
        }),
        expect.any(Number),
      );
    });

    it('treats an absolute-path prompt as regular input while MCP is loading', async () => {
      vi.spyOn(mockConfig, 'getMcpClientManager').mockReturnValue({
        getDiscoveryState: () => MCPDiscoveryState.IN_PROGRESS,
      } as ReturnType<typeof mockConfig.getMcpClientManager>);

      const result = await setupProcessorHook();
      await waitFor(() => expect(result.current.slashCommands).toBeDefined());

      let handled: Awaited<
        ReturnType<typeof result.current.handleSlashCommand>
      >;
      await act(async () => {
        handled = await result.current.handleSlashCommand(
          '/Users/me/project 这里面有啥',
        );
      });

      expect(handled!).toBe(false);
      expect(mockAddItem).not.toHaveBeenCalled();
    });

    it('executes a registered command before falling back to a same-named root path', async () => {
      const action = vi.fn();
      const result = await setupProcessorHook({
        builtinCommands: [createTestCommand({ name: 'tmp', action })],
      });
      await waitFor(() => expect(result.current.slashCommands).toBeDefined());

      await act(async () => {
        await result.current.handleSlashCommand('/tmp');
      });

      expect(action).toHaveBeenCalled();
    });

    it('does not record the raw invocation for a hideInput command', async () => {
      // The USER history item is what the orchestrator later converts into a
      // model-visible <command-message> transcript trace. Commands flagged
      // hideInput (pure-local dialogs like /release-notes) must execute
      // without leaving that trace behind (feedback defea18a-b66b).
      const action = vi.fn();
      const result = await setupProcessorHook({
        builtinCommands: [
          createTestCommand({ name: 'local-dialog', action, hideInput: true }),
        ],
      });
      await waitFor(() => expect(result.current.slashCommands).toBeDefined());

      await act(async () => {
        await result.current.handleSlashCommand('/local-dialog');
      });

      expect(action).toHaveBeenCalledTimes(1);
      expect(mockAddItem).not.toHaveBeenCalledWith(
        { type: MessageType.USER, text: '/local-dialog' },
        expect.any(Number),
      );
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
      const result = await setupProcessorHook({
        builtinCommands: [parentCommand],
      });
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
      const result = await setupProcessorHook({
        builtinCommands: [parentCommand],
      });
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      await act(async () => {
        await result.current.handleSlashCommand('/parent child with args');
      });

      expect(childAction).toHaveBeenCalledTimes(1);

      expect(childAction).toHaveBeenCalledWith(
        expect.objectContaining({
          services: expect.objectContaining({
            agentContext: mockConfig,
          }),
          ui: expect.objectContaining({
            addItem: mockAddItem,
          }),
        }),
        'with args',
      );
    });

    it('threads referenced pasted images into context.invocation', async () => {
      const action = vi.fn();
      const command: SlashCommand = {
        name: 'withimages',
        description: 'a command receiving images',
        kind: CommandKind.BUILT_IN,
        action,
      };
      const result = await setupProcessorHook({
        builtinCommands: [command],
      });
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      const referenced = {
        id: 2,
        type: 'image' as const,
        content: 'b64',
        mediaType: 'image/png',
      };
      await act(async () => {
        await result.current.handleSlashCommand(
          '/withimages look [Image #2]',
          undefined,
          undefined,
          true,
          false,
          {
            2: referenced,
            5: { id: 5, type: 'image' as const, content: 'orphan' },
          },
        );
      });

      expect(action).toHaveBeenCalledWith(
        expect.objectContaining({
          invocation: expect.objectContaining({
            pastedContents: { 2: referenced },
          }),
        }),
        'look [Image #2]',
      );
    });

    it('sets isProcessing to false if the the input is not a command', async () => {
      const setMockIsProcessing = vi.fn();
      const result = await setupProcessorHook({
        setIsProcessing: setMockIsProcessing,
      });

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

      const result = await setupProcessorHook({
        builtinCommands: [failCommand],
        setIsProcessing: setMockIsProcessing,
      });

      await waitFor(() => expect(result.current.slashCommands).toBeDefined());

      await act(async () => {
        await result.current.handleSlashCommand('/fail');
      });

      expect(setMockIsProcessing).toHaveBeenNthCalledWith(1, true);
      expect(setMockIsProcessing).toHaveBeenNthCalledWith(2, false);
    });

    it('should set isProcessing to true during execution and false afterwards', async () => {
      const mockSetIsProcessing = vi.fn();
      let resolveAction: (() => void) | undefined;
      const command = createTestCommand({
        name: 'long-running',
        progressMessage: 'Loading command data...',
        action: () =>
          new Promise<void>((resolve) => {
            resolveAction = resolve;
          }),
      });

      const result = await setupProcessorHook({
        builtinCommands: [command],
        setIsProcessing: mockSetIsProcessing,
      });
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      let executionPromise: Promise<unknown> | undefined;
      await act(async () => {
        executionPromise = result.current.handleSlashCommand('/long-running');
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(mockSetIsProcessing).toHaveBeenNthCalledWith(1, true);
        expect(result.current.activeProgressMessage).toBe(
          'Loading command data...',
        );
      });
      // It should not have been called with false yet
      expect(mockSetIsProcessing).not.toHaveBeenCalledWith(false);

      await act(async () => {
        resolveAction?.();
        await executionPromise;
      });

      // After the promise resolves, it should be called with false
      expect(mockSetIsProcessing).toHaveBeenNthCalledWith(2, false);
      expect(mockSetIsProcessing).toHaveBeenCalledTimes(2);
      expect(result.current.activeProgressMessage).toBeUndefined();
    });

    it('cancels waiting for command-declared startup gates', async () => {
      const mockSetIsProcessing = vi.fn();
      const command = createTestCommand({
        name: 'needs-mcp',
        requiredStartupGates: ['mcp-budget'],
        action: vi.fn(),
      });

      const result = await setupProcessorHook({
        builtinCommands: [command],
        setIsProcessing: mockSetIsProcessing,
      });

      let handled: Awaited<
        ReturnType<typeof result.current.handleSlashCommand>
      >;
      const executionPromise = act(async () => {
        handled = await result.current.handleSlashCommand('/needs-mcp');
      });

      await waitFor(() => {
        expect(mockSetIsProcessing).toHaveBeenCalledWith(true);
      });

      act(() => {
        result.current.triggerCancellableCallbacks();
      });
      await executionPromise;

      expect(command.action).not.toHaveBeenCalled();
      expect(handled!).toEqual({ type: 'handled' });
      expect(mockSetIsProcessing).toHaveBeenLastCalledWith(false);
      expect(mockAddItem).not.toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.ERROR,
          text: 'Startup readiness wait aborted',
        }),
        expect.any(Number),
      );
    });
  });

  describe('Action Result Handling', () => {
    describe('Dialog actions', () => {
      it.each([
        {
          dialogType: 'theme',
          commandName: 'themecmd',
          mockFn: mockOpenThemeDialog,
        },
      ])(
        'should handle "dialog: $dialogType" action',
        async ({ dialogType, commandName, mockFn }) => {
          const command = createTestCommand({
            name: commandName,
            action: vi
              .fn()
              .mockResolvedValue({ type: 'dialog', dialog: dialogType }),
          });
          const result = await setupProcessorHook({
            builtinCommands: [command],
          });
          await waitFor(() =>
            expect(result.current.slashCommands).toHaveLength(1),
          );

          await act(async () => {
            await result.current.handleSlashCommand(`/${commandName}`);
          });

          expect(mockFn).toHaveBeenCalled();
        },
      );

      it('should handle "dialog: agentConfig" action with props', async () => {
        const mockOpenAgentConfigDialog = vi.fn();
        const agentDefinition = { name: 'test-agent' };
        const commandName = 'agentconfigcmd';
        const command = createTestCommand({
          name: commandName,
          action: vi.fn().mockResolvedValue({
            type: 'dialog',
            dialog: 'agentConfig',
            props: {
              name: 'test-agent',
              definition: agentDefinition,
            },
          }),
        });

        const result = await setupProcessorHook({
          builtinCommands: [command],
          openAgentConfigDialog: mockOpenAgentConfigDialog,
        });

        await waitFor(() =>
          expect(result.current.slashCommands).toHaveLength(1),
        );

        await act(async () => {
          await result.current.handleSlashCommand(`/${commandName}`);
        });

        expect(mockOpenAgentConfigDialog).toHaveBeenCalledWith(
          'test-agent',
          agentDefinition,
        );
      });
    });

    it('should handle "load_history" action', async () => {
      const clientHistory: Message[] = [createUserMessage('old prompt')];
      const commandResult: LoadHistoryActionReturn<
        Array<{ type: MessageType.USER; text: string }>
      > = {
        type: 'load_history',
        history: [{ type: MessageType.USER, text: 'old prompt' }],
        clientHistory,
      };
      const command = createTestCommand({
        name: 'load',
        action: vi.fn().mockResolvedValue(commandResult),
      });

      const mockClearConversation = vi.fn();
      const mockSetMessages =
        vi.fn<NonNullable<CommandContext['setMessages']>>();
      const result = await setupProcessorHook({
        builtinCommands: [command],
        clearConversation: mockClearConversation,
        setMessages: mockSetMessages,
      });

      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      await act(async () => {
        await result.current.handleSlashCommand('/load');
      });

      // Loading a complete command history explicitly replaces the session.
      expect(mockClearItems).toHaveBeenCalledTimes(1);
      expect(mockClearConversation).toHaveBeenCalledTimes(1);
      expect(mockSetMessages).toHaveBeenCalledTimes(1);
      expect(mockClearConversation.mock.invocationCallOrder[0]).toBeLessThan(
        mockSetMessages.mock.invocationCallOrder[0],
      );
      const updater = mockSetMessages.mock.calls[0][0];
      expect(updater([])).toEqual(clientHistory);
      expect(updater([])[0]).toBe(clientHistory[0]);
      expect(mockAddItem).toHaveBeenNthCalledWith(
        2,
        { type: 'user', text: 'old prompt' },
        0,
        true,
      );
    });

    it('should request one viewport reset when ui.loadHistory is called', async () => {
      const mockRequestViewportReset = vi.fn();
      const result = await setupProcessorHook({
        requestViewportReset: mockRequestViewportReset,
      });

      await act(async () => {
        await result.current.commandContext.ui.loadHistory([]);
      });

      expect(mockClearItems).toHaveBeenCalledTimes(1);
      expect(mockLoadHistory).not.toHaveBeenCalled();
      expect(mockRequestViewportReset).toHaveBeenCalledTimes(1);
    });

    it('should handle a "quit" action', async () => {
      const quitAction = vi
        .fn()
        .mockResolvedValue({ type: 'quit', messages: ['bye'] });
      const command = createTestCommand({
        name: 'exit',
        action: quitAction,
      });
      const result = await setupProcessorHook({
        builtinCommands: [command],
      });

      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      await act(async () => {
        await result.current.handleSlashCommand('/exit');
      });

      expect(mockSetQuittingMessages).toHaveBeenCalledWith(['bye']);
    });
    it('should handle "submit_prompt" action returned from a skill command', async () => {
      const fileCommand = createTestCommand(
        {
          name: 'filecmd',
          description: 'A command from a skill',
          action: async () => ({
            type: 'submit_prompt',
            content: [{ text: 'The actual prompt from the skill file.' }],
          }),
        },
        CommandKind.SKILL,
      );

      const result = await setupProcessorHook({
        builtinCommands: [fileCommand],
      });
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      let actionResult;
      await act(async () => {
        actionResult = await result.current.handleSlashCommand('/filecmd');
      });

      expect(actionResult).toMatchObject({
        type: 'submit_prompt',
        content: [{ text: 'The actual prompt from the skill file.' }],
        commandInvocationId: expect.any(String),
      });

      expect(mockAddItem).toHaveBeenCalledWith(
        { type: MessageType.USER, text: '/filecmd' },
        expect.any(Number),
      );
    });

    it('passes on that a submitted meta prompt is the user own words', async () => {
      const command = createTestCommand({
        name: 'typed',
        description: 'Submits text the user typed in a dialog',
        action: async () => ({
          type: 'submit_prompt',
          content: 'Only check the migration scripts.',
          isMeta: true,
          isUserDecision: true,
        }),
      });

      const result = await setupProcessorHook({ builtinCommands: [command] });
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      let actionResult;
      await act(async () => {
        actionResult = await result.current.handleSlashCommand('/typed');
      });

      expect(actionResult).toMatchObject({
        type: 'submit_prompt',
        isMeta: true,
        isUserDecision: true,
      });
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

      const result = await setupProcessorHook({
        mcpCommands: [mcpCommand],
      });
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      let actionResult;
      await act(async () => {
        actionResult = await result.current.handleSlashCommand('/mcpcmd');
      });

      expect(actionResult).toMatchObject({
        type: 'submit_prompt',
        content: [{ text: 'The actual prompt from the mcp command.' }],
        commandInvocationId: expect.any(String),
      });

      expect(mockAddItem).toHaveBeenCalledWith(
        { type: MessageType.USER, text: '/mcpcmd' },
        expect.any(Number),
      );
    });
  });

  describe('Command Parsing and Matching', () => {
    it('should be case-sensitive', async () => {
      const command = createTestCommand({ name: 'test' });
      const result = await setupProcessorHook({
        builtinCommands: [command],
      });
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      let handled: Awaited<
        ReturnType<typeof result.current.handleSlashCommand>
      >;
      await act(async () => {
        // Use uppercase when command is lowercase
        handled = await result.current.handleSlashCommand('/Test');
      });

      // Case mismatch means it's not a known command, so treat as regular input
      expect(handled!).toBe(false);
      expect(mockAddItem).not.toHaveBeenCalled();
    });

    it('should correctly match an altName', async () => {
      const action = vi.fn();
      const command = createTestCommand({
        name: 'main',
        altNames: ['alias'],
        description: 'a command with an alias',
        action,
      });
      const result = await setupProcessorHook({
        builtinCommands: [command],
      });
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
      const result = await setupProcessorHook({
        builtinCommands: [command],
      });
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      await act(async () => {
        await result.current.handleSlashCommand('  /test  with-args  ');
      });

      expect(action).toHaveBeenCalledWith(expect.anything(), 'with-args');
    });

    it('should handle `?` as a command prefix', async () => {
      const action = vi.fn();
      const command = createTestCommand({ name: 'help', action });
      const result = await setupProcessorHook({
        builtinCommands: [command],
      });
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(1));

      await act(async () => {
        await result.current.handleSlashCommand('?help');
      });

      expect(action).toHaveBeenCalledTimes(1);
    });
  });

  describe('Command Precedence', () => {
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
        CommandKind.SKILL,
      );

      // The order of commands in the final loaded array is not guaranteed,
      // so the test must work regardless of which comes first.
      const result = await setupProcessorHook({
        builtinCommands: [quitCommand, exitCommand],
      });

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
        CommandKind.SKILL,
      );

      const result = await setupProcessorHook({
        builtinCommands: [quitCommand, exitCommand],
      });
      await waitFor(() => expect(result.current.slashCommands).toHaveLength(2));

      await act(async () => {
        await result.current.handleSlashCommand('/exit');
      });

      // It should be added to the history.
      expect(mockAddItem).toHaveBeenCalledWith(
        { type: MessageType.USER, text: '/exit' },
        expect.any(Number),
      );
    });
  });

  describe('Lifecycle', () => {
    it('should abort command loading when the hook unmounts', async () => {
      const abortSpy = vi.spyOn(AbortController.prototype, 'abort');
      const { unmount } = await setupProcessorHook();

      unmount();

      expect(abortSpy).toHaveBeenCalledTimes(1);
    });
  });

  it('refreshes generic plugin commands on configuration changes', async () => {
    const result = await setupProcessorHook();
    await waitFor(() => expect(result.current.slashCommands).toEqual([]));
    const command = createTestCommand({ name: 'new-command', action: vi.fn() });
    mockBuiltinLoadCommands.mockResolvedValue([command]);
    act(() => {
      coreEvents.emit(CoreEvent.DynamicCommandsChanged);
    });
    await waitFor(() =>
      expect(result.current.slashCommands).toEqual([command]),
    );
  });

  it('should reload commands on extension events', async () => {
    const result = await setupProcessorHook();
    await waitFor(() => expect(result.current.slashCommands).toEqual([]));

    // Create a new command and make that the result of the skillLoadCommands
    // (which is where extension/skill commands come from)
    const newCommand = createTestCommand({
      name: 'someNewCommand',
      action: vi.fn(),
    });
    mockSkillLoadCommands.mockResolvedValue([newCommand]);

    // We should not see a change until we fire an event.
    await waitFor(() => expect(result.current.slashCommands).toEqual([]));
    act(() => {
      coreEvents.emit('extensionsStarting', { total: 1, completed: 1 });
    });
    await waitFor(() =>
      expect(result.current.slashCommands).toEqual([newCommand]),
    );
  });
  // The command catalog is rebuilt in full on every reload, so event-driven
  // reload sources must coalesce. All reload triggers are bridged through
  // startupRuntime.emitChange, which debounces at 175ms trailing / 700ms
  // maxWait.
  //
  // NOTE: these cases must build on `makeFakeConfig` (a real Config, hence a
  // real StartupRuntime with real timers). `createMockConfig`'s startupRuntime
  // stub has no onChange/emitChange and would silently test nothing.
  //
  // NOTE: count assertions must never live inside `waitFor` — it returns the
  // moment an assertion first holds, so it cannot distinguish "1 rebuild" from
  // "1 rebuild followed by a 2nd". Advance timers explicitly instead, and
  // always assert the negative half.
  describe('Command reload coalescing', () => {
    const DEBOUNCE_MS = 175;
    const MAX_WAIT_MS = 700;

    // Every CommandService.create runs all six loaders exactly once, so the
    // builtin loader's call count is the rebuild count. Aborted rebuilds count
    // too — they already burned the IO.
    const rebuilds = () => mockBuiltinLoadCommands.mock.calls.length;

    const advance = async (ms: number) => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    };

    const flushMicrotasks = async () => {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    };

    /** Settles the initial build under real timers, then switches to fake. */
    const settleThenFakeTimers = async () => {
      const result = await setupProcessorHook();
      await waitFor(() => expect(result.current.slashCommands).toBeDefined());
      vi.useFakeTimers();
      return { result, baseline: rebuilds() };
    };

    afterEach(() => {
      if (vi.isFakeTimers()) {
        vi.useRealTimers();
      }
    });

    // AC1. Drives a real event source rather than startupRuntime.emitChange:
    // emitting directly would bypass the bridge and merely re-test the
    // runtime's pre-existing debounce, passing even with the bridge removed.
    it('collapses a same-kind burst into exactly one rebuild', async () => {
      const { baseline } = await settleThenFakeTimers();

      act(() => {
        for (let i = 0; i < 5; i++) {
          coreEvents.emit('extensionsStarting', { total: 5, completed: i });
        }
      });

      // Negative half: without this, a no-debounce implementation passes.
      await advance(DEBOUNCE_MS - 75);
      expect(rebuilds()).toBe(baseline);

      await advance(MAX_WAIT_MS);
      expect(rebuilds()).toBe(baseline + 1);
    });

    // AC3, first half: transitions inside one window collapse to 1.
    it('collapses 2N MCP transitions inside one window into one rebuild', async () => {
      const { baseline } = await settleThenFakeTimers();

      act(() => {
        for (let i = 0; i < 3; i++) {
          emitMcpUpdate();
          emitMcpUpdate();
        }
      });

      await advance(DEBOUNCE_MS - 75);
      expect(rebuilds()).toBe(baseline);

      await advance(MAX_WAIT_MS);
      expect(rebuilds()).toBe(baseline + 1);
    });

    // AC3, second half: coalescing is gap-driven, NOT N-driven. Transitions
    // spaced beyond the debounce window each get their own rebuild, because
    // flushChange deletes the timer entry and the next emit opens a fresh
    // window. This is expected — do not "fix" it.
    it('does not coalesce MCP transitions spaced beyond the debounce window', async () => {
      const { baseline } = await settleThenFakeTimers();

      for (let i = 0; i < 2; i++) {
        act(() => {
          emitMcpUpdate();
        });
        await advance(DEBOUNCE_MS + 100);
        act(() => {
          emitMcpUpdate();
        });
        await advance(DEBOUNCE_MS + 100);
      }

      // 2 servers x 2 transitions, none sharing a window => 2N.
      expect(rebuilds()).toBe(baseline + 4);
    });

    // AC2
    it('caps a sustained same-kind stream at one rebuild per maxWait window', async () => {
      const { baseline } = await settleThenFakeTimers();

      // Inter-arrival below the debounce window, so only maxWait can flush.
      for (let i = 0; i < 12; i++) {
        act(() => {
          coreEvents.emit('extensionsStarting', { total: 12, completed: i });
        });
        await advance(100);
      }
      await advance(MAX_WAIT_MS + DEBOUNCE_MS);

      const elapsedWindows = Math.ceil((12 * 100) / MAX_WAIT_MS) + 1;
      const observed = rebuilds() - baseline;
      expect(observed).toBeGreaterThan(0);
      expect(observed).toBeLessThanOrEqual(elapsedWindows);
    });

    // AC4: the discriminating property is K-invariance across kinds, not any
    // particular count. Timers are per event key, so kinds never merge with
    // each other; whether the resulting setReloadTrigger calls collapse into
    // one render is React's business and both outcomes are correct.
    it('coalesces each kind independently and is invariant in burst size', async () => {
      // All four live sources, driven for real so the bridge is exercised.
      const fireAllKinds = () => {
        emitMcpUpdate();
        coreEvents.emit('extensionsStarting', { total: 1, completed: 1 });
        coreEvents.emit(CoreEvent.DynamicCommandsChanged);
        (
          mockConfig as unknown as { emitSkillChange: () => void }
        ).emitSkillChange();
      };

      const { baseline: baseOnce } = await settleThenFakeTimers();
      act(() => fireAllKinds());
      await advance(MAX_WAIT_MS + DEBOUNCE_MS);
      const onceCount = rebuilds() - baseOnce;
      expect(onceCount).toBeGreaterThan(0);

      vi.useRealTimers();
      await unmountHook?.();
      unmountHook = undefined;
      mockBuiltinLoadCommands.mockClear();
      const { baseline: baseMany } = await settleThenFakeTimers();
      // Rounds must be separated in time. Firing all four inside a single
      // act() would let React batch every setReloadTrigger into one render,
      // which makes the invariant hold even without a debounce. Each gap stays
      // under DEBOUNCE_MS so a debounced implementation still coalesces.
      for (let i = 0; i < 4; i++) {
        act(() => fireAllKinds());
        await advance(50);
      }
      await advance(MAX_WAIT_MS + DEBOUNCE_MS);
      const manyCount = rebuilds() - baseMany;

      // 4x the events must not mean 4x the rebuilds.
      expect(manyCount).toBe(onceCount);
    });

    // AC5
    it('still reloads for every live event source', async () => {
      const { baseline } = await settleThenFakeTimers();
      let expected = baseline;

      const fire = async (trigger: () => void) => {
        act(trigger);
        await advance(MAX_WAIT_MS + DEBOUNCE_MS);
        expected += 1;
        expect(rebuilds()).toBe(expected);
      };

      await fire(() => emitMcpUpdate());
      await fire(() =>
        coreEvents.emit('extensionsStarting', { total: 1, completed: 1 }),
      );
      await fire(() => coreEvents.emit(CoreEvent.DynamicCommandsChanged));
      await fire(() =>
        (
          mockConfig as unknown as { emitSkillChange: () => void }
        ).emitSkillChange(),
      );
    });

    // AC6: emitSkillChange emits BOTH 'skills' and 'commands'. Driving only
    // 'skills' would pass even if someone re-added an onChange('commands')
    // subscription, since nothing would emit 'commands' in that test.
    it('rebuilds once per skill change even though it emits skills and commands', async () => {
      const { baseline } = await settleThenFakeTimers();

      act(() => {
        (
          mockConfig as unknown as { emitSkillChange: () => void }
        ).emitSkillChange();
      });

      await advance(DEBOUNCE_MS - 75);
      expect(rebuilds()).toBe(baseline);

      await advance(MAX_WAIT_MS + DEBOUNCE_MS);
      expect(rebuilds()).toBe(baseline + 1);
    });

    // AC6, discriminating half. The behavior assertion above cannot catch a
    // re-added onChange('commands') subscription: emitSkillChange emits
    // 'skills' and 'commands' in the same tick, so both timers flush together
    // and React batches the two setReloadTrigger calls into one render. This
    // asserts the subscription's absence directly instead.
    it('does not subscribe to the commands channel', async () => {
      const { baseline } = await settleThenFakeTimers();
      const runtime = mockConfig.getStartupRuntime();

      act(() => {
        runtime.emitChange('commands');
      });
      await advance(MAX_WAIT_MS + DEBOUNCE_MS);

      expect(rebuilds()).toBe(baseline);
    });

    // AC9: user-initiated reloads bypass the debounce. Asserting after a timer
    // advance would pass for both debounced and immediate implementations, so
    // this must not advance timers at all.
    it('keeps user-initiated reloadCommands immediate', async () => {
      const { result, baseline } = await settleThenFakeTimers();

      act(() => {
        result.current.reloadCommands();
      });
      await flushMicrotasks();

      expect(rebuilds()).toBe(baseline + 1);
    });
  });
});
