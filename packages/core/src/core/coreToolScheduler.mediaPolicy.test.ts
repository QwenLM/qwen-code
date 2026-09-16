/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Scheduler wiring tests for the omni media-policy protocol:
 * modelAccess gate at schedule time, fixed-policy permission bypass,
 * and raw policy-artifact capture on the success response.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Mock } from 'vitest';
import { executeToolCall } from './nonInteractiveToolExecutor.js';
import type {
  Config,
  MediaPolicyToolDescriptor,
  OmniPolicyToolsSettings,
  ToolCallRequestInfo,
  ToolRegistry,
  ToolResult,
} from '../index.js';
import {
  ApprovalMode,
  CoreToolScheduler,
  DEFAULT_TRUNCATE_TOOL_OUTPUT_LINES,
  DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD,
  ToolErrorType,
} from '../index.js';
import type { ToolCall } from './coreToolScheduler.js';
import { MockTool } from '../test-utils/mock-tool.js';

const DESCRIPTOR: MediaPolicyToolDescriptor = {
  kind: 'media_policy',
  inputMediaTypes: ['image'],
  outputs: [{ kind: 'media', required: true }],
};

/** MockTool that reports itself as a media-policy tool (code-registration
 * fact — the descriptor getter, never configuration). */
class MockMediaPolicyTool extends MockTool {
  override get mediaPolicyDescriptor(): MediaPolicyToolDescriptor {
    return DESCRIPTOR;
  }
}

const FIXED_ORIGIN = {
  kind: 'fixed_policy',
  policyId: 'image-compress-v1',
  stage: 'preprocessing',
} as const;

function makeConfig(options: {
  tool: MockTool;
  omniPolicyTools?: OmniPolicyToolsSettings;
  approvalMode?: ApprovalMode;
  interactive?: boolean;
  isToolEnabled?: (name: string) => Promise<boolean>;
}): Config {
  const mockToolRegistry = {
    getTool: (name: string) =>
      name === options.tool.name ? options.tool : undefined,
    ensureTool: async (name: string) =>
      name === options.tool.name ? options.tool : undefined,
    getToolByName: (name: string) =>
      name === options.tool.name ? options.tool : undefined,
    getAllToolNames: () => [options.tool.name],
    getFunctionDeclarations: () => [],
    getAllTools: () => [options.tool],
  } as unknown as ToolRegistry;

  return {
    getToolRegistry: () => mockToolRegistry,
    getApprovalMode: () => options.approvalMode ?? ApprovalMode.DEFAULT,
    getAllowedTools: () => [],
    getPermissionsAllow: () => [],
    getPermissionsDeny: () => undefined,
    getSessionId: () => 'test-session-id',
    getUsageStatisticsEnabled: () => true,
    getDebugMode: () => false,
    getContentGeneratorConfig: () => ({
      model: 'test-model',
      authType: 'gemini',
    }),
    getEffectiveInputModalities: () => ({ image: true }),
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
    getGeminiClient: () => null,
    getChatRecordingService: () => undefined,
    getMessageBus: vi.fn().mockReturnValue(undefined),
    getDisableAllHooks: vi.fn().mockReturnValue(true),
    getHookSystem: vi.fn().mockReturnValue(undefined),
    isInteractive: vi.fn().mockReturnValue(options.interactive ?? false),
    getExperimentalZedIntegration: () => false,
    getAutoModeDenialState: () => ({
      consecutiveBlock: 0,
      consecutiveUnavailable: 0,
      totalBlock: 0,
      totalUnavailable: 0,
    }),
    setAutoModeDenialState: vi.fn(),
    getAutoModeSettings: () => ({}),
    getOmniPolicyToolsSettings: () => options.omniPolicyTools,
    ...(options.isToolEnabled
      ? {
          getPermissionManager: () => ({
            isToolEnabled: options.isToolEnabled,
            findMatchingDenyRule: () => undefined,
          }),
        }
      : {}),
  } as unknown as Config;
}

const request = (
  overrides: Partial<ToolCallRequestInfo> & { name: string },
): ToolCallRequestInfo => ({
  callId: 'call-1',
  args: {},
  isClientInitiated: false,
  prompt_id: 'prompt-1',
  ...overrides,
});

describe('CoreToolScheduler media-policy modelAccess gate', () => {
  it('rejects a call with a missing executionOrigin (fails closed as model) when modelAccess is absent', async () => {
    const executeFn = vi.fn();
    const tool = new MockMediaPolicyTool({
      name: 'omni_compress_image',
      execute: executeFn,
    });
    const config = makeConfig({ tool });

    const response = await executeToolCall(
      config,
      request({ name: tool.name }),
      new AbortController().signal,
    );

    expect(response.errorType).toBe(ToolErrorType.EXECUTION_DENIED);
    expect(response.error?.message).toContain(
      '"omni.processing.policyTools.omni_compress_image.modelAccess.enabled": true',
    );
    expect(executeFn).not.toHaveBeenCalled();
  });

  it('executes an enabled tool with defaults + model args + lockedArguments merged', async () => {
    const executeFn: Mock = vi.fn().mockResolvedValue({
      llmContent: 'ok',
      returnDisplay: 'ok',
    } satisfies ToolResult);
    const tool = new MockMediaPolicyTool({
      name: 'omni_compress_image',
      execute: executeFn,
    });
    const config = makeConfig({
      tool,
      omniPolicyTools: {
        omni_compress_image: {
          modelAccess: {
            enabled: true,
            defaultArguments: { quality: 80, format: 'jpeg' },
            lockedArguments: { output_dir: '/objects' },
          },
        },
      },
    });

    const response = await executeToolCall(
      config,
      request({ name: tool.name, args: { quality: 55, source: 'a.png' } }),
      new AbortController().signal,
    );

    expect(response.error).toBeUndefined();
    expect(executeFn).toHaveBeenCalledWith({
      quality: 55,
      format: 'jpeg',
      source: 'a.png',
      output_dir: '/objects',
    });
  });

  it('rejects explicit lockedArguments keys as INVALID_TOOL_PARAMS', async () => {
    const executeFn = vi.fn();
    const tool = new MockMediaPolicyTool({
      name: 'omni_compress_image',
      execute: executeFn,
    });
    const config = makeConfig({
      tool,
      omniPolicyTools: {
        omni_compress_image: {
          modelAccess: {
            enabled: true,
            lockedArguments: { output_dir: '/objects' },
          },
        },
      },
    });

    const response = await executeToolCall(
      config,
      request({ name: tool.name, args: { output_dir: '/evil' } }),
      new AbortController().signal,
    );

    expect(response.errorType).toBe(ToolErrorType.INVALID_TOOL_PARAMS);
    expect(response.error?.message).toContain('"output_dir"');
    expect(executeFn).not.toHaveBeenCalled();
  });

  it('rejects a forged fixed_policy origin on a non-media-policy tool', async () => {
    const executeFn = vi.fn();
    const tool = new MockTool({
      name: 'run_shell_command',
      execute: executeFn,
    });
    const config = makeConfig({ tool });

    const response = await executeToolCall(
      config,
      request({
        name: tool.name,
        args: { command: 'rm -rf /' },
        executionOrigin: FIXED_ORIGIN,
      }),
      new AbortController().signal,
    );

    expect(response.errorType).toBe(ToolErrorType.EXECUTION_DENIED);
    expect(response.error?.message).toContain('not a media policy tool');
    expect(executeFn).not.toHaveBeenCalled();
  });
});

describe('CoreToolScheduler fixed_policy execution', () => {
  it('executes a fixed_policy call without confirmation even when modelAccess is disabled', async () => {
    const executeFn: Mock = vi.fn().mockResolvedValue({
      llmContent: 'compressed',
      returnDisplay: 'compressed',
    } satisfies ToolResult);
    const getDefaultPermission = vi.fn(async () => 'ask' as const);
    const tool = new MockMediaPolicyTool({
      name: 'omni_compress_image',
      execute: executeFn,
      getDefaultPermission,
    });
    // No omniPolicyTools at all: modelAccess disabled by default, but the
    // fixed-policy orchestrator path must still work.
    const config = makeConfig({ tool });

    const response = await executeToolCall(
      config,
      request({
        name: tool.name,
        args: { source: 'a.png' },
        executionOrigin: FIXED_ORIGIN,
      }),
      new AbortController().signal,
    );

    expect(response.error).toBeUndefined();
    expect(executeFn).toHaveBeenCalledWith({ source: 'a.png' });
    // The interactive permission flow is skipped entirely.
    expect(getDefaultPermission).not.toHaveBeenCalled();
  });

  it('keeps confirmation for model-origin calls of the same enabled tool (bypass is origin-keyed)', async () => {
    const executeFn = vi.fn();
    const tool = new MockMediaPolicyTool({
      name: 'omni_compress_image',
      execute: executeFn,
      getDefaultPermission: async () => 'ask' as const,
      getConfirmationDetails: async () => ({
        type: 'info' as const,
        title: 'Confirm compression',
        prompt: 'Compress?',
        onConfirm: async () => {},
      }),
    });
    const config = makeConfig({
      tool,
      interactive: true,
      omniPolicyTools: {
        omni_compress_image: { modelAccess: { enabled: true } },
      },
    });

    const onToolCallsUpdate = vi.fn();
    const scheduler = new CoreToolScheduler({
      config,
      onAllToolCallsComplete: vi.fn(),
      onToolCallsUpdate,
      getPreferredEditor: () => 'vscode',
      onEditorClose: vi.fn(),
    });

    await scheduler.schedule(
      [request({ name: tool.name, args: { source: 'a.png' } })],
      new AbortController().signal,
    );

    await vi.waitFor(() => {
      const statuses = onToolCallsUpdate.mock.calls
        .flatMap((call) => call[0] as ToolCall[])
        .map((toolCall) => toolCall.status);
      expect(statuses).toContain('awaiting_approval');
    });
    expect(executeFn).not.toHaveBeenCalled();
  });

  it('still enforces PermissionManager.isToolEnabled for fixed_policy calls', async () => {
    const executeFn = vi.fn();
    const tool = new MockMediaPolicyTool({
      name: 'omni_compress_image',
      execute: executeFn,
    });
    const config = makeConfig({
      tool,
      isToolEnabled: async () => false,
    });

    const response = await executeToolCall(
      config,
      request({
        name: tool.name,
        executionOrigin: FIXED_ORIGIN,
      }),
      new AbortController().signal,
    );

    expect(response.error).toBeDefined();
    expect(executeFn).not.toHaveBeenCalled();
  });
});

describe('CoreToolScheduler policyArtifacts capture', () => {
  const ARTIFACTS = [
    {
      title: 'compressed.webp',
      workspacePath: 'objects/compressed.webp',
      mimeType: 'image/webp',
    },
  ];

  it('captures raw artifacts of a successful media-policy call into policyArtifacts', async () => {
    const tool = new MockMediaPolicyTool({
      name: 'omni_compress_image',
      execute: vi.fn().mockResolvedValue({
        llmContent: 'ok',
        returnDisplay: 'ok',
        artifacts: ARTIFACTS,
      } satisfies ToolResult),
    });
    const config = makeConfig({ tool });

    const response = await executeToolCall(
      config,
      request({
        name: tool.name,
        callId: 'staging-invocation-7',
        executionOrigin: FIXED_ORIGIN,
      }),
      new AbortController().signal,
    );

    expect(response.error).toBeUndefined();
    expect(response.policyArtifacts).toEqual({
      toolName: 'omni_compress_image',
      invocationId: 'staging-invocation-7',
      executionOrigin: FIXED_ORIGIN,
      artifacts: ARTIFACTS,
    });
  });

  it('reports a model origin in policyArtifacts for enabled model-origin calls', async () => {
    const tool = new MockMediaPolicyTool({
      name: 'omni_compress_image',
      execute: vi.fn().mockResolvedValue({
        llmContent: 'ok',
        returnDisplay: 'ok',
        artifacts: ARTIFACTS,
      } satisfies ToolResult),
    });
    const config = makeConfig({
      tool,
      omniPolicyTools: {
        omni_compress_image: { modelAccess: { enabled: true } },
      },
    });

    const response = await executeToolCall(
      config,
      request({ name: tool.name }),
      new AbortController().signal,
    );

    expect(response.policyArtifacts?.executionOrigin).toEqual({
      kind: 'model',
    });
  });

  it('does not emit policyArtifacts for ordinary tools with artifacts', async () => {
    const tool = new MockTool({
      name: 'ordinary_tool',
      execute: vi.fn().mockResolvedValue({
        llmContent: 'ok',
        returnDisplay: 'ok',
        artifacts: ARTIFACTS,
      } satisfies ToolResult),
    });
    const config = makeConfig({ tool });

    const response = await executeToolCall(
      config,
      request({ name: tool.name }),
      new AbortController().signal,
    );

    expect(response.error).toBeUndefined();
    expect(response.policyArtifacts).toBeUndefined();
    // The regular artifacts channel is unaffected.
    expect(response.artifacts).toEqual(ARTIFACTS);
  });

  it('does not emit policyArtifacts when a media-policy call produced no artifacts', async () => {
    const tool = new MockMediaPolicyTool({
      name: 'omni_compress_image',
      execute: vi.fn().mockResolvedValue({
        llmContent: 'nothing to do',
        returnDisplay: 'nothing to do',
      } satisfies ToolResult),
    });
    const config = makeConfig({ tool });

    const response = await executeToolCall(
      config,
      request({ name: tool.name, executionOrigin: FIXED_ORIGIN }),
      new AbortController().signal,
    );

    expect(response.error).toBeUndefined();
    expect(response.policyArtifacts).toBeUndefined();
  });
});
