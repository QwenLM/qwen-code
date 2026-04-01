/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import type {
  Config,
  ToolCallConfirmationDetails,
  ToolConfirmationPayload,
  ToolInvocation,
  ToolResult,
  ToolResultDisplay,
  ToolRegistry,
} from '../index.js';
import type { PermissionDecision } from '../permissions/types.js';
import {
  ApprovalMode,
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  ToolConfirmationOutcome,
  DEFAULT_TRUNCATE_TOOL_OUTPUT_LINES,
  DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD,
  SkillTool,
} from '../index.js';
import type { ToolCall, WaitingToolCall } from './coreToolScheduler.js';
import {
  CoreToolScheduler,
  convertToFunctionResponse,
} from './coreToolScheduler.js';
import type { Part, PartListUnion } from '@google/genai';
import {
  MockModifiableTool,
  MockTool,
  MOCK_TOOL_GET_DEFAULT_PERMISSION,
  MOCK_TOOL_GET_CONFIRMATION_DETAILS,
} from '../test-utils/mock-tool.js';
import { MessageBusType } from '../confirmation-bus/types.js';
import type { HookExecutionResponse } from '../confirmation-bus/types.js';
import { type NotificationType } from '../hooks/types.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';

vi.mock('fs/promises', () => ({
  writeFile: vi.fn(),
}));

class TestApprovalTool extends BaseDeclarativeTool<{ id: string }, ToolResult> {
  static readonly Name = 'testApprovalTool';

  constructor(private config: Config) {
    super(
      TestApprovalTool.Name,
      'TestApprovalTool',
      'A tool for testing approval logic',
      Kind.Edit,
      {
        properties: { id: { type: 'string' } },
        required: ['id'],
        type: 'object',
      },
    );
  }

  protected createInvocation(params: {
    id: string;
  }): ToolInvocation<{ id: string }, ToolResult> {
    return new TestApprovalInvocation(this.config, params);
  }
}

class TestApprovalInvocation extends BaseToolInvocation<
  { id: string },
  ToolResult
> {
  constructor(
    private config: Config,
    params: { id: string },
  ) {
    super(params);
  }

  getDescription(): string {
    return `Test tool ${this.params.id}`;
  }

  override async getDefaultPermission(): Promise<PermissionDecision> {
    if (this.config.getApprovalMode() === ApprovalMode.AUTO_EDIT) {
      return 'allow';
    }
    return 'ask';
  }

  override async getConfirmationDetails(): Promise<ToolCallConfirmationDetails> {
    return {
      type: 'edit',
      title: `Confirm Test Tool ${this.params.id}`,
      fileName: `test-${this.params.id}.txt`,
      filePath: `/test-${this.params.id}.txt`,
      fileDiff: 'Test diff content',
      originalContent: '',
      newContent: 'Test content',
      onConfirm: async (outcome: ToolConfirmationOutcome) => {
        if (outcome === ToolConfirmationOutcome.ProceedAlways) {
          this.config.setApprovalMode(ApprovalMode.AUTO_EDIT);
        }
      },
    };
  }

  async execute(): Promise<ToolResult> {
    return {
      llmContent: `Executed test tool ${this.params.id}`,
      returnDisplay: `Executed test tool ${this.params.id}`,
    };
  }
}

class AbortDuringConfirmationInvocation extends BaseToolInvocation<
  Record<string, unknown>,
  ToolResult
> {
  constructor(
    private readonly abortController: AbortController,
    private readonly abortError: Error,
    params: Record<string, unknown>,
  ) {
    super(params);
  }

  override async getDefaultPermission(): Promise<PermissionDecision> {
    return 'ask';
  }

  override async getConfirmationDetails(
    _signal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails> {
    this.abortController.abort();
    throw this.abortError;
  }

  async execute(_abortSignal: AbortSignal): Promise<ToolResult> {
    throw new Error('execute should not be called when confirmation fails');
  }

  getDescription(): string {
    return 'Abort during confirmation invocation';
  }
}

class AbortDuringConfirmationTool extends BaseDeclarativeTool<
  Record<string, unknown>,
  ToolResult
> {
  constructor(
    private readonly abortController: AbortController,
    private readonly abortError: Error,
  ) {
    super(
      'abortDuringConfirmationTool',
      'Abort During Confirmation Tool',
      'A tool that aborts while confirming execution.',
      Kind.Other,
      {
        type: 'object',
        properties: {},
      },
    );
  }

  protected createInvocation(
    params: Record<string, unknown>,
  ): ToolInvocation<Record<string, unknown>, ToolResult> {
    return new AbortDuringConfirmationInvocation(
      this.abortController,
      this.abortError,
      params,
    );
  }
}

async function waitForStatus(
  onToolCallsUpdate: Mock,
  status: 'awaiting_approval' | 'executing' | 'success' | 'error' | 'cancelled',
  timeout = 5000,
): Promise<ToolCall> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const check = () => {
      if (Date.now() - startTime > timeout) {
        const seenStatuses = onToolCallsUpdate.mock.calls
          .flatMap((call) => call[0])
          .map((toolCall: ToolCall) => toolCall.status);
        reject(
          new Error(
            `Timed out waiting for status "${status}". Seen statuses: ${seenStatuses.join(
              ', ',
            )}`,
          ),
        );
        return;
      }

      const foundCall = onToolCallsUpdate.mock.calls
        .flatMap((call) => call[0])
        .find((toolCall: ToolCall) => toolCall.status === status);
      if (foundCall) {
        resolve(foundCall);
      } else {
        setTimeout(check, 10); // Check again in 10ms
      }
    };
    check();
  });
}

describe('CoreToolScheduler', () => {
  it('should cancel a tool call if the signal is aborted before confirmation', async () => {
    const mockTool = new MockTool({
      name: 'mockTool',
      getDefaultPermission: MOCK_TOOL_GET_DEFAULT_PERMISSION,
      getConfirmationDetails: MOCK_TOOL_GET_CONFIRMATION_DETAILS,
    });
    const declarativeTool = mockTool;
    const mockToolRegistry = {
      getTool: () => declarativeTool,
      getFunctionDeclarations: () => [],
      tools: new Map(),
      discovery: {},
      registerTool: () => {},
      getToolByName: () => declarativeTool,
      getToolByDisplayName: () => declarativeTool,
      getTools: () => [],
      discoverTools: async () => {},
      getAllTools: () => [],
      getToolsByServer: () => [],
    } as unknown as ToolRegistry;

    const onAllToolCallsComplete = vi.fn();
    const onToolCallsUpdate = vi.fn();

    const mockConfig = {
      getSessionId: () => 'test-session-id',
      getUsageStatisticsEnabled: () => true,
      getDebugMode: () => false,
      getApprovalMode: () => ApprovalMode.DEFAULT,
      getPermissionsAllow: () => [],
      getContentGeneratorConfig: () => ({
        model: 'test-model',
        authType: 'gemini',
      }),
      getShellExecutionConfig: () => ({
        terminalWidth: 90,
        terminalHeight: 30,
      }),
      storage: {
        getProjectTempDir: () => '/tmp',
      },
      getTruncateToolOutputThreshold: () =>
        DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD,
      getTruncateToolOutputLines: () => DEFAULT_TRUNCATE_TOOL_OUTPUT_LINES,
      getToolRegistry: () => mockToolRegistry,
      getUseModelRouter: () => false,
      getGeminiClient: () => null, // No client needed for these tests
      getChatRecordingService: () => undefined,
      getMessageBus: vi.fn().mockReturnValue(undefined),
      getDisableAllHooks: vi.fn().mockReturnValue(true),
    } as unknown as Config;

    const scheduler = new CoreToolScheduler({
      config: mockConfig,
      onAllToolCallsComplete,
      onToolCallsUpdate,
      getPreferredEditor: () => 'vscode',
      onEditorClose: vi.fn(),
    });

    const abortController = new AbortController();
    const request = {
      callId: '1',
      name: 'mockTool',
      args: {},
      isClientInitiated: false,
      prompt_id: 'prompt-id-1',
    };

    abortController.abort();
    await scheduler.schedule([request], abortController.signal);

    expect(onAllToolCallsComplete).toHaveBeenCalled();
    const completedCalls = onAllToolCallsComplete.mock
      .calls[0][0] as ToolCall[];
    expect(completedCalls[0].status).toBe('cancelled');
  });

  it('should mark tool call as cancelled when abort happens during confirmation error', async () => {
    const abortController = new AbortController();
    const abortError = new Error('Abort requested during confirmation');
    const declarativeTool = new AbortDuringConfirmationTool(
      abortController,
      abortError,
    );

    const mockToolRegistry = {
      getTool: () => declarativeTool,
      getFunctionDeclarations: () => [],
      tools: new Map(),
      discovery: {},
      registerTool: () => {},
      getToolByName: () => declarativeTool,
      getToolByDisplayName: () => declarativeTool,
      getTools: () => [],
      discoverTools: async () => {},
      getAllTools: () => [],
      getToolsByServer: () => [],
    } as unknown as ToolRegistry;

    const onAllToolCallsComplete = vi.fn();
    const onToolCallsUpdate = vi.fn();

    const mockConfig = {
      getSessionId: () => 'test-session-id',
      getUsageStatisticsEnabled: () => true,
      getDebugMode: () => false,
      getApprovalMode: () => ApprovalMode.DEFAULT,
      getPermissionsAllow: () => [],
      getContentGeneratorConfig: () => ({
        model: 'test-model',
        authType: 'gemini',
      }),
      getShellExecutionConfig: () => ({
        terminalWidth: 90,
        terminalHeight: 30,
      }),
      storage: {
        getProjectTempDir: () => '/tmp',
      },
      getTruncateToolOutputThreshold: () =>
        DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD,
      getTruncateToolOutputLines: () => DEFAULT_TRUNCATE_TOOL_OUTPUT_LINES,
      getToolRegistry: () => mockToolRegistry,
      getUseModelRouter: () => false,
      getGeminiClient: () => null,
      getChatRecordingService: () => undefined,
      getMessageBus: vi.fn().mockReturnValue(undefined),
      getDisableAllHooks: vi.fn().mockReturnValue(true),
    } as unknown as Config;

    const scheduler = new CoreToolScheduler({
      config: mockConfig,
      onAllToolCallsComplete,
      onToolCallsUpdate,
      getPreferredEditor: () => 'vscode',
      onEditorClose: vi.fn(),
    });

    const request = {
      callId: 'abort-1',
      name: 'abortDuringConfirmationTool',
      args: {},
      isClientInitiated: false,
      prompt_id: 'prompt-id-abort',
    };

    await scheduler.schedule([request], abortController.signal);

    expect(onAllToolCallsComplete).toHaveBeenCalled();
    const completedCalls = onAllToolCallsComplete.mock
      .calls[0][0] as ToolCall[];
    expect(completedCalls[0].status).toBe('cancelled');
    const statuses = onToolCallsUpdate.mock.calls.flatMap((call) =>
      (call[0] as ToolCall[]).map((toolCall) => toolCall.status),
    );
    expect(statuses).not.toContain('error');
  });

  describe('getToolSuggestion', () => {
    it('should suggest the top N closest tool names for a typo', () => {
      // Create mocked tool registry
      const mockToolRegistry = {
        getAllToolNames: () => ['list_files', 'read_file', 'write_file'],
        getTool: () => undefined, // No SkillTool in this test
      } as unknown as ToolRegistry;
      const mockConfig = {
        getToolRegistry: () => mockToolRegistry,
        getUseModelRouter: () => false,
        getGeminiClient: () => null, // No client needed for these tests
        getPermissionsDeny: () => undefined,
        isInteractive: () => true,
        getMessageBus: vi.fn().mockReturnValue(undefined),
        getDisableAllHooks: vi.fn().mockReturnValue(true),
      } as unknown as Config;

      // Create scheduler
      const scheduler = new CoreToolScheduler({
        config: mockConfig,
        getPreferredEditor: () => 'vscode',
        onEditorClose: vi.fn(),
      });

      // Test that the right tool is selected, with only 1 result, for typos
      // @ts-expect-error accessing private method
      const misspelledTool = scheduler.getToolSuggestion('list_fils', 1);
      expect(misspelledTool).toBe(' Did you mean "list_files"?');

      // Test that the right tool is selected, with only 1 result, for prefixes
      // @ts-expect-error accessing private method
      const prefixedTool = scheduler.getToolSuggestion('github.list_files', 1);
      expect(prefixedTool).toBe(' Did you mean "list_files"?');

      // Test that the right tool is first
      // @ts-expect-error accessing private method
      const suggestionMultiple = scheduler.getToolSuggestion('list_fils');
      expect(suggestionMultiple).toBe(
        ' Did you mean one of: "list_files", "read_file", "write_file"?',
      );
    });

    it('should use Levenshtein suggestions for excluded tools (getToolSuggestion only handles non-excluded)', () => {
      // Create mocked tool registry
      const mockToolRegistry = {
        getAllToolNames: () => ['list_files', 'read_file'],
        getTool: () => undefined, // No SkillTool in this test
      } as unknown as ToolRegistry;

      // Create mocked config with excluded tools
      const mockConfig = {
        getToolRegistry: () => mockToolRegistry,
        getUseModelRouter: () => false,
        getGeminiClient: () => null,
        getPermissionsDeny: () => ['write_file', 'edit', 'run_shell_command'],
        isInteractive: () => false, // Value doesn't matter, but included for completeness
        getMessageBus: vi.fn().mockReturnValue(undefined),
        getDisableAllHooks: vi.fn().mockReturnValue(true),
      } as unknown as Config;

      // Create scheduler
      const scheduler = new CoreToolScheduler({
        config: mockConfig,
        getPreferredEditor: () => 'vscode',
        onEditorClose: vi.fn(),
      });

      // getToolSuggestion no longer handles excluded tools - it only handles truly missing tools
      // So excluded tools will use Levenshtein distance to find similar registered tools
      // @ts-expect-error accessing private method
      const excludedTool = scheduler.getToolSuggestion('write_file');
      expect(excludedTool).toContain('Did you mean');
    });

    it('should use Levenshtein suggestions for non-excluded tools', () => {
      // Create mocked tool registry
      const mockToolRegistry = {
        getAllToolNames: () => ['list_files', 'read_file'],
        getTool: () => undefined, // No SkillTool in this test
      } as unknown as ToolRegistry;

      // Create mocked config with excluded tools
      const mockConfig = {
        getToolRegistry: () => mockToolRegistry,
        getUseModelRouter: () => false,
        getGeminiClient: () => null,
        getPermissionsDeny: () => ['write_file', 'edit'],
        isInteractive: () => false, // Value doesn't matter
        getMessageBus: vi.fn().mockReturnValue(undefined),
        getDisableAllHooks: vi.fn().mockReturnValue(true),
      } as unknown as Config;

      // Create scheduler
      const scheduler = new CoreToolScheduler({
        config: mockConfig,
        getPreferredEditor: () => 'vscode',
        onEditorClose: vi.fn(),
      });

      // Test that non-excluded tool (hallucinated) still uses Levenshtein suggestions
      // @ts-expect-error accessing private method
      const hallucinatedTool = scheduler.getToolSuggestion('list_fils');
      expect(hallucinatedTool).toContain('Did you mean');
      expect(hallucinatedTool).not.toContain(
        'not available in the current environment',
      );
    });

    it('should suggest using Skill tool when unknown tool name matches a skill name', () => {
      // Create a mock that passes instanceof SkillTool check
      const mockSkillTool = Object.create(SkillTool.prototype);
      mockSkillTool.getAvailableSkillNames = () => [
        'pdf',
        'xlsx',
        'frontend-design',
      ];

      // Create mocked tool registry that returns the mock SkillTool
      const mockToolRegistry = {
        getAllToolNames: () => ['skill', 'list_files', 'read_file'],
        getTool: (name: string) =>
          name === 'skill' ? mockSkillTool : undefined,
      } as unknown as ToolRegistry;

      // Create mocked config
      const mockConfig = {
        getToolRegistry: () => mockToolRegistry,
        getUseModelRouter: () => false,
        getGeminiClient: () => null,
        getPermissionsDeny: () => undefined,
        isInteractive: () => true,
        getMessageBus: vi.fn().mockReturnValue(undefined),
        getDisableAllHooks: vi.fn().mockReturnValue(true),
      } as unknown as Config;

      // Create scheduler
      const scheduler = new CoreToolScheduler({
        config: mockConfig,
        getPreferredEditor: () => 'vscode',
        onEditorClose: vi.fn(),
      });

      // Test that when unknown tool name matches a skill name, we get skill-specific message
      // @ts-expect-error accessing private method
      const skillMessage = scheduler.getToolNotFoundMessage('pdf');
      expect(skillMessage).toContain('is a skill name, not a tool name');
      expect(skillMessage).toContain('skill');
      expect(skillMessage).toContain('skill: "pdf"');
      // Should NOT contain the standard "not found in registry" prefix
      expect(skillMessage).not.toContain('not found in registry');

      // Test another skill name
      // @ts-expect-error accessing private method
      const xlsxMessage = scheduler.getToolNotFoundMessage('xlsx');
      expect(xlsxMessage).toContain('is a skill name, not a tool name');
      expect(xlsxMessage).toContain('skill: "xlsx"');

      // Test that non-skill names still use standard message with Levenshtein suggestions
      // @ts-expect-error accessing private method
      const nonSkillMessage = scheduler.getToolNotFoundMessage('list_fils');
      expect(nonSkillMessage).toContain('not found in registry');
      expect(nonSkillMessage).toContain('Did you mean');
      expect(nonSkillMessage).not.toContain('is a skill name');
    });
  });

  describe('excluded tools handling', () => {
    it('should return permission error for excluded tools instead of "not found" message', async () => {
      const onAllToolCallsComplete = vi.fn();
      const onToolCallsUpdate = vi.fn();

      const mockToolRegistry = {
        getTool: () => undefined, // Tool not in registry
        getAllToolNames: () => ['list_files', 'read_file'],
        getFunctionDeclarations: () => [],
        tools: new Map(),
        discovery: {},
        registerTool: () => {},
        getToolByName: () => undefined,
        getToolByDisplayName: () => undefined,
        getTools: () => [],
        discoverTools: async () => {},
        getAllTools: () => [],
        getToolsByServer: () => [],
      } as unknown as ToolRegistry;

      const mockConfig = {
        getSessionId: () => 'test-session-id',
        getUsageStatisticsEnabled: () => true,
        getDebugMode: () => false,
        getApprovalMode: () => ApprovalMode.DEFAULT,
        getPermissionsAllow: () => [],
        getPermissionsDeny: () => ['write_file', 'edit', 'run_shell_command'],
        getContentGeneratorConfig: () => ({
          model: 'test-model',
          authType: 'gemini',
        }),
        getShellExecutionConfig: () => ({
          terminalWidth: 90,
          terminalHeight: 30,
        }),
        storage: {
          getProjectTempDir: () => '/tmp',
        },
        getTruncateToolOutputThreshold: () =>
          DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD,
        getTruncateToolOutputLines: () => DEFAULT_TRUNCATE_TOOL_OUTPUT_LINES,
        getToolRegistry: () => mockToolRegistry,
        getUseModelRouter: () => false,
        getGeminiClient: () => null,
        getChatRecordingService: () => undefined,
        getMessageBus: vi.fn().mockReturnValue(undefined),
        getDisableAllHooks: vi.fn().mockReturnValue(true),
      } as unknown as Config;

      const scheduler = new CoreToolScheduler({
        config: mockConfig,
        onAllToolCallsComplete,
        onToolCallsUpdate,
        getPreferredEditor: () => 'vscode',
        onEditorClose: vi.fn(),
      });

      const abortController = new AbortController();
      const request = {
        callId: '1',
        name: 'write_file', // Excluded tool
        args: {},
        isClientInitiated: false,
        prompt_id: 'prompt-id-excluded',
      };

      await scheduler.schedule([request], abortController.signal);

      // Wait for completion
      await vi.waitFor(() => {
        expect(onAllToolCallsComplete).toHaveBeenCalled();
      });

      const completedCalls = onAllToolCallsComplete.mock
        .calls[0][0] as ToolCall[];
      expect(completedCalls).toHaveLength(1);
      const completedCall = completedCalls[0];
      expect(completedCall.status).toBe('error');

      if (completedCall.status === 'error') {
        const errorMessage = completedCall.response.error?.message;
        expect(errorMessage).toBe(
          'Qwen Code requires permission to use write_file, but that permission was declined.',
        );
        // Should NOT contain "not found in registry"
        expect(errorMessage).not.toContain('not found in registry');
      }
    });

    it('should return "not found" message for truly missing tools (not excluded)', async () => {
      const onAllToolCallsComplete = vi.fn();
      const onToolCallsUpdate = vi.fn();

      const mockToolRegistry = {
        getTool: () => undefined, // Tool not in registry
        getAllToolNames: () => ['list_files', 'read_file'],
        getFunctionDeclarations: () => [],
        tools: new Map(),
        discovery: {},
        registerTool: () => {},
        getToolByName: () => undefined,
        getToolByDisplayName: () => undefined,
        getTools: () => [],
        discoverTools: async () => {},
        getAllTools: () => [],
        getToolsByServer: () => [],
      } as unknown as ToolRegistry;

      const mockConfig = {
        getSessionId: () => 'test-session-id',
        getUsageStatisticsEnabled: () => true,
        getDebugMode: () => false,
        getApprovalMode: () => ApprovalMode.DEFAULT,
        getPermissionsAllow: () => [],
        getPermissionsDeny: () => ['write_file', 'edit'], // Different excluded tools
        getContentGeneratorConfig: () => ({
          model: 'test-model',
          authType: 'gemini',
        }),
        getShellExecutionConfig: () => ({
          terminalWidth: 90,
          terminalHeight: 30,
        }),
        storage: {
          getProjectTempDir: () => '/tmp',
        },
        getTruncateToolOutputThreshold: () =>
          DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD,
        getTruncateToolOutputLines: () => DEFAULT_TRUNCATE_TOOL_OUTPUT_LINES,
        getToolRegistry: () => mockToolRegistry,
        getUseModelRouter: () => false,
        getGeminiClient: () => null,
        getChatRecordingService: () => undefined,
        getMessageBus: vi.fn().mockReturnValue(undefined),
        getDisableAllHooks: vi.fn().mockReturnValue(true),
      } as unknown as Config;

      const scheduler = new CoreToolScheduler({
        config: mockConfig,
        onAllToolCallsComplete,
        onToolCallsUpdate,
        getPreferredEditor: () => 'vscode',
        onEditorClose: vi.fn(),
      });

      const abortController = new AbortController();
      const request = {
        callId: '1',
        name: 'nonexistent_tool', // Not excluded, just doesn't exist
        args: {},
        isClientInitiated: false,
        prompt_id: 'prompt-id-missing',
      };

      await scheduler.schedule([request], abortController.signal);

      // Wait for completion
      await vi.waitFor(() => {
        expect(onAllToolCallsComplete).toHaveBeenCalled();
      });

      const completedCalls = onAllToolCallsComplete.mock
        .calls[0][0] as ToolCall[];
      expect(completedCalls).toHaveLength(1);
      const completedCall = completedCalls[0];
      expect(completedCall.status).toBe('error');

      if (completedCall.status === 'error') {
        const errorMessage = completedCall.response.error?.message;
        // Should contain "not found in registry"
        expect(errorMessage).toContain('not found in registry');
        // Should NOT contain permission message
        expect(errorMessage).not.toContain('requires permission');
      }
    });
  });
});

describe('CoreToolScheduler with payload', () => {
  it('should update args and diff and execute tool when payload is provided', async () => {
    const mockTool = new MockModifiableTool();
    mockTool.executeFn = vi.fn();
    const declarativeTool = mockTool;
    const mockToolRegistry = {
      getTool: () => declarativeTool,
      getFunctionDeclarations: () => [],
      tools: new Map(),
      discovery: {},
      registerTool: () => {},
      getToolByName: () => declarativeTool,
      getToolByDisplayName: () => declarativeTool,
      getTools: () => [],
      discoverTools: async () => {},
      getAllTools: () => [],
      getToolsByServer: () => [],
    } as unknown as ToolRegistry;

    const onAllToolCallsComplete = vi.fn();
    const onToolCallsUpdate = vi.fn();

    const mockConfig = {
      getSessionId: () => 'test-session-id',
      getUsageStatisticsEnabled: () => true,
      getDebugMode: () => false,
      getApprovalMode: () => ApprovalMode.DEFAULT,
      getPermissionsAllow: () => [],
      getContentGeneratorConfig: () => ({
        model: 'test-model',
        authType: 'gemini',
      }),
      getShellExecutionConfig: () => ({
        terminalWidth: 90,
        terminalHeight: 30,
      }),
      storage: {
        getProjectTempDir: () => '/tmp',
      },
      getTruncateToolOutputThreshold: () =>
        DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD,
      getTruncateToolOutputLines: () => DEFAULT_TRUNCATE_TOOL_OUTPUT_LINES,
      getToolRegistry: () => mockToolRegistry,
      getUseModelRouter: () => false,
      getGeminiClient: () => null, // No client needed for these tests
      isInteractive: () => true, // Required to prevent auto-denial of tool calls
      getIdeMode: () => false,
      getExperimentalZedIntegration: () => false,
      getChatRecordingService: () => undefined,
      getMessageBus: vi.fn().mockReturnValue(undefined),
      getDisableAllHooks: vi.fn().mockReturnValue(true),
    } as unknown as Config;

    const scheduler = new CoreToolScheduler({
      config: mockConfig,
      onAllToolCallsComplete,
      onToolCallsUpdate,
      getPreferredEditor: () => 'vscode',
      onEditorClose: vi.fn(),
    });

    const abortController = new AbortController();
    const request = {
      callId: '1',
      name: 'mockModifiableTool',
      args: {},
      isClientInitiated: false,
      prompt_id: 'prompt-id-2',
    };

    await scheduler.schedule([request], abortController.signal);

    const awaitingCall = (await waitForStatus(
      onToolCallsUpdate,
      'awaiting_approval',
    )) as WaitingToolCall;
    const confirmationDetails = awaitingCall.confirmationDetails;

    if (confirmationDetails) {
      const payload: ToolConfirmationPayload = { newContent: 'final version' };
      await confirmationDetails.onConfirm(
        ToolConfirmationOutcome.ProceedOnce,
        payload,
      );
    }

    // Wait for the tool execution to complete
    await vi.waitFor(() => {
      expect(onAllToolCallsComplete).toHaveBeenCalled();
    });

    const completedCalls = onAllToolCallsComplete.mock
      .calls[0][0] as ToolCall[];
    expect(completedCalls[0].status).toBe('success');
    expect(mockTool.executeFn).toHaveBeenCalledWith({
      newContent: 'final version',
    });
  });
});

describe('convertToFunctionResponse', () => {
  const toolName = 'testTool';
  const callId = 'call1';

  it('should handle simple string llmContent', () => {
    const llmContent = 'Simple text output';
    const result = convertToFunctionResponse(toolName, callId, llmContent);
    expect(result).toEqual([
      {
        functionResponse: {
          name: toolName,
          id: callId,
          response: { output: 'Simple text output' },
        },
      },
    ]);
  });

  it('should handle llmContent as a single Part with text', () => {
    const llmContent: Part = { text: 'Text from Part object' };
    const result = convertToFunctionResponse(toolName, callId, llmContent);
    expect(result).toEqual([
      {
        functionResponse: {
          name: toolName,
          id: callId,
          response: { output: 'Text from Part object' },
        },
      },
    ]);
  });

  it('should handle llmContent as a PartListUnion array with a single text Part', () => {
    const llmContent: PartListUnion = [{ text: 'Text from array' }];
    const result = convertToFunctionResponse(toolName, callId, llmContent);
    expect(result).toEqual([
      {
        functionResponse: {
          name: toolName,
          id: callId,
          response: { output: 'Text from array' },
        },
      },
    ]);
  });

  it('should handle llmContent with inlineData', () => {
    const llmContent: Part = {
      inlineData: { mimeType: 'image/png', data: 'base64...' },
    };
    const result = convertToFunctionResponse(toolName, callId, llmContent);
    expect(result).toEqual([
      {
        functionResponse: {
          name: toolName,
          id: callId,
          response: {
            output: '',
          },
          parts: [{ inlineData: { mimeType: 'image/png', data: 'base64...' } }],
        },
      },
    ]);
  });

  it('should handle llmContent with fileData', () => {
    const llmContent: Part = {
      fileData: { mimeType: 'application/pdf', fileUri: 'gs://...' },
    };
    const result = convertToFunctionResponse(toolName, callId, llmContent);
    expect(result).toEqual([
      {
        functionResponse: {
          name: toolName,
          id: callId,
          response: {
            output: '',
          },
          parts: [
            {
              fileData: { mimeType: 'application/pdf', fileUri: 'gs://...' },
            },
          ],
        },
      },
    ]);
  });

  it('should handle llmContent as an array of multiple Parts (text and inlineData)', () => {
    const llmContent: PartListUnion = [
      { text: 'Some textual description' },
      { inlineData: { mimeType: 'image/jpeg', data: 'base64data...' } },
      { text: 'Another text part' },
    ];
    const result = convertToFunctionResponse(toolName, callId, llmContent);
    // All content should be inside the FunctionResponse:
    // - text parts joined into response.output
    // - media parts in response.parts
    expect(result).toEqual([
      {
        functionResponse: {
          name: toolName,
          id: callId,
          response: {
            output: 'Some textual description\nAnother text part',
          },
          parts: [
            { inlineData: { mimeType: 'image/jpeg', data: 'base64data...' } },
          ],
        },
      },
    ]);
  });

  it('should handle llmContent as an array with a single inlineData Part', () => {
    const llmContent: PartListUnion = [
      { inlineData: { mimeType: 'image/gif', data: 'gifdata...' } },
    ];
    const result = convertToFunctionResponse(toolName, callId, llmContent);
    expect(result).toEqual([
      {
        functionResponse: {
          name: toolName,
          id: callId,
          response: {
            output: '',
          },
          parts: [
            { inlineData: { mimeType: 'image/gif', data: 'gifdata...' } },
          ],
        },
      },
    ]);
  });

  it('should handle llmContent as a generic Part (not text, inlineData, or fileData)', () => {
    const llmContent: Part = { functionCall: { name: 'test', args: {} } };
    const result = convertToFunctionResponse(toolName, callId, llmContent);
    expect(result).toEqual([
      {
        functionResponse: {
          name: toolName,
          id: callId,
          response: { output: 'Tool execution succeeded.' },
        },
      },
    ]);
  });

  it('should handle empty string llmContent', () => {
    const llmContent = '';
    const result = convertToFunctionResponse(toolName, callId, llmContent);
    expect(result).toEqual([
      {
        functionResponse: {
          name: toolName,
          id: callId,
          response: { output: '' },
        },
      },
    ]);
  });

  it('should handle llmContent as an empty array', () => {
    const llmContent: PartListUnion = [];
    const result = convertToFunctionResponse(toolName, callId, llmContent);
    expect(result).toEqual([
      {
        functionResponse: {
          name: toolName,
          id: callId,
          response: { output: 'Tool execution succeeded.' },
        },
      },
    ]);
  });

  it('should handle llmContent as a Part with undefined inlineData/fileData/text', () => {
    const llmContent: Part = {}; // An empty part object
    const result = convertToFunctionResponse(toolName, callId, llmContent);
    expect(result).toEqual([
      {
        functionResponse: {
          name: toolName,
          id: callId,
          response: { output: 'Tool execution succeeded.' },
        },
      },
    ]);
  });
});

class MockEditToolInvocation extends BaseToolInvocation<
  Record<string, unknown>,
  ToolResult
> {
  constructor(params: Record<string, unknown>) {
    super(params);
  }

  getDescription(): string {
    return 'A mock edit tool invocation';
  }

  override async getDefaultPermission(): Promise<PermissionDecision> {
    return 'ask';
  }

  override async getConfirmationDetails(
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails> {
    return {
      type: 'edit',
      title: 'Confirm Edit',
      fileName: 'test.txt',
      filePath: 'test.txt',
      fileDiff:
        '--- test.txt\n+++ test.txt\n@@ -1,1 +1,1 @@\n-old content\n+new content',
      originalContent: 'old content',
      newContent: 'new content',
      onConfirm: async () => {},
    };
  }

  async execute(_abortSignal: AbortSignal): Promise<ToolResult> {
    return {
      llmContent: 'Edited successfully',
      returnDisplay: 'Edited successfully',
    };
  }
}

class MockEditTool extends BaseDeclarativeTool<
  Record<string, unknown>,
  ToolResult
> {
  constructor() {
    super('mockEditTool', 'mockEditTool', 'A mock edit tool', Kind.Edit, {});
  }

  protected createInvocation(
    params: Record<string, unknown>,
  ): ToolInvocation<Record<string, unknown>, ToolResult> {
    return new MockEditToolInvocation(params);
  }
}

describe('CoreToolScheduler edit cancellation', () => {
  it('should preserve diff when an edit is cancelled', async () => {
    const mockEditTool = new MockEditTool();
    const mockToolRegistry = {
      getTool: () => mockEditTool,
      getFunctionDeclarations: () => [],
      tools: new Map(),
      discovery: {},
      registerTool: () => {},
      getToolByName: () => mockEditTool,
      getToolByDisplayName: () => mockEditTool,
      getTools: () => [],
      discoverTools: async () => {},
      getAllTools: () => [],
      getToolsByServer: () => [],
    } as unknown as ToolRegistry;

    const onAllToolCallsComplete = vi.fn();
    const onToolCallsUpdate = vi.fn();

    const mockConfig = {
      getSessionId: () => 'test-session-id',
      getUsageStatisticsEnabled: () => true,
      getDebugMode: () => false,
      getApprovalMode: () => ApprovalMode.DEFAULT,
      getPermissionsAllow: () => [],
      getContentGeneratorConfig: () => ({
        model: 'test-model',
        authType: 'gemini',
      }),
      getShellExecutionConfig: () => ({
        terminalWidth: 90,
        terminalHeight: 30,
      }),
      storage: {
        getProjectTempDir: () => '/tmp',
      },
      getToolRegistry: () => mockToolRegistry,
      getUseModelRouter: () => false,
      getGeminiClient: () => null, // No client needed for these tests
      isInteractive: () => true, // Required to prevent auto-denial of tool calls
      getIdeMode: () => false,
      getExperimentalZedIntegration: () => false,
      getChatRecordingService: () => undefined,
      getMessageBus: vi.fn().mockReturnValue(undefined),
      getDisableAllHooks: vi.fn().mockReturnValue(true),
    } as unknown as Config;

    const scheduler = new CoreToolScheduler({
      config: mockConfig,
      onAllToolCallsComplete,
      onToolCallsUpdate,
      getPreferredEditor: () => 'vscode',
      onEditorClose: vi.fn(),
    });

    const abortController = new AbortController();
    const request = {
      callId: '1',
      name: 'mockEditTool',
      args: {},
      isClientInitiated: false,
      prompt_id: 'prompt-id-1',
    };

    await scheduler.schedule([request], abortController.signal);

    const awaitingCall = (await waitForStatus(
      onToolCallsUpdate,
      'awaiting_approval',
    )) as WaitingToolCall;

    // Cancel the edit
    const confirmationDetails = awaitingCall.confirmationDetails;
    if (confirmationDetails) {
      await confirmationDetails.onConfirm(ToolConfirmationOutcome.Cancel);
    }

    expect(onAllToolCallsComplete).toHaveBeenCalled();
    const completedCalls = onAllToolCallsComplete.mock
      .calls[0][0] as ToolCall[];

    expect(completedCalls[0].status).toBe('cancelled');

    // Check that the diff is preserved
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cancelledCall = completedCalls[0] as any;
    expect(cancelledCall.response.resultDisplay).toBeDefined();
    expect(cancelledCall.response.resultDisplay.fileDiff).toBe(
      '--- test.txt\n+++ test.txt\n@@ -1,1 +1,1 @@\n-old content\n+new content',
    );
    expect(cancelledCall.response.resultDisplay.fileName).toBe('test.txt');
  });
});

describe('CoreToolScheduler YOLO mode', () => {
  it('should execute tool requiring confirmation directly without waiting', async () => {
    // Arrange
    const executeFn = vi.fn().mockResolvedValue({
      llmContent: 'Tool executed',
      returnDisplay: 'Tool executed',
    });
    const mockTool = new MockTool({
      name: 'mockTool',
      execute: executeFn,
      getDefaultPermission: MOCK_TOOL_GET_DEFAULT_PERMISSION,
      getConfirmationDetails: MOCK_TOOL_GET_CONFIRMATION_DETAILS,
    });
    const declarativeTool = mockTool;

    const mockToolRegistry = {
      getTool: () => declarativeTool,
      getToolByName: () => declarativeTool,
      // Other properties are not needed for this test but are included for type consistency.
      getFunctionDeclarations: () => [],
      tools: new Map(),
      discovery: {},
      registerTool: () => {},
      getToolByDisplayName: () => declarativeTool,
      getTools: () => [],
      discoverTools: async () => {},
      getAllTools: () => [],
      getToolsByServer: () => [],
    } as unknown as ToolRegistry;

    const onAllToolCallsComplete = vi.fn();
    const onToolCallsUpdate = vi.fn();

    // Configure the scheduler for YOLO mode.
    const mockConfig = {
      getSessionId: () => 'test-session-id',
      getUsageStatisticsEnabled: () => true,
      getDebugMode: () => false,
      getApprovalMode: () => ApprovalMode.YOLO,
      getPermissionsAllow: () => [],
      getContentGeneratorConfig: () => ({
        model: 'test-model',
        authType: 'gemini',
      }),
      getShellExecutionConfig: () => ({
        terminalWidth: 90,
        terminalHeight: 30,
      }),
      storage: {
        getProjectTempDir: () => '/tmp',
      },
      getToolRegistry: () => mockToolRegistry,
      getTruncateToolOutputThreshold: () =>
        DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD,
      getTruncateToolOutputLines: () => DEFAULT_TRUNCATE_TOOL_OUTPUT_LINES,
      getUseModelRouter: () => false,
      getGeminiClient: () => null, // No client needed for these tests
      getChatRecordingService: () => undefined,
      getMessageBus: vi.fn().mockReturnValue(undefined),
      getDisableAllHooks: vi.fn().mockReturnValue(true),
    } as unknown as Config;

    const scheduler = new CoreToolScheduler({
      config: mockConfig,
      onAllToolCallsComplete,
      onToolCallsUpdate,
      getPreferredEditor: () => 'vscode',
      onEditorClose: vi.fn(),
    });

    const abortController = new AbortController();
    const request = {
      callId: '1',
      name: 'mockTool',
      args: { param: 'value' },
      isClientInitiated: false,
      prompt_id: 'prompt-id-yolo',
    };

    // Act
    await scheduler.schedule([request], abortController.signal);

    // Wait for the tool execution to complete
    await vi.waitFor(() => {
      expect(onAllToolCallsComplete).toHaveBeenCalled();
    });

    // Assert
    // 1. The tool's execute method was called directly.
    expect(executeFn).toHaveBeenCalledWith({ param: 'value' });

    // 2. The tool call status never entered 'awaiting_approval'.
    const statusUpdates = onToolCallsUpdate.mock.calls
      .map((call) => (call[0][0] as ToolCall)?.status)
      .filter(Boolean);
    expect(statusUpdates).not.toContain('awaiting_approval');
    expect(statusUpdates).toEqual([
      'validating',
      'scheduled',
      'executing',
      'success',
    ]);

    // 3. The final callback indicates the tool call was successful.
    const completedCalls = onAllToolCallsComplete.mock
      .calls[0][0] as ToolCall[];
    expect(completedCalls).toHaveLength(1);
    const completedCall = completedCalls[0];
    expect(completedCall.status).toBe('success');
    if (completedCall.status === 'success') {
      expect(completedCall.response.resultDisplay).toBe('Tool executed');
    }
  });
});

describe('CoreToolScheduler cancellation during executing with live output', () => {
  it('sets status to cancelled and preserves last output', async () => {
    class StreamingInvocation extends BaseToolInvocation<
      { id: string },
      ToolResult
    > {
      getDescription(): string {
        return `Streaming tool ${this.params.id}`;
      }

      async execute(
        signal: AbortSignal,
        updateOutput?: (output: ToolResultDisplay) => void,
      ): Promise<ToolResult> {
        updateOutput?.('hello');
        // Wait until aborted to emulate a long-running task
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          const onAbort = () => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          };
          signal.addEventListener('abort', onAbort, { once: true });
        });
        // Return a normal (non-error) result; scheduler should still mark cancelled
        return { llmContent: 'done', returnDisplay: 'done' };
      }
    }

    class StreamingTool extends BaseDeclarativeTool<
      { id: string },
      ToolResult
    > {
      constructor() {
        super(
          'stream-tool',
          'Stream Tool',
          'Emits live output and waits for abort',
          Kind.Other,
          {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
          },
          true,
          true,
        );
      }
      protected createInvocation(params: { id: string }) {
        return new StreamingInvocation(params);
      }
    }

    const tool = new StreamingTool();
    const mockToolRegistry = {
      getTool: () => tool,
      getFunctionDeclarations: () => [],
      tools: new Map(),
      discovery: {},
      registerTool: () => {},
      getToolByName: () => tool,
      getToolByDisplayName: () => tool,
      getTools: () => [],
      discoverTools: async () => {},
      getAllTools: () => [],
      getToolsByServer: () => [],
    } as unknown as ToolRegistry;

    const onAllToolCallsComplete = vi.fn();
    const onToolCallsUpdate = vi.fn();

    const mockConfig = {
      getSessionId: () => 'test-session-id',
      getUsageStatisticsEnabled: () => true,
      getDebugMode: () => false,
      getApprovalMode: () => ApprovalMode.DEFAULT,
      getContentGeneratorConfig: () => ({
        model: 'test-model',
        authType: 'gemini',
      }),
      getToolRegistry: () => mockToolRegistry,
      getShellExecutionConfig: () => ({
        terminalWidth: 90,
        terminalHeight: 30,
      }),
      getChatRecordingService: () => undefined,
      getMessageBus: vi.fn().mockReturnValue(undefined),
      getDisableAllHooks: vi.fn().mockReturnValue(true),
    } as unknown as Config;

    const scheduler = new CoreToolScheduler({
      config: mockConfig,
      onAllToolCallsComplete,
      onToolCallsUpdate,
      getPreferredEditor: () => 'vscode',
      onEditorClose: vi.fn(),
    });

    const abortController = new AbortController();
    const request = {
      callId: '1',
      name: 'stream-tool',
      args: { id: 'x' },
      isClientInitiated: true,
      prompt_id: 'prompt-stream',
    };

    const schedulePromise = scheduler.schedule(
      [request],
      abortController.signal,
    );

    // Wait until executing
    await vi.waitFor(() => {
      const calls = onToolCallsUpdate.mock.calls;
      const last = calls[calls.length - 1]?.[0][0] as ToolCall | undefined;
      expect(last?.status).toBe('executing');
    });

    // Now abort
    abortController.abort();

    await schedulePromise;

    await vi.waitFor(() => {
      expect(onAllToolCallsComplete).toHaveBeenCalled();
    });
    const completedCalls = onAllToolCallsComplete.mock
      .calls[0][0] as ToolCall[];
    expect(completedCalls[0].status).toBe('cancelled');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cancelled: any = completedCalls[0];
    expect(cancelled.response.resultDisplay).toBe('hello');
  });
});

describe('CoreToolScheduler request queueing', () => {
  it('should queue a request if another is running', async () => {
    let resolveFirstCall: (result: ToolResult) => void;
    const firstCallPromise = new Promise<ToolResult>((resolve) => {
      resolveFirstCall = resolve;
    });

    const executeFn = vi.fn().mockImplementation(() => firstCallPromise);
    const mockTool = new MockTool({ name: 'mockTool', execute: executeFn });
    const declarativeTool = mockTool;

    const mockToolRegistry = {
      getTool: () => declarativeTool,
      getToolByName: () => declarativeTool,
      getFunctionDeclarations: () => [],
      tools: new Map(),
      discovery: {},
      registerTool: () => {},
      getToolByDisplayName: () => declarativeTool,
      getTools: () => [],
      discoverTools: async () => {},
      getAllTools: () => [],
      getToolsByServer: () => [],
    } as unknown as ToolRegistry;

    const onAllToolCallsComplete = vi.fn();
    const onToolCallsUpdate = vi.fn();

    const mockConfig = {
      getSessionId: () => 'test-session-id',
      getUsageStatisticsEnabled: () => true,
      getDebugMode: () => false,
      getApprovalMode: () => ApprovalMode.YOLO, // Use YOLO to avoid confirmation prompts
      getPermissionsAllow: () => [],
      getContentGeneratorConfig: () => ({
        model: 'test-model',
        authType: 'gemini',
      }),
      getShellExecutionConfig: () => ({
        terminalWidth: 90,
        terminalHeight: 30,
      }),
      storage: {
        getProjectTempDir: () => '/tmp',
      },
      getTruncateToolOutputThreshold: () =>
        DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD,
      getTruncateToolOutputLines: () => DEFAULT_TRUNCATE_TOOL_OUTPUT_LINES,
      getToolRegistry: () => mockToolRegistry,
      getUseModelRouter: () => false,
      getGeminiClient: () => null, // No client needed for these tests
      getChatRecordingService: () => undefined,
      getMessageBus: vi.fn().mockReturnValue(undefined),
      getDisableAllHooks: vi.fn().mockReturnValue(true),
    } as unknown as Config;

    const scheduler = new CoreToolScheduler({
      config: mockConfig,
      onAllToolCallsComplete,
      onToolCallsUpdate,
      getPreferredEditor: () => 'vscode',
      onEditorClose: vi.fn(),
    });

    const abortController = new AbortController();
    const request1 = {
      callId: '1',
      name: 'mockTool',
      args: { a: 1 },
      isClientInitiated: false,
      prompt_id: 'prompt-1',
    };
    const request2 = {
      callId: '2',
      name: 'mockTool',
      args: { b: 2 },
      isClientInitiated: false,
      prompt_id: 'prompt-2',
    };

    // Schedule the first call, which will pause execution.
    scheduler.schedule([request1], abortController.signal);

    // Wait for the first call to be in the 'executing' state.
    await waitForStatus(onToolCallsUpdate, 'executing');

    // Schedule the second call while the first is "running".
    const schedulePromise2 = scheduler.schedule(
      [request2],
      abortController.signal,
    );

    // Ensure the second tool call hasn't been executed yet.
    expect(executeFn).toHaveBeenCalledWith({ a: 1 });

    // Complete the first tool call.
    resolveFirstCall!({
      llmContent: 'First call complete',
      returnDisplay: 'First call complete',
    });

    // Wait for the second schedule promise to resolve.
    await schedulePromise2;

    // Let the second call finish.
    const secondCallResult = {
      llmContent: 'Second call complete',
      returnDisplay: 'Second call complete',
    };
    // Since the mock is shared, we need to resolve the current promise.
    // In a real scenario, a new promise would be created for the second call.
    resolveFirstCall!(secondCallResult);

    await vi.waitFor(() => {
      // Now the second tool call should have been executed.
      expect(executeFn).toHaveBeenCalledTimes(2);
    });
    expect(executeFn).toHaveBeenCalledWith({ b: 2 });

    // Wait for the second completion.
    await vi.waitFor(() => {
      expect(onAllToolCallsComplete).toHaveBeenCalledTimes(2);
    });

    // Verify the completion callbacks were called correctly.
    expect(onAllToolCallsComplete.mock.calls[0][0][0].status).toBe('success');
    expect(onAllToolCallsComplete.mock.calls[1][0][0].status).toBe('success');
  });

  it('should handle two synchronous calls to schedule', async () => {
    const executeFn = vi.fn().mockResolvedValue({
      llmContent: 'Tool executed',
      returnDisplay: 'Tool executed',
    });
    const mockTool = new MockTool({ name: 'mockTool', execute: executeFn });
    const declarativeTool = mockTool;
    const mockToolRegistry = {
      getTool: () => declarativeTool,
      getToolByName: () => declarativeTool,
      getFunctionDeclarations: () => [],
      tools: new Map(),
      discovery: {},
      registerTool: () => {},
      getToolByDisplayName: () => declarativeTool,
      getTools: () => [],
      discoverTools: async () => {},
      getAllTools: () => [],
      getToolsByServer: () => [],
    } as unknown as ToolRegistry;
    const onAllToolCallsComplete = vi.fn();
    const onToolCallsUpdate = vi.fn();

    const mockConfig = {
      getSessionId: () => 'test-session-id',
      getUsageStatisticsEnabled: () => true,
      getDebugMode: () => false,
      getApprovalMode: () => ApprovalMode.YOLO,
      getPermissionsAllow: () => [],
      getContentGeneratorConfig: () => ({
        model: 'test-model',
        authType: 'gemini',
      }),
      getShellExecutionConfig: () => ({
        terminalWidth: 90,
        terminalHeight: 30,
      }),
      storage: {
        getProjectTempDir: () => '/tmp',
      },
      getTruncateToolOutputThreshold: () =>
        DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD,
      getTruncateToolOutputLines: () => DEFAULT_TRUNCATE_TOOL_OUTPUT_LINES,
      getToolRegistry: () => mockToolRegistry,
      getUseModelRouter: () => false,
      getGeminiClient: () => null, // No client needed for these tests
      getChatRecordingService: () => undefined,
      getMessageBus: vi.fn().mockReturnValue(undefined),
      getDisableAllHooks: vi.fn().mockReturnValue(true),
    } as unknown as Config;

    const scheduler = new CoreToolScheduler({
      config: mockConfig,
      onAllToolCallsComplete,
      onToolCallsUpdate,
      getPreferredEditor: () => 'vscode',
      onEditorClose: vi.fn(),
    });

    const abortController = new AbortController();
    const request1 = {
      callId: '1',
      name: 'mockTool',
      args: { a: 1 },
      isClientInitiated: false,
      prompt_id: 'prompt-1',
    };
    const request2 = {
      callId: '2',
      name: 'mockTool',
      args: { b: 2 },
      isClientInitiated: false,
      prompt_id: 'prompt-2',
    };

    // Schedule two calls synchronously.
    const schedulePromise1 = scheduler.schedule(
      [request1],
      abortController.signal,
    );
    const schedulePromise2 = scheduler.schedule(
      [request2],
      abortController.signal,
    );

    // Wait for both promises to resolve.
    await Promise.all([schedulePromise1, schedulePromise2]);

    // Ensure the tool was called twice with the correct arguments.
    expect(executeFn).toHaveBeenCalledTimes(2);
    expect(executeFn).toHaveBeenCalledWith({ a: 1 });
    expect(executeFn).toHaveBeenCalledWith({ b: 2 });

    // Ensure completion callbacks were called twice.
    expect(onAllToolCallsComplete).toHaveBeenCalledTimes(2);
  });

  it('should auto-approve remaining tool calls when first tool call is approved with ProceedAlways', async () => {
    let approvalMode = ApprovalMode.DEFAULT;
    const mockConfig = {
      getSessionId: () => 'test-session-id',
      getUsageStatisticsEnabled: () => true,
      getDebugMode: () => false,
      getApprovalMode: () => approvalMode,
      getPermissionsAllow: () => [],
      setApprovalMode: (mode: ApprovalMode) => {
        approvalMode = mode;
      },
      getShellExecutionConfig: () => ({
        terminalWidth: 90,
        terminalHeight: 30,
      }),
      storage: {
        getProjectTempDir: () => '/tmp',
      },
      getTruncateToolOutputThreshold: () =>
        DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD,
      getTruncateToolOutputLines: () => DEFAULT_TRUNCATE_TOOL_OUTPUT_LINES,
      getUseModelRouter: () => false,
      getGeminiClient: () => null, // No client needed for these tests
      isInteractive: () => true, // Required to prevent auto-denial of tool calls
      getIdeMode: () => false,
      getExperimentalZedIntegration: () => false,
      getChatRecordingService: () => undefined,
      getMessageBus: vi.fn().mockReturnValue(undefined),
      getDisableAllHooks: vi.fn().mockReturnValue(true),
    } as unknown as Config;

    const testTool = new TestApprovalTool(mockConfig);
    const toolRegistry = {
      getTool: () => testTool,
      getFunctionDeclarations: () => [],
      getFunctionDeclarationsFiltered: () => [],
      registerTool: () => {},
      discoverAllTools: async () => {},
      discoverMcpTools: async () => {},
      discoverToolsForServer: async () => {},
      removeMcpToolsByServer: () => {},
      getAllTools: () => [],
      getToolsByServer: () => [],
      tools: new Map(),
      config: mockConfig,
      mcpClientManager: undefined,
      getToolByName: () => testTool,
      getToolByDisplayName: () => testTool,
      getTools: () => [],
      discoverTools: async () => {},
      discovery: {},
    } as unknown as ToolRegistry;

    mockConfig.getToolRegistry = () => toolRegistry;

    const onAllToolCallsComplete = vi.fn();
    const onToolCallsUpdate = vi.fn();
    const pendingConfirmations: Array<
      (
        outcome: ToolConfirmationOutcome,
        payload?: ToolConfirmationPayload,
      ) => Promise<void>
    > = [];

    const scheduler = new CoreToolScheduler({
      config: mockConfig,
      onAllToolCallsComplete,
      onToolCallsUpdate: (toolCalls) => {
        onToolCallsUpdate(toolCalls);
        // Capture confirmation handlers for awaiting_approval tools
        toolCalls.forEach((call) => {
          if (call.status === 'awaiting_approval') {
            const waitingCall = call as WaitingToolCall;
            if (waitingCall.confirmationDetails?.onConfirm) {
              const originalHandler = pendingConfirmations.find(
                (h) => h === waitingCall.confirmationDetails.onConfirm,
              );
              if (!originalHandler) {
                pendingConfirmations.push(
                  waitingCall.confirmationDetails.onConfirm,
                );
              }
            }
          }
        });
      },
      getPreferredEditor: () => 'vscode',
      onEditorClose: vi.fn(),
    });

    const abortController = new AbortController();

    // Schedule multiple tools that need confirmation
    const requests = [
      {
        callId: '1',
        name: 'testApprovalTool',
        args: { id: 'first' },
        isClientInitiated: false,
        prompt_id: 'prompt-1',
      },
      {
        callId: '2',
        name: 'testApprovalTool',
        args: { id: 'second' },
        isClientInitiated: false,
        prompt_id: 'prompt-2',
      },
      {
        callId: '3',
        name: 'testApprovalTool',
        args: { id: 'third' },
        isClientInitiated: false,
        prompt_id: 'prompt-3',
      },
    ];

    await scheduler.schedule(requests, abortController.signal);

    // Wait for all tools to be awaiting approval
    await vi.waitFor(() => {
      const calls = onToolCallsUpdate.mock.calls.at(-1)?.[0] as ToolCall[];
      expect(calls?.length).toBe(3);
      expect(calls?.every((call) => call.status === 'awaiting_approval')).toBe(
        true,
      );
    });

    expect(pendingConfirmations.length).toBe(3);

    // Approve the first tool with ProceedAlways
    const firstConfirmation = pendingConfirmations[0];
    await firstConfirmation(ToolConfirmationOutcome.ProceedAlways);

    // Wait for all tools to be completed
    await vi.waitFor(() => {
      expect(onAllToolCallsComplete).toHaveBeenCalled();
      const completedCalls = onAllToolCallsComplete.mock.calls.at(
        -1,
      )?.[0] as ToolCall[];
      expect(completedCalls?.length).toBe(3);
      expect(completedCalls?.every((call) => call.status === 'success')).toBe(
        true,
      );
    });

    // Verify approval mode was changed
    expect(approvalMode).toBe(ApprovalMode.AUTO_EDIT);
  });
});

describe('CoreToolScheduler truncated output protection', () => {
  function createTruncationTestScheduler(
    tool: TestApprovalTool | MockTool,
    toolNames: string[],
  ) {
    const onAllToolCallsComplete = vi.fn();
    const onToolCallsUpdate = vi.fn();

    const mockToolRegistry = {
      getTool: () => tool,
      getAllToolNames: () => toolNames,
      getFunctionDeclarations: () => [],
      tools: new Map(),
    } as unknown as ToolRegistry;

    const mockConfig = {
      getSessionId: () => 'test-session-id',
      getUsageStatisticsEnabled: () => true,
      getDebugMode: () => false,
      getApprovalMode: () => ApprovalMode.AUTO_EDIT,
      getPermissionsAllow: () => [],
      getPermissionsDeny: () => undefined,
      getContentGeneratorConfig: () => ({
        model: 'test-model',
        authType: 'gemini',
      }),
      getShellExecutionConfig: () => ({
        terminalWidth: 90,
        terminalHeight: 30,
      }),
      storage: {
        getProjectTempDir: () => '/tmp',
      },
      getTruncateToolOutputThreshold: () =>
        DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD,
      getTruncateToolOutputLines: () => DEFAULT_TRUNCATE_TOOL_OUTPUT_LINES,
      getToolRegistry: () => mockToolRegistry,
      getUseModelRouter: () => false,
      getGeminiClient: () => null,
      getChatRecordingService: () => undefined,
      isInteractive: () => true,
      getMessageBus: vi.fn().mockReturnValue(undefined),
      getDisableAllHooks: vi.fn().mockReturnValue(true),
    } as unknown as Config;

    const scheduler = new CoreToolScheduler({
      config: mockConfig,
      onAllToolCallsComplete,
      onToolCallsUpdate,
      getPreferredEditor: () => 'vscode',
      onEditorClose: vi.fn(),
    });

    return { scheduler, onAllToolCallsComplete };
  }

  it('should reject Kind.Edit tool calls when wasOutputTruncated is true', async () => {
    const declarativeTool = new TestApprovalTool({
      getApprovalMode: () => ApprovalMode.AUTO_EDIT,
    } as unknown as Config);
    const { scheduler, onAllToolCallsComplete } = createTruncationTestScheduler(
      declarativeTool,
      [TestApprovalTool.Name],
    );

    await scheduler.schedule(
      [
        {
          callId: '1',
          name: TestApprovalTool.Name,
          args: { id: 'test-truncated' },
          isClientInitiated: false,
          prompt_id: 'prompt-id-truncated',
          wasOutputTruncated: true,
        },
      ],
      new AbortController().signal,
    );

    await vi.waitFor(() => {
      expect(onAllToolCallsComplete).toHaveBeenCalled();
    });

    const completedCalls = onAllToolCallsComplete.mock
      .calls[0][0] as ToolCall[];
    expect(completedCalls).toHaveLength(1);
    const completedCall = completedCalls[0];
    expect(completedCall.status).toBe('error');

    if (completedCall.status === 'error') {
      const errorMessage = completedCall.response.error?.message;
      expect(errorMessage).toContain('truncated due to max_tokens limit');
      expect(errorMessage).toContain(
        'rejected to prevent writing truncated content',
      );
    }
  });

  it('should allow Kind.Edit tool calls when wasOutputTruncated is false', async () => {
    const declarativeTool = new TestApprovalTool({
      getApprovalMode: () => ApprovalMode.AUTO_EDIT,
    } as unknown as Config);
    const { scheduler, onAllToolCallsComplete } = createTruncationTestScheduler(
      declarativeTool,
      [TestApprovalTool.Name],
    );

    await scheduler.schedule(
      [
        {
          callId: '1',
          name: TestApprovalTool.Name,
          args: { id: 'test-normal' },
          isClientInitiated: false,
          prompt_id: 'prompt-id-normal',
          wasOutputTruncated: false,
        },
      ],
      new AbortController().signal,
    );

    await vi.waitFor(() => {
      expect(onAllToolCallsComplete).toHaveBeenCalled();
    });

    const completedCalls = onAllToolCallsComplete.mock
      .calls[0][0] as ToolCall[];
    expect(completedCalls).toHaveLength(1);
    // Should succeed (not error) since wasOutputTruncated is false
    expect(completedCalls[0].status).toBe('success');
  });

  it('should allow non-Edit tools when wasOutputTruncated is true', async () => {
    const mockTool = new MockTool({
      name: 'mockReadTool',
      execute: async () => ({
        llmContent: 'read result',
        returnDisplay: 'read result',
      }),
    });
    const { scheduler, onAllToolCallsComplete } = createTruncationTestScheduler(
      mockTool,
      ['mockReadTool'],
    );

    await scheduler.schedule(
      [
        {
          callId: '1',
          name: 'mockReadTool',
          args: {},
          isClientInitiated: false,
          prompt_id: 'prompt-id-read-truncated',
          wasOutputTruncated: true,
        },
      ],
      new AbortController().signal,
    );

    await vi.waitFor(() => {
      expect(onAllToolCallsComplete).toHaveBeenCalled();
    });

    const completedCalls = onAllToolCallsComplete.mock
      .calls[0][0] as ToolCall[];
    expect(completedCalls).toHaveLength(1);
    // Non-Edit tools should still execute even when output was truncated
    expect(completedCalls[0].status).toBe('success');
  });
});

describe('CoreToolScheduler Sequential Execution', () => {
  it('should execute tool calls in a batch sequentially', async () => {
    // Arrange
    let firstCallFinished = false;
    const executeFn = vi
      .fn()
      .mockImplementation(async (args: { call: number }) => {
        if (args.call === 1) {
          // First call, wait for a bit to simulate work
          await new Promise((resolve) => setTimeout(resolve, 50));
          firstCallFinished = true;
          return { llmContent: 'First call done' };
        }
        if (args.call === 2) {
          // Second call, should only happen after the first is finished
          if (!firstCallFinished) {
            throw new Error(
              'Second tool call started before the first one finished!',
            );
          }
          return { llmContent: 'Second call done' };
        }
        return { llmContent: 'default' };
      });

    const mockTool = new MockTool({ name: 'mockTool', execute: executeFn });
    const declarativeTool = mockTool;

    const mockToolRegistry = {
      getTool: () => declarativeTool,
      getToolByName: () => declarativeTool,
      getFunctionDeclarations: () => [],
      tools: new Map(),
      discovery: {},
      registerTool: () => {},
      getToolByDisplayName: () => declarativeTool,
      getTools: () => [],
      discoverTools: async () => {},
      getAllTools: () => [],
      getToolsByServer: () => [],
    } as unknown as ToolRegistry;

    const onAllToolCallsComplete = vi.fn();
    const onToolCallsUpdate = vi.fn();

    const mockConfig = {
      getSessionId: () => 'test-session-id',
      getUsageStatisticsEnabled: () => true,
      getDebugMode: () => false,
      getApprovalMode: () => ApprovalMode.YOLO, // Use YOLO to avoid confirmation prompts
      getPermissionsAllow: () => [],
      getContentGeneratorConfig: () => ({
        model: 'test-model',
        authType: 'gemini',
      }),
      getShellExecutionConfig: () => ({
        terminalWidth: 90,
        terminalHeight: 30,
      }),
      storage: {
        getProjectTempDir: () => '/tmp',
      },
      getToolRegistry: () => mockToolRegistry,
      getTruncateToolOutputThreshold: () =>
        DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD,
      getTruncateToolOutputLines: () => DEFAULT_TRUNCATE_TOOL_OUTPUT_LINES,
      getUseModelRouter: () => false,
      getGeminiClient: () => null,
      getChatRecordingService: () => undefined,
      getMessageBus: vi.fn().mockReturnValue(undefined),
      getDisableAllHooks: vi.fn().mockReturnValue(true),
    } as unknown as Config;

    const scheduler = new CoreToolScheduler({
      config: mockConfig,
      onAllToolCallsComplete,
      onToolCallsUpdate,
      getPreferredEditor: () => 'vscode',
      onEditorClose: vi.fn(),
    });

    const abortController = new AbortController();
    const requests = [
      {
        callId: '1',
        name: 'mockTool',
        args: { call: 1 },
        isClientInitiated: false,
        prompt_id: 'prompt-1',
      },
      {
        callId: '2',
        name: 'mockTool',
        args: { call: 2 },
        isClientInitiated: false,
        prompt_id: 'prompt-1',
      },
    ];

    // Act
    await scheduler.schedule(requests, abortController.signal);

    // Assert
    await vi.waitFor(() => {
      expect(onAllToolCallsComplete).toHaveBeenCalled();
    });

    // Check that execute was called twice
    expect(executeFn).toHaveBeenCalledTimes(2);

    // Check the order of calls
    const calls = executeFn.mock.calls;
    expect(calls[0][0]).toEqual({ call: 1 });
    expect(calls[1][0]).toEqual({ call: 2 });

    // The onAllToolCallsComplete should be called once with both results
    const completedCalls = onAllToolCallsComplete.mock
      .calls[0][0] as ToolCall[];
    expect(completedCalls).toHaveLength(2);
    expect(completedCalls[0].status).toBe('success');
    expect(completedCalls[1].status).toBe('success');
  });

  it('should cancel subsequent tools when the signal is aborted.', async () => {
    // Arrange
    const abortController = new AbortController();
    let secondCallStarted = false;

    const executeFn = vi
      .fn()
      .mockImplementation(async (args: { call: number }) => {
        if (args.call === 1) {
          return { llmContent: 'First call done' };
        }
        if (args.call === 2) {
          secondCallStarted = true;
          // This call will be cancelled while it's "running".
          await new Promise((resolve) => setTimeout(resolve, 100));
          // It should not return a value because it will be cancelled.
          return { llmContent: 'Second call should not complete' };
        }
        if (args.call === 3) {
          return { llmContent: 'Third call done' };
        }
        return { llmContent: 'default' };
      });

    const mockTool = new MockTool({ name: 'mockTool', execute: executeFn });
    const declarativeTool = mockTool;

    const mockToolRegistry = {
      getTool: () => declarativeTool,
      getToolByName: () => declarativeTool,
      getFunctionDeclarations: () => [],
      tools: new Map(),
      discovery: {},
      registerTool: () => {},
      getToolByDisplayName: () => declarativeTool,
      getTools: () => [],
      discoverTools: async () => {},
      getAllTools: () => [],
      getToolsByServer: () => [],
    } as unknown as ToolRegistry;

    const onAllToolCallsComplete = vi.fn();
    const onToolCallsUpdate = vi.fn();

    const mockConfig = {
      getSessionId: () => 'test-session-id',
      getUsageStatisticsEnabled: () => true,
      getDebugMode: () => false,
      getApprovalMode: () => ApprovalMode.YOLO,
      getPermissionsAllow: () => [],
      getContentGeneratorConfig: () => ({
        model: 'test-model',
        authType: 'gemini',
      }),
      getShellExecutionConfig: () => ({
        terminalWidth: 90,
        terminalHeight: 30,
      }),
      storage: {
        getProjectTempDir: () => '/tmp',
      },
      getToolRegistry: () => mockToolRegistry,
      getTruncateToolOutputThreshold: () =>
        DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD,
      getTruncateToolOutputLines: () => DEFAULT_TRUNCATE_TOOL_OUTPUT_LINES,
      getUseModelRouter: () => false,
      getGeminiClient: () => null,
      getChatRecordingService: () => undefined,
      getMessageBus: vi.fn().mockReturnValue(undefined),
      getDisableAllHooks: vi.fn().mockReturnValue(true),
    } as unknown as Config;

    const scheduler = new CoreToolScheduler({
      config: mockConfig,
      onAllToolCallsComplete,
      onToolCallsUpdate,
      getPreferredEditor: () => 'vscode',
      onEditorClose: vi.fn(),
    });

    const requests = [
      {
        callId: '1',
        name: 'mockTool',
        args: { call: 1 },
        isClientInitiated: false,
        prompt_id: 'prompt-1',
      },
      {
        callId: '2',
        name: 'mockTool',
        args: { call: 2 },
        isClientInitiated: false,
        prompt_id: 'prompt-1',
      },
      {
        callId: '3',
        name: 'mockTool',
        args: { call: 3 },
        isClientInitiated: false,
        prompt_id: 'prompt-1',
      },
    ];

    // Act
    const schedulePromise = scheduler.schedule(
      requests,
      abortController.signal,
    );

    // Wait for the second call to start, then abort.
    await vi.waitFor(() => {
      expect(secondCallStarted).toBe(true);
    });
    abortController.abort();

    await schedulePromise;

    // Assert
    await vi.waitFor(() => {
      expect(onAllToolCallsComplete).toHaveBeenCalled();
    });

    // Check that execute was called for all three tools initially
    expect(executeFn).toHaveBeenCalledTimes(3);
    expect(executeFn).toHaveBeenCalledWith({ call: 1 });
    expect(executeFn).toHaveBeenCalledWith({ call: 2 });
    expect(executeFn).toHaveBeenCalledWith({ call: 3 });

    const completedCalls = onAllToolCallsComplete.mock
      .calls[0][0] as ToolCall[];
    expect(completedCalls).toHaveLength(3);

    const call1 = completedCalls.find((c) => c.request.callId === '1');
    const call2 = completedCalls.find((c) => c.request.callId === '2');
    const call3 = completedCalls.find((c) => c.request.callId === '3');

    expect(call1?.status).toBe('success');
    expect(call2?.status).toBe('cancelled');
    expect(call3?.status).toBe('cancelled');
  });
});

describe('CoreToolScheduler plan mode with ask_user_question', () => {
  function createAskUserQuestionMockTool() {
    let wasAnswered = false;
    let userAnswers: Record<string, string> = {};

    return new MockTool({
      name: 'ask_user_question',
      getDefaultPermission: async () => 'ask',
      getConfirmationDetails: async () => ({
        type: 'ask_user_question' as const,
        title: 'Please answer the following question(s):',
        questions: [
          {
            question: 'Which approach do you prefer?',
            header: 'Approach',
            options: [
              { label: 'Option A', description: 'First approach' },
              { label: 'Option B', description: 'Second approach' },
            ],
            multiSelect: false,
          },
        ],
        onConfirm: async (
          outcome: ToolConfirmationOutcome,
          payload?: ToolConfirmationPayload,
        ) => {
          if (
            outcome === ToolConfirmationOutcome.ProceedOnce ||
            outcome === ToolConfirmationOutcome.ProceedAlways
          ) {
            wasAnswered = true;
            userAnswers = payload?.answers ?? {};
          } else {
            wasAnswered = false;
          }
        },
      }),
      execute: async () => {
        if (!wasAnswered) {
          return {
            llmContent: 'User declined to answer the questions.',
            returnDisplay: 'User declined to answer the questions.',
          };
        }
        const answersContent = Object.entries(userAnswers)
          .map(([key, value]) => `**Question ${key}**: ${value}`)
          .join('\n');
        return {
          llmContent: `User has provided the following answers:\n\n${answersContent}`,
          returnDisplay: `User has provided the following answers:\n\n${answersContent}`,
        };
      },
    });
  }

  function createPlanModeScheduler(
    tool: MockTool,
    onAllToolCallsComplete: ReturnType<typeof vi.fn>,
    onToolCallsUpdate: ReturnType<typeof vi.fn>,
  ) {
    const mockToolRegistry = {
      getTool: () => tool,
      getToolByName: () => tool,
      getFunctionDeclarations: () => [],
      tools: new Map(),
      discovery: {},
      registerTool: () => {},
      getToolByDisplayName: () => tool,
      getTools: () => [],
      discoverTools: async () => {},
      getAllTools: () => [],
      getToolsByServer: () => [],
    } as unknown as ToolRegistry;

    const mockConfig = {
      getSessionId: () => 'test-session-id',
      getUsageStatisticsEnabled: () => true,
      getDebugMode: () => false,
      getApprovalMode: () => ApprovalMode.PLAN,
      getPermissionsAllow: () => [],
      getContentGeneratorConfig: () => ({
        model: 'test-model',
        authType: 'gemini',
      }),
      getShellExecutionConfig: () => ({
        terminalWidth: 90,
        terminalHeight: 30,
      }),
      storage: {
        getProjectTempDir: () => '/tmp',
      },
      getTruncateToolOutputThreshold: () =>
        DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD,
      getTruncateToolOutputLines: () => DEFAULT_TRUNCATE_TOOL_OUTPUT_LINES,
      getToolRegistry: () => mockToolRegistry,
      getUseModelRouter: () => false,
      getGeminiClient: () => null,
      isInteractive: () => true,
      getIdeMode: () => false,
      getExperimentalZedIntegration: () => false,
      getChatRecordingService: () => undefined,
      getMessageBus: vi.fn().mockReturnValue(undefined),
      getDisableAllHooks: vi.fn().mockReturnValue(true),
    } as unknown as Config;

    return new CoreToolScheduler({
      config: mockConfig,
      onAllToolCallsComplete,
      onToolCallsUpdate,
      getPreferredEditor: () => 'vscode',
      onEditorClose: vi.fn(),
    });
  }

  it('should enter awaiting_approval for ask_user_question in plan mode', async () => {
    const mockTool = createAskUserQuestionMockTool();
    const onAllToolCallsComplete = vi.fn();
    const onToolCallsUpdate = vi.fn();
    const scheduler = createPlanModeScheduler(
      mockTool,
      onAllToolCallsComplete,
      onToolCallsUpdate,
    );

    const abortController = new AbortController();
    const request = {
      callId: '1',
      name: 'ask_user_question',
      args: {
        questions: [
          {
            question: 'Which approach?',
            header: 'Approach',
            options: [
              { label: 'A', description: 'First' },
              { label: 'B', description: 'Second' },
            ],
            multiSelect: false,
          },
        ],
      },
      isClientInitiated: false,
      prompt_id: 'prompt-plan-ask',
    };

    await scheduler.schedule([request], abortController.signal);

    // Should enter awaiting_approval, NOT be directly scheduled
    const awaitingCall = await waitForStatus(
      onToolCallsUpdate,
      'awaiting_approval',
    );
    expect(awaitingCall).toBeDefined();
    expect(awaitingCall.status).toBe('awaiting_approval');
  });

  it('should execute successfully when user answers in plan mode', async () => {
    const mockTool = createAskUserQuestionMockTool();
    const onAllToolCallsComplete = vi.fn();
    const onToolCallsUpdate = vi.fn();
    const scheduler = createPlanModeScheduler(
      mockTool,
      onAllToolCallsComplete,
      onToolCallsUpdate,
    );

    const abortController = new AbortController();
    const request = {
      callId: '1',
      name: 'ask_user_question',
      args: {
        questions: [
          {
            question: 'Which approach?',
            header: 'Approach',
            options: [
              { label: 'A', description: 'First' },
              { label: 'B', description: 'Second' },
            ],
            multiSelect: false,
          },
        ],
      },
      isClientInitiated: false,
      prompt_id: 'prompt-plan-ask-answer',
    };

    await scheduler.schedule([request], abortController.signal);

    const awaitingCall = (await waitForStatus(
      onToolCallsUpdate,
      'awaiting_approval',
    )) as WaitingToolCall;

    // Simulate user answering the question
    await awaitingCall.confirmationDetails.onConfirm(
      ToolConfirmationOutcome.ProceedOnce,
      { answers: { '0': 'Option A' } },
    );

    await vi.waitFor(() => {
      expect(onAllToolCallsComplete).toHaveBeenCalled();
    });

    const completedCalls = onAllToolCallsComplete.mock
      .calls[0][0] as ToolCall[];
    expect(completedCalls[0].status).toBe('success');
    if (completedCalls[0].status === 'success') {
      expect(completedCalls[0].response.resultDisplay).toContain(
        'User has provided the following answers',
      );
    }
  });

  it('should block non-ask_user_question tools that need confirmation in plan mode', async () => {
    const editTool = new MockTool({
      name: 'write_file',
      getDefaultPermission: MOCK_TOOL_GET_DEFAULT_PERMISSION,
      getConfirmationDetails: MOCK_TOOL_GET_CONFIRMATION_DETAILS,
    });
    const onAllToolCallsComplete = vi.fn();
    const onToolCallsUpdate = vi.fn();
    const scheduler = createPlanModeScheduler(
      editTool,
      onAllToolCallsComplete,
      onToolCallsUpdate,
    );

    const abortController = new AbortController();
    const request = {
      callId: '1',
      name: 'write_file',
      args: {},
      isClientInitiated: false,
      prompt_id: 'prompt-plan-blocked',
    };

    await scheduler.schedule([request], abortController.signal);

    await vi.waitFor(() => {
      expect(onAllToolCallsComplete).toHaveBeenCalled();
    });

    const completedCalls = onAllToolCallsComplete.mock
      .calls[0][0] as ToolCall[];
    expect(completedCalls[0].status).toBe('error');
    if (completedCalls[0].status === 'error') {
      expect(completedCalls[0].response.resultDisplay).toBe(
        'Plan mode blocked a non-read-only tool call.',
      );
    }
  });

  it('should handle user cancellation of ask_user_question in plan mode', async () => {
    const mockTool = createAskUserQuestionMockTool();
    const onAllToolCallsComplete = vi.fn();
    const onToolCallsUpdate = vi.fn();
    const scheduler = createPlanModeScheduler(
      mockTool,
      onAllToolCallsComplete,
      onToolCallsUpdate,
    );

    const abortController = new AbortController();
    const request = {
      callId: '1',
      name: 'ask_user_question',
      args: {
        questions: [
          {
            question: 'Which approach?',
            header: 'Approach',
            options: [
              { label: 'A', description: 'First' },
              { label: 'B', description: 'Second' },
            ],
            multiSelect: false,
          },
        ],
      },
      isClientInitiated: false,
      prompt_id: 'prompt-plan-ask-cancel',
    };

    await scheduler.schedule([request], abortController.signal);

    const awaitingCall = (await waitForStatus(
      onToolCallsUpdate,
      'awaiting_approval',
    )) as WaitingToolCall;

    // Simulate user cancelling
    await awaitingCall.confirmationDetails.onConfirm(
      ToolConfirmationOutcome.Cancel,
    );

    await vi.waitFor(() => {
      expect(onAllToolCallsComplete).toHaveBeenCalled();
    });

    const completedCalls = onAllToolCallsComplete.mock
      .calls[0][0] as ToolCall[];
    expect(completedCalls[0].status).toBe('cancelled');
  });
});

// Integration tests for the fire* functions
describe('Fire hook functions integration', () => {
  let mockMessageBus: { request: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockMessageBus = {
      request: vi.fn(),
    };
  });

  describe('firePreToolUseHook', () => {
    it('should allow tool execution when hook permits', async () => {
      const { firePreToolUseHook } = await import('./toolHookTriggers.js');

      const mockResponse: HookExecutionResponse = {
        type: MessageBusType.HOOK_EXECUTION_RESPONSE,
        correlationId: 'test-correlation-id',
        success: true,
        output: {
          decision: 'allow',
        },
      };

      mockMessageBus.request.mockResolvedValue(mockResponse);

      const result = await firePreToolUseHook(
        mockMessageBus as unknown as MessageBus,
        'testTool',
        { param: 'value' },
        'toolu_test',
        'full',
      );

      expect(result.shouldProceed).toBe(true);
      expect(mockMessageBus.request).toHaveBeenCalledWith(
        {
          type: MessageBusType.HOOK_EXECUTION_REQUEST,
          eventName: 'PreToolUse',
          input: {
            permission_mode: 'full',
            tool_name: 'testTool',
            tool_input: { param: 'value' },
            tool_use_id: 'toolu_test',
          },
        },
        MessageBusType.HOOK_EXECUTION_RESPONSE,
      );
    });

    it('should block tool execution when hook denies', async () => {
      const { firePreToolUseHook } = await import('./toolHookTriggers.js');

      const mockResponse: HookExecutionResponse = {
        type: MessageBusType.HOOK_EXECUTION_RESPONSE,
        correlationId: 'test-correlation-id',
        success: true,
        output: {
          decision: 'deny',
          reason: 'Not allowed',
        },
      };

      mockMessageBus.request.mockResolvedValue(mockResponse);

      const result = await firePreToolUseHook(
        mockMessageBus as unknown as MessageBus,
        'testTool',
        { param: 'value' },
        'toolu_test',
        'full',
      );

      expect(result.shouldProceed).toBe(false);
      expect(result.blockReason).toBe('Not allowed');
    });

    it('should return shouldProceed: true when no message bus is provided', async () => {
      const { firePreToolUseHook } = await import('./toolHookTriggers.js');

      const result = await firePreToolUseHook(
        undefined,
        'testTool',
        { param: 'value' },
        'toolu_test',
        'full',
      );

      expect(result.shouldProceed).toBe(true);
    });

    it('should return shouldProceed: true when hook request fails', async () => {
      const { firePreToolUseHook } = await import('./toolHookTriggers.js');

      mockMessageBus.request.mockRejectedValue(new Error('Network error'));

      const result = await firePreToolUseHook(
        mockMessageBus as unknown as MessageBus,
        'testTool',
        { param: 'value' },
        'toolu_test',
        'full',
      );

      expect(result.shouldProceed).toBe(true);
    });
  });

  describe('firePostToolUseHook', () => {
    it('should return shouldStop: false when hook permits', async () => {
      const { firePostToolUseHook } = await import('./toolHookTriggers.js');

      const mockResponse: HookExecutionResponse = {
        type: MessageBusType.HOOK_EXECUTION_RESPONSE,
        correlationId: 'test-correlation-id',
        success: true,
        output: {
          permission_decision: 'proceed',
        },
      };

      mockMessageBus.request.mockResolvedValue(mockResponse);

      const result = await firePostToolUseHook(
        mockMessageBus as unknown as MessageBus,
        'testTool',
        { param: 'value' },
        { response: 'result' },
        'toolu_test',
        'full',
      );

      expect(result.shouldStop).toBe(false);
    });

    it('should return shouldStop: true when hook indicates stop', async () => {
      const { firePostToolUseHook } = await import('./toolHookTriggers.js');

      const mockResponse: HookExecutionResponse = {
        type: MessageBusType.HOOK_EXECUTION_RESPONSE,
        correlationId: 'test-correlation-id',
        success: true,
        output: {
          decision: 'allow',
          continue: false,
          stopReason: 'Completed',
        },
      };

      mockMessageBus.request.mockResolvedValue(mockResponse);

      const result = await firePostToolUseHook(
        mockMessageBus as unknown as MessageBus,
        'testTool',
        { param: 'value' },
        { response: 'result' },
        'toolu_test',
        'full',
      );

      expect(result.shouldStop).toBe(true);
      expect(result.stopReason).toBe('Completed');
    });

    it('should return shouldStop: false when no message bus is provided', async () => {
      const { firePostToolUseHook } = await import('./toolHookTriggers.js');

      const result = await firePostToolUseHook(
        undefined,
        'testTool',
        { param: 'value' },
        { response: 'result' },
        'toolu_test',
        'full',
      );

      expect(result.shouldStop).toBe(false);
    });
  });

  describe('firePostToolUseFailureHook', () => {
    it('should return additional context when hook provides it', async () => {
      const { firePostToolUseFailureHook } = await import(
        './toolHookTriggers.js'
      );

      const mockResponse: HookExecutionResponse = {
        type: MessageBusType.HOOK_EXECUTION_RESPONSE,
        correlationId: 'test-correlation-id',
        success: true,
        output: {
          hookSpecificOutput: {
            additionalContext: 'Additional error context',
          },
        },
      };

      mockMessageBus.request.mockResolvedValue(mockResponse);

      const result = await firePostToolUseFailureHook(
        mockMessageBus as unknown as MessageBus,
        'toolu_test',
        'testTool',
        { param: 'value' },
        'Error occurred',
        false,
        'full',
      );

      expect(result.additionalContext).toBe('Additional error context');
    });

    it('should return empty object when no message bus is provided', async () => {
      const { firePostToolUseFailureHook } = await import(
        './toolHookTriggers.js'
      );

      const result = await firePostToolUseFailureHook(
        undefined,
        'toolu_test',
        'testTool',
        { param: 'value' },
        'Error occurred',
        false,
        'full',
      );

      expect(result).toEqual({});
    });
  });

  describe('fireNotificationHook', () => {
    it('should send notification to message bus', async () => {
      const { fireNotificationHook } = await import('./toolHookTriggers.js');

      const mockResponse: HookExecutionResponse = {
        type: MessageBusType.HOOK_EXECUTION_RESPONSE,
        correlationId: 'test-correlation-id',
        success: true,
        output: {
          hookSpecificOutput: {
            additionalContext: 'Notification processed',
          },
        },
      };

      mockMessageBus.request.mockResolvedValue(mockResponse);

      const result = await fireNotificationHook(
        mockMessageBus as unknown as MessageBus,
        'Test message',
        'info' as NotificationType,
        'Test Title',
      );

      expect(result.additionalContext).toBe('Notification processed');
      expect(mockMessageBus.request).toHaveBeenCalledWith(
        {
          type: MessageBusType.HOOK_EXECUTION_REQUEST,
          eventName: 'Notification',
          input: {
            message: 'Test message',
            notification_type: 'info',
            title: 'Test Title',
          },
        },
        MessageBusType.HOOK_EXECUTION_RESPONSE,
      );
    });

    it('should return empty object when no message bus is provided', async () => {
      const { fireNotificationHook } = await import('./toolHookTriggers.js');

      const result = await fireNotificationHook(
        undefined,
        'Test message',
        'info' as NotificationType,
        'Test Title',
      );

      expect(result).toEqual({});
    });
  });

  describe('firePermissionRequestHook', () => {
    it('should return hasDecision: false when hook makes no decision', async () => {
      const { firePermissionRequestHook } = await import(
        './toolHookTriggers.js'
      );

      const mockResponse: HookExecutionResponse = {
        type: MessageBusType.HOOK_EXECUTION_RESPONSE,
        correlationId: 'test-correlation-id',
        success: true,
        output: {
          decision: null,
        },
      };

      mockMessageBus.request.mockResolvedValue(mockResponse);

      const result = await firePermissionRequestHook(
        mockMessageBus as unknown as MessageBus,
        'testTool',
        { param: 'value' },
        'full',
      );

      expect(result.hasDecision).toBe(false);
    });

    it('should return hasDecision: true with allow decision when hook allows', async () => {
      const { firePermissionRequestHook } = await import(
        './toolHookTriggers.js'
      );

      const mockResponse: HookExecutionResponse = {
        type: MessageBusType.HOOK_EXECUTION_RESPONSE,
        correlationId: 'test-correlation-id',
        success: true,
        output: {
          hookSpecificOutput: {
            decision: {
              behavior: 'allow',
              updatedInput: { param: 'modified_value' },
            },
          },
        },
      };

      mockMessageBus.request.mockResolvedValue(mockResponse);

      const result = await firePermissionRequestHook(
        mockMessageBus as unknown as MessageBus,
        'testTool',
        { param: 'value' },
        'full',
      );

      expect(result.hasDecision).toBe(true);
      expect(result.shouldAllow).toBe(true);
      expect(result.updatedInput).toEqual({ param: 'modified_value' });
    });

    it('should return hasDecision: true with deny decision when hook denies', async () => {
      const { firePermissionRequestHook } = await import(
        './toolHookTriggers.js'
      );

      const mockResponse: HookExecutionResponse = {
        type: MessageBusType.HOOK_EXECUTION_RESPONSE,
        correlationId: 'test-correlation-id',
        success: true,
        output: {
          hookSpecificOutput: {
            decision: {
              behavior: 'deny',
              message: 'Access denied',
              interrupt: true,
            },
          },
        },
      };

      mockMessageBus.request.mockResolvedValue(mockResponse);

      const result = await firePermissionRequestHook(
        mockMessageBus as unknown as MessageBus,
        'testTool',
        { param: 'value' },
        'full',
      );

      expect(result.hasDecision).toBe(true);
      expect(result.shouldAllow).toBe(false);
      expect(result.denyMessage).toBe('Access denied');
      expect(result.shouldInterrupt).toBe(true);
    });

    it('should return hasDecision: false when no message bus is provided', async () => {
      const { firePermissionRequestHook } = await import(
        './toolHookTriggers.js'
      );

      const result = await firePermissionRequestHook(
        undefined,
        'testTool',
        { param: 'value' },
        'full',
      );

      expect(result.hasDecision).toBe(false);
    });
  });

  describe('Concurrent agent tool execution', () => {
    function createScheduler(
      tools: Map<string, MockTool>,
      onAllToolCallsComplete: Mock,
      onToolCallsUpdate: Mock,
    ) {
      const mockToolRegistry = {
        getTool: (name: string) => tools.get(name),
        getFunctionDeclarations: () => [],
        tools,
        discovery: {},
        registerTool: () => {},
        getToolByName: (name: string) => tools.get(name),
        getToolByDisplayName: () => undefined,
        getTools: () => [...tools.values()],
        discoverTools: async () => {},
        getAllTools: () => [...tools.values()],
        getToolsByServer: () => [],
      } as unknown as ToolRegistry;

      const mockConfig = {
        getSessionId: () => 'test-session-id',
        getUsageStatisticsEnabled: () => true,
        getDebugMode: () => false,
        getApprovalMode: () => ApprovalMode.AUTO_EDIT,
        getAllowedTools: () => [],
        getContentGeneratorConfig: () => ({
          model: 'test-model',
          authType: 'gemini',
        }),
        getShellExecutionConfig: () => ({
          terminalWidth: 90,
          terminalHeight: 30,
        }),
        storage: {
          getProjectTempDir: () => '/tmp',
        },
        getTruncateToolOutputThreshold: () =>
          DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD,
        getTruncateToolOutputLines: () => DEFAULT_TRUNCATE_TOOL_OUTPUT_LINES,
        getToolRegistry: () => mockToolRegistry,
        getUseModelRouter: () => false,
        getGeminiClient: () => null,
        getChatRecordingService: () => undefined,
        getMessageBus: vi.fn().mockReturnValue(undefined),
        getDisableAllHooks: vi.fn().mockReturnValue(true),
      } as unknown as Config;

      return new CoreToolScheduler({
        config: mockConfig,
        onAllToolCallsComplete,
        onToolCallsUpdate,
        getPreferredEditor: () => 'vscode',
        onEditorClose: vi.fn(),
      });
    }

    it('should execute multiple agent tools concurrently', async () => {
      const executionLog: string[] = [];

      const agentTool = new MockTool({
        name: 'agent',
        execute: async (params) => {
          const id = (params as { id: string }).id;
          executionLog.push(`start:${id}`);
          // Simulate async work — concurrent agents will interleave here
          await new Promise((r) => setTimeout(r, 50));
          executionLog.push(`end:${id}`);
          return {
            llmContent: `Agent ${id} done`,
            returnDisplay: `Agent ${id} done`,
          };
        },
      });

      const tools = new Map([['agent', agentTool]]);
      const onAllToolCallsComplete = vi.fn();
      const onToolCallsUpdate = vi.fn();
      const scheduler = createScheduler(
        tools,
        onAllToolCallsComplete,
        onToolCallsUpdate,
      );

      const abortController = new AbortController();
      const requests = [
        {
          callId: '1',
          name: 'agent',
          args: { id: 'A' },
          isClientInitiated: false,
          prompt_id: 'p1',
        },
        {
          callId: '2',
          name: 'agent',
          args: { id: 'B' },
          isClientInitiated: false,
          prompt_id: 'p1',
        },
        {
          callId: '3',
          name: 'agent',
          args: { id: 'C' },
          isClientInitiated: false,
          prompt_id: 'p1',
        },
      ];

      await scheduler.schedule(requests, abortController.signal);

      // All agents should have completed
      expect(onAllToolCallsComplete).toHaveBeenCalled();
      const completedCalls = onAllToolCallsComplete.mock
        .calls[0][0] as ToolCall[];
      expect(completedCalls).toHaveLength(3);
      expect(completedCalls.every((c) => c.status === 'success')).toBe(true);

      // Verify concurrency: all agents should start before any finishes
      // With sequential execution, the log would be [start:A, end:A, start:B, end:B, ...]
      // With concurrent execution, all starts happen before any end
      const startIndices = executionLog
        .filter((e) => e.startsWith('start:'))
        .map((e) => executionLog.indexOf(e));
      const firstEnd = executionLog.findIndex((e) => e.startsWith('end:'));
      expect(startIndices.every((i) => i < firstEnd)).toBe(true);
    });

    it('should run agent tools concurrently while other tools run sequentially', async () => {
      const executionLog: string[] = [];

      const agentTool = new MockTool({
        name: 'agent',
        execute: async (params) => {
          const id = (params as { id: string }).id;
          executionLog.push(`agent:start:${id}`);
          await new Promise((r) => setTimeout(r, 50));
          executionLog.push(`agent:end:${id}`);
          return {
            llmContent: `Agent ${id} done`,
            returnDisplay: `Agent ${id} done`,
          };
        },
      });

      const readTool = new MockTool({
        name: 'read_file',
        execute: async (params) => {
          const id = (params as { id: string }).id;
          executionLog.push(`read:start:${id}`);
          await new Promise((r) => setTimeout(r, 20));
          executionLog.push(`read:end:${id}`);
          return {
            llmContent: `Read ${id} done`,
            returnDisplay: `Read ${id} done`,
          };
        },
      });

      const tools = new Map<string, MockTool>([
        ['agent', agentTool],
        ['read_file', readTool],
      ]);
      const onAllToolCallsComplete = vi.fn();
      const onToolCallsUpdate = vi.fn();
      const scheduler = createScheduler(
        tools,
        onAllToolCallsComplete,
        onToolCallsUpdate,
      );

      const abortController = new AbortController();
      const requests = [
        {
          callId: '1',
          name: 'read_file',
          args: { id: '1' },
          isClientInitiated: false,
          prompt_id: 'p1',
        },
        {
          callId: '2',
          name: 'agent',
          args: { id: 'A' },
          isClientInitiated: false,
          prompt_id: 'p1',
        },
        {
          callId: '3',
          name: 'read_file',
          args: { id: '2' },
          isClientInitiated: false,
          prompt_id: 'p1',
        },
        {
          callId: '4',
          name: 'agent',
          args: { id: 'B' },
          isClientInitiated: false,
          prompt_id: 'p1',
        },
      ];

      await scheduler.schedule(requests, abortController.signal);

      expect(onAllToolCallsComplete).toHaveBeenCalled();
      const completedCalls = onAllToolCallsComplete.mock
        .calls[0][0] as ToolCall[];
      expect(completedCalls).toHaveLength(4);
      expect(completedCalls.every((c) => c.status === 'success')).toBe(true);

      // Non-agent tools should execute sequentially: read:1 finishes before read:2 starts
      const read1End = executionLog.indexOf('read:end:1');
      const read2Start = executionLog.indexOf('read:start:2');
      expect(read1End).toBeLessThan(read2Start);

      // Agent tools should execute concurrently: both start before either ends
      const agentAStart = executionLog.indexOf('agent:start:A');
      const agentBStart = executionLog.indexOf('agent:start:B');
      const firstAgentEnd = Math.min(
        executionLog.indexOf('agent:end:A'),
        executionLog.indexOf('agent:end:B'),
      );
      expect(agentAStart).toBeLessThan(firstAgentEnd);
      expect(agentBStart).toBeLessThan(firstAgentEnd);
    });
  });
});
