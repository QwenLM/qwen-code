/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { ApprovalMode } from '../config/approval-mode.js';
import {
  CoreToolScheduler,
  type ToolCall,
  type WaitingToolCall,
} from '../core/coreToolScheduler.js';
import { makeFakeConfig } from '../test-utils/config.js';
import { MockTool } from '../test-utils/mock-tool.js';
import { ExecTool } from '../tools/exec.js';
import { getToolCallRuntime } from './tool-call-runtime.js';
import { Kind, ToolConfirmationOutcome } from '../tools/tools.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { MessageBusType } from '../confirmation-bus/types.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';

describe('CodeModeOnly scheduler dispatch', () => {
  it('returns image() output to the model as inline media', async () => {
    const config = makeFakeConfig({
      codeModeOnly: true,
      approvalMode: ApprovalMode.DEFAULT,
      targetDir: '/tmp',
      cwd: '/tmp',
    });
    const registry = new ToolRegistry(config);
    vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
    registry.registerTool(new ExecTool(config));
    const completed = vi.fn();
    const scheduler = new CoreToolScheduler({
      config,
      onAllToolCallsComplete: async (calls) => completed(calls),
      onToolCallsUpdate: vi.fn(),
      getPreferredEditor: () => undefined,
      onEditorClose: vi.fn(),
    });

    await scheduler.schedule(
      {
        callId: 'exec-image',
        name: 'exec',
        args: {
          source: `text('caption'); image('data:image/png;base64,${TINY_PNG_BASE64}');`,
        },
        isClientInitiated: false,
        prompt_id: 'prompt-image',
      },
      new AbortController().signal,
    );

    expect(completed).toHaveBeenCalledOnce();
    const completedCall = completed.mock.calls[0]?.[0][0];
    const functionResponse =
      completedCall.response.responseParts[0].functionResponse;
    expect(functionResponse?.response?.['output']).toBe('caption');
    expect(functionResponse?.parts).toEqual([
      {
        inlineData: {
          mimeType: 'image/png',
          data: TINY_PNG_BASE64,
        },
      },
    ]);
    expect(completedCall.response.resultDisplay).toBe('caption');
    expect(JSON.stringify(functionResponse)).not.toContain('Media output:');
  }, 10_000);

  it('normalizes a nested MCP image for image(result.content[0])', async () => {
    const config = makeFakeConfig({
      codeModeOnly: true,
      approvalMode: ApprovalMode.DEFAULT,
      targetDir: '/tmp',
      cwd: '/tmp',
    });
    const registry = new ToolRegistry(config);
    vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
    registry.registerTool(new ExecTool(config));
    registry.registerTool(
      new MockTool({
        name: 'mcp_screenshot',
        kind: Kind.Read,
        params: { type: 'object', additionalProperties: false },
        execute: async () => ({
          llmContent: [
            { text: 'MCP screenshot' },
            {
              inlineData: {
                mimeType: 'image/png',
                data: TINY_PNG_BASE64,
              },
            },
          ],
          returnDisplay: 'MCP screenshot',
        }),
      }),
    );
    const completed = vi.fn();
    const scheduler = new CoreToolScheduler({
      config,
      onAllToolCallsComplete: async (calls) => completed(calls),
      onToolCallsUpdate: vi.fn(),
      getPreferredEditor: () => undefined,
      onEditorClose: vi.fn(),
    });

    await scheduler.schedule(
      {
        callId: 'exec-mcp-image',
        name: 'exec',
        args: {
          source: `const result = await tools.mcp_screenshot({});
            image(result.content[0]);`,
        },
        isClientInitiated: false,
        prompt_id: 'prompt-mcp-image',
      },
      new AbortController().signal,
    );

    const functionResponse =
      completed.mock.calls[0]?.[0][0].response.responseParts[0]
        .functionResponse;
    expect(functionResponse?.parts).toEqual([
      {
        inlineData: {
          mimeType: 'image/png',
          data: TINY_PNG_BASE64,
        },
      },
    ]);
  }, 10_000);

  it('passes the Qwen image_gen result to generatedImage()', async () => {
    const config = makeFakeConfig({
      codeModeOnly: true,
      approvalMode: ApprovalMode.DEFAULT,
      targetDir: '/tmp',
      cwd: '/tmp',
    });
    const registry = new ToolRegistry(config);
    vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
    registry.registerTool(new ExecTool(config));
    registry.registerTool(
      new MockTool({
        name: 'image_gen',
        kind: Kind.Read,
        params: {
          type: 'object',
          properties: { prompt: { type: 'string' } },
          required: ['prompt'],
        },
        execute: async () => ({
          llmContent: [
            { text: 'Generated image saved to /tmp/generated.png.' },
            {
              inlineData: {
                mimeType: 'image/png',
                data: TINY_PNG_BASE64,
              },
            },
          ],
          returnDisplay: 'Generated image saved to /tmp/generated.png.',
        }),
      }),
    );
    const completed = vi.fn();
    const scheduler = new CoreToolScheduler({
      config,
      onAllToolCallsComplete: async (calls) => completed(calls),
      onToolCallsUpdate: vi.fn(),
      getPreferredEditor: () => undefined,
      onEditorClose: vi.fn(),
    });

    await scheduler.schedule(
      {
        callId: 'exec-generated-image',
        name: 'exec',
        args: {
          source: `const result = await tools.image_gen({ prompt: 'poster' });
            generatedImage(result);`,
        },
        isClientInitiated: false,
        prompt_id: 'prompt-generated-image',
      },
      new AbortController().signal,
    );

    const functionResponse =
      completed.mock.calls[0]?.[0][0].response.responseParts[0]
        .functionResponse;
    expect(functionResponse?.response?.['output']).toBe(
      'Generated image saved to /tmp/generated.png.',
    );
    expect(functionResponse?.parts).toEqual([
      {
        inlineData: {
          mimeType: 'image/png',
          data: TINY_PNG_BASE64,
        },
      },
    ]);
  }, 10_000);

  it('awaits a nested tool without self-queue deadlock and reports the real name', async () => {
    const config = makeFakeConfig({
      codeModeOnly: true,
      approvalMode: ApprovalMode.DEFAULT,
      targetDir: '/tmp',
      cwd: '/tmp',
    });
    const registry = new ToolRegistry(config);
    vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
    const nestedExecute = vi.fn().mockImplementation(async () => {
      expect(getToolCallRuntime()).toBeUndefined();
      return {
        llmContent: 'nested output',
        returnDisplay: 'nested output',
      };
    });
    registry.registerTool(new ExecTool(config));
    registry.registerTool(
      new MockTool({
        name: 'read_probe',
        kind: Kind.Read,
        params: { type: 'object', additionalProperties: false },
        execute: nestedExecute,
      }),
    );

    const updates: ToolCall[][] = [];
    const completed = vi.fn();
    const scheduler = new CoreToolScheduler({
      config,
      onAllToolCallsComplete: async (calls) => completed(calls),
      onToolCallsUpdate: (calls) => updates.push(calls),
      getPreferredEditor: () => undefined,
      onEditorClose: vi.fn(),
    });

    await scheduler.schedule(
      {
        callId: 'exec-parent',
        name: 'exec',
        args: {
          source:
            'const result = await tools.read_probe({}); return result.output;',
        },
        isClientInitiated: false,
        prompt_id: 'prompt-1',
      },
      new AbortController().signal,
    );

    expect(nestedExecute).toHaveBeenCalledOnce();
    const nestedCall = updates
      .flat()
      .find((call) => call.request.name === 'read_probe');
    expect(nestedCall?.request).toMatchObject({
      callId: 'exec-parent:code:1',
      parentCallId: 'exec-parent',
      source: 'code_mode',
    });
    expect(completed).toHaveBeenCalledOnce();
    expect(
      completed.mock.calls[0]?.[0][0].response.responseParts[0].functionResponse
        ?.response?.['output'],
    ).toContain('nested output');
  }, 10_000);

  it('runs Promise.all reads in one scheduler batch', async () => {
    const config = makeFakeConfig({
      codeModeOnly: true,
      approvalMode: ApprovalMode.DEFAULT,
      targetDir: '/tmp',
      cwd: '/tmp',
    });
    const registry = new ToolRegistry(config);
    vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
    registry.registerTool(new ExecTool(config));

    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    registry.registerTool(
      new MockTool({
        name: 'parallel_read',
        kind: Kind.Read,
        params: { type: 'object' },
        execute: async () => {
          started++;
          await gate;
          return { llmContent: 'ok', returnDisplay: 'ok' };
        },
      }),
    );
    const scheduler = new CoreToolScheduler({
      config,
      onAllToolCallsComplete: vi.fn(),
      onToolCallsUpdate: vi.fn(),
      getPreferredEditor: () => undefined,
      onEditorClose: vi.fn(),
    });

    const scheduled = scheduler.schedule(
      {
        callId: 'exec-parallel',
        name: 'exec',
        args: {
          source:
            'await Promise.all([tools.parallel_read({ id: 1 }), tools.parallel_read({ id: 2 })])',
        },
        isClientInitiated: false,
        prompt_id: 'prompt-parallel',
      },
      new AbortController().signal,
    );
    try {
      await vi.waitFor(() => expect(started).toBe(2), { timeout: 4000 });
    } finally {
      release();
    }
    await scheduled;
  }, 10_000);

  it('applies nested tool permission denial before execution', async () => {
    const config = makeFakeConfig({
      codeModeOnly: true,
      approvalMode: ApprovalMode.DEFAULT,
      targetDir: '/tmp',
      cwd: '/tmp',
    });
    const registry = new ToolRegistry(config);
    vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
    registry.registerTool(new ExecTool(config));
    const nestedExecute = vi.fn();
    registry.registerTool(
      new MockTool({
        name: 'denied_probe',
        kind: Kind.Read,
        params: { type: 'object' },
        getDefaultPermission: async () => 'deny',
        execute: nestedExecute,
      }),
    );
    const completed = vi.fn();
    const scheduler = new CoreToolScheduler({
      config,
      onAllToolCallsComplete: async (calls) => completed(calls),
      onToolCallsUpdate: vi.fn(),
      getPreferredEditor: () => undefined,
      onEditorClose: vi.fn(),
    });

    await scheduler.schedule(
      {
        callId: 'exec-denied',
        name: 'exec',
        args: { source: 'await tools.denied_probe({})' },
        isClientInitiated: false,
        prompt_id: 'prompt-denied',
      },
      new AbortController().signal,
    );

    expect(nestedExecute).not.toHaveBeenCalled();
    expect(completed.mock.calls[0]?.[0][0].status).toBe('error');
    expect(
      completed.mock.calls[0]?.[0][0].response.responseParts[0].functionResponse
        ?.response?.['error'],
    ).toContain('denied');
  }, 10_000);

  it('routes nested permission approval through the visible scheduler', async () => {
    const config = makeFakeConfig({
      codeModeOnly: true,
      approvalMode: ApprovalMode.DEFAULT,
      targetDir: '/tmp',
      cwd: '/tmp',
      interactive: true,
    });
    const registry = new ToolRegistry(config);
    vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
    registry.registerTool(new ExecTool(config));
    const execute = vi.fn().mockResolvedValue({
      llmContent: 'approved',
      returnDisplay: 'approved',
    });
    registry.registerTool(
      new MockTool({
        name: 'approval_probe',
        kind: Kind.Other,
        params: { type: 'object' },
        getDefaultPermission: async () => 'ask',
        getConfirmationDetails: async () => ({
          type: 'info',
          title: 'Approve nested tool',
          prompt: 'Continue?',
          onConfirm: vi.fn().mockResolvedValue(undefined),
        }),
        execute,
      }),
    );
    const updates: ToolCall[][] = [];
    const completed = vi.fn();
    const scheduler = new CoreToolScheduler({
      config,
      onAllToolCallsComplete: async (calls) => completed(calls),
      onToolCallsUpdate: (calls) => updates.push(calls),
      getPreferredEditor: () => undefined,
      onEditorClose: vi.fn(),
    });

    const controller = new AbortController();
    const scheduled = scheduler.schedule(
      {
        callId: 'exec-approval',
        name: 'exec',
        args: { source: 'await tools.approval_probe({})' },
        isClientInitiated: false,
        prompt_id: 'prompt-approval',
      },
      controller.signal,
    );
    await vi.waitFor(
      () => {
        expect(
          updates
            .flat()
            .some(
              (call) =>
                call.request.name === 'approval_probe' &&
                call.status === 'awaiting_approval',
            ),
        ).toBe(true);
      },
      { timeout: 4000 },
    );
    const waiting = updates
      .flat()
      .find(
        (call) =>
          call.request.name === 'approval_probe' &&
          call.status === 'awaiting_approval',
      ) as WaitingToolCall;
    await scheduler.handleConfirmationResponse(
      waiting.request.callId,
      waiting.confirmationDetails.onConfirm,
      ToolConfirmationOutcome.ProceedOnce,
      controller.signal,
    );

    await scheduled;
    await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce());
    expect(execute).toHaveBeenCalledOnce();
    expect(completed.mock.calls[0]?.[0][0].status).toBe('success');
  }, 10_000);

  it('runs nested hooks with the real tool name', async () => {
    const config = makeFakeConfig({
      codeModeOnly: true,
      approvalMode: ApprovalMode.DEFAULT,
      targetDir: '/tmp',
      cwd: '/tmp',
    });
    const messageBus = {
      request: vi
        .fn()
        .mockImplementation(async (request: { eventName: string }) => ({
          type: MessageBusType.HOOK_EXECUTION_RESPONSE,
          correlationId: `${request.eventName}-code-mode-test`,
          success: true,
          output: { decision: 'allow' },
        })),
    };
    config.setMessageBus(messageBus as unknown as MessageBus);
    const registry = new ToolRegistry(config);
    vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
    registry.registerTool(new ExecTool(config));
    registry.registerTool(
      new MockTool({
        name: 'hook_probe',
        kind: Kind.Read,
        params: { type: 'object' },
      }),
    );
    const completed = vi.fn();
    const scheduler = new CoreToolScheduler({
      config,
      onAllToolCallsComplete: async (calls) => completed(calls),
      onToolCallsUpdate: vi.fn(),
      getPreferredEditor: () => undefined,
      onEditorClose: vi.fn(),
    });

    await scheduler.schedule(
      {
        callId: 'exec-hooks',
        name: 'exec',
        args: { source: 'await tools.hook_probe({})' },
        isClientInitiated: false,
        prompt_id: 'prompt-hooks',
      },
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce());

    for (const eventName of ['PreToolUse', 'PostToolUse']) {
      expect(messageBus.request).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName,
          input: expect.objectContaining({ tool_name: 'hook_probe' }),
        }),
        MessageBusType.HOOK_EXECUTION_RESPONSE,
      );
    }
  }, 10_000);

  it('validates nested arguments before execution', async () => {
    const config = makeFakeConfig({
      codeModeOnly: true,
      approvalMode: ApprovalMode.DEFAULT,
      targetDir: '/tmp',
      cwd: '/tmp',
    });
    const registry = new ToolRegistry(config);
    vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
    registry.registerTool(new ExecTool(config));
    const execute = vi.fn();
    registry.registerTool(
      new MockTool({
        name: 'validated_probe',
        kind: Kind.Read,
        params: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
          additionalProperties: false,
        },
        execute,
      }),
    );
    const completed = vi.fn();
    const scheduler = new CoreToolScheduler({
      config,
      onAllToolCallsComplete: async (calls) => completed(calls),
      onToolCallsUpdate: vi.fn(),
      getPreferredEditor: () => undefined,
      onEditorClose: vi.fn(),
    });

    await scheduler.schedule(
      {
        callId: 'exec-invalid',
        name: 'exec',
        args: { source: 'await tools.validated_probe({})' },
        isClientInitiated: false,
        prompt_id: 'prompt-invalid',
      },
      new AbortController().signal,
    );

    expect(execute).not.toHaveBeenCalled();
    expect(completed.mock.calls[0]?.[0][0].status).toBe('error');
    expect(JSON.stringify(completed.mock.calls[0]?.[0][0].response)).toContain(
      'value',
    );
  }, 10_000);

  it('propagates parent cancellation to a running nested tool', async () => {
    const config = makeFakeConfig({
      codeModeOnly: true,
      approvalMode: ApprovalMode.DEFAULT,
      targetDir: '/tmp',
      cwd: '/tmp',
    });
    const registry = new ToolRegistry(config);
    vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
    registry.registerTool(new ExecTool(config));
    let nestedStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      nestedStarted = resolve;
    });
    let nestedAborted = false;
    registry.registerTool(
      new MockTool({
        name: 'wait_probe',
        kind: Kind.Read,
        canUpdateOutput: true,
        execute: (_params, signal) =>
          new Promise((_resolve, reject) => {
            nestedStarted();
            signal?.addEventListener(
              'abort',
              () => {
                nestedAborted = true;
                reject(signal.reason);
              },
              { once: true },
            );
          }),
      }),
    );
    const scheduler = new CoreToolScheduler({
      config,
      onAllToolCallsComplete: vi.fn(),
      onToolCallsUpdate: vi.fn(),
      getPreferredEditor: () => undefined,
      onEditorClose: vi.fn(),
    });
    const controller = new AbortController();
    const scheduled = scheduler.schedule(
      {
        callId: 'exec-cancel',
        name: 'exec',
        args: { source: 'await tools.wait_probe({})' },
        isClientInitiated: false,
        prompt_id: 'prompt-cancel',
      },
      controller.signal,
    );

    await started;
    controller.abort(new Error('cancelled by test'));
    await scheduled;
    expect(nestedAborted).toBe(true);
  }, 10_000);

  it('rejects an ordinary direct call on the CodeModeOnly surface', async () => {
    const config = makeFakeConfig({
      codeModeOnly: true,
      approvalMode: ApprovalMode.DEFAULT,
      targetDir: '/tmp',
      cwd: '/tmp',
    });
    const registry = new ToolRegistry(config);
    vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
    const execute = vi.fn();
    registry.registerTool(
      new MockTool({ name: 'read_probe', kind: Kind.Read, execute }),
    );
    const completed = vi.fn();
    const scheduler = new CoreToolScheduler({
      config,
      onAllToolCallsComplete: async (calls) => completed(calls),
      onToolCallsUpdate: vi.fn(),
      getPreferredEditor: () => undefined,
      onEditorClose: vi.fn(),
    });

    await scheduler.schedule(
      {
        callId: 'direct-read',
        name: 'read_probe',
        args: {},
        isClientInitiated: false,
        prompt_id: 'prompt-direct-read',
      },
      new AbortController().signal,
    );

    expect(execute).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce());
    const call = completed.mock.calls[0]?.[0][0];
    expect(call?.status).toBe('error');
    expect(JSON.stringify(call?.response.responseParts)).toContain(
      'unavailable on this CodeModeOnly call surface',
    );
  });

  it('enforces a restricted agent allowlist inside exec', async () => {
    const config = makeFakeConfig({
      codeModeOnly: true,
      approvalMode: ApprovalMode.DEFAULT,
      targetDir: '/tmp',
      cwd: '/tmp',
    });
    const registry = new ToolRegistry(config);
    vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
    registry.registerTool(new ExecTool(config));
    const read = vi.fn().mockResolvedValue({
      llmContent: 'read ok',
      returnDisplay: 'read ok',
    });
    const write = vi.fn();
    registry.registerTool(
      new MockTool({ name: 'read_probe', kind: Kind.Read, execute: read }),
    );
    registry.registerTool(
      new MockTool({ name: 'write_probe', kind: Kind.Edit, execute: write }),
    );
    const completed = vi.fn();
    const scheduler = new CoreToolScheduler({
      config,
      onAllToolCallsComplete: async (calls) => completed(calls),
      onToolCallsUpdate: vi.fn(),
      getPreferredEditor: () => undefined,
      onEditorClose: vi.fn(),
    });

    await expect(
      (
        scheduler as unknown as {
          dispatchCodeModeTool: (
            name: string,
            args: Record<string, unknown>,
            parent: {
              callId: string;
              name: string;
              args: Record<string, unknown>;
              isClientInitiated: boolean;
              prompt_id: string;
              codeModeAllowedToolNames: readonly string[];
            },
            signal: AbortSignal,
          ) => Promise<unknown>;
        }
      ).dispatchCodeModeTool(
        'write_probe',
        {},
        {
          callId: 'exec-restricted-dispatch',
          name: 'exec',
          args: {},
          isClientInitiated: false,
          prompt_id: 'prompt-restricted',
          codeModeAllowedToolNames: ['read_probe'],
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('not callable from exec');

    await scheduler.schedule(
      {
        callId: 'exec-restricted',
        name: 'exec',
        args: {
          source: `
            try { await tools.write_probe({}); }
            catch (error) { text(error.message); }
            return (await tools.read_probe({})).output;
          `,
        },
        isClientInitiated: false,
        prompt_id: 'prompt-restricted',
        codeModeAllowedToolNames: ['read_probe'],
      },
      new AbortController().signal,
    );

    expect(read).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
    expect(completed.mock.calls[0]?.[0][0].status).toBe('success');
    expect(
      completed.mock.calls[0]?.[0][0].response.responseParts[0].functionResponse
        ?.response?.['output'],
    ).toContain('Unknown or unavailable code mode tool: write_probe');
  }, 10_000);
});
