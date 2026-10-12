/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { ApprovalMode } from '../config/approval-mode.js';
import type { Config, ConfigParameters } from '../config/config.js';
import {
  CoreToolScheduler,
  type ToolCall,
  type WaitingToolCall,
} from '../core/coreToolScheduler.js';
import type { ToolCallRequestInfo } from '../core/turn.js';
import type { ChatRecordingService } from '../services/chatRecordingService.js';
import { makeFakeConfig } from '../test-utils/config.js';
import { MockTool } from '../test-utils/mock-tool.js';
import { ExecTool } from '../tools/exec.js';
import { ToolSearchTool } from '../tools/tool-search.js';
import { getToolCallRuntime } from './tool-call-runtime.js';
import {
  Kind,
  ToolConfirmationOutcome,
  type AnyDeclarativeTool,
} from '../tools/tools.js';
import { ToolNames } from '../tools/tool-names.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { UpdateGoalTool } from '../goals/goal-tools.js';
import type { GoalRuntime } from '../goals/goal-runtime.js';
import { MessageBusType } from '../confirmation-bus/types.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
const pngPart = () => ({
  inlineData: { mimeType: 'image/png', data: TINY_PNG_BASE64 },
});

// A CodeModeOnly scheduler whose registry holds ExecTool (unless `exec` is
// false) followed by `tools`; `configure` runs before the registry is built.
function setup(
  tools: AnyDeclarativeTool[] = [],
  opts: {
    params?: Partial<ConfigParameters>;
    configure?: (config: Config) => void;
    exec?: boolean;
    onToolCallsUpdate?: (calls: ToolCall[]) => void;
  } = {},
) {
  const config = makeFakeConfig({
    codeModeOnly: true,
    approvalMode: ApprovalMode.DEFAULT,
    chatRecording: false,
    targetDir: '/tmp',
    cwd: '/tmp',
    ...opts.params,
  });
  opts.configure?.(config);
  const registry = new ToolRegistry(config);
  vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
  if (opts.exec !== false) registry.registerTool(new ExecTool(config));
  for (const tool of tools) registry.registerTool(tool);
  const completed = vi.fn();
  const scheduler = new CoreToolScheduler({
    config,
    onAllToolCallsComplete: async (calls) => completed(calls),
    onToolCallsUpdate: opts.onToolCallsUpdate ?? vi.fn(),
    getPreferredEditor: () => undefined,
    onEditorClose: vi.fn(),
  });
  // Schedules an `exec` call (args `{ source }`, or `{}` without a source).
  const run = (
    callId: string,
    prompt_id: string,
    source?: string,
    extra: Partial<ToolCallRequestInfo> = {},
    signal = new AbortController().signal,
  ) =>
    scheduler.schedule(
      {
        callId,
        name: 'exec',
        args: source === undefined ? {} : { source },
        isClientInitiated: false,
        prompt_id,
        ...extra,
      },
      signal,
    );
  const call = () => completed.mock.calls[0]?.[0][0];
  const fnResponse = () => call().response.responseParts[0].functionResponse;
  return { scheduler, completed, run, call, fnResponse };
}

// The first tool-call update entry for `name` (optionally in `status`).
const findUpdate = (updates: ToolCall[][], name: string, status?: string) =>
  updates
    .flat()
    .find(
      (call) =>
        call.request.name === name &&
        (status === undefined || call.status === status),
    );

describe('CodeModeOnly scheduler dispatch', () => {
  it('searches a scoped deferred tool, executes it, and still validates arguments', async () => {
    const config = makeFakeConfig({
      codeModeOnly: true,
      targetDir: '/tmp',
      cwd: '/tmp',
    });
    const registry = new ToolRegistry(config);
    vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
    const execute = vi.fn(async () => ({
      llmContent: 'DEFERRED_RESULT',
      returnDisplay: 'read',
    }));
    registry.registerTool(new ExecTool(config));
    registry.registerTool(new ToolSearchTool(config));
    registry.registerTool(
      new MockTool({
        name: 'deferred-read',
        shouldDefer: true,
        kind: Kind.Read,
        params: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        execute,
      }),
    );
    registry.registerTool(
      new MockTool({ name: 'secret_read', shouldDefer: true }),
    );
    const completed = vi.fn();
    const scheduler = new CoreToolScheduler({
      config,
      onAllToolCallsComplete: async (calls) => completed(calls),
      onToolCallsUpdate: vi.fn(),
      getPreferredEditor: () => undefined,
      onEditorClose: vi.fn(),
    });
    const declarations = registry.getFunctionDeclarationsFiltered([
      'tool_search',
      'deferred-read',
    ]);
    const run = async (name: string, args: Record<string, unknown>) => {
      await scheduler.schedule(
        {
          callId: `${name}-${completed.mock.calls.length}`,
          name,
          args,
          isClientInitiated: false,
          prompt_id: 'lazy-code',
          codeModeAllowedToolNames: ['deferred-read'],
        },
        new AbortController().signal,
      );
      return completed.mock.calls.at(-1)![0][0];
    };
    const search = await run('tool_search', {
      query: 'select:deferred-read,secret_read',
    });
    expect(search.status).toBe('success');
    const content = JSON.stringify(search.response.responseParts);
    expect(content).toContain('tools.deferred_read(args:');
    expect(content).not.toContain('tools.secret_read(args:');
    const valid = await run('exec', {
      source: 'text(await tools.deferred_read({path: "/tmp/test"}));',
    });
    expect(valid.status).toBe('success');
    expect(JSON.stringify(valid.response.responseParts)).toContain(
      'DEFERRED_RESULT',
    );
    expect(execute).toHaveBeenCalledOnce();
    const invalid = await run('exec', {
      source: 'text(await tools.deferred_read({}));',
    });
    expect(invalid.status).toBe('error');
    expect(JSON.stringify(invalid.response.responseParts)).toContain(
      "required property 'path'",
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(
      registry.getFunctionDeclarationsFiltered([
        'tool_search',
        'deferred-read',
      ]),
    ).toEqual(declarations);
  }, 15_000);

  it('keeps the Goal permit and termination metadata for a nested proposal', async () => {
    const permit = {
      goalId: 'goal-nested',
      revision: 2,
      turnId: 'turn-nested',
    };
    const recordTerminalProposal = vi.fn().mockReturnValue({
      recorded: true,
      readyForVerification: true,
    });
    const getGoalForWorker = vi.fn().mockResolvedValue({
      goalId: permit.goalId,
      revision: permit.revision,
      objective: 'Verified output',
      evidenceCursor: { recordId: 'goal-created' },
    });
    const getSnapshotForPermit = vi.fn().mockReturnValue({
      goal: { status: 'active' },
    });
    const goalTool = new UpdateGoalTool({
      getGoalRuntime: () =>
        ({
          getGoalForWorker,
          getSnapshotForPermit,
          recordTerminalProposal,
        }) as unknown as GoalRuntime,
    });
    const onResult = vi.fn();
    const proposal = {
      status: 'complete' as const,
      reason: 'Verified output',
    };
    const exec = new MockTool({
      name: 'exec',
      execute: async (_params, signal) => {
        const value = await getToolCallRuntime()!.dispatch(
          'update_goal',
          proposal,
          signal ?? new AbortController().signal,
          onResult,
        );
        return { llmContent: JSON.stringify(value), returnDisplay: '' };
      },
    });
    const { run, completed } = setup([exec, goalTool], { exec: false });

    await run('exec-goal', 'prompt-nested-goal', undefined, {
      goalContext: permit,
    });

    const last = () => completed.mock.calls.at(-1)?.[0]?.[0];
    expect(last()?.response.error).toBeUndefined();
    expect(getGoalForWorker).toHaveBeenCalledWith(permit);
    expect(recordTerminalProposal).toHaveBeenCalledWith(permit, proposal);
    expect(onResult).toHaveBeenCalledWith(
      expect.objectContaining({
        terminateTurn: true,
        executionStatus: 'success',
      }),
    );
    expect(last()).toMatchObject({ status: 'success' });
  });

  it('returns image() output to the model as inline media', async () => {
    const { run, completed, call, fnResponse } = setup();

    await run(
      'exec-image',
      'prompt-image',
      `text('caption'); image('data:image/png;base64,${TINY_PNG_BASE64}');`,
    );

    expect(completed).toHaveBeenCalledOnce();
    expect(fnResponse()?.response?.['output']).toBe('caption');
    expect(fnResponse()?.parts).toEqual([pngPart()]);
    expect(call().response.resultDisplay).toBe('caption');
    expect(JSON.stringify(fnResponse())).not.toContain('Media output:');
  }, 10_000);

  it.each(['image', 'audio'] as const)(
    'preserves emitted %s and text when exec fails',
    async (kind) => {
      const { run, call, fnResponse } = setup([], {
        params: { approvalMode: undefined },
        configure: (config) =>
          vi
            .spyOn(config, 'getEffectiveInputModalities')
            .mockReturnValue({ image: true }),
      });
      const mimeType = kind === 'image' ? 'image/png' : 'audio/wav';
      const data = kind === 'image' ? TINY_PNG_BASE64 : 'QUJD';
      await run(
        'exec-failure-media',
        'media-failure',
        `text('DONE'); ${kind}('data:${mimeType};base64,${data}'); throw new Error('LATER');`,
      );
      expect(call().status).toBe('error');
      const response = fnResponse();
      expect(response.response.error).toContain('DONE');
      expect(response.response.error).toContain('LATER');
      expect(response.parts).toEqual([{ inlineData: { mimeType, data } }]);
    },
    10_000,
  );

  it('normalizes a nested MCP image for image(result.content[0])', async () => {
    const { run, fnResponse } = setup([
      new MockTool({
        name: 'mcp_screenshot',
        kind: Kind.Read,
        params: { type: 'object', additionalProperties: false },
        execute: async () => ({
          llmContent: [{ text: 'MCP screenshot' }, pngPart()],
          returnDisplay: 'MCP screenshot',
        }),
      }),
    ]);

    await run(
      'exec-mcp-image',
      'prompt-mcp-image',
      `const result = await tools.mcp_screenshot({});
            image(result.content[0]);`,
    );

    expect(fnResponse()?.parts).toEqual([pngPart()]);
  }, 10_000);

  it('passes the Qwen image_gen result to generatedImage()', async () => {
    const saved = 'Generated image saved to /tmp/generated.png.';
    const { run, fnResponse } = setup(
      [
        new MockTool({
          name: 'image_gen',
          kind: Kind.Read,
          params: {
            type: 'object',
            properties: { prompt: { type: 'string' } },
            required: ['prompt'],
          },
          execute: async () => ({
            llmContent: [{ text: saved }, pngPart()],
            returnDisplay: saved,
          }),
        }),
      ],
      {
        params: {
          imageModel: 'openai:qwen-image-2.0',
          modelProvidersConfig: {
            openai: [
              {
                id: 'qwen-image-2.0',
                baseUrl: 'https://images.example/v1',
                envKey: 'TEST_IMAGE_API_KEY',
                imageOnly: true,
              },
            ],
          },
        },
      },
    );

    await run(
      'exec-generated-image',
      'prompt-generated-image',
      `const result = await tools.image_gen({ prompt: 'poster' });
            generatedImage(result);`,
    );

    expect(fnResponse()?.response?.['output']).toBe(saved);
    expect(fnResponse()?.parts).toEqual([pngPart()]);
  }, 10_000);

  it('awaits a nested tool without self-queue deadlock and reports the real name', async () => {
    const nestedExecute = vi.fn().mockImplementation(async () => {
      expect(getToolCallRuntime()).toBeUndefined();
      return {
        llmContent: 'nested output',
        returnDisplay: 'nested output',
      };
    });
    const updates: ToolCall[][] = [];
    const { run, completed, fnResponse } = setup(
      [
        new MockTool({
          name: 'read_probe',
          kind: Kind.Read,
          params: { type: 'object', additionalProperties: false },
          execute: nestedExecute,
        }),
      ],
      { onToolCallsUpdate: (calls) => updates.push(calls) },
    );

    await run(
      'exec-parent',
      'prompt-1',
      'const result = await tools.read_probe({}); text(result.output);',
    );

    expect(nestedExecute).toHaveBeenCalledOnce();
    expect(findUpdate(updates, 'read_probe')?.request).toMatchObject({
      callId: 'exec-parent:code:1',
      parentCallId: 'exec-parent',
      source: 'code_mode',
    });
    expect(completed).toHaveBeenCalledOnce();
    expect(fnResponse()?.response?.['output']).toContain('nested output');
  }, 10_000);

  it('records no nested code_mode result when the call is outside a Goal turn', async () => {
    const recordToolResult = vi.fn();
    const { run, fnResponse } = setup(
      [
        new MockTool({
          name: 'read_probe',
          kind: Kind.Read,
          params: { type: 'object', additionalProperties: false },
          execute: async () => ({
            llmContent: 'nested output',
            returnDisplay: 'nested output',
          }),
        }),
      ],
      {
        configure: (config) =>
          vi.spyOn(config, 'getChatRecordingService').mockReturnValue({
            recordToolResult,
          } as unknown as ChatRecordingService),
      },
    );

    await run(
      'exec-nogoal',
      'prompt-nogoal',
      'const result = await tools.read_probe({}); text(result.output);',
    );

    // Positive control: without it the negative below also passes when the
    // nested call never dispatches.
    expect(fnResponse()?.response?.['output']).toContain('nested output');
    expect(recordToolResult).not.toHaveBeenCalled();
  }, 10_000);

  it('runs Promise.all reads in one scheduler batch', async () => {
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { run } = setup([
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
    ]);

    const scheduled = run(
      'exec-parallel',
      'prompt-parallel',
      'await Promise.all([tools.parallel_read({ id: 1 }), tools.parallel_read({ id: 2 })])',
    );
    try {
      await vi.waitFor(() => expect(started).toBe(2), { timeout: 30_000 });
    } finally {
      release();
    }
    await scheduled;
  }, 40_000);

  it('runs Code Mode Bash calls in one Promise.allSettled batch', async () => {
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
        name: ToolNames.SHELL,
        kind: Kind.Execute,
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
        callId: 'exec-parallel-shell',
        name: ToolNames.EXEC,
        args: {
          source:
            "await Promise.allSettled([tools.run_shell_command({ command: 'first' }), tools.run_shell_command({ command: 'second' })]);",
        },
        isClientInitiated: false,
        prompt_id: 'prompt-parallel-shell',
      },
      new AbortController().signal,
    );
    try {
      await vi.waitFor(() => expect(started).toBe(2), { timeout: 30_000 });
    } finally {
      release();
    }
    await scheduled;
  }, 40_000);

  it('applies nested tool permission denial before execution', async () => {
    const nestedExecute = vi.fn();
    const { run, call, fnResponse } = setup([
      new MockTool({
        name: 'denied_probe',
        kind: Kind.Read,
        params: { type: 'object' },
        getDefaultPermission: async () => 'deny',
        execute: nestedExecute,
      }),
    ]);

    await run('exec-denied', 'prompt-denied', 'await tools.denied_probe({})');

    expect(nestedExecute).not.toHaveBeenCalled();
    expect(call().status).toBe('error');
    expect(fnResponse()?.response?.['error']).toContain('denied');
  }, 10_000);

  it('routes nested permission approval through the visible scheduler', async () => {
    const execute = vi.fn().mockResolvedValue({
      llmContent: 'approved',
      returnDisplay: 'approved',
    });
    const updates: ToolCall[][] = [];
    const { scheduler, run, completed, call } = setup(
      [
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
      ],
      {
        params: { interactive: true },
        onToolCallsUpdate: (calls) => updates.push(calls),
      },
    );

    const controller = new AbortController();
    const scheduled = run(
      'exec-approval',
      'prompt-approval',
      'await tools.approval_probe({})',
      {},
      controller.signal,
    );
    const waiting = () =>
      findUpdate(updates, 'approval_probe', 'awaiting_approval');
    await vi.waitFor(() => expect(waiting() !== undefined).toBe(true), {
      timeout: 30_000,
    });
    const { request, confirmationDetails } = waiting() as WaitingToolCall;
    await scheduler.handleConfirmationResponse(
      request.callId,
      confirmationDetails.onConfirm,
      ToolConfirmationOutcome.ProceedOnce,
      controller.signal,
    );

    await scheduled;
    await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce());
    expect(execute).toHaveBeenCalledOnce();
    expect(call().status).toBe('success');
  }, 40_000);

  it('runs nested hooks with the real tool name', async () => {
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
    const { run, completed } = setup(
      [
        new MockTool({
          name: 'hook_probe',
          kind: Kind.Read,
          params: { type: 'object' },
        }),
      ],
      {
        configure: (config) =>
          config.setMessageBus(messageBus as unknown as MessageBus),
      },
    );

    await run('exec-hooks', 'prompt-hooks', 'await tools.hook_probe({})');
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

  it('delivers nested PreToolUse context with the exec result, not the script value', async () => {
    const config = makeFakeConfig({
      codeModeOnly: true,
      approvalMode: ApprovalMode.DEFAULT,
      targetDir: '/tmp',
      cwd: '/tmp',
    });
    const messageBus = {
      request: vi
        .fn()
        .mockImplementation(
          async (request: {
            eventName: string;
            input?: { tool_name?: string; tool_call_id?: string };
          }) => ({
            type: MessageBusType.HOOK_EXECUTION_RESPONSE,
            correlationId: `${request.eventName}-code-mode-test`,
            success: true,
            output:
              request.eventName === 'PreToolUse' &&
              request.input?.tool_name === 'hook_probe'
                ? {
                    hookSpecificOutput: {
                      hookEventName: 'PreToolUse',
                      additionalContext: `NESTED_CTX_${request.input.tool_call_id}`,
                    },
                  }
                : {},
          }),
        ),
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
        execute: vi.fn(async () => ({
          llmContent: 'PROBE_RAW',
          returnDisplay: 'probe',
        })),
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
        callId: 'exec-ctx',
        name: 'exec',
        // Consumes the nested result without printing it.
        args: {
          source:
            'const r = JSON.stringify(await tools.hook_probe({})); text(r.includes("PROBE_RAW") && !r.includes("NESTED_CTX") ? "raw" : "changed")',
        },
        isClientInitiated: false,
        prompt_id: 'prompt-ctx',
      },
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce());

    const [execCall] = completed.mock.calls[0][0] as ToolCall[];
    expect(execCall.status).toBe('success');
    const text = JSON.stringify(
      (execCall as { response: { responseParts: unknown } }).response
        .responseParts,
    );
    expect(text).toContain('raw');
    expect(text).not.toContain('changed');
    expect(text.split('NESTED_CTX_exec-ctx:code:1').length - 1).toBe(1);
  }, 10_000);

  it('delivers nested PostToolUseFailure context with the exec result, not the script error', async () => {
    const config = makeFakeConfig({
      codeModeOnly: true,
      approvalMode: ApprovalMode.DEFAULT,
      targetDir: '/tmp',
      cwd: '/tmp',
    });
    const messageBus = {
      request: vi
        .fn()
        .mockImplementation(
          async (request: {
            eventName: string;
            input?: { tool_name?: string; tool_call_id?: string };
          }) => ({
            type: MessageBusType.HOOK_EXECUTION_RESPONSE,
            correlationId: `${request.eventName}-code-mode-test`,
            success: true,
            output:
              request.eventName === 'PostToolUseFailure' &&
              request.input?.tool_name === 'hook_probe'
                ? {
                    hookSpecificOutput: {
                      hookEventName: 'PostToolUseFailure',
                      additionalContext: `NESTED_FAIL_${request.input.tool_call_id}`,
                    },
                  }
                : {},
          }),
        ),
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
        execute: vi.fn(async () => ({
          llmContent: 'probe failed',
          returnDisplay: 'probe failed',
          error: { message: 'probe failed' },
        })),
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
        callId: 'exec-fail',
        name: 'exec',
        // Swallows the nested error without printing it.
        args: {
          source:
            'let seen = ""; try { await tools.hook_probe({}); } catch (error) { seen = String(error && error.message); } text(seen.includes("NESTED_FAIL") ? "changed" : seen ? "raw" : "no error")',
        },
        isClientInitiated: false,
        prompt_id: 'prompt-fail',
      },
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce());

    const [execCall] = completed.mock.calls[0][0] as ToolCall[];
    expect(execCall.status).toBe('success');
    const text = JSON.stringify(
      (execCall as { response: { responseParts: unknown } }).response
        .responseParts,
    );
    expect(text).toContain('raw');
    expect(text).not.toContain('changed');
    expect(text.split('NESTED_FAIL_exec-fail:code:1').length - 1).toBe(1);
  }, 10_000);

  it('validates nested arguments before execution', async () => {
    const execute = vi.fn();
    const { run, call } = setup([
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
    ]);

    await run(
      'exec-invalid',
      'prompt-invalid',
      'await tools.validated_probe({})',
    );

    expect(execute).not.toHaveBeenCalled();
    expect(call().status).toBe('error');
    expect(JSON.stringify(call().response)).toContain('value');
  }, 10_000);

  it('propagates parent cancellation to a running nested tool', async () => {
    let nestedStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      nestedStarted = resolve;
    });
    let nestedAborted = false;
    const { run } = setup([
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
    ]);
    const controller = new AbortController();
    const scheduled = run(
      'exec-cancel',
      'prompt-cancel',
      'await tools.wait_probe({})',
      {},
      controller.signal,
    );

    await started;
    controller.abort(new Error('cancelled by test'));
    await scheduled;
    expect(nestedAborted).toBe(true);
  }, 10_000);

  it('rejects an ordinary direct call on the CodeModeOnly surface', async () => {
    const execute = vi.fn();
    const { run, completed, call } = setup(
      [new MockTool({ name: 'read_probe', kind: Kind.Read, execute })],
      { exec: false },
    );

    await run('direct-read', 'prompt-direct-read', undefined, {
      name: 'read_probe',
    });

    expect(execute).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce());
    expect(call()?.status).toBe('error');
    expect(JSON.stringify(call()?.response.responseParts)).toContain(
      'unavailable on this CodeModeOnly call surface',
    );
  });

  it('enforces a restricted agent allowlist inside exec', async () => {
    const read = vi.fn().mockResolvedValue({
      llmContent: 'read ok',
      returnDisplay: 'read ok',
    });
    const write = vi.fn();
    const { scheduler, run, call, fnResponse } = setup([
      new MockTool({ name: 'read_probe', kind: Kind.Read, execute: read }),
      new MockTool({ name: 'write_probe', kind: Kind.Edit, execute: write }),
    ]);
    const restricted = { codeModeAllowedToolNames: ['read_probe'] };

    await expect(
      (
        scheduler as unknown as {
          dispatchCodeModeTool: (...args: unknown[]) => Promise<unknown>;
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
          ...restricted,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('not callable from exec');

    await run(
      'exec-restricted',
      'prompt-restricted',
      `
            try { await tools.write_probe({}); }
            catch (error) { text(error.message); }
            return (await tools.read_probe({})).output;
          `,
      restricted,
    );

    expect(read).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
    expect(call().status).toBe('success');
    expect(fnResponse()?.response?.['output']).toContain(
      'Unknown or unavailable code mode tool: write_probe',
    );
  }, 10_000);
});
