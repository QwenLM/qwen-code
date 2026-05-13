/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import { SpanStatusCode } from '@opentelemetry/api';
import type {
  AnyDeclarativeTool,
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
  ToolErrorType,
} from '../index.js';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SkillTool } from '../tools/skill.js';
import { StructuredToolError } from '../tools/priorReadEnforcement.js';
import { ToolNames } from '../tools/tool-names.js';
import type { ToolCall, WaitingToolCall } from './coreToolScheduler.js';
import {
  CoreToolScheduler,
  convertToFunctionResponse,
  extractToolFilePaths,
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
import { IdeClient } from '../ide/ide-client.js';
import { WriteFileTool } from '../tools/write-file.js';
import { ShellTool, ShellToolInvocation } from '../tools/shell.js';
import type { ShellToolParams } from '../tools/shell.js';
import type { ShellExecutionConfig } from '../services/shellExecutionService.js';

type ToolSpanRecord = {
  name: string;
  attributes: Record<string, string | number | boolean>;
  statusCalls: Array<{ code: number; message?: string }>;
  spanAttributes: Record<string, string | number | boolean>;
  ended: boolean;
};

const toolSpanRecords = vi.hoisted((): ToolSpanRecord[] => []);
const shouldThrowToolSpanSetAttribute = vi.hoisted(() => ({ value: false }));
const shouldThrowToolSpanSetStatus = vi.hoisted(() => ({ value: false }));

vi.mock('../telemetry/tracer.js', () => ({
  safeSetStatus: (
    span: { setStatus: (status: { code: number; message?: string }) => void },
    status: { code: number; message?: string },
  ) => {
    try {
      span.setStatus(status);
    } catch {
      // Match production best-effort telemetry behavior.
    }
  },
  withSpan: vi.fn(
    async (
      name: string,
      attributes: Record<string, string | number | boolean>,
      fn: (span: {
        setStatus: (status: { code: number; message?: string }) => void;
        setAttribute: (key: string, value: string | number | boolean) => void;
        end: () => void;
      }) => Promise<unknown>,
      options?: { autoOkOnSuccess?: boolean },
    ) => {
      const autoOkOnSuccess = options?.autoOkOnSuccess ?? true;
      const record: ToolSpanRecord = {
        name,
        attributes,
        statusCalls: [],
        spanAttributes: {},
        ended: false,
      };
      toolSpanRecords.push(record);
      let statusSet = false;
      const span = {
        setStatus(status: { code: number; message?: string }) {
          statusSet = true;
          if (shouldThrowToolSpanSetStatus.value) {
            throw new Error('setStatus failed');
          }
          record.statusCalls.push(status);
        },
        setAttribute(key: string, value: string | number | boolean) {
          if (shouldThrowToolSpanSetAttribute.value) {
            throw new Error('setAttribute failed');
          }
          record.spanAttributes[key] = value;
        },
        end() {
          record.ended = true;
        },
      };

      try {
        const result = await fn(span);
        if (autoOkOnSuccess && !statusSet) {
          record.statusCalls.push({ code: 1 });
        }
        return result;
      } catch (error) {
        if (!statusSet) {
          record.statusCalls.push({
            code: 2,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        throw error;
      } finally {
        record.ended = true;
      }
    },
  ),
}));

vi.mock('fs/promises', () => ({
  writeFile: vi.fn(),
}));

vi.mock('../ide/ide-client.js', () => ({
  IdeClient: {
    getInstance: vi.fn(),
  },
}));

const mockIdeClient = {
  openDiff: vi.fn(),
  isDiffingEnabled: vi.fn(),
  closeDiff: vi.fn(),
};

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

/**
 * Test fixture: a tool whose getConfirmationDetails always throws a
 * StructuredToolError carrying a configurable ToolErrorType. Used to
 * pin the scheduler's behaviour of propagating error.errorType
 * instead of collapsing every confirmation-time throw into
 * UNHANDLED_EXCEPTION.
 */
class StructuredErrorOnConfirmationInvocation extends BaseToolInvocation<
  Record<string, unknown>,
  ToolResult
> {
  constructor(
    private readonly errorType: ToolErrorType,
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
    throw new StructuredToolError(
      'enforcement-rejected-during-confirmation',
      this.errorType,
    );
  }

  async execute(_abortSignal: AbortSignal): Promise<ToolResult> {
    throw new Error('execute should not run when confirmation rejects');
  }

  getDescription(): string {
    return 'Structured error on confirmation';
  }
}

class StructuredErrorOnConfirmationTool extends BaseDeclarativeTool<
  Record<string, unknown>,
  ToolResult
> {
  constructor(private readonly errorType: ToolErrorType) {
    super(
      'structuredErrorOnConfirmationTool',
      'Structured Error On Confirmation Tool',
      'A tool that throws StructuredToolError from getConfirmationDetails.',
      Kind.Other,
      { type: 'object', properties: {} },
    );
  }

  protected createInvocation(
    params: Record<string, unknown>,
  ): ToolInvocation<Record<string, unknown>, ToolResult> {
    return new StructuredErrorOnConfirmationInvocation(this.errorType, params);
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
      ensureTool: async () => declarativeTool,
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
      ensureTool: async () => declarativeTool,
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

  it('surfaces error.errorType from a confirmation throw instead of UNHANDLED_EXCEPTION', async () => {
    // Without the explicitErrorType extraction in the scheduler's
    // catch block, every getConfirmationDetails throw (including
    // structured prior-read enforcement rejections) would collapse
    // into UNHANDLED_EXCEPTION — losing the new
    // EDIT_REQUIRES_PRIOR_READ / FILE_CHANGED_SINCE_READ /
    // PRIOR_READ_VERIFICATION_FAILED / EDIT_NO_OCCURRENCE_FOUND /
    // ... contracts that StructuredToolError exists to carry. Pin
    // the propagation here.
    const declarativeTool = new StructuredErrorOnConfirmationTool(
      ToolErrorType.EDIT_REQUIRES_PRIOR_READ,
    );

    const mockToolRegistry = {
      getTool: () => declarativeTool,
      ensureTool: async () => declarativeTool,
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
      callId: 'structured-1',
      name: 'structuredErrorOnConfirmationTool',
      args: {},
      isClientInitiated: false,
      prompt_id: 'prompt-id-structured',
    };

    await scheduler.schedule([request], new AbortController().signal);

    expect(onAllToolCallsComplete).toHaveBeenCalled();
    const completedCalls = onAllToolCallsComplete.mock
      .calls[0][0] as ToolCall[];
    expect(completedCalls[0].status).toBe('error');
    const errored = completedCalls[0] as ToolCall & {
      response: { errorType?: ToolErrorType };
    };
    expect(errored.response.errorType).toBe(
      ToolErrorType.EDIT_REQUIRES_PRIOR_READ,
    );
    expect(errored.response.errorType).not.toBe(
      ToolErrorType.UNHANDLED_EXCEPTION,
    );
  });

  describe('getToolSuggestion', () => {
    it('should suggest the top N closest tool names for a typo', () => {
      // Create mocked tool registry
      const mockToolRegistry = {
        getAllToolNames: () => ['list_files', 'read_file', 'write_file'],
        getTool: () => undefined, // No SkillTool in this test
        ensureTool: async () => undefined,
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
        ensureTool: async () => undefined,
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
        ensureTool: async () => undefined,
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

    it('should suggest using Skill tool when unknown tool name matches a skill name', async () => {
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
        ensureTool: async (name: string) =>
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
      const skillMessage = await scheduler.getToolNotFoundMessage('pdf');
      expect(skillMessage).toContain('is a skill name, not a tool name');
      expect(skillMessage).toContain('skill');
      expect(skillMessage).toContain('skill: "pdf"');
      // Should NOT contain the standard "not found in registry" prefix
      expect(skillMessage).not.toContain('not found in registry');

      // Test another skill name
      // @ts-expect-error accessing private method
      const xlsxMessage = await scheduler.getToolNotFoundMessage('xlsx');
      expect(xlsxMessage).toContain('is a skill name, not a tool name');
      expect(xlsxMessage).toContain('skill: "xlsx"');

      // Test that non-skill names still use standard message with Levenshtein suggestions
      const nonSkillMessage =
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (scheduler as any).getToolNotFoundMessage('list_fils');
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
        ensureTool: async () => undefined,
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
        ensureTool: async () => undefined,
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
      ensureTool: async () => declarativeTool,
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
      ensureTool: async () => mockEditTool,
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
      ensureTool: async () => declarativeTool,
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
      ensureTool: async () => tool,
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
      ensureTool: async () => declarativeTool,
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
      ensureTool: async () => declarativeTool,
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
      ensureTool: async () => testTool,
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
    tool: AnyDeclarativeTool,
    toolNames: string[],
  ) {
    const onAllToolCallsComplete = vi.fn();
    const onToolCallsUpdate = vi.fn();

    const mockToolRegistry = {
      getTool: () => tool,
      ensureTool: async () => tool,
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

  it('should prefer truncation rejection over validation errors for truncated write_file calls', async () => {
    const writeFileConfig = {
      getProjectRoot: () => '/tmp',
      getTargetDir: () => '/tmp',
      getFileSystemService: () => ({
        readTextFile: vi.fn(),
        writeTextFile: vi.fn(),
      }),
      getDefaultFileEncoding: () => undefined,
      setApprovalMode: vi.fn(),
    } as unknown as Config;
    const writeFileTool = new WriteFileTool(writeFileConfig);
    const { scheduler, onAllToolCallsComplete } = createTruncationTestScheduler(
      writeFileTool,
      [WriteFileTool.Name],
    );

    await scheduler.schedule(
      [
        {
          callId: '1',
          name: WriteFileTool.Name,
          args: { file_path: '/tmp/test.txt' },
          isClientInitiated: false,
          prompt_id: 'prompt-id-write-file-truncated',
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
      expect(errorMessage).not.toContain(
        "params must have required property 'content'",
      );
    }
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
      ensureTool: async () => declarativeTool,
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
      ensureTool: async () => declarativeTool,
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
      ensureTool: async () => tool,
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

  it('should allow info confirmation tools in plan mode after approval', async () => {
    const onConfirmSpy = vi.fn().mockResolvedValue(undefined);
    const infoTool = new MockTool({
      name: 'web_fetch',
      getDefaultPermission: async () => 'ask',
      getConfirmationDetails: async () => ({
        type: 'info' as const,
        title: 'Confirm Web Fetch',
        prompt: 'Fetch https://example.com/docs',
        urls: ['https://example.com/docs'],
        onConfirm: onConfirmSpy,
      }),
      execute: async () => ({
        llmContent: 'Fetched docs',
        returnDisplay: 'Fetched docs',
      }),
    });
    const onAllToolCallsComplete = vi.fn();
    const onToolCallsUpdate = vi.fn();
    const scheduler = createPlanModeScheduler(
      infoTool,
      onAllToolCallsComplete,
      onToolCallsUpdate,
    );

    const abortController = new AbortController();
    const request = {
      callId: '1',
      name: 'web_fetch',
      args: {
        url: 'https://example.com/docs',
        prompt: 'Summarize the API docs',
      },
      isClientInitiated: false,
      prompt_id: 'prompt-plan-info',
    };

    await scheduler.schedule([request], abortController.signal);

    const awaitingCall = (await waitForStatus(
      onToolCallsUpdate,
      'awaiting_approval',
    )) as WaitingToolCall;

    expect(awaitingCall.confirmationDetails.type).toBe('info');

    await awaitingCall.confirmationDetails.onConfirm(
      ToolConfirmationOutcome.ProceedOnce,
    );

    await vi.waitFor(() => {
      expect(onAllToolCallsComplete).toHaveBeenCalled();
    });

    expect(onConfirmSpy).toHaveBeenCalledWith(
      ToolConfirmationOutcome.ProceedOnce,
      undefined,
    );

    const completedCalls = onAllToolCallsComplete.mock
      .calls[0][0] as ToolCall[];
    expect(completedCalls[0].status).toBe('success');
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

describe('CoreToolScheduler telemetry spans', () => {
  afterEach(() => {
    shouldThrowToolSpanSetAttribute.value = false;
    shouldThrowToolSpanSetStatus.value = false;
  });

  function getLastToolSpan(): ToolSpanRecord {
    const spanRecord = toolSpanRecords.at(-1);
    if (!spanRecord) {
      throw new Error('tool span was not created');
    }
    return spanRecord;
  }

  function buildScheduler(options: {
    execute?: () => Promise<ToolResult>;
    messageBus?: { request: ReturnType<typeof vi.fn> };
    disableHooks?: boolean;
  }): {
    scheduler: CoreToolScheduler;
    onAllToolCallsComplete: ReturnType<typeof vi.fn>;
  } {
    const mockTool = new MockTool({
      name: 'mockTool',
      execute:
        options.execute ??
        vi.fn().mockResolvedValue({
          llmContent: 'ok',
          returnDisplay: 'ok',
        }),
    });
    const mockToolRegistry = {
      getTool: () => mockTool,
      ensureTool: async () => mockTool,
      getFunctionDeclarations: () => [],
      tools: new Map(),
      discovery: {},
      registerTool: () => {},
      getToolByName: () => mockTool,
      getToolByDisplayName: () => mockTool,
      getTools: () => [],
      discoverTools: async () => {},
      getAllTools: () => [],
      getToolsByServer: () => [],
    } as unknown as ToolRegistry;

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
      storage: { getProjectTempDir: () => '/tmp' },
      getTruncateToolOutputThreshold: () =>
        DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD,
      getTruncateToolOutputLines: () => DEFAULT_TRUNCATE_TOOL_OUTPUT_LINES,
      getToolRegistry: () => mockToolRegistry,
      getUseModelRouter: () => false,
      getGeminiClient: () => null,
      getChatRecordingService: () => undefined,
      getMessageBus: vi.fn().mockReturnValue(options.messageBus),
      getDisableAllHooks: vi.fn().mockReturnValue(options.disableHooks ?? true),
    } as unknown as Config;

    const onAllToolCallsComplete = vi.fn();
    const scheduler = new CoreToolScheduler({
      config: mockConfig,
      onAllToolCallsComplete,
      onToolCallsUpdate: vi.fn(),
      getPreferredEditor: () => 'vscode',
      onEditorClose: vi.fn(),
    });
    return { scheduler, onAllToolCallsComplete };
  }

  async function runSingleTool(
    options: {
      execute?: () => Promise<ToolResult>;
      messageBus?: { request: ReturnType<typeof vi.fn> };
      disableHooks?: boolean;
      abortController?: AbortController;
      throwSpanSetAttribute?: boolean;
      throwSpanSetStatus?: boolean;
    } = {},
  ): Promise<{
    spanRecord: ToolSpanRecord;
    completedCalls: ToolCall[];
  }> {
    toolSpanRecords.length = 0;
    shouldThrowToolSpanSetAttribute.value =
      options.throwSpanSetAttribute ?? false;
    shouldThrowToolSpanSetStatus.value = options.throwSpanSetStatus ?? false;
    const { scheduler, onAllToolCallsComplete } = buildScheduler(options);
    const abortController = options.abortController ?? new AbortController();
    await scheduler.schedule(
      [
        {
          callId: 'span-call',
          name: 'mockTool',
          args: { input: '/secret/path' },
          isClientInitiated: false,
          prompt_id: 'prompt-telemetry',
        },
      ],
      abortController.signal,
    );

    return {
      spanRecord: getLastToolSpan(),
      completedCalls: onAllToolCallsComplete.mock.calls.at(
        -1,
      )?.[0] as ToolCall[],
    };
  }

  function expectSanitizedFailure(
    spanRecord: ToolSpanRecord,
    message: string,
    failureKind: string,
  ): void {
    expect(spanRecord.statusCalls).toEqual([
      { code: SpanStatusCode.ERROR, message },
    ]);
    expect(spanRecord.spanAttributes['tool.failure_kind']).toBe(failureKind);
    expect(JSON.stringify(spanRecord.statusCalls)).not.toContain('/secret');
    expect(JSON.stringify(spanRecord.statusCalls)).not.toContain('sensitive');
    expect(spanRecord.ended).toBe(true);
  }

  it('marks pre-hook denial with a sanitized failure kind', async () => {
    const execute = vi.fn().mockResolvedValue({
      llmContent: 'ok',
      returnDisplay: 'ok',
    });
    const messageBus = {
      request: vi.fn().mockResolvedValue({
        type: MessageBusType.HOOK_EXECUTION_RESPONSE,
        correlationId: 'pre-hook',
        success: true,
        output: {
          decision: 'deny',
          reason: 'sensitive /secret/path',
        },
      }),
    };

    const { spanRecord, completedCalls } = await runSingleTool({
      execute,
      messageBus,
      disableHooks: false,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(completedCalls[0].status).toBe('error');
    expectSanitizedFailure(
      spanRecord,
      'Tool execution blocked by hook',
      'pre_hook_blocked',
    );
  });

  it('marks post-hook stop with a sanitized failure kind', async () => {
    const messageBus = {
      request: vi
        .fn()
        .mockResolvedValueOnce({
          type: MessageBusType.HOOK_EXECUTION_RESPONSE,
          correlationId: 'pre-hook',
          success: true,
          output: { decision: 'allow' },
        })
        .mockResolvedValueOnce({
          type: MessageBusType.HOOK_EXECUTION_RESPONSE,
          correlationId: 'post-hook',
          success: true,
          output: {
            decision: 'allow',
            continue: false,
            stopReason: 'sensitive /secret/path',
          },
        }),
    };

    const { spanRecord, completedCalls } = await runSingleTool({
      messageBus,
      disableHooks: false,
    });

    expect(completedCalls[0].status).toBe('error');
    expectSanitizedFailure(
      spanRecord,
      'Tool execution stopped by hook',
      'post_hook_stopped',
    );
  });

  it('marks toolResult.error with a sanitized failure kind', async () => {
    const { spanRecord, completedCalls } = await runSingleTool({
      execute: vi.fn().mockResolvedValue({
        llmContent: 'failed',
        returnDisplay: 'failed',
        error: {
          message: 'sensitive /secret/path',
          type: ToolErrorType.EXECUTION_FAILED,
        },
      }),
    });

    expect(completedCalls[0].status).toBe('error');
    expectSanitizedFailure(spanRecord, 'Tool execution failed', 'tool_error');
  });

  it('sets tool failure status when span attribute recording fails', async () => {
    const { spanRecord, completedCalls } = await runSingleTool({
      throwSpanSetAttribute: true,
      execute: vi.fn().mockResolvedValue({
        llmContent: 'failed',
        returnDisplay: 'failed',
        error: {
          message: 'sensitive /secret/path',
          type: ToolErrorType.EXECUTION_FAILED,
        },
      }),
    });

    expect(completedCalls[0].status).toBe('error');
    expect(spanRecord.statusCalls).toEqual([
      { code: SpanStatusCode.ERROR, message: 'Tool execution failed' },
    ]);
    expect(spanRecord.spanAttributes).not.toHaveProperty('tool.failure_kind');
    expect(spanRecord.ended).toBe(true);
  });

  it('preserves tool failures when span status recording fails', async () => {
    const { spanRecord, completedCalls } = await runSingleTool({
      throwSpanSetStatus: true,
      execute: vi.fn().mockResolvedValue({
        llmContent: 'failed',
        returnDisplay: 'failed',
        error: {
          message: 'sensitive /secret/path',
          type: ToolErrorType.EXECUTION_FAILED,
        },
      }),
    });

    expect(completedCalls[0].status).toBe('error');
    expect(spanRecord.statusCalls).toEqual([]);
    expect(spanRecord.spanAttributes['tool.failure_kind']).toBe('tool_error');
    expect(spanRecord.ended).toBe(true);
  });

  it('preserves original tool errors when the failure hook rejects', async () => {
    const messageBus = {
      request: vi
        .fn()
        .mockResolvedValueOnce({
          type: MessageBusType.HOOK_EXECUTION_RESPONSE,
          correlationId: 'pre-hook',
          success: true,
          output: { decision: 'allow' },
        })
        .mockRejectedValueOnce(new Error('failure hook failed')),
    };
    const { spanRecord, completedCalls } = await runSingleTool({
      messageBus,
      disableHooks: false,
      execute: vi.fn().mockResolvedValue({
        llmContent: 'failed',
        returnDisplay: 'failed',
        error: {
          message: 'original tool error',
          type: ToolErrorType.EXECUTION_FAILED,
        },
      }),
    });

    const completedCall = completedCalls[0];
    expect(completedCall.status).toBe('error');
    if (completedCall.status === 'error') {
      expect(completedCall.response.error?.message).toBe('original tool error');
      expect(completedCall.response.errorType).toBe(
        ToolErrorType.EXECUTION_FAILED,
      );
    }
    expectSanitizedFailure(spanRecord, 'Tool execution failed', 'tool_error');
  });

  it('marks thrown tool exceptions with a sanitized failure kind', async () => {
    const { spanRecord, completedCalls } = await runSingleTool({
      execute: vi.fn().mockRejectedValue(new Error('sensitive /secret/path')),
    });

    expect(completedCalls[0].status).toBe('error');
    expectSanitizedFailure(
      spanRecord,
      'Tool execution failed with exception',
      'tool_exception',
    );
  });

  it('preserves original tool exceptions when the failure hook rejects', async () => {
    const messageBus = {
      request: vi
        .fn()
        .mockResolvedValueOnce({
          type: MessageBusType.HOOK_EXECUTION_RESPONSE,
          correlationId: 'pre-hook',
          success: true,
          output: { decision: 'allow' },
        })
        .mockRejectedValueOnce(new Error('failure hook failed')),
    };
    const { spanRecord, completedCalls } = await runSingleTool({
      messageBus,
      disableHooks: false,
      execute: vi.fn().mockRejectedValue(new Error('original exception')),
    });

    const completedCall = completedCalls[0];
    expect(completedCall.status).toBe('error');
    if (completedCall.status === 'error') {
      expect(completedCall.response.error?.message).toBe('original exception');
      expect(completedCall.response.errorType).toBe(
        ToolErrorType.UNHANDLED_EXCEPTION,
      );
    }
    expectSanitizedFailure(
      spanRecord,
      'Tool execution failed with exception',
      'tool_exception',
    );
  });

  it('leaves cancellation spans with no explicit status (autoOkOnSuccess: false)', async () => {
    const abortController = new AbortController();
    const { spanRecord, completedCalls } = await runSingleTool({
      abortController,
      execute: vi.fn().mockImplementation(async () => {
        abortController.abort();
        return {
          llmContent: 'cancelled',
          returnDisplay: 'cancelled',
        };
      }),
    });

    expect(completedCalls[0].status).toBe('cancelled');
    // autoOkOnSuccess: false prevents withSpan from auto-setting OK;
    // setToolSpanCancelled only sets the failure_kind attribute, not a status.
    expect(spanRecord.statusCalls).toEqual([]);
    expect(spanRecord.spanAttributes['tool.failure_kind']).toBe('cancelled');
    expect(spanRecord.ended).toBe(true);
  });

  it('sets cancellation attribute even when span attribute recording fails', async () => {
    const abortController = new AbortController();
    const { spanRecord, completedCalls } = await runSingleTool({
      abortController,
      throwSpanSetAttribute: true,
      execute: vi.fn().mockImplementation(async () => {
        abortController.abort();
        return {
          llmContent: 'cancelled',
          returnDisplay: 'cancelled',
        };
      }),
    });

    expect(completedCalls[0].status).toBe('cancelled');
    // No status set — autoOkOnSuccess: false, and setToolSpanCancelled
    // only sets the attribute (which fails here, caught internally).
    expect(spanRecord.statusCalls).toEqual([]);
    expect(spanRecord.spanAttributes).not.toHaveProperty('tool.failure_kind');
    expect(spanRecord.ended).toBe(true);
  });

  it('preserves cancellation when span status recording fails', async () => {
    const abortController = new AbortController();
    const { spanRecord, completedCalls } = await runSingleTool({
      abortController,
      throwSpanSetStatus: true,
      execute: vi.fn().mockImplementation(async () => {
        abortController.abort();
        return {
          llmContent: 'cancelled',
          returnDisplay: 'cancelled',
        };
      }),
    });

    expect(completedCalls[0].status).toBe('cancelled');
    // setToolSpanCancelled no longer calls setStatus, so throwSpanSetStatus
    // only affects the safeSetStatus(span, OK) in the success path (not hit).
    // With autoOkOnSuccess: false, withSpan does not attempt setStatus either.
    expect(spanRecord.statusCalls).toEqual([]);
    expect(spanRecord.spanAttributes['tool.failure_kind']).toBe('cancelled');
    expect(spanRecord.ended).toBe(true);
  });

  it('does not crash when safeSetStatus throws on the success path', async () => {
    const { spanRecord, completedCalls } = await runSingleTool({
      throwSpanSetStatus: true,
    });

    expect(completedCalls[0].status).toBe('success');
    expect(spanRecord.statusCalls).toEqual([]);
    expect(spanRecord.spanAttributes).not.toHaveProperty('tool.failure_kind');
    expect(spanRecord.ended).toBe(true);
  });

  it('leaves successful tool calls to be marked OK by withSpan', async () => {
    const { spanRecord, completedCalls } = await runSingleTool();

    expect(completedCalls[0].status).toBe('success');
    expect(spanRecord.statusCalls).toEqual([{ code: SpanStatusCode.OK }]);
    expect(spanRecord.spanAttributes).not.toHaveProperty('tool.failure_kind');
    expect(spanRecord.ended).toBe(true);
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

  describe('Concurrent tool execution', () => {
    // Ensure tests are deterministic regardless of environment.
    const origEnv = process.env['QWEN_CODE_MAX_TOOL_CONCURRENCY'];
    beforeEach(() => {
      delete process.env['QWEN_CODE_MAX_TOOL_CONCURRENCY'];
    });
    afterEach(() => {
      if (origEnv !== undefined) {
        process.env['QWEN_CODE_MAX_TOOL_CONCURRENCY'] = origEnv;
      } else {
        delete process.env['QWEN_CODE_MAX_TOOL_CONCURRENCY'];
      }
    });

    function createScheduler(
      tools: Map<string, MockTool>,
      onAllToolCallsComplete: Mock,
      onToolCallsUpdate: Mock,
    ) {
      const mockToolRegistry = {
        getTool: (name: string) => tools.get(name),
        ensureTool: async (name: string) => tools.get(name),
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

    it('should run concurrency-safe tools in parallel and unsafe tools sequentially', async () => {
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
        kind: Kind.Read,
        execute: async (params) => {
          const id = (params as { id: string }).id;
          executionLog.push(`read:start:${id}`);
          await new Promise((r) => setTimeout(r, 50));
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
      // All 4 calls are concurrency-safe (read_file=Kind.Read, agent=Agent name)
      // so they form one parallel batch and all run concurrently.
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

      // All 4 tools are concurrency-safe → they should all start
      // before any of them finishes (parallel execution).
      const allStarts = [
        executionLog.indexOf('read:start:1'),
        executionLog.indexOf('agent:start:A'),
        executionLog.indexOf('read:start:2'),
        executionLog.indexOf('agent:start:B'),
      ];
      const firstEnd = Math.min(
        executionLog.indexOf('read:end:1'),
        executionLog.indexOf('agent:end:A'),
        executionLog.indexOf('read:end:2'),
        executionLog.indexOf('agent:end:B'),
      );
      // Ensure all entries exist before comparing ordering
      for (const start of allStarts) {
        expect(start).not.toBe(-1);
      }
      expect(firstEnd).not.toBe(-1);
      for (const start of allStarts) {
        expect(start).toBeLessThan(firstEnd);
      }
    });

    it('should partition mixed safe/unsafe tools into correct batches', async () => {
      const executionLog: string[] = [];

      const readTool = new MockTool({
        name: 'read_file',
        kind: Kind.Read,
        execute: async (params) => {
          const id = (params as { id: string }).id;
          executionLog.push(`read:start:${id}`);
          await new Promise((r) => setTimeout(r, 50));
          executionLog.push(`read:end:${id}`);
          return {
            llmContent: `Read ${id} done`,
            returnDisplay: `Read ${id} done`,
          };
        },
      });

      const editTool = new MockTool({
        name: 'edit',
        kind: Kind.Edit,
        execute: async (params) => {
          const id = (params as { id: string }).id;
          executionLog.push(`edit:start:${id}`);
          await new Promise((r) => setTimeout(r, 20));
          executionLog.push(`edit:end:${id}`);
          return {
            llmContent: `Edit ${id} done`,
            returnDisplay: `Edit ${id} done`,
          };
        },
      });

      const tools = new Map<string, MockTool>([
        ['read_file', readTool],
        ['edit', editTool],
      ]);
      const onAllToolCallsComplete = vi.fn();
      const onToolCallsUpdate = vi.fn();
      const scheduler = createScheduler(
        tools,
        onAllToolCallsComplete,
        onToolCallsUpdate,
      );

      // [Read₁, Read₂, Edit, Read₃]
      // Expected batches: [Read₁,Read₂](parallel) → [Edit](seq) → [Read₃](seq)
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
          name: 'read_file',
          args: { id: '2' },
          isClientInitiated: false,
          prompt_id: 'p1',
        },
        {
          callId: '3',
          name: 'edit',
          args: { id: 'E' },
          isClientInitiated: false,
          prompt_id: 'p1',
        },
        {
          callId: '4',
          name: 'read_file',
          args: { id: '3' },
          isClientInitiated: false,
          prompt_id: 'p1',
        },
      ];

      await scheduler.schedule(requests, new AbortController().signal);

      expect(onAllToolCallsComplete).toHaveBeenCalled();
      const completedCalls = onAllToolCallsComplete.mock
        .calls[0][0] as ToolCall[];
      expect(completedCalls).toHaveLength(4);
      expect(completedCalls.every((c) => c.status === 'success')).toBe(true);

      // Batch 1: Read₁ and Read₂ run in parallel (both start before either ends)
      const read1Start = executionLog.indexOf('read:start:1');
      const read2Start = executionLog.indexOf('read:start:2');
      const firstReadEnd = Math.min(
        executionLog.indexOf('read:end:1'),
        executionLog.indexOf('read:end:2'),
      );
      expect(read1Start).not.toBe(-1);
      expect(read2Start).not.toBe(-1);
      expect(firstReadEnd).not.toBe(-1);
      expect(read1Start).toBeLessThan(firstReadEnd);
      expect(read2Start).toBeLessThan(firstReadEnd);

      // Batch 2: Edit starts after both reads complete
      const lastReadEnd = Math.max(
        executionLog.indexOf('read:end:1'),
        executionLog.indexOf('read:end:2'),
      );
      const editStart = executionLog.indexOf('edit:start:E');
      expect(editStart).not.toBe(-1);
      expect(editStart).toBeGreaterThan(lastReadEnd);

      // Batch 3: Read₃ starts after Edit completes
      const editEnd = executionLog.indexOf('edit:end:E');
      const read3Start = executionLog.indexOf('read:start:3');
      expect(editEnd).not.toBe(-1);
      expect(read3Start).not.toBe(-1);
      expect(read3Start).toBeGreaterThan(editEnd);
    });

    it('should run read-only shell commands concurrently and non-read-only sequentially', async () => {
      const executionLog: string[] = [];

      const shellTool = new MockTool({
        name: 'run_shell_command',
        kind: Kind.Execute,
        execute: async (params) => {
          const cmd = (params as { command: string }).command;
          executionLog.push(`shell:start:${cmd}`);
          await new Promise((r) => setTimeout(r, 50));
          executionLog.push(`shell:end:${cmd}`);
          return {
            llmContent: `Shell ${cmd} done`,
            returnDisplay: `Shell ${cmd} done`,
          };
        },
      });

      const tools = new Map<string, MockTool>([
        ['run_shell_command', shellTool],
      ]);
      const onAllToolCallsComplete = vi.fn();
      const onToolCallsUpdate = vi.fn();
      const scheduler = createScheduler(
        tools,
        onAllToolCallsComplete,
        onToolCallsUpdate,
      );

      // "git log" and "ls" are read-only → concurrent
      // "npm install" is not read-only → sequential, breaks the batch
      const requests = [
        {
          callId: '1',
          name: 'run_shell_command',
          args: { command: 'git log' },
          isClientInitiated: false,
          prompt_id: 'p1',
        },
        {
          callId: '2',
          name: 'run_shell_command',
          args: { command: 'ls' },
          isClientInitiated: false,
          prompt_id: 'p1',
        },
        {
          callId: '3',
          name: 'run_shell_command',
          args: { command: 'npm install' },
          isClientInitiated: false,
          prompt_id: 'p1',
        },
      ];

      await scheduler.schedule(requests, new AbortController().signal);

      expect(onAllToolCallsComplete).toHaveBeenCalled();

      // "git log" and "ls" should start concurrently (both before either ends)
      const gitStart = executionLog.indexOf('shell:start:git log');
      const lsStart = executionLog.indexOf('shell:start:ls');
      const firstReadOnlyEnd = Math.min(
        executionLog.indexOf('shell:end:git log'),
        executionLog.indexOf('shell:end:ls'),
      );
      expect(gitStart).not.toBe(-1);
      expect(lsStart).not.toBe(-1);
      expect(firstReadOnlyEnd).not.toBe(-1);
      expect(gitStart).toBeLessThan(firstReadOnlyEnd);
      expect(lsStart).toBeLessThan(firstReadOnlyEnd);

      // "npm install" should start after both read-only commands complete
      const lastReadOnlyEnd = Math.max(
        executionLog.indexOf('shell:end:git log'),
        executionLog.indexOf('shell:end:ls'),
      );
      const npmStart = executionLog.indexOf('shell:start:npm install');
      expect(npmStart).not.toBe(-1);
      expect(npmStart).toBeGreaterThan(lastReadOnlyEnd);
    });
  });
});

describe('CoreToolScheduler IDE interaction', () => {
  function createIdeMockConfig(
    overrides: {
      approvalMode?: ApprovalMode;
      ideMode?: boolean;
    } = {},
  ) {
    const mockModifiableTool = new MockModifiableTool();
    mockModifiableTool.executeFn = vi.fn();

    const mockToolRegistry = {
      getTool: () => mockModifiableTool,
      ensureTool: async () => mockModifiableTool,
      getFunctionDeclarations: () => [],
      tools: new Map(),
      discovery: {},
      registerTool: () => {},
      getToolByName: () => mockModifiableTool,
      getToolByDisplayName: () => mockModifiableTool,
      getTools: () => [],
      discoverTools: async () => {},
      getAllTools: () => [],
      getToolsByServer: () => [],
    } as unknown as ToolRegistry;

    const mockConfig = {
      getSessionId: () => 'test-session-id',
      getUsageStatisticsEnabled: () => true,
      getDebugMode: () => false,
      getApprovalMode: () => overrides.approvalMode ?? ApprovalMode.DEFAULT,
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
      getIdeMode: () => overrides.ideMode ?? true,
      getExperimentalZedIntegration: () => false,
      getChatRecordingService: () => undefined,
      getMessageBus: vi.fn().mockReturnValue(undefined),
      getDisableAllHooks: vi.fn().mockReturnValue(true),
      setApprovalMode: vi.fn(),
    } as unknown as Config;

    return { mockConfig, mockModifiableTool, mockToolRegistry };
  }

  beforeEach(() => {
    vi.mocked(IdeClient.getInstance).mockResolvedValue(
      mockIdeClient as unknown as IdeClient,
    );
    mockIdeClient.isDiffingEnabled.mockReturnValue(true);
    mockIdeClient.openDiff.mockReset();
  });

  it('should safely update args via _applyInlineModify when IDE returns modified content (#2709)', async () => {
    const { mockConfig, mockModifiableTool } = createIdeMockConfig({
      ideMode: true,
    });

    // IDE returns accepted with modified content
    mockIdeClient.openDiff.mockResolvedValue({
      status: 'accepted',
      content: 'IDE-modified content',
    });

    const onAllToolCallsComplete = vi.fn();
    const onToolCallsUpdate = vi.fn();

    const scheduler = new CoreToolScheduler({
      config: mockConfig,
      onAllToolCallsComplete,
      onToolCallsUpdate,
      getPreferredEditor: () => 'vscode',
      onEditorClose: vi.fn(),
    });

    const originalArgs = { param: 'original-value' };
    const request = {
      callId: 'ide-1',
      name: 'mockModifiableTool',
      args: originalArgs,
      isClientInitiated: false,
      prompt_id: 'prompt-ide-1',
    };

    const abortController = new AbortController();
    await scheduler.schedule([request], abortController.signal);

    // Wait for the tool to complete (IDE auto-confirms)
    await vi.waitFor(() => {
      expect(onAllToolCallsComplete).toHaveBeenCalled();
    });

    const completedCalls = onAllToolCallsComplete.mock
      .calls[0][0] as ToolCall[];
    expect(completedCalls[0].status).toBe('success');

    // The tool should have been executed with the IDE-modified content
    // via _applyInlineModify -> createUpdatedParams -> setArgsInternal
    expect(mockModifiableTool.executeFn).toHaveBeenCalledWith({
      newContent: 'IDE-modified content',
    });

    // CRITICAL: The original args object should NOT have been mutated (#2709)
    expect(originalArgs).toEqual({ param: 'original-value' });
    // The request.args (which is what goes into history) should also be safe.
    // structuredClone in buildInvocation ensures the tool gets its own copy.
    expect(request.args).toEqual({ param: 'original-value' });
  });

  it('should NOT call openDiff when AUTO_EDIT mode is active (#2673)', async () => {
    const { mockConfig, mockModifiableTool } = createIdeMockConfig({
      approvalMode: ApprovalMode.AUTO_EDIT,
      ideMode: true,
    });

    mockModifiableTool.shouldConfirm = false; // AUTO_EDIT returns 'allow'

    const onAllToolCallsComplete = vi.fn();
    const onToolCallsUpdate = vi.fn();

    const scheduler = new CoreToolScheduler({
      config: mockConfig,
      onAllToolCallsComplete,
      onToolCallsUpdate,
      getPreferredEditor: () => 'vscode',
      onEditorClose: vi.fn(),
    });

    const request = {
      callId: 'auto-edit-1',
      name: 'mockModifiableTool',
      args: { param: 'value' },
      isClientInitiated: false,
      prompt_id: 'prompt-auto-edit-1',
    };

    const abortController = new AbortController();
    await scheduler.schedule([request], abortController.signal);

    await vi.waitFor(() => {
      expect(onAllToolCallsComplete).toHaveBeenCalled();
    });

    // openDiff should NOT have been called since AUTO_EDIT auto-approves
    expect(mockIdeClient.openDiff).not.toHaveBeenCalled();

    const completedCalls = onAllToolCallsComplete.mock
      .calls[0][0] as ToolCall[];
    expect(completedCalls[0].status).toBe('success');
  });

  it('should execute normally when IDE accepts without modifying content', async () => {
    const { mockConfig, mockModifiableTool } = createIdeMockConfig({
      ideMode: true,
    });

    // IDE returns accepted without content (no modifications)
    mockIdeClient.openDiff.mockResolvedValue({
      status: 'accepted',
      content: undefined,
    });

    const onAllToolCallsComplete = vi.fn();
    const onToolCallsUpdate = vi.fn();

    const scheduler = new CoreToolScheduler({
      config: mockConfig,
      onAllToolCallsComplete,
      onToolCallsUpdate,
      getPreferredEditor: () => 'vscode',
      onEditorClose: vi.fn(),
    });

    const request = {
      callId: 'ide-no-mod-1',
      name: 'mockModifiableTool',
      args: { param: 'keep-this' },
      isClientInitiated: false,
      prompt_id: 'prompt-ide-no-mod-1',
    };

    const abortController = new AbortController();
    await scheduler.schedule([request], abortController.signal);

    await vi.waitFor(() => {
      expect(onAllToolCallsComplete).toHaveBeenCalled();
    });

    const completedCalls = onAllToolCallsComplete.mock
      .calls[0][0] as ToolCall[];
    expect(completedCalls[0].status).toBe('success');

    // Tool should execute with original params (no _applyInlineModify call)
    // executeFn receives the params object from the invocation
    expect(mockModifiableTool.executeFn).toHaveBeenCalled();
  });

  it('should cancel tool when IDE rejects the diff', async () => {
    const { mockConfig } = createIdeMockConfig({
      ideMode: true,
    });

    // IDE rejects the diff
    mockIdeClient.openDiff.mockResolvedValue({
      status: 'rejected',
    });

    const onAllToolCallsComplete = vi.fn();
    const onToolCallsUpdate = vi.fn();

    const scheduler = new CoreToolScheduler({
      config: mockConfig,
      onAllToolCallsComplete,
      onToolCallsUpdate,
      getPreferredEditor: () => 'vscode',
      onEditorClose: vi.fn(),
    });

    const request = {
      callId: 'ide-reject-1',
      name: 'mockModifiableTool',
      args: { param: 'value' },
      isClientInitiated: false,
      prompt_id: 'prompt-ide-reject-1',
    };

    const abortController = new AbortController();
    await scheduler.schedule([request], abortController.signal);

    await vi.waitFor(() => {
      expect(onAllToolCallsComplete).toHaveBeenCalled();
    });

    const completedCalls = onAllToolCallsComplete.mock
      .calls[0][0] as ToolCall[];
    expect(completedCalls[0].status).toBe('cancelled');
  });

  it('should fall back to CLI confirmation when opening the IDE diff fails', async () => {
    const { mockConfig } = createIdeMockConfig({
      ideMode: true,
    });

    mockIdeClient.openDiff.mockRejectedValue(new Error('IDE disconnected'));

    const onAllToolCallsComplete = vi.fn();
    const onToolCallsUpdate = vi.fn();

    const scheduler = new CoreToolScheduler({
      config: mockConfig,
      onAllToolCallsComplete,
      onToolCallsUpdate,
      getPreferredEditor: () => 'vscode',
      onEditorClose: vi.fn(),
    });

    const request = {
      callId: 'ide-open-fail-1',
      name: 'mockModifiableTool',
      args: { param: 'value' },
      isClientInitiated: false,
      prompt_id: 'prompt-ide-open-fail-1',
    };

    const abortController = new AbortController();
    await scheduler.schedule([request], abortController.signal);

    const awaitingCall = (await waitForStatus(
      onToolCallsUpdate,
      'awaiting_approval',
    )) as WaitingToolCall;

    expect(awaitingCall.status).toBe('awaiting_approval');
    expect(mockIdeClient.openDiff).toHaveBeenCalled();
    expect(onAllToolCallsComplete).not.toHaveBeenCalled();
  });

  it('should not swallow confirmation handling errors after IDE diff opens', async () => {
    const { mockConfig } = createIdeMockConfig({
      ideMode: true,
    });

    mockIdeClient.openDiff.mockResolvedValue({
      status: 'rejected',
    });

    const scheduler = new CoreToolScheduler({
      config: mockConfig,
      onAllToolCallsComplete: vi.fn(),
      onToolCallsUpdate: vi.fn(),
      getPreferredEditor: () => 'vscode',
      onEditorClose: vi.fn(),
    });

    const request = {
      callId: 'ide-confirmation-error-1',
      name: 'mockModifiableTool',
      args: { param: 'value' },
      isClientInitiated: false,
      prompt_id: 'prompt-ide-confirmation-error-1',
    };
    const confirmationDetails = {
      type: 'edit',
      title: 'Confirm Mock Tool',
      fileName: 'test.txt',
      filePath: 'test.txt',
      fileDiff: 'diff',
      originalContent: 'originalContent',
      newContent: 'newContent',
      onConfirm: vi.fn(),
    } satisfies ToolCallConfirmationDetails;
    const confirmationError = new Error('confirmation handling failed');

    (
      scheduler as unknown as {
        toolCalls: WaitingToolCall[];
      }
    ).toolCalls = [
      {
        status: 'awaiting_approval',
        request,
        tool: {} as never,
        invocation: {} as never,
        confirmationDetails,
      },
    ];

    vi.spyOn(scheduler, 'handleConfirmationResponse').mockRejectedValue(
      confirmationError,
    );

    await expect(
      (
        scheduler as unknown as {
          openIdeDiffIfEnabled: (
            confirmationDetails: ToolCallConfirmationDetails,
            callId: string,
            signal: AbortSignal,
          ) => Promise<void>;
        }
      ).openIdeDiffIfEnabled(
        confirmationDetails,
        request.callId,
        new AbortController().signal,
      ),
    ).rejects.toThrow('confirmation handling failed');
  });

  it('should not call openDiff when IDE mode is disabled', async () => {
    const { mockConfig } = createIdeMockConfig({
      ideMode: false,
    });

    const onAllToolCallsComplete = vi.fn();
    const onToolCallsUpdate = vi.fn();

    const scheduler = new CoreToolScheduler({
      config: mockConfig,
      onAllToolCallsComplete,
      onToolCallsUpdate,
      getPreferredEditor: () => 'vscode',
      onEditorClose: vi.fn(),
    });

    const request = {
      callId: 'no-ide-1',
      name: 'mockModifiableTool',
      args: { param: 'value' },
      isClientInitiated: false,
      prompt_id: 'prompt-no-ide-1',
    };

    const abortController = new AbortController();
    await scheduler.schedule([request], abortController.signal);

    // Tool should be awaiting approval but openDiff was never called
    await waitForStatus(onToolCallsUpdate, 'awaiting_approval');
    expect(mockIdeClient.openDiff).not.toHaveBeenCalled();
  });
});

describe('CoreToolScheduler validation retry loop detection', () => {
  const RETRY_LOOP_STOP_DIRECTIVE = 'RETRY LOOP DETECTED';

  /** Tool with a schema that requires a string `value` param. */
  class StrictStringTool extends BaseDeclarativeTool<
    { value: string },
    ToolResult
  > {
    static readonly Name = 'strictStringTool';

    constructor() {
      super(
        StrictStringTool.Name,
        'StrictStringTool',
        'A tool that requires a string value param.',
        Kind.Other,
        {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
      );
    }

    protected createInvocation(params: {
      value: string;
    }): ToolInvocation<{ value: string }, ToolResult> {
      return new (class extends BaseToolInvocation<
        { value: string },
        ToolResult
      > {
        constructor(p: { value: string }) {
          super(p);
        }
        getDescription(): string {
          return 'strictStringTool invocation';
        }
        async execute(): Promise<ToolResult> {
          return { llmContent: 'ok', returnDisplay: 'ok' };
        }
      })(params);
    }
  }

  function createSchedulerWithTool(tool: StrictStringTool) {
    const mockToolRegistry = {
      ensureTool: async (name: string) =>
        name === StrictStringTool.Name ? tool : undefined,
      getTool: (name: string) =>
        name === StrictStringTool.Name ? tool : undefined,
      getFunctionDeclarations: () => [],
      tools: new Map(),
      discovery: {},
      registerTool: () => {},
      getToolByName: (name: string) =>
        name === StrictStringTool.Name ? tool : undefined,
      getToolByDisplayName: (name: string) =>
        name === 'StrictStringTool' ? tool : undefined,
      getTools: () => [],
      discoverTools: async () => {},
      getAllTools: () => [],
      getAllToolNames: () => [StrictStringTool.Name],
      getToolsByServer: () => [],
    } as unknown as ToolRegistry;

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
      storage: { getProjectTempDir: () => '/tmp' },
      getTruncateToolOutputThreshold: () => 100,
      getTruncateToolOutputLines: () => 10,
      getToolRegistry: () => mockToolRegistry,
      getUseModelRouter: () => false,
      getGeminiClient: () => null,
      isInteractive: () => true,
      getIdeMode: () => false,
      getExperimentalZedIntegration: () => false,
      getChatRecordingService: () => undefined,
      getMessageBus: vi.fn().mockReturnValue(undefined),
      getDisableAllHooks: vi.fn().mockReturnValue(true),
      setApprovalMode: vi.fn(),
    } as unknown as Config;

    const onAllToolCallsComplete = vi.fn();
    const onToolCallsUpdate = vi.fn();

    const scheduler = new CoreToolScheduler({
      config: mockConfig,
      onAllToolCallsComplete,
      onToolCallsUpdate,
      getPreferredEditor: () => 'vscode',
      onEditorClose: vi.fn(),
    });

    return { scheduler, onToolCallsUpdate, onAllToolCallsComplete };
  }

  function makeRequest(
    callId: string,
    name: string,
    args: Record<string, unknown>,
  ) {
    return {
      callId,
      name,
      args,
      isClientInitiated: false,
      prompt_id: `prompt-${callId}`,
    };
  }

  function getLastErrorMessage(onToolCallsUpdate: Mock): string | undefined {
    const calls = onToolCallsUpdate.mock.calls;
    for (let i = calls.length - 1; i >= 0; i--) {
      const toolCalls = calls[i][0] as ToolCall[];
      for (const call of toolCalls) {
        if (call.status === 'error' && call.response?.responseParts) {
          for (const part of call.response.responseParts) {
            if ('functionResponse' in part) {
              const resp = part.functionResponse as {
                response?: { error?: string };
              };
              if (resp.response?.error) return resp.response.error;
            }
          }
        }
      }
    }
    return undefined;
  }

  it('should inject RETRY LOOP DETECTED directive after 3 consecutive validation failures', async () => {
    const tool = new StrictStringTool();
    const { scheduler, onToolCallsUpdate } = createSchedulerWithTool(tool);

    // Turn 1: bad params (value is number, not string)
    await scheduler.schedule(
      [makeRequest('c1', 'strictStringTool', { value: 123 })],
      new AbortController().signal,
    );
    let msg = getLastErrorMessage(onToolCallsUpdate);
    expect(msg).toBeDefined();
    expect(msg).not.toContain(RETRY_LOOP_STOP_DIRECTIVE);

    // Turn 2: same bad params
    await scheduler.schedule(
      [makeRequest('c2', 'strictStringTool', { value: 123 })],
      new AbortController().signal,
    );
    msg = getLastErrorMessage(onToolCallsUpdate);
    expect(msg).not.toContain(RETRY_LOOP_STOP_DIRECTIVE);

    // Turn 3: same bad params — should trigger directive
    await scheduler.schedule(
      [makeRequest('c3', 'strictStringTool', { value: 123 })],
      new AbortController().signal,
    );
    msg = getLastErrorMessage(onToolCallsUpdate);
    expect(msg).toContain(RETRY_LOOP_STOP_DIRECTIVE);
  });

  it('should reset retry counter when a different tool is called', async () => {
    const tool = new StrictStringTool();
    const { scheduler, onToolCallsUpdate } = createSchedulerWithTool(tool);

    // Turn 1-2: tool fails twice
    await scheduler.schedule(
      [makeRequest('c1', 'strictStringTool', { value: 123 })],
      new AbortController().signal,
    );
    await scheduler.schedule(
      [makeRequest('c2', 'strictStringTool', { value: 123 })],
      new AbortController().signal,
    );

    // Turn 3: switch to a different tool that also fails
    // We simulate by calling with a tool name that won't be found
    await scheduler.schedule(
      [makeRequest('c3', 'nonexistentTool', {})],
      new AbortController().signal,
    );

    // Turn 4: back to tool — should be count 1 again (no directive)
    await scheduler.schedule(
      [makeRequest('c4', 'strictStringTool', { value: 123 })],
      new AbortController().signal,
    );
    const msg = getLastErrorMessage(onToolCallsUpdate);
    expect(msg).toBeDefined();
    expect(msg).not.toContain(RETRY_LOOP_STOP_DIRECTIVE);
  });

  it('should reset retry counter after a successful invocation of the same tool', async () => {
    const tool = new StrictStringTool();
    const { scheduler, onToolCallsUpdate } = createSchedulerWithTool(tool);

    // Two validation failures with the same error.
    await scheduler.schedule(
      [makeRequest('c1', 'strictStringTool', { value: 123 })],
      new AbortController().signal,
    );
    await scheduler.schedule(
      [makeRequest('c2', 'strictStringTool', { value: 123 })],
      new AbortController().signal,
    );

    // A valid invocation succeeds, which must clear the per-tool counter.
    await scheduler.schedule(
      [makeRequest('c3', 'strictStringTool', { value: 'ok' })],
      new AbortController().signal,
    );

    // Two more failures — count should restart at 1, not jump to 3+.
    await scheduler.schedule(
      [makeRequest('c4', 'strictStringTool', { value: 123 })],
      new AbortController().signal,
    );
    await scheduler.schedule(
      [makeRequest('c5', 'strictStringTool', { value: 123 })],
      new AbortController().signal,
    );

    const msg = getLastErrorMessage(onToolCallsUpdate);
    expect(msg).toBeDefined();
    expect(msg).not.toContain(RETRY_LOOP_STOP_DIRECTIVE);
  });

  it('should isolate retry counters per-tool across batches', async () => {
    // Regression: the batch-level continues-loop check used to keep *all*
    // retry state whenever any current request matched a previously failing
    // tool. That let stale counts for an unrelated tool survive long enough
    // to fire RETRY LOOP DETECTED prematurely the next time that tool was
    // called. The correct behaviour prunes counters per-tool: keep only
    // counters whose tool name actually appears in the current batch.
    class StrictToolAlt extends BaseDeclarativeTool<
      { other: string },
      ToolResult
    > {
      static readonly Name = 'strictStringToolAlt';
      constructor() {
        super(
          StrictToolAlt.Name,
          'StrictStringToolAlt',
          'Alt tool requiring string other param.',
          Kind.Other,
          {
            type: 'object',
            properties: { other: { type: 'string' } },
            required: ['other'],
          },
        );
      }
      protected createInvocation(params: {
        other: string;
      }): ToolInvocation<{ other: string }, ToolResult> {
        return new (class extends BaseToolInvocation<
          { other: string },
          ToolResult
        > {
          constructor(p: { other: string }) {
            super(p);
          }
          getDescription() {
            return 'strictStringToolAlt invocation';
          }
          async execute(): Promise<ToolResult> {
            return { llmContent: 'ok', returnDisplay: 'ok' };
          }
        })(params);
      }
    }

    const toolA = new StrictStringTool();
    const toolB = new StrictToolAlt();
    const mockToolRegistry = {
      ensureTool: async (name: string) =>
        name === StrictStringTool.Name
          ? toolA
          : name === StrictToolAlt.Name
            ? toolB
            : undefined,
      getTool: (name: string) =>
        name === StrictStringTool.Name
          ? toolA
          : name === StrictToolAlt.Name
            ? toolB
            : undefined,
      getFunctionDeclarations: () => [],
      tools: new Map(),
      discovery: {},
      registerTool: () => {},
      getToolByName: (name: string) =>
        name === StrictStringTool.Name
          ? toolA
          : name === StrictToolAlt.Name
            ? toolB
            : undefined,
      getToolByDisplayName: () => undefined,
      getTools: () => [],
      discoverTools: async () => {},
      getAllTools: () => [],
      getAllToolNames: () => [StrictStringTool.Name, StrictToolAlt.Name],
      getToolsByServer: () => [],
    } as unknown as ToolRegistry;

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
      storage: { getProjectTempDir: () => '/tmp' },
      getTruncateToolOutputThreshold: () => 100,
      getTruncateToolOutputLines: () => 10,
      getToolRegistry: () => mockToolRegistry,
      getUseModelRouter: () => false,
      getGeminiClient: () => null,
      isInteractive: () => true,
      getIdeMode: () => false,
      getExperimentalZedIntegration: () => false,
      getChatRecordingService: () => undefined,
      getMessageBus: vi.fn().mockReturnValue(undefined),
      getDisableAllHooks: vi.fn().mockReturnValue(true),
      setApprovalMode: vi.fn(),
    } as unknown as Config;

    const onToolCallsUpdate = vi.fn();
    const scheduler = new CoreToolScheduler({
      config: mockConfig,
      onAllToolCallsComplete: vi.fn(),
      onToolCallsUpdate,
      getPreferredEditor: () => 'vscode',
      onEditorClose: vi.fn(),
    });

    // Tool A fails twice, accumulating a retry count of 2.
    await scheduler.schedule(
      [makeRequest('a1', StrictStringTool.Name, { value: 123 })],
      new AbortController().signal,
    );
    await scheduler.schedule(
      [makeRequest('a2', StrictStringTool.Name, { value: 123 })],
      new AbortController().signal,
    );

    // Now a batch for tool B only — tool A's counter must be pruned because
    // A is not present in this batch.
    await scheduler.schedule(
      [makeRequest('b1', StrictToolAlt.Name, { other: 456 })],
      new AbortController().signal,
    );

    // Tool A fails once more. Under the old wholesale-keep behaviour this
    // would be the third consecutive A failure and would trip the directive.
    // Under per-tool pruning the counter starts fresh at 1 and no directive
    // should be emitted.
    await scheduler.schedule(
      [makeRequest('a3', StrictStringTool.Name, { value: 123 })],
      new AbortController().signal,
    );
    const msg = getLastErrorMessage(onToolCallsUpdate);
    expect(msg).toBeDefined();
    expect(msg).not.toContain(RETRY_LOOP_STOP_DIRECTIVE);
  });
});

describe('extractToolFilePaths', () => {
  // 'read_file' is the canonical FS tool name and is on the allowlist;
  // most cases below use it so the field-extraction logic itself runs.
  const FS_TOOL = 'read_file';

  it('returns empty for non-object inputs', () => {
    expect(extractToolFilePaths(FS_TOOL, undefined)).toEqual([]);
    expect(extractToolFilePaths(FS_TOOL, null)).toEqual([]);
    expect(extractToolFilePaths(FS_TOOL, 'string')).toEqual([]);
    expect(extractToolFilePaths(FS_TOOL, 42)).toEqual([]);
  });

  it('extracts file_path (read-file / edit / write-file convention)', () => {
    expect(extractToolFilePaths(FS_TOOL, { file_path: '/proj/a.ts' })).toEqual([
      '/proj/a.ts',
    ]);
  });

  it('extracts filePath for lsp (camelCase convention)', () => {
    expect(extractToolFilePaths('lsp', { filePath: '/proj/b.ts' })).toEqual([
      '/proj/b.ts',
    ]);
  });

  it('extracts path for list_directory', () => {
    expect(
      extractToolFilePaths('list_directory', { path: '/proj/dir' }),
    ).toEqual(['/proj/dir']);
  });

  it('drops empty / non-string file_path on read_file', () => {
    expect(extractToolFilePaths(FS_TOOL, { file_path: '' })).toEqual([]);
    expect(extractToolFilePaths(FS_TOOL, { file_path: undefined })).toEqual([]);
    expect(extractToolFilePaths(FS_TOOL, { file_path: 42 })).toEqual([]);
  });

  it('ignores file_path with the wrong shape on read_file', () => {
    expect(
      extractToolFilePaths(FS_TOOL, { file_path: { not: 'a string' } }),
    ).toEqual([]);
  });

  it('ignores irrelevant fields on the wrong tool', () => {
    // Realistic per-tool dispatch: read_file does not look at `path`,
    // `filePath`, or `paths`; grep_search does not look at `filePath`
    // or `paths`. The previous generic extractor accepted everything for
    // every FS tool — overly permissive given that the field names mean
    // different things across tools.
    expect(
      extractToolFilePaths(FS_TOOL, {
        file_path: '/correct',
        path: '/wrong-for-read',
        filePath: '/wrong-for-read',
      }),
    ).toEqual(['/correct']);
    expect(
      extractToolFilePaths('grep_search', {
        filePath: '/wrong-for-grep',
        paths: ['/wrong-for-grep'],
      }),
    ).toEqual([]);
  });

  it('extracts grep_search.glob as a path-shaped file filter', () => {
    // GrepToolParams.glob is a path-shaped selector; `pattern` is a
    // regex on contents and intentionally NOT extracted. Without this
    // branch, `grep_search({ pattern: 'TODO', glob: 'src/**/*.ts' })`
    // produces no candidate even though the call walks every file under
    // `src/**/*.ts`.
    expect(
      extractToolFilePaths('grep_search', { glob: 'src/**/*.ts' }),
    ).toEqual(['src/**/*.ts']);
    expect(
      extractToolFilePaths('grep_search', {
        path: 'packages/core',
        glob: '**/*.ts',
        pattern: 'TODO|FIXME',
      }),
    ).toEqual(['packages/core', 'packages/core/**/*.ts']);
  });

  it('decodes file:// URIs for lsp via fileURLToPath', () => {
    // Regression: LSP `filePath` is allowed to be a `file://` URI.
    // Forwarding the URI as-is to the activation registry would never
    // match a project-relative skill glob (the leading `file:///`
    // never occurs inside project-relative path strings).
    //
    // Construct the URI from a real absolute path via `pathToFileURL`
    // so the test is portable across POSIX and Windows: a hand-rolled
    // `file:///proj/...` URI throws on Windows because there's no
    // drive letter, which Node treats as a malformed file URL.
    const absolutePath = path.resolve('/tmp/lsp-test/src/App.ts');
    const fileUri = pathToFileURL(absolutePath).href;
    expect(extractToolFilePaths('lsp', { filePath: fileUri })).toEqual([
      absolutePath,
    ]);
  });

  it('drops non-file URI schemes for lsp (http://, git://, etc.)', () => {
    // Regression: forwarding `http://api/x` or `git://repo/foo` into
    // the activation pipeline would let an LSP call against a
    // non-file resource activate path-gated skills without the model
    // having touched a real project file.
    expect(extractToolFilePaths('lsp', { filePath: 'http://api/x' })).toEqual(
      [],
    );
    expect(extractToolFilePaths('lsp', { filePath: 'git://repo/foo' })).toEqual(
      [],
    );
  });

  it('extracts callHierarchyItem.uri for lsp (incomingCalls / outgoingCalls)', () => {
    // Regression: incomingCalls / outgoingCalls operate on
    // `callHierarchyItem.uri`, NOT the top-level `filePath`. Following
    // the call hierarchy through a project file would otherwise never
    // contribute an activation candidate.
    //
    // Same portability concern as the filePath URI test above: build
    // the URI from a real absolute path via pathToFileURL so the test
    // works on both POSIX and Windows runners.
    const absolutePath = path.resolve('/tmp/lsp-test/src/App.ts');
    const fileUri = pathToFileURL(absolutePath).href;
    expect(
      extractToolFilePaths('lsp', {
        method: 'incomingCalls',
        callHierarchyItem: { uri: fileUri },
      }),
    ).toEqual([absolutePath]);
    // Plain absolute path also accepted.
    expect(
      extractToolFilePaths('lsp', {
        callHierarchyItem: { uri: absolutePath },
      }),
    ).toEqual([absolutePath]);
    // Non-file URI on the item is also dropped.
    expect(
      extractToolFilePaths('lsp', {
        callHierarchyItem: { uri: 'http://api/x' },
      }),
    ).toEqual([]);
  });

  it('extracts pattern for glob (path-shaped selector, glob-only)', () => {
    // Regression: `glob({ pattern: 'src/**/*.tsx' })` with no `path` is a
    // common shape that previously produced an empty candidate set, so a
    // skill keyed on `paths: ['src/**/*.tsx']` would never activate from
    // a glob call.
    expect(extractToolFilePaths('glob', { pattern: 'src/**/*.tsx' })).toEqual([
      'src/**/*.tsx',
    ]);
  });

  it('joins glob.path + glob.pattern into the effective selector', () => {
    // Regression: glob({ path: 'src', pattern: '**/*.ts' }) actually
    // searches src/**/*.ts. Emitting them as separate candidates
    // ('src', '**/*.ts') would NOT activate a skill keyed on
    // `paths: ['src/**/*.ts']`, because neither component matches the
    // skill glob in isolation. Join them with path.join so the
    // effective-selector candidate reflects what the tool really
    // touched. (The standalone `path` candidate is still emitted by the
    // generic block above so a broad skill keyed on `paths: ['src/**']`
    // still matches.)
    expect(
      extractToolFilePaths('glob', { path: 'src', pattern: '**/*.ts' }),
    ).toEqual(['src', 'src/**/*.ts']);
  });

  it('joins absolute glob.path with pattern (registry guard rejects downstream)', () => {
    // glob({ path: '/tmp/external', pattern: '**/*.ts' }) joins to an
    // absolute path. SkillActivationRegistry's project-root guard
    // rejects it; the test pins the joined shape so absolute roots
    // stay distinguishable from project-relative ones.
    expect(
      extractToolFilePaths('glob', {
        path: '/tmp/external',
        pattern: '**/*.ts',
      }),
    ).toEqual(['/tmp/external', '/tmp/external/**/*.ts']);
  });

  it('preserves `..` in glob.pattern instead of normalizing it away', () => {
    // Regression: `path.join('src', '../*.ts')` collapses to `*.ts`,
    // losing the information that the glob escaped its `path` root and
    // searched files at the parent level. Plain string concat keeps the
    // selector verbatim so the registry can match against it as-is.
    expect(
      extractToolFilePaths('glob', { path: 'src', pattern: '../*.ts' }),
    ).toEqual(['src', 'src/../*.ts']);
  });

  it('uses forward slashes regardless of host OS', () => {
    // Regression: `path.join` is OS-aware — on Windows it emits
    // backslashes and silently diverges from the forward-slash form
    // the registry matches against. Plain concat with a literal `/`
    // keeps the candidate cross-platform consistent.
    expect(
      extractToolFilePaths('glob', { path: 'src', pattern: '**/*.ts' }),
    ).toEqual(['src', 'src/**/*.ts']);
  });

  it('trims a trailing slash on glob.path before concatenating', () => {
    // Authors sometimes write `path: 'src/'`; we want one separator,
    // not `src//pattern`.
    expect(
      extractToolFilePaths('glob', { path: 'src/', pattern: '**/*.ts' }),
    ).toEqual(['src/', 'src/**/*.ts']);
    // Same with a Windows-style trailing backslash.
    expect(
      extractToolFilePaths('glob', { path: 'src\\', pattern: '**/*.ts' }),
    ).toEqual(['src\\', 'src/**/*.ts']);
  });

  it('does not extract pattern for non-glob tools', () => {
    // Grep's `pattern` is a regex, not a path glob; treating it as a
    // path would false-match. Pattern is only path-shaped for `glob`.
    expect(
      extractToolFilePaths('grep_search', {
        pattern: 'TODO|FIXME',
        path: 'src',
      }),
    ).toEqual(['src']);
  });

  it('canonicalizes legacy tool-name aliases before the allowlist check', () => {
    // Regression: the tool registry resolves `replace` → `edit`,
    // `search_file_content` → `grep_search`, etc. at execution time, so
    // a model call like `replace({ file_path: 'src/App.tsx' })` actually
    // runs EditTool. If the activation pipeline gates on the raw alias
    // name, conditional rules and skill activation silently skip every
    // tool call that uses a legacy name.
    expect(
      extractToolFilePaths('replace', { file_path: '/proj/a.ts' }),
    ).toEqual(['/proj/a.ts']);
    // search_file_content canonicalizes to grep_search; use its actual
    // shape (`path` / `glob`).
    expect(
      extractToolFilePaths('search_file_content', { path: 'src' }),
    ).toEqual(['src']);
  });

  it('returns empty for tool names outside the FS allowlist', () => {
    // Regression: MCP tools and other non-FS tools that happen to use
    // `path` / `paths` for non-filesystem semantics (e.g. URL routes,
    // JSON keys) must not feed those values into the activation pipeline.
    expect(
      extractToolFilePaths('mcp_some_tool', {
        path: 'https://api.example.com/users/123',
      }),
    ).toEqual([]);
    expect(
      extractToolFilePaths('web_fetch', {
        paths: ['https://x.example.com', 'a.com/b'],
      }),
    ).toEqual([]);
    expect(extractToolFilePaths('skill', { skill: 'review' })).toEqual([]);
  });
});

describe('CoreToolScheduler activation wiring', () => {
  // Integration coverage for the scheduler-side hook that ties
  // extractToolFilePaths → matchAndActivateByPaths → system-reminder
  // append. Unit tests on extractToolFilePaths alone don't catch
  // wiring regressions (e.g. forgetting the await, dropping the
  // SkillTool gate, posting the reminder before the listener chain
  // settled).

  function buildSchedulerWithSkillManager(opts: {
    matchAndActivateByPaths: ReturnType<typeof vi.fn>;
    skillToolPresent: boolean;
    toolResult?: ToolResult;
  }): {
    scheduler: CoreToolScheduler;
    onAllToolCallsComplete: ReturnType<typeof vi.fn>;
  } {
    const fsTool = new MockTool({
      name: ToolNames.READ_FILE,
      execute: vi.fn().mockResolvedValue(
        opts.toolResult ?? {
          llmContent: 'file contents',
          returnDisplay: 'file contents',
        },
      ),
    });
    const mockToolRegistry = {
      // Return the fs tool when asked by name; for SkillTool, mirror the
      // configured presence so the scheduler's reminder gate sees what
      // the test wants.
      getTool: (n: string) => {
        if (n === ToolNames.SKILL)
          return opts.skillToolPresent ? fsTool : undefined;
        return fsTool;
      },
      ensureTool: async () => fsTool,
      getToolByName: () => fsTool,
      getFunctionDeclarations: () => [],
      tools: new Map(),
      discovery: {},
      registerTool: () => {},
      getToolByDisplayName: () => fsTool,
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
      storage: { getProjectTempDir: () => '/tmp' },
      getTruncateToolOutputThreshold: () =>
        DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD,
      getTruncateToolOutputLines: () => DEFAULT_TRUNCATE_TOOL_OUTPUT_LINES,
      getToolRegistry: () => mockToolRegistry,
      getUseModelRouter: () => false,
      getGeminiClient: () => null,
      getChatRecordingService: () => undefined,
      getMessageBus: vi.fn().mockReturnValue(undefined),
      getDisableAllHooks: vi.fn().mockReturnValue(true),
      getConditionalRulesRegistry: () => undefined,
      getSkillManager: () => ({
        matchAndActivateByPaths: opts.matchAndActivateByPaths,
      }),
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

  function getResponseText(call: ToolCall): string {
    const r = call as unknown as {
      response?: { responseParts?: unknown };
    };
    return JSON.stringify(r.response?.responseParts ?? null);
  }

  it('invokes matchAndActivateByPaths with extracted candidates and appends the reminder when SkillTool is present', async () => {
    const matchAndActivateByPaths = vi.fn().mockResolvedValue(['tsx-helper']);
    const { scheduler, onAllToolCallsComplete } =
      buildSchedulerWithSkillManager({
        matchAndActivateByPaths,
        skillToolPresent: true,
      });

    await scheduler.schedule(
      [
        {
          callId: '1',
          name: ToolNames.READ_FILE,
          args: { file_path: '/proj/src/App.tsx' },
          isClientInitiated: false,
          prompt_id: 'p1',
        },
      ],
      new AbortController().signal,
    );

    expect(matchAndActivateByPaths).toHaveBeenCalledWith(['/proj/src/App.tsx']);
    const completed = onAllToolCallsComplete.mock.calls[0][0] as ToolCall[];
    expect(completed[0].status).toBe('success');
    const responseText = getResponseText(completed[0]);
    expect(responseText).toContain('tsx-helper');
    expect(responseText).toContain('now available via the Skill tool');
  });

  it('includes concrete result paths in skill activation candidates', async () => {
    const matchAndActivateByPaths = vi.fn().mockResolvedValue(['core-helper']);
    const { scheduler } = buildSchedulerWithSkillManager({
      matchAndActivateByPaths,
      skillToolPresent: true,
      toolResult: {
        llmContent: 'glob results',
        returnDisplay: 'glob results',
        resultFilePaths: [
          '/proj/packages/core/src/skills/target.ts',
          '/proj/packages/cli/src/other.ts',
        ],
      },
    });

    await scheduler.schedule(
      [
        {
          callId: '1',
          name: ToolNames.GLOB,
          args: { pattern: '**/*.ts' },
          isClientInitiated: false,
          prompt_id: 'p1',
        },
      ],
      new AbortController().signal,
    );

    expect(matchAndActivateByPaths).toHaveBeenCalledWith([
      '**/*.ts',
      '/proj/packages/core/src/skills/target.ts',
      '/proj/packages/cli/src/other.ts',
    ]);
  });

  it('deduplicates overlapping input and result paths before activation', async () => {
    const matchAndActivateByPaths = vi.fn().mockResolvedValue([]);
    const { scheduler } = buildSchedulerWithSkillManager({
      matchAndActivateByPaths,
      skillToolPresent: true,
      toolResult: {
        llmContent: 'file contents',
        returnDisplay: 'file contents',
        resultFilePaths: ['/proj/src/App.tsx'],
      },
    });

    await scheduler.schedule(
      [
        {
          callId: '1',
          name: ToolNames.READ_FILE,
          args: { file_path: '/proj/src/App.tsx' },
          isClientInitiated: false,
          prompt_id: 'p1',
        },
      ],
      new AbortController().signal,
    );

    expect(matchAndActivateByPaths).toHaveBeenCalledWith(['/proj/src/App.tsx']);
  });

  it('does not unescape concrete result paths before activation', async () => {
    const matchAndActivateByPaths = vi.fn().mockResolvedValue([]);
    const { scheduler } = buildSchedulerWithSkillManager({
      matchAndActivateByPaths,
      skillToolPresent: true,
      toolResult: {
        llmContent: 'glob results',
        returnDisplay: 'glob results',
        resultFilePaths: ['/proj/src/foo\\ bar.ts'],
      },
    });

    await scheduler.schedule(
      [
        {
          callId: '1',
          name: ToolNames.GLOB,
          args: { pattern: '**/*.ts' },
          isClientInitiated: false,
          prompt_id: 'p1',
        },
      ],
      new AbortController().signal,
    );

    expect(matchAndActivateByPaths).toHaveBeenCalledWith([
      '**/*.ts',
      '/proj/src/foo\\ bar.ts',
    ]);
  });

  it('ignores result path metadata from non-filesystem tools', async () => {
    const nonFsTool = new MockTool({
      name: 'web_fetch',
      execute: vi.fn().mockResolvedValue({
        llmContent: 'web results',
        returnDisplay: 'web results',
        resultFilePaths: ['/proj/src/App.tsx'],
      }),
    });
    const mockToolRegistry = {
      getTool: () => nonFsTool,
      ensureTool: async () => nonFsTool,
      getToolByName: () => nonFsTool,
      getFunctionDeclarations: () => [],
      tools: new Map(),
      discovery: {},
      registerTool: () => {},
      getToolByDisplayName: () => nonFsTool,
      getTools: () => [],
      discoverTools: async () => {},
      getAllTools: () => [],
      getToolsByServer: () => [],
    } as unknown as ToolRegistry;
    const matchAndActivateByPaths = vi.fn().mockResolvedValue([]);
    const scheduler = new CoreToolScheduler({
      config: {
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
        storage: { getProjectTempDir: () => '/tmp' },
        getTruncateToolOutputThreshold: () =>
          DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD,
        getTruncateToolOutputLines: () => DEFAULT_TRUNCATE_TOOL_OUTPUT_LINES,
        getToolRegistry: () => mockToolRegistry,
        getUseModelRouter: () => false,
        getGeminiClient: () => null,
        getChatRecordingService: () => undefined,
        getMessageBus: vi.fn().mockReturnValue(undefined),
        getDisableAllHooks: vi.fn().mockReturnValue(true),
        getConditionalRulesRegistry: () => undefined,
        getSkillManager: () => ({ matchAndActivateByPaths }),
      } as unknown as Config,
      onAllToolCallsComplete: vi.fn(),
      onToolCallsUpdate: vi.fn(),
      getPreferredEditor: () => 'vscode',
      onEditorClose: vi.fn(),
    });

    await scheduler.schedule(
      [
        {
          callId: '1',
          name: 'web_fetch',
          args: { url: 'https://example.com' },
          isClientInitiated: false,
          prompt_id: 'p1',
        },
      ],
      new AbortController().signal,
    );

    expect(matchAndActivateByPaths).not.toHaveBeenCalled();
  });

  it('suppresses the activation reminder when SkillTool is absent (subagent without skill in toolslist)', async () => {
    const matchAndActivateByPaths = vi.fn().mockResolvedValue(['tsx-helper']);
    const { scheduler, onAllToolCallsComplete } =
      buildSchedulerWithSkillManager({
        matchAndActivateByPaths,
        skillToolPresent: false,
      });

    await scheduler.schedule(
      [
        {
          callId: '1',
          name: ToolNames.READ_FILE,
          args: { file_path: '/proj/src/App.tsx' },
          isClientInitiated: false,
          prompt_id: 'p1',
        },
      ],
      new AbortController().signal,
    );

    // Activation registry still mutates (correct — model in another
    // context might want it), but the reminder is suppressed for this
    // subagent's tool result because invoking the announced skill from
    // here would fail.
    expect(matchAndActivateByPaths).toHaveBeenCalled();
    const completed = onAllToolCallsComplete.mock.calls[0][0] as ToolCall[];
    const responseText = getResponseText(completed[0]);
    expect(responseText).not.toContain('now available via the Skill tool');
    expect(responseText).not.toContain('tsx-helper');
  });

  it('coalesces rules + activation reminders into a single <system-reminder> envelope', async () => {
    // Regression: previously each matching rule emitted its own
    // `<system-reminder>` and skill activation emitted another — a
    // multi-path tool could produce N+1 envelopes. Coalesce so the
    // model gets one block per tool call.
    const matchAndActivateByPaths = vi.fn().mockResolvedValue(['tsx-helper']);
    const rulesRegistry = {
      matchAndConsume: vi
        .fn()
        .mockReturnValueOnce('Rule 1 body.')
        .mockReturnValueOnce('Rule 2 body.'),
    };

    const grepTool = new MockTool({
      name: ToolNames.GREP,
      execute: vi.fn().mockResolvedValue({
        llmContent: 'grep results',
        returnDisplay: 'grep results',
      }),
    });
    const mockToolRegistry = {
      getTool: () => grepTool,
      ensureTool: async () => grepTool,
      getToolByName: () => grepTool,
      getFunctionDeclarations: () => [],
      tools: new Map(),
      discovery: {},
      registerTool: () => {},
      getToolByDisplayName: () => grepTool,
      getTools: () => [],
      discoverTools: async () => {},
      getAllTools: () => [],
      getToolsByServer: () => [],
    } as unknown as ToolRegistry;

    const onAllToolCallsComplete = vi.fn();
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
      storage: { getProjectTempDir: () => '/tmp' },
      getTruncateToolOutputThreshold: () =>
        DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD,
      getTruncateToolOutputLines: () => DEFAULT_TRUNCATE_TOOL_OUTPUT_LINES,
      getToolRegistry: () => mockToolRegistry,
      getUseModelRouter: () => false,
      getGeminiClient: () => null,
      getChatRecordingService: () => undefined,
      getMessageBus: vi.fn().mockReturnValue(undefined),
      getDisableAllHooks: vi.fn().mockReturnValue(true),
      getConditionalRulesRegistry: () => rulesRegistry,
      getSkillManager: () => ({ matchAndActivateByPaths }),
    } as unknown as Config;

    const scheduler = new CoreToolScheduler({
      config: mockConfig,
      onAllToolCallsComplete,
      onToolCallsUpdate: vi.fn(),
      getPreferredEditor: () => 'vscode',
      onEditorClose: vi.fn(),
    });

    // grep_search with `path` + `glob` produces TWO candidate paths
    // (the search root and the joined effective selector), so the
    // rules registry gets two matchAndConsume calls and two reminder
    // blocks. Plus one for skill activation = three blocks; coalesce
    // into a single envelope.
    await scheduler.schedule(
      [
        {
          callId: '1',
          name: ToolNames.GREP,
          args: { pattern: 'TODO', path: 'src', glob: '**/*.ts' },
          isClientInitiated: false,
          prompt_id: 'p1',
        },
      ],
      new AbortController().signal,
    );

    const completed = onAllToolCallsComplete.mock.calls[0][0] as ToolCall[];
    const responseText = JSON.stringify(
      (completed[0] as unknown as { response?: { responseParts?: unknown } })
        .response?.responseParts ?? null,
    );
    // All three reminder blocks land but inside ONE envelope.
    const envelopeCount = (responseText.match(/<system-reminder>/g) || [])
      .length;
    expect(envelopeCount).toBe(1);
    expect(responseText).toContain('Rule 1 body.');
    expect(responseText).toContain('Rule 2 body.');
    expect(responseText).toContain('tsx-helper');
  });

  it('escapes activated skill names in the activation reminder', async () => {
    // Regression: validateSkillName excludes `<>&` for parsed skills,
    // but extension skills bypass it. A crafted extension name would
    // otherwise close the <system-reminder> envelope early when emitted
    // as part of "skill X is now available".
    const matchAndActivateByPaths = vi.fn().mockResolvedValue(['evil<inject>']);

    const fsTool = new MockTool({
      name: ToolNames.READ_FILE,
      execute: vi.fn().mockResolvedValue({
        llmContent: 'file contents',
        returnDisplay: 'file contents',
      }),
    });
    const mockToolRegistry = {
      getTool: () => fsTool,
      ensureTool: async () => fsTool,
      getToolByName: () => fsTool,
      getFunctionDeclarations: () => [],
      tools: new Map(),
      discovery: {},
      registerTool: () => {},
      getToolByDisplayName: () => fsTool,
      getTools: () => [],
      discoverTools: async () => {},
      getAllTools: () => [],
      getToolsByServer: () => [],
    } as unknown as ToolRegistry;

    const onAllToolCallsComplete = vi.fn();
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
      storage: { getProjectTempDir: () => '/tmp' },
      getTruncateToolOutputThreshold: () =>
        DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD,
      getTruncateToolOutputLines: () => DEFAULT_TRUNCATE_TOOL_OUTPUT_LINES,
      getToolRegistry: () => mockToolRegistry,
      getUseModelRouter: () => false,
      getGeminiClient: () => null,
      getChatRecordingService: () => undefined,
      getMessageBus: vi.fn().mockReturnValue(undefined),
      getDisableAllHooks: vi.fn().mockReturnValue(true),
      getConditionalRulesRegistry: () => undefined,
      getSkillManager: () => ({ matchAndActivateByPaths }),
    } as unknown as Config;

    const scheduler = new CoreToolScheduler({
      config: mockConfig,
      onAllToolCallsComplete,
      onToolCallsUpdate: vi.fn(),
      getPreferredEditor: () => 'vscode',
      onEditorClose: vi.fn(),
    });

    await scheduler.schedule(
      [
        {
          callId: '1',
          name: ToolNames.READ_FILE,
          args: { file_path: '/proj/a.ts' },
          isClientInitiated: false,
          prompt_id: 'p1',
        },
      ],
      new AbortController().signal,
    );

    const completed = onAllToolCallsComplete.mock.calls[0][0] as ToolCall[];
    const responseText = JSON.stringify(
      (completed[0] as unknown as { response?: { responseParts?: unknown } })
        .response?.responseParts ?? null,
    );
    expect(responseText).toContain('evil&lt;inject&gt;');
    // Raw tag must NOT appear (would close the envelope early).
    expect(responseText).not.toContain('evil<inject>');
  });

  it('scrubs literal </system-reminder> in rule content to prevent envelope breakout', async () => {
    // A rule body containing literal `</system-reminder>` (e.g. a
    // documentation rule about how reminders work) would close our
    // envelope early. Scrub the closing-tag literal — minimal escape
    // needed to keep the wrapper intact, without mangling code blocks.
    const rulesRegistry = {
      matchAndConsume: vi
        .fn()
        .mockReturnValueOnce(
          'Rule about reminders: never write </system-reminder> in your output.',
        ),
    };

    const fsTool = new MockTool({
      name: ToolNames.READ_FILE,
      execute: vi.fn().mockResolvedValue({
        llmContent: 'file contents',
        returnDisplay: 'file contents',
      }),
    });
    const mockToolRegistry = {
      getTool: () => fsTool,
      ensureTool: async () => fsTool,
      getToolByName: () => fsTool,
      getFunctionDeclarations: () => [],
      tools: new Map(),
      discovery: {},
      registerTool: () => {},
      getToolByDisplayName: () => fsTool,
      getTools: () => [],
      discoverTools: async () => {},
      getAllTools: () => [],
      getToolsByServer: () => [],
    } as unknown as ToolRegistry;

    const onAllToolCallsComplete = vi.fn();
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
      storage: { getProjectTempDir: () => '/tmp' },
      getTruncateToolOutputThreshold: () =>
        DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD,
      getTruncateToolOutputLines: () => DEFAULT_TRUNCATE_TOOL_OUTPUT_LINES,
      getToolRegistry: () => mockToolRegistry,
      getUseModelRouter: () => false,
      getGeminiClient: () => null,
      getChatRecordingService: () => undefined,
      getMessageBus: vi.fn().mockReturnValue(undefined),
      getDisableAllHooks: vi.fn().mockReturnValue(true),
      getConditionalRulesRegistry: () => rulesRegistry,
      getSkillManager: () => ({
        matchAndActivateByPaths: vi.fn().mockResolvedValue([]),
      }),
    } as unknown as Config;

    const scheduler = new CoreToolScheduler({
      config: mockConfig,
      onAllToolCallsComplete,
      onToolCallsUpdate: vi.fn(),
      getPreferredEditor: () => 'vscode',
      onEditorClose: vi.fn(),
    });

    await scheduler.schedule(
      [
        {
          callId: '1',
          name: ToolNames.READ_FILE,
          args: { file_path: '/proj/a.ts' },
          isClientInitiated: false,
          prompt_id: 'p1',
        },
      ],
      new AbortController().signal,
    );

    const completed = onAllToolCallsComplete.mock.calls[0][0] as ToolCall[];
    const responseText = JSON.stringify(
      (completed[0] as unknown as { response?: { responseParts?: unknown } })
        .response?.responseParts ?? null,
    );
    // Exactly one closing tag — the envelope's. The literal in the
    // body is rewritten to <\/system-reminder> so it doesn't close
    // the wrapper.
    const closeCount = (responseText.match(/<\/system-reminder>/g) || [])
      .length;
    expect(closeCount).toBe(1);
    // The rewritten form of the body literal still appears verbatim
    // (escaped form), so the rule content survives.
    expect(responseText).toContain('<\\\\/system-reminder>');
  });

  it('does not call matchAndActivateByPaths for non-FS tools', async () => {
    const matchAndActivateByPaths = vi.fn().mockResolvedValue([]);
    const { scheduler } = buildSchedulerWithSkillManager({
      matchAndActivateByPaths,
      skillToolPresent: true,
    });

    // Use a tool name outside FS_PATH_TOOL_NAMES; the mock fsTool above
    // is registered under read_file, but the scheduler will look up by
    // request.name. We override request.name to a non-FS name and
    // confirm the activation hook never fires.
    await scheduler.schedule(
      [
        {
          callId: '1',
          name: 'web_fetch',
          args: { url: 'https://example.com' },
          isClientInitiated: false,
          prompt_id: 'p1',
        },
      ],
      new AbortController().signal,
    );

    expect(matchAndActivateByPaths).not.toHaveBeenCalled();
  });
});

describe('CoreToolScheduler shell-tool promote integration (#3831 PR-2)', () => {
  it('stashes promoteAbortController on the executing tool call when shell.ts fires the callback', async () => {
    // Pin the scheduler-side wiring for the promote-AbortController
    // callback. PR-3's Ctrl+B keybind will look up the
    // currently-executing shell tool call by callId and abort
    // `tc.promoteAbortController`; if the scheduler stops populating
    // that field, the keybind silently breaks. Direct
    // ShellToolInvocation tests can't see this — they don't go
    // through the scheduler.
    let exposedAc: AbortController | undefined;
    class TestShellInvocation extends ShellToolInvocation {
      override async execute(
        _signal: AbortSignal,
        _updateOutput?: (output: ToolResultDisplay) => void,
        _shellExecutionConfig?: ShellExecutionConfig,
        _setPidCallback?: (pid: number) => void,
        setPromoteAbortControllerCallback?: (ac: AbortController) => void,
      ): Promise<ToolResult> {
        // Mirror the production flow: foreground shell.ts spawns,
        // calls setPromoteAbortControllerCallback right after spawn,
        // then waits for the result. We synthesize the callback fire
        // and immediately complete with a benign success result.
        const ac = new AbortController();
        exposedAc = ac;
        setPromoteAbortControllerCallback?.(ac);
        return { llmContent: 'ok', returnDisplay: 'ok' };
      }
    }

    class TestShellTool extends ShellTool {
      protected override createInvocation(params: ShellToolParams) {
        // Cast through unknown — the test invocation extends the real
        // ShellToolInvocation prototype so the scheduler's `instanceof
        // ShellToolInvocation` check still routes the call through
        // the shell-tool-specific branch (which is the branch that
        // wires setPromoteAbortControllerCallback).
        return new TestShellInvocation(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (this as any).config,
          params,
        ) as unknown as ToolInvocation<ShellToolParams, ToolResult>;
      }
    }

    const tool = new TestShellTool({} as Config);
    const mockToolRegistry = {
      getTool: () => tool,
      ensureTool: async () => tool,
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
      getApprovalMode: () => ApprovalMode.YOLO,
      getContentGeneratorConfig: () => ({
        model: 'test-model',
        authType: 'gemini',
      }),
      getToolRegistry: () => mockToolRegistry,
      getShellExecutionConfig: () => ({
        terminalWidth: 80,
        terminalHeight: 24,
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

    await scheduler.schedule(
      [
        {
          callId: 'shell-1',
          name: 'run_shell_command',
          args: { command: 'echo hi' },
          isClientInitiated: true,
          prompt_id: 'p-shell',
        },
      ],
      new AbortController().signal,
    );

    await vi.waitFor(() => {
      expect(onAllToolCallsComplete).toHaveBeenCalled();
    });

    // Find a tool-calls-update emitted while the call was 'executing'
    // that carries the promoteAbortController. The exact ordering of
    // updates depends on the scheduler's internal flow, but at SOME
    // point during the executing window the field must be populated —
    // otherwise PR-3's Ctrl+B keybind has nothing to abort.
    const updateBatches = onToolCallsUpdate.mock.calls;
    const sawPromoteAcWhileExecuting = updateBatches.some((batch) => {
      const tcs = batch[0] as ToolCall[];
      return tcs.some(
        (tc) =>
          tc.request.callId === 'shell-1' &&
          tc.status === 'executing' &&
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (tc as any).promoteAbortController === exposedAc,
      );
    });
    expect(sawPromoteAcWhileExecuting).toBe(true);
  });
});
