/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAvailableCommands,
  handleSlashCommand,
} from './nonInteractiveCliCommands.js';
import {
  createGoalRuntime,
  type ChatRecord,
  type Config,
  type GoalJournal,
  type GoalStateRecordPayloadV2,
  uiTelemetryService,
} from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from './config/settings.js';
import { CommandKind, type ExecutionMode } from './ui/commands/types.js';
import { filterCommandsForMode } from './services/commandUtils.js';
import { goalCommand } from './ui/commands/goalCommand.js';

// Mock the CommandService
const mockGetCommands = vi.hoisted(() => vi.fn());
const mockGetCommandsForMode = vi.hoisted(() => vi.fn());
const mockGetModelInvocableCommands = vi.hoisted(() => vi.fn());
const mockCommandServiceCreate = vi.hoisted(() => vi.fn());
vi.mock('./services/CommandService.js', () => ({
  CommandService: {
    create: mockCommandServiceCreate,
  },
}));

describe('handleSlashCommand', () => {
  let mockConfig: Config;
  let mockSettings: LoadedSettings;
  let abortController: AbortController;
  let mockFireUserPromptExpansionEvent: ReturnType<typeof vi.fn>;

  const createJournal = (): GoalJournal => ({
    getTranscriptCursor: () => ({ recordId: null }),
    async recordGoalState(
      recordUuid: string,
      payload: GoalStateRecordPayloadV2,
    ): Promise<ChatRecord> {
      return {
        uuid: recordUuid,
        parentUuid: null,
        sessionId: 'test-session',
        timestamp: new Date(0).toISOString(),
        type: 'system',
        subtype: 'goal_state',
        provenance: 'goal_control',
        cwd: '/test/project',
        version: 'test',
        systemPayload: structuredClone(payload),
      };
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    uiTelemetryService.reset();
    const goalRuntime = createGoalRuntime({ journal: createJournal() });
    // getCommandsForMode applies real mode filtering on top of getCommands()
    mockGetCommandsForMode.mockImplementation((mode: ExecutionMode) =>
      filterCommandsForMode(mockGetCommands(), mode),
    );
    mockGetModelInvocableCommands.mockImplementation(() =>
      mockGetCommands().filter(
        (command: { modelInvocable?: boolean; hidden?: boolean }) =>
          !command.hidden && command.modelInvocable === true,
      ),
    );
    mockCommandServiceCreate.mockResolvedValue({
      getCommands: mockGetCommands,
      getCommandsForMode: mockGetCommandsForMode,
      getModelInvocableCommands: mockGetModelInvocableCommands,
    });
    mockFireUserPromptExpansionEvent = vi.fn().mockResolvedValue(undefined);

    mockConfig = {
      getExperimentalZedIntegration: vi.fn().mockReturnValue(false),
      isInteractive: vi.fn().mockReturnValue(false),
      getSessionId: vi.fn().mockReturnValue('test-session'),
      getFolderTrustFeature: vi.fn().mockReturnValue(false),
      getFolderTrust: vi.fn().mockReturnValue(false),
      getProjectRoot: vi.fn().mockReturnValue('/test/project'),
      isTrustedFolder: vi.fn().mockReturnValue(true),
      getDisableAllHooks: vi.fn().mockReturnValue(false),
      hasHooksForEvent: vi.fn().mockReturnValue(true),
      getHookSystem: vi.fn().mockReturnValue({
        addFunctionHook: vi.fn().mockReturnValue('goal-hook-id'),
        removeFunctionHook: vi.fn().mockReturnValue(true),
        fireUserPromptExpansionEvent: mockFireUserPromptExpansionEvent,
      }),
      setModelInvocableCommandsProvider: vi.fn(),
      setModelInvocableCommandsExecutor: vi.fn(),
      getDisabledSlashCommands: vi.fn().mockReturnValue([]),
      getGoalRuntime: vi.fn(() => goalRuntime),
      getGoalRuntimeReady: vi.fn(async () => goalRuntime),
      storage: {},
    } as unknown as Config;

    mockSettings = {
      system: { path: '', settings: {} },
      systemDefaults: { path: '', settings: {} },
      user: { path: '', settings: {} },
      workspace: { path: '', settings: {} },
    } as LoadedSettings;

    abortController = new AbortController();
  });

  afterEach(() => {
    uiTelemetryService.reset();
  });

  it('should return no_command for non-slash input', async () => {
    const result = await handleSlashCommand(
      'regular text',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(result.type).toBe('no_command');
  });

  it('should return no_command for unknown slash commands', async () => {
    mockGetCommands.mockReturnValue([]);

    const result = await handleSlashCommand(
      '/unknowncommand',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(result.type).toBe('no_command');
  });

  it('should return unsupported for built-in commands without non-interactive supportedModes', async () => {
    const mockHelpCommand = {
      name: 'help',
      description: 'Show help',
      kind: CommandKind.BUILT_IN,
      // No supportedModes → BUILT_IN fallback → interactive only
      action: vi.fn(),
    };
    mockGetCommands.mockReturnValue([mockHelpCommand]);

    const result = await handleSlashCommand(
      '/help',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(result.type).toBe('unsupported');
    if (result.type === 'unsupported') {
      expect(result.reason).toContain('/help');
      expect(result.reason).toContain('not supported');
    }
  });

  it('should return unsupported for /help when using default allowed list', async () => {
    const mockHelpCommand = {
      name: 'help',
      description: 'Show help',
      kind: CommandKind.BUILT_IN,
      action: vi.fn(),
    };
    mockGetCommands.mockReturnValue([mockHelpCommand]);

    const result = await handleSlashCommand(
      '/help',
      abortController,
      mockConfig,
      mockSettings,
      // Default allowed list: ['init', 'summary', 'compress']
    );

    expect(result.type).toBe('unsupported');
    if (result.type === 'unsupported') {
      expect(result.reason).toBe(
        'The command "/help" is not supported in this mode.',
      );
    }
  });

  it('should execute local commands with non_interactive supportedModes', async () => {
    const mockInitCommand = {
      name: 'init',
      description: 'Initialize project',
      kind: CommandKind.BUILT_IN,
      supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
      action: vi.fn().mockResolvedValue({
        type: 'message',
        messageType: 'info',
        content: 'Project initialized',
      }),
    };
    mockGetCommands.mockReturnValue([mockInitCommand]);

    const result = await handleSlashCommand(
      '/init',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(result.type).toBe('message');
    if (result.type === 'message') {
      expect(result.content).toBe('Project initialized');
    }
  });

  it('should execute /btw with non_interactive supportedModes', async () => {
    const mockBtwCommand = {
      name: 'btw',
      description: 'Ask a side question',
      kind: CommandKind.BUILT_IN,
      supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
      action: vi.fn().mockResolvedValue({
        type: 'message',
        messageType: 'info',
        content: 'btw> question\nanswer',
      }),
    };
    mockGetCommands.mockReturnValue([mockBtwCommand]);

    const result = await handleSlashCommand(
      '/btw question',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(mockBtwCommand.action).toHaveBeenCalled();
    expect(result.type).toBe('message');
    if (result.type === 'message') {
      expect(result.content).toBe('btw> question\nanswer');
    }
  });

  it('returns canonical goal_control for a non-interactive create', async () => {
    mockGetCommands.mockReturnValue([goalCommand]);

    const result = await handleSlashCommand(
      '/goal write a hello world script',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(result).toMatchObject({
      type: 'goal_control',
      operation: {
        kind: 'set',
        objective: 'write a hello world script',
      },
      response: {
        snapshot: {
          v: 2,
          activity: 'idle',
          goal: {
            objective: 'write a hello world script',
            status: 'active',
          },
        },
      },
    });
  });

  it('returns canonical goal_control for empty non-interactive /goal status', async () => {
    mockGetCommands.mockReturnValue([goalCommand]);

    const result = await handleSlashCommand(
      '/goal',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(result).toMatchObject({
      type: 'goal_control',
      operation: { kind: 'status' },
      response: {
        snapshot: { v: 2, activity: 'idle', goal: null },
      },
    });
  });

  it('returns the active v2 snapshot for status after create', async () => {
    mockGetCommands.mockReturnValue([goalCommand]);

    await handleSlashCommand(
      '/goal write a hello world script',
      abortController,
      mockConfig,
      mockSettings,
    );
    const result = await handleSlashCommand(
      '/goal',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(result).toMatchObject({
      type: 'goal_control',
      operation: { kind: 'status' },
      response: {
        snapshot: {
          goal: {
            objective: 'write a hello world script',
            status: 'active',
          },
        },
      },
    });
  });

  it('returns the cleared v2 snapshot for non-interactive /goal clear', async () => {
    mockGetCommands.mockReturnValue([goalCommand]);

    await handleSlashCommand(
      '/goal write a hello world script',
      abortController,
      mockConfig,
      mockSettings,
    );
    const result = await handleSlashCommand(
      '/goal clear',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(result).toMatchObject({
      type: 'goal_control',
      operation: { kind: 'clear' },
      response: {
        snapshot: { v: 2, activity: 'idle', goal: null },
      },
    });
  });

  it('should report cleared goal for ACP /goal clear', async () => {
    vi.mocked(mockConfig.getExperimentalZedIntegration).mockReturnValue(true);
    mockGetCommands.mockReturnValue([goalCommand]);

    await handleSlashCommand(
      '/goal write a hello world script',
      abortController,
      mockConfig,
      mockSettings,
    );
    const result = await handleSlashCommand(
      '/goal clear',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(result).toMatchObject({
      type: 'goal_control',
      operation: { kind: 'clear' },
      response: { snapshot: { goal: null } },
    });
  });

  it('should execute FILE commands in any mode without explicit supportedModes', async () => {
    const mockFileCommand = {
      name: 'custom',
      description: 'Custom file command',
      kind: CommandKind.FILE,
      action: vi.fn().mockResolvedValue({
        type: 'submit_prompt',
        content: [{ text: 'Custom prompt' }],
      }),
    };
    mockGetCommands.mockReturnValue([mockFileCommand]);

    const result = await handleSlashCommand(
      '/custom',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(result.type).toBe('submit_prompt');
    if (result.type === 'submit_prompt') {
      expect(result.content).toEqual([{ text: 'Custom prompt' }]);
    }
  });

  it('passes a submit_prompt modelOverride through to the result', async () => {
    const mockCommand = {
      name: 'custom',
      description: 'Custom command with a per-turn model override',
      kind: CommandKind.FILE,
      action: vi.fn().mockResolvedValue({
        type: 'submit_prompt',
        content: [{ text: 'Run on the override model' }],
        modelOverride: 'glm-5.1',
      }),
    };
    mockGetCommands.mockReturnValue([mockCommand]);

    const result = await handleSlashCommand(
      '/custom',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(result.type).toBe('submit_prompt');
    if (result.type === 'submit_prompt') {
      expect(result.content).toEqual([{ text: 'Run on the override model' }]);
      expect(result.modelOverride).toBe('glm-5.1');
    }
  });

  it('omits modelOverride when the command does not set one', async () => {
    const mockCommand = {
      name: 'custom',
      description: 'Custom command without a model override',
      kind: CommandKind.FILE,
      action: vi.fn().mockResolvedValue({
        type: 'submit_prompt',
        content: [{ text: 'Run on the session model' }],
      }),
    };
    mockGetCommands.mockReturnValue([mockCommand]);

    const result = await handleSlashCommand(
      '/custom',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(result.type).toBe('submit_prompt');
    if (result.type === 'submit_prompt') {
      expect(result.modelOverride).toBeUndefined();
    }
  });

  it('records successful SKILL submit_prompt commands in session metrics', async () => {
    const mockSkillCommand = {
      name: 'review',
      description: 'Review code',
      kind: CommandKind.SKILL,
      skillDetail: { name: 'review-skill' },
      action: vi.fn().mockResolvedValue({
        type: 'submit_prompt',
        content: [{ text: 'Review prompt' }],
      }),
    };
    mockGetCommands.mockReturnValue([mockSkillCommand]);

    const result = await handleSlashCommand(
      '/review',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(result.type).toBe('submit_prompt');
    expect(
      uiTelemetryService.getMetricsForSession('test-session').skills,
    ).toEqual({
      totalCalls: 1,
      totalSuccess: 1,
      totalFail: 0,
      byName: {
        'review-skill': { count: 1, success: 1, fail: 0 },
      },
    });
  });

  it('records ACP SKILL submit_prompt commands in session metrics', async () => {
    vi.mocked(mockConfig.getExperimentalZedIntegration).mockReturnValue(true);
    const mockSkillCommand = {
      name: 'review',
      description: 'Review code',
      kind: CommandKind.SKILL,
      supportedModes: ['acp'] as const,
      action: vi.fn().mockResolvedValue({
        type: 'submit_prompt',
        content: [{ text: 'Review prompt' }],
      }),
    };
    mockGetCommands.mockReturnValue([mockSkillCommand]);

    const result = await handleSlashCommand(
      '/review',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(result.type).toBe('submit_prompt');
    expect(
      uiTelemetryService.getMetricsForSession('test-session').skills,
    ).toEqual({
      totalCalls: 1,
      totalSuccess: 1,
      totalFail: 0,
      byName: {
        review: { count: 1, success: 1, fail: 0 },
      },
    });
  });

  it('records failed SKILL commands when action throws', async () => {
    const mockSkillCommand = {
      name: 'review',
      description: 'Review code',
      kind: CommandKind.SKILL,
      action: vi.fn().mockRejectedValue(new Error('boom')),
    };
    mockGetCommands.mockReturnValue([mockSkillCommand]);

    await expect(
      handleSlashCommand('/review', abortController, mockConfig, mockSettings),
    ).rejects.toThrow('boom');

    expect(
      uiTelemetryService.getMetricsForSession('test-session').skills,
    ).toEqual({
      totalCalls: 1,
      totalSuccess: 0,
      totalFail: 1,
      byName: {
        review: { count: 1, success: 0, fail: 1 },
      },
    });
  });

  it('records blocked SKILL submit_prompt commands as failures', async () => {
    mockFireUserPromptExpansionEvent.mockResolvedValue({
      getBlockingError: () => ({
        blocked: true,
        reason: 'Blocked by policy',
      }),
      shouldStopExecution: () => false,
    });
    const mockSkillCommand = {
      name: 'review',
      description: 'Review code',
      kind: CommandKind.SKILL,
      action: vi.fn().mockResolvedValue({
        type: 'submit_prompt',
        content: 'Review prompt',
      }),
    };
    mockGetCommands.mockReturnValue([mockSkillCommand]);

    const result = await handleSlashCommand(
      '/review',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(result.type).toBe('message');
    expect(
      uiTelemetryService.getMetricsForSession('test-session').skills,
    ).toEqual({
      totalCalls: 1,
      totalSuccess: 0,
      totalFail: 1,
      byName: {
        review: { count: 1, success: 0, fail: 1 },
      },
    });
  });

  it('records SKILL submit_prompt commands as failures when hooks throw', async () => {
    mockFireUserPromptExpansionEvent.mockRejectedValue(new Error('hook crash'));
    const mockSkillCommand = {
      name: 'review',
      description: 'Review code',
      kind: CommandKind.SKILL,
      action: vi.fn().mockResolvedValue({
        type: 'submit_prompt',
        content: 'Review prompt',
      }),
    };
    mockGetCommands.mockReturnValue([mockSkillCommand]);

    await expect(
      handleSlashCommand('/review', abortController, mockConfig, mockSettings),
    ).rejects.toThrow('hook crash');

    expect(
      uiTelemetryService.getMetricsForSession('test-session').skills,
    ).toEqual({
      totalCalls: 1,
      totalSuccess: 0,
      totalFail: 1,
      byName: {
        review: { count: 1, success: 0, fail: 1 },
      },
    });
  });

  it('does not record FILE submit_prompt commands as skill metrics', async () => {
    const mockFileCommand = {
      name: 'custom',
      description: 'Custom file command',
      kind: CommandKind.FILE,
      action: vi.fn().mockResolvedValue({
        type: 'submit_prompt',
        content: [{ text: 'Custom prompt' }],
      }),
    };
    mockGetCommands.mockReturnValue([mockFileCommand]);

    const result = await handleSlashCommand(
      '/custom',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(result.type).toBe('submit_prompt');
    expect(
      uiTelemetryService.getMetricsForSession('test-session').skills,
    ).toEqual({
      totalCalls: 0,
      totalSuccess: 0,
      totalFail: 0,
      byName: {},
    });
  });

  it('should fire UserPromptExpansion hooks for submit_prompt commands', async () => {
    const mockFileCommand = {
      name: 'custom',
      description: 'Custom file command',
      kind: CommandKind.FILE,
      action: vi.fn().mockResolvedValue({
        type: 'submit_prompt',
        content: [{ text: 'Expanded prompt' }],
      }),
    };
    mockGetCommands.mockReturnValue([mockFileCommand]);

    const result = await handleSlashCommand(
      '/custom with args',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(result.type).toBe('submit_prompt');
    expect(mockFireUserPromptExpansionEvent).toHaveBeenCalledWith(
      'custom',
      'with args',
      'Expanded prompt',
      abortController.signal,
    );
  });

  it('should append UserPromptExpansion additional context for submit_prompt commands', async () => {
    mockFireUserPromptExpansionEvent.mockResolvedValue({
      getBlockingError: () => ({ blocked: false }),
      shouldStopExecution: () => false,
      getAdditionalContext: () => 'Hook context',
    });
    const mockFileCommand = {
      name: 'custom',
      description: 'Custom file command',
      kind: CommandKind.FILE,
      action: vi.fn().mockResolvedValue({
        type: 'submit_prompt',
        content: [{ text: 'Expanded prompt' }],
      }),
    };
    mockGetCommands.mockReturnValue([mockFileCommand]);

    const result = await handleSlashCommand(
      '/custom with args',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(result.type).toBe('submit_prompt');
    if (result.type === 'submit_prompt') {
      expect(result.content).toEqual([
        { text: 'Expanded prompt' },
        { text: '\n\nHook context' },
      ]);
    }
  });

  it('should not fire UserPromptExpansion hooks when hooks are disabled', async () => {
    vi.mocked(mockConfig.getDisableAllHooks).mockReturnValue(true);
    const mockFileCommand = {
      name: 'custom',
      description: 'Custom file command',
      kind: CommandKind.FILE,
      action: vi.fn().mockResolvedValue({
        type: 'submit_prompt',
        content: 'Expanded prompt',
      }),
    };
    mockGetCommands.mockReturnValue([mockFileCommand]);

    const result = await handleSlashCommand(
      '/custom',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(mockFireUserPromptExpansionEvent).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'submit_prompt',
      content: 'Expanded prompt',
    });
  });

  it('should not fire UserPromptExpansion hooks when no hooks are configured', async () => {
    vi.mocked(mockConfig.hasHooksForEvent).mockReturnValue(false);
    const mockFileCommand = {
      name: 'custom',
      description: 'Custom file command',
      kind: CommandKind.FILE,
      action: vi.fn().mockResolvedValue({
        type: 'submit_prompt',
        content: 'Expanded prompt',
      }),
    };
    mockGetCommands.mockReturnValue([mockFileCommand]);

    const result = await handleSlashCommand(
      '/custom',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(mockFireUserPromptExpansionEvent).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'submit_prompt',
      content: 'Expanded prompt',
    });
  });

  it('should not fire UserPromptExpansion hooks when hook system is unavailable', async () => {
    vi.mocked(mockConfig.getHookSystem).mockReturnValue(undefined);
    const mockFileCommand = {
      name: 'custom',
      description: 'Custom file command',
      kind: CommandKind.FILE,
      action: vi.fn().mockResolvedValue({
        type: 'submit_prompt',
        content: 'Expanded prompt',
      }),
    };
    mockGetCommands.mockReturnValue([mockFileCommand]);

    const result = await handleSlashCommand(
      '/custom',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(mockFireUserPromptExpansionEvent).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'submit_prompt',
      content: 'Expanded prompt',
    });
  });

  it('should block submit_prompt commands when UserPromptExpansion blocks', async () => {
    mockFireUserPromptExpansionEvent.mockResolvedValue({
      getBlockingError: () => ({
        blocked: true,
        reason: 'Blocked by policy',
      }),
      shouldStopExecution: () => false,
    });
    const mockFileCommand = {
      name: 'custom',
      description: 'Custom file command',
      kind: CommandKind.FILE,
      action: vi.fn().mockResolvedValue({
        type: 'submit_prompt',
        content: 'Expanded prompt',
      }),
    };
    mockGetCommands.mockReturnValue([mockFileCommand]);

    const result = await handleSlashCommand(
      '/custom',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'UserPromptExpansion blocked: Blocked by policy',
    });
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
    const mockFileCommand = {
      name: 'custom',
      description: 'Custom file command',
      kind: CommandKind.FILE,
      modelInvocable: true,
      action: vi.fn().mockResolvedValue({
        type: 'submit_prompt',
        content: 'Expanded prompt',
      }),
    };
    mockGetCommands.mockReturnValue([mockFileCommand]);

    await handleSlashCommand(
      '/custom',
      abortController,
      mockConfig,
      mockSettings,
    );

    const executor = vi.mocked(mockConfig.setModelInvocableCommandsExecutor)
      .mock.calls[0]?.[0];
    expect(executor).toBeDefined();

    const content = await executor?.('custom', 'with args');

    expect(content).toEqual({
      error: 'UserPromptExpansion blocked: Blocked by policy',
    });
  });

  it('should return unsupported for other built-in commands like /quit', async () => {
    const mockQuitCommand = {
      name: 'quit',
      description: 'Quit application',
      kind: CommandKind.BUILT_IN,
      action: vi.fn(),
    };
    mockGetCommands.mockReturnValue([mockQuitCommand]);

    const result = await handleSlashCommand(
      '/quit',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(result.type).toBe('unsupported');
    if (result.type === 'unsupported') {
      expect(result.reason).toContain('/quit');
      expect(result.reason).toContain('not supported');
    }
  });

  it('should handle command with no action', async () => {
    const mockCommand = {
      name: 'noaction',
      description: 'Command without action',
      kind: CommandKind.FILE,
      // No action property
    };
    mockGetCommands.mockReturnValue([mockCommand]);

    const result = await handleSlashCommand(
      '/noaction',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(result.type).toBe('no_command');
  });

  it('should return message when command returns void', async () => {
    const mockCommand = {
      name: 'voidcmd',
      description: 'Command that returns void',
      kind: CommandKind.FILE,
      action: vi.fn().mockResolvedValue(undefined),
    };
    mockGetCommands.mockReturnValue([mockCommand]);

    const result = await handleSlashCommand(
      '/voidcmd',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(result.type).toBe('message');
    if (result.type === 'message') {
      expect(result.content).toBe('Command executed successfully.');
      expect(result.messageType).toBe('info');
    }
  });

  describe('disabled slash commands', () => {
    const mockDisabledCommand = {
      name: 'help',
      description: 'Show help',
      kind: CommandKind.BUILT_IN,
      supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
      action: vi.fn().mockResolvedValue({
        type: 'message',
        messageType: 'info',
        content: 'Help content',
      }),
    };

    it('should return unsupported with disabled reason for a disabled command', async () => {
      mockGetCommands.mockReturnValue([mockDisabledCommand]);
      vi.mocked(mockConfig.getDisabledSlashCommands).mockReturnValue(['help']);

      const result = await handleSlashCommand(
        '/help',
        abortController,
        mockConfig,
        mockSettings,
      );

      expect(result.type).toBe('unsupported');
      if (result.type === 'unsupported') {
        expect(result.reason).toContain('disabled');
        expect(result.originalType).toBe('filtered_command');
      }
    });

    it('should match disabled command names case-insensitively', async () => {
      mockGetCommands.mockReturnValue([mockDisabledCommand]);
      vi.mocked(mockConfig.getDisabledSlashCommands).mockReturnValue(['HELP']);

      const result = await handleSlashCommand(
        '/help',
        abortController,
        mockConfig,
        mockSettings,
      );

      expect(result.type).toBe('unsupported');
      if (result.type === 'unsupported') {
        expect(result.reason).toContain('disabled');
      }
    });

    it('should still return no_command for genuinely unknown commands even with a denylist', async () => {
      mockGetCommands.mockReturnValue([mockDisabledCommand]);
      vi.mocked(mockConfig.getDisabledSlashCommands).mockReturnValue(['help']);

      const result = await handleSlashCommand(
        '/unknowncommand',
        abortController,
        mockConfig,
        mockSettings,
      );

      expect(result.type).toBe('no_command');
    });

    it('does not expose disabled model-invocable commands through SkillTool', async () => {
      const modelInvocableCommand = {
        name: 'custom',
        description: 'Custom file command',
        kind: CommandKind.FILE,
        modelInvocable: true,
        supportedModes: ['non_interactive'] as ExecutionMode[],
        action: vi.fn().mockResolvedValue({
          type: 'submit_prompt',
          content: 'Expanded prompt',
        }),
      };
      mockGetCommands.mockReturnValue([modelInvocableCommand]);
      vi.mocked(mockConfig.getDisabledSlashCommands).mockReturnValue([
        'custom',
      ]);
      mockCommandServiceCreate.mockImplementation(
        async (_loaders, _signal, disabledNames?: ReadonlySet<string>) => {
          const commands =
            disabledNames?.has('custom') === true
              ? []
              : [modelInvocableCommand];
          return {
            getCommands: () => commands,
            getCommandsForMode: (mode: ExecutionMode) =>
              filterCommandsForMode(commands, mode),
            getModelInvocableCommands: () =>
              commands.filter((command) => command.modelInvocable === true),
          };
        },
      );

      const result = await handleSlashCommand(
        '/custom',
        abortController,
        mockConfig,
        mockSettings,
      );

      expect(result.type).toBe('unsupported');
      if (result.type === 'unsupported') {
        expect(result.reason).toContain('disabled');
      }
      const provider = vi.mocked(mockConfig.setModelInvocableCommandsProvider)
        .mock.calls[0]?.[0];
      expect(provider?.()).toEqual([]);
      const executor = vi.mocked(mockConfig.setModelInvocableCommandsExecutor)
        .mock.calls[0]?.[0];
      await expect(executor?.('custom')).resolves.toBeNull();
    });
  });

  describe('stacked skill invocations', () => {
    const createSkillCommand = (name: string, body: string) => ({
      name,
      description: `Skill ${name}`,
      kind: CommandKind.SKILL,
      supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
      action: vi.fn().mockResolvedValue({
        type: 'submit_prompt',
        content: [{ text: `SKILL_BODY:${name}:${body}` }],
      }),
    });

    it('combines two stacked skills into a single submit_prompt', async () => {
      const skillA = createSkillCommand('feat-dev', 'feature workflow');
      const skillB = createSkillCommand('e2e-testing', 'e2e workflow');
      mockGetCommands.mockReturnValue([skillA, skillB]);

      const result = await handleSlashCommand(
        '/feat-dev /e2e-testing implement X',
        abortController,
        mockConfig,
        mockSettings,
      );

      expect(result.type).toBe('submit_prompt');
      if (result.type === 'submit_prompt') {
        const content = result.content as Array<{ text: string }>;
        const texts = content.map((c) => c.text);
        expect(texts).toContain('SKILL_BODY:feat-dev:feature workflow');
        expect(texts).toContain('SKILL_BODY:e2e-testing:e2e workflow');
        expect(texts).toContain('implement X');
      }
    });

    it('calls each skill action once', async () => {
      const skillA = createSkillCommand('feat-dev', 'a');
      const skillB = createSkillCommand('review', 'b');
      mockGetCommands.mockReturnValue([skillA, skillB]);

      await handleSlashCommand(
        '/feat-dev /review do stuff',
        abortController,
        mockConfig,
        mockSettings,
      );

      expect(skillA.action).toHaveBeenCalledTimes(1);
      expect(skillB.action).toHaveBeenCalledTimes(1);
    });

    it('handles stacked skills with no remaining text', async () => {
      const skillA = createSkillCommand('feat-dev', 'a');
      const skillB = createSkillCommand('bugfix', 'b');
      mockGetCommands.mockReturnValue([skillA, skillB]);

      const result = await handleSlashCommand(
        '/feat-dev /bugfix',
        abortController,
        mockConfig,
        mockSettings,
      );

      expect(result.type).toBe('submit_prompt');
      if (result.type === 'submit_prompt') {
        const content = result.content as Array<{ text: string }>;
        const texts = content.map((c) => c.text);
        expect(texts).toContain('SKILL_BODY:feat-dev:a');
        expect(texts).toContain('SKILL_BODY:bugfix:b');
        expect(texts).toHaveLength(2);
      }
    });

    it('falls through to normal dispatch for a single skill', async () => {
      const skillA = createSkillCommand('feat-dev', 'a');
      mockGetCommands.mockReturnValue([skillA]);

      const result = await handleSlashCommand(
        '/feat-dev build something',
        abortController,
        mockConfig,
        mockSettings,
      );

      // Single skill goes through normal dispatch, not stacked path
      expect(result.type).toBe('submit_prompt');
      expect(skillA.action).toHaveBeenCalledTimes(1);
    });

    it('skips skills whose action is undefined', async () => {
      const skillA = createSkillCommand('feat-dev', 'a');
      const noActionSkill = {
        name: 'no-action',
        description: 'No action',
        kind: CommandKind.SKILL,
        supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
        action: undefined,
      };
      const skillB = createSkillCommand('review', 'b');
      mockGetCommands.mockReturnValue([skillA, noActionSkill, skillB]);

      const result = await handleSlashCommand(
        '/feat-dev /no-action /review do it',
        abortController,
        mockConfig,
        mockSettings,
      );

      expect(result.type).toBe('submit_prompt');
      if (result.type === 'submit_prompt') {
        const content = result.content as Array<{ text: string }>;
        const texts = content.map((c) => c.text);
        expect(texts).toContain('SKILL_BODY:feat-dev:a');
        expect(texts).toContain('SKILL_BODY:review:b');
      }
    });

    it('excludes non-submit_prompt results from combined content', async () => {
      const skillA = createSkillCommand('feat-dev', 'a');
      const errorSkill = {
        name: 'error-skill',
        description: 'Skill returning error',
        kind: CommandKind.SKILL,
        supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
        action: vi.fn().mockResolvedValue({
          type: 'message',
          messageType: 'error',
          content: 'Something failed',
        }),
      };
      const skillB = createSkillCommand('review', 'b');
      mockGetCommands.mockReturnValue([skillA, errorSkill, skillB]);

      const result = await handleSlashCommand(
        '/feat-dev /error-skill /review do it',
        abortController,
        mockConfig,
        mockSettings,
      );

      expect(result.type).toBe('submit_prompt');
      if (result.type === 'submit_prompt') {
        const content = result.content as Array<{ text: string }>;
        const texts = content.map((c) => c.text);
        expect(texts).toContain('SKILL_BODY:feat-dev:a');
        expect(texts).toContain('SKILL_BODY:review:b');
        // Error message is not in combined content
        expect(texts).not.toContain('Something failed');
      }
    });

    it('records telemetry success=false for non-submit_prompt results', async () => {
      const skillA = createSkillCommand('feat-dev', 'a');
      const errorSkill = {
        name: 'error-skill',
        description: 'Skill returning error',
        kind: CommandKind.SKILL,
        supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
        action: vi.fn().mockResolvedValue({
          type: 'message',
          messageType: 'error',
          content: 'fail',
        }),
      };
      mockGetCommands.mockReturnValue([skillA, errorSkill]);

      const result = await handleSlashCommand(
        '/feat-dev /error-skill do it',
        abortController,
        mockConfig,
        mockSettings,
      );

      // Verify the error skill's action was actually called
      // (telemetry recording logic is tested in slashCommandProcessor.test.ts)
      expect(errorSkill.action).toHaveBeenCalledTimes(1);
      expect(result.type).toBe('submit_prompt');
    });

    it('propagates modelOverride from first submit_prompt skill', async () => {
      const skillA = {
        name: 'feat-dev',
        description: 'Skill with model override',
        kind: CommandKind.SKILL,
        supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
        action: vi.fn().mockResolvedValue({
          type: 'submit_prompt',
          content: [{ text: 'SKILL_BODY:feat-dev' }],
          modelOverride: 'gemini-2.5-pro',
        }),
      };
      const skillB = createSkillCommand('review', 'b');
      mockGetCommands.mockReturnValue([skillA, skillB]);

      const result = await handleSlashCommand(
        '/feat-dev /review do it',
        abortController,
        mockConfig,
        mockSettings,
      );

      expect(result.type).toBe('submit_prompt');
      if (result.type === 'submit_prompt') {
        expect(result.modelOverride).toBe('gemini-2.5-pro');
      }
    });
  });
});

describe('getAvailableCommands', () => {
  let mockConfig: Config;
  let notifyConfigChanged: ReturnType<typeof vi.fn>;
  let fireUserPromptExpansionEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCommandsForMode.mockImplementation((mode: ExecutionMode) =>
      filterCommandsForMode(mockGetCommands(), mode),
    );
    mockGetModelInvocableCommands.mockImplementation(() =>
      mockGetCommands().filter(
        (command: { modelInvocable?: boolean; hidden?: boolean }) =>
          !command.hidden && command.modelInvocable === true,
      ),
    );
    mockCommandServiceCreate.mockResolvedValue({
      getCommands: mockGetCommands,
      getCommandsForMode: mockGetCommandsForMode,
      getModelInvocableCommands: mockGetModelInvocableCommands,
    });
    notifyConfigChanged = vi.fn().mockResolvedValue(undefined);
    fireUserPromptExpansionEvent = vi.fn().mockResolvedValue(undefined);

    mockConfig = {
      getExperimentalZedIntegration: vi.fn().mockReturnValue(false),
      isInteractive: vi.fn().mockReturnValue(false),
      getSessionId: vi.fn().mockReturnValue('test-session'),
      getFolderTrustFeature: vi.fn().mockReturnValue(false),
      getFolderTrust: vi.fn().mockReturnValue(false),
      getProjectRoot: vi.fn().mockReturnValue('/test/project'),
      getDisabledSlashCommands: vi.fn().mockReturnValue([]),
      getDisableAllHooks: vi.fn().mockReturnValue(false),
      hasHooksForEvent: vi.fn().mockReturnValue(false),
      getHookSystem: vi.fn().mockReturnValue({
        fireUserPromptExpansionEvent,
      }),
      setModelInvocableCommandsProvider: vi.fn(),
      setModelInvocableCommandsExecutor: vi.fn(),
      getSkillManager: vi.fn().mockReturnValue({ notifyConfigChanged }),
      storage: {},
    } as unknown as Config;
  });

  it('includes /export in the default non-interactive command list', async () => {
    const exportCommand = {
      name: 'export',
      description: 'Export current session',
      kind: CommandKind.BUILT_IN,
      supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
      action: vi.fn(),
    };
    mockGetCommands.mockReturnValue([exportCommand]);

    const commands = await getAvailableCommands(
      mockConfig,
      new AbortController().signal,
    );

    expect(commands.map((command) => command.name)).toContain('export');
  });

  it('does not partially register model-invocable commands without settings', async () => {
    mockGetCommands.mockReturnValue([
      {
        name: 'expand-prompt',
        description: 'Expand prompt',
        kind: CommandKind.FILE,
        modelInvocable: true,
        supportedModes: ['acp'] as const,
      },
    ]);

    await getAvailableCommands(mockConfig, new AbortController().signal, 'acp');

    expect(mockConfig.setModelInvocableCommandsProvider).not.toHaveBeenCalled();
    expect(mockConfig.setModelInvocableCommandsExecutor).not.toHaveBeenCalled();
    expect(notifyConfigChanged).not.toHaveBeenCalled();
  });

  it('registers model-invocable commands for ACP command snapshots', async () => {
    const promptCommand = {
      name: 'expand-prompt',
      description: 'Fallback description',
      modelDescription: 'Model-facing description',
      kind: CommandKind.FILE,
      modelInvocable: true,
      supportedModes: ['acp'] as const,
      action: vi.fn().mockResolvedValue({
        type: 'submit_prompt',
        content: 'expanded prompt',
      }),
    };
    mockGetCommands.mockReturnValue([promptCommand]);
    vi.mocked(mockConfig.hasHooksForEvent).mockReturnValue(true);
    const expiredSnapshotSignal = new AbortController();
    expiredSnapshotSignal.abort();

    await getAvailableCommands(
      mockConfig,
      expiredSnapshotSignal.signal,
      'acp',
      {
        system: { path: '', settings: {} },
        systemDefaults: { path: '', settings: {} },
        user: { path: '', settings: {} },
        workspace: { path: '', settings: {} },
      } as LoadedSettings,
    );

    const provider = vi.mocked(mockConfig.setModelInvocableCommandsProvider)
      .mock.calls[0]?.[0];
    expect(provider?.()).toEqual([
      {
        name: 'expand-prompt',
        description: 'Model-facing description',
      },
    ]);

    const executor = vi.mocked(mockConfig.setModelInvocableCommandsExecutor)
      .mock.calls[0]?.[0];
    await expect(executor?.('expand-prompt', 'with args')).resolves.toBe(
      'expanded prompt',
    );
    expect(fireUserPromptExpansionEvent).toHaveBeenCalledTimes(1);
    expect(fireUserPromptExpansionEvent.mock.calls[0]?.[3].aborted).toBe(false);
    expect(promptCommand.action).toHaveBeenCalledWith(
      expect.objectContaining({
        executionMode: 'acp',
        invocation: {
          raw: '/expand-prompt with args',
          name: 'expand-prompt',
          args: 'with args',
        },
      }),
      'with args',
    );
    expect(notifyConfigChanged).toHaveBeenCalledTimes(1);
  });
});
