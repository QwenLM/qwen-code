/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Part } from '@google/genai';
import { SendMessageType } from '@qwen-code/qwen-code-core/core/client.js';
import { LlmEventType } from '@qwen-code/qwen-code-core/core/turn.js';
import { MockTool } from '@qwen-code/qwen-code-core/test-utils/mock-tool.js';
import { makeFakeConfig } from '@qwen-code/qwen-code-core/test-utils/config.js';
import { ToolRegistry } from '@qwen-code/qwen-code-core/tools/tool-registry.js';
import { ToolErrorType } from '@qwen-code/qwen-code-core/utils/tool-error-type.js';
import type {
  Config,
  ServerLlmStreamEvent,
  SendMessageOptions,
  ToolCallRequestInfo,
} from '@qwen-code/qwen-code-core';
import type {
  InteractiveModToolScheduler,
  InteractiveToolCall,
  InteractiveCompletedToolCall,
} from '../../services/interactive-mod-tool-scheduler.js';
import { DualOutputBridge } from '../../dualOutput/DualOutputBridge.js';
import type {
  CLIMessage,
  CLIAssistantMessage,
  CLIUserMessage,
  CLIPartialAssistantMessage,
  ControlMessage,
} from '../../nonInteractive/types.js';
import {
  livePromptEvents,
  type LivePromptOptions,
  type PreparedLiveRequest,
} from './live-session.js';

type SchedulerOptions = ConstructorParameters<
  typeof InteractiveModToolScheduler
>[0];
const control = vi.hoisted(() => ({
  schedule: vi.fn(),
  expand: vi.fn(),
  vision: vi.fn(),
  finalize: vi.fn(),
}));
vi.mock('../../services/interactive-mod-session.js', () => ({
  getInteractiveModSession: () => null,
}));
vi.mock('../../services/interactive-mod-tool-scheduler.js', () => ({
  InteractiveModToolScheduler: class {
    constructor(private readonly options: SchedulerOptions) {}
    schedule(requests: ToolCallRequestInfo[], signal: AbortSignal) {
      return control.schedule(this.options, requests, signal);
    }
  },
}));
vi.mock('../hooks/atCommandProcessor.js', () => ({
  handleAtCommand: (options: unknown) => control.expand(options),
}));
vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@qwen-code/qwen-code-core')>()),
  runVisionBridge: (options: unknown) => control.vision(options),
  finalizeToolResponses: (...args: unknown[]) => control.finalize(...args),
}));

type Frame = CLIMessage | ControlMessage;
const content = (value: string): ServerLlmStreamEvent => ({
  type: LlmEventType.Content,
  value,
});
const request: ToolCallRequestInfo = {
  callId: 'call-one',
  name: 'read_file',
  args: { file_path: '/owned/input' },
  isClientInitiated: false,
  prompt_id: 'prompt-one',
};
const tool = new MockTool({ name: request.name });
function completed(
  status: 'success' | 'error' | 'cancelled' = 'success',
  id = request.callId,
): InteractiveCompletedToolCall {
  return {
    request: { ...request, callId: id },
    status,
    tool,
    invocation: tool.build(request.args),
    response: {
      callId: id,
      resultDisplay: 'tool-result',
      responseParts: [
        {
          functionResponse: {
            id,
            name: request.name,
            response: { output: 'tool-result' },
          },
        },
      ],
      error: status === 'error' ? new Error('tool-failure') : undefined,
      errorType:
        status === 'error' ? ToolErrorType.EXECUTION_FAILED : undefined,
    },
  };
}
function waiting(id = request.callId): InteractiveToolCall {
  return {
    status: 'awaiting_approval',
    request: { ...request, callId: id },
    tool,
    invocation: tool.build(request.args),
    confirmationDetails: {
      type: 'info',
      title: 'Read?',
      prompt: 'Read?',
      onConfirm: async () => {},
    },
  };
}
function assistants(frames: Frame[]) {
  return frames.filter(
    (frame): frame is CLIAssistantMessage => frame.type === 'assistant',
  );
}
function users(frames: Frame[]) {
  return frames.filter(
    (frame): frame is CLIUserMessage => frame.type === 'user',
  );
}
function userBlocks(frames: Frame[]) {
  return users(frames).flatMap((frame) => {
    if (typeof frame.message.content === 'string')
      throw new Error('expected structured user content');
    return frame.message.content;
  });
}
function streamEvents(frames: Frame[]) {
  return frames
    .filter(
      (frame): frame is CLIPartialAssistantMessage =>
        frame.type === 'stream_event',
    )
    .map((frame) => frame.event);
}
async function drain(generator: AsyncGenerator<unknown>) {
  for await (const _event of generator) {
    /* drain the actual producer */
  }
}

const roots: string[] = [];
const bridges: DualOutputBridge[] = [];
function setup(
  send: (...args: unknown[]) => unknown,
  visionModel?: { id: string },
) {
  const root = mkdtempSync(join(tmpdir(), 'opentui-output-'));
  roots.push(root);
  const path = join(root, 'events.jsonl');
  const recorder = {
    recordMidTurnUserMessage: vi.fn(),
    recordToolResult: vi.fn(),
  };
  const client = {
    sendMessageStream: vi.fn(send),
    isInitialized: () => true,
    getChat: () => ({ getGenerationConfig: () => ({ tools: [] }) }),
    addHistory: vi.fn(async () => {}),
  };
  const config = {
    initialize: vi.fn(async () => {}),
    getGeminiClient: () => client,
    getSessionId: () => 'session-output',
    getModel: () => 'test-model',
    getMaxSessionTurns: () => 10,
    getContentGeneratorConfig: () => ({ authType: 'openai' }),
    getDefaultVisionBridgeModel: () => visionModel,
    getChatRecordingService: () => recorder,
    getDebugLogger: () => ({
      debug: () => {},
      warn: () => {},
      error: () => {},
    }),
  } as unknown as Config;
  const bridge = new DualOutputBridge(config, { filePath: path });
  bridges.push(bridge);
  return {
    config,
    client,
    bridge,
    recorder,
    run: (
      prompt: string | Part[] = 'hello',
      options: LivePromptOptions = {},
      signal?: AbortSignal,
    ) =>
      drain(
        livePromptEvents(config, prompt, signal, {
          ...options,
          dualOutput: bridge,
        }),
      ),
    async frames(): Promise<Frame[]> {
      await bridge.shutdown();
      const raw = readFileSync(path, 'utf8');
      expect(raw.endsWith('\n')).toBe(true);
      expect(raw).not.toContain('\x1b');
      const frames: Frame[] = raw
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(frames[0]).toMatchObject({
        type: 'system',
        subtype: 'session_start',
      });
      expect(frames.at(-1)).toMatchObject({
        type: 'system',
        subtype: 'session_end',
      });
      expect(
        frames.filter(
          (frame) =>
            frame.type === 'system' && frame.subtype === 'session_start',
        ),
      ).toHaveLength(1);
      expect(
        frames.filter(
          (frame) => frame.type === 'system' && frame.subtype === 'session_end',
        ),
      ).toHaveLength(1);
      return frames;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  control.expand.mockResolvedValue({
    processedQuery: [{ text: 'expanded-file' }],
    shouldProceed: true,
  });
  control.schedule.mockImplementation(async (options: SchedulerOptions) => {
    await options.onAllToolCallsComplete([completed()]);
  });
  control.finalize.mockImplementation(
    async (_config: unknown, calls: unknown[]) => calls,
  );
});
afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.shutdown()));
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe('OpenTUI live output through the real JSON writer', () => {
  it('preserves ordered thought/text deltas and final content exactly once', async () => {
    const h = setup(function* () {
      yield { type: 'thought', value: { subject: '', description: 'think-' } };
      yield { type: 'thought', value: { subject: '', description: 'once' } };
      yield content('answer-');
      yield content('once');
    });
    await h.run();
    const frames = await h.frames();
    expect(users(frames).map((frame) => frame.message.content)).toEqual([
      [{ type: 'text', text: 'hello' }],
    ]);
    expect(
      assistants(frames).flatMap((frame) => frame.message.content),
    ).toEqual([
      { type: 'thinking', thinking: 'think-once', signature: '' },
      { type: 'text', text: 'answer-once' },
    ]);
    const events = streamEvents(frames);
    expect(
      events
        .filter((event) => event.type === 'content_block_delta')
        .map((event) => event.delta),
    ).toEqual([
      { type: 'thinking_delta', thinking: 'think-' },
      { type: 'thinking_delta', thinking: 'once' },
      { type: 'text_delta', text: 'answer-' },
      { type: 'text_delta', text: 'once' },
    ]);
    expect(
      events.filter((event) => event.type === 'message_start'),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === 'message_stop'),
    ).toHaveLength(1);
    expect(frames.filter((frame) => frame.type === 'result')).toEqual([]);
  });

  it('emits the prepared @ expansion and attached bytes, not the typed alias', async () => {
    const h = setup(function* () {});
    const image = { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } };
    await h.run([{ text: '@owned' }, image], { submittedPrompt: '@owned' });
    expect(h.client.sendMessageStream.mock.calls[0][0]).toEqual([
      { text: 'expanded-file' },
      image,
    ]);
    expect(users(await h.frames())[0].message.content).toEqual([
      { type: 'text', text: 'expanded-file' + JSON.stringify(image) },
    ]);
  });

  it('does not re-expand generated @ content or invent an extra user from its UI echo', async () => {
    const h = setup(function* () {
      yield content('done');
    });
    await h.run('@generated');
    expect(control.expand).not.toHaveBeenCalled();
    expect(
      users(await h.frames()).map((frame) => frame.message.content),
    ).toEqual([[{ type: 'text', text: '@generated' }]]);
  });

  it('does not emit an explicitly declined @ submission', async () => {
    control.expand.mockResolvedValue({
      processedQuery: null,
      shouldProceed: false,
    });
    const h = setup(function* () {
      yield content('must-not-run');
    });
    await h.run('@missing', { submittedPrompt: '@missing' });
    expect(h.client.sendMessageStream).not.toHaveBeenCalled();
    expect(await h.frames()).toHaveLength(2);
  });

  it('mirrors the prepared vision description using the existing adapter projection', async () => {
    control.vision.mockResolvedValue({
      applied: true,
      status: 'ok',
      parts: [{ text: 'look' }, { text: 'converted-image' }],
      convertedCount: 1,
      omittedCount: 0,
      modelId: 'vision',
      egressOccurred: true,
    });
    const h = setup(function* () {}, { id: 'vision' });
    await h.run([
      { text: 'look' },
      { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } },
    ]);
    expect(control.vision).toHaveBeenCalledOnce();
    expect(h.client.sendMessageStream.mock.calls[0][0]).toEqual([
      { text: 'look' },
      { text: 'converted-image' },
    ]);
    expect(userBlocks(await h.frames())).toEqual([
      { type: 'text', text: 'lookconverted-image' },
    ]);
  });

  it('does not emit a user if cancellation wins before preparation', async () => {
    const abort = new AbortController();
    abort.abort();
    const h = setup(function* () {});
    await expect(h.run('cancelled', {}, abort.signal)).rejects.toBeDefined();
    expect(h.client.sendMessageStream).not.toHaveBeenCalled();
    expect(await h.frames()).toHaveLength(2);
  });

  it.each([
    'empty',
    'max_session_turns',
    'session_token_limit_exceeded',
    'loop_detected',
  ])('does not fabricate an assistant for a %s early exit', async (kind) => {
    const h = setup(function* () {
      if (kind !== 'empty')
        yield {
          type: kind,
          value:
            kind === 'session_token_limit_exceeded'
              ? { currentTokens: 200, limit: 100 }
              : {},
        };
    });
    await h.run();
    const frames = await h.frames();
    expect(users(frames)).toHaveLength(1);
    expect(assistants(frames)).toEqual([]);
    expect(streamEvents(frames)).toEqual([]);
  });

  it('finalizes partial output before propagating a provider failure', async () => {
    const failure = new Error('provider-failure');
    const h = setup(function* () {
      yield content('partial');
      throw failure;
    });
    await expect(h.run()).rejects.toBe(failure);
    const frames = await h.frames();
    expect(
      assistants(frames).flatMap((frame) => frame.message.content),
    ).toEqual([{ type: 'text', text: 'partial' }]);
    expect(streamEvents(frames).at(-1)).toEqual({ type: 'message_stop' });
  });

  it('closes a partial on same-generation abort and rejects a late provider chunk', async () => {
    const abort = new AbortController();
    const h = setup(function* () {
      yield content('partial');
      abort.abort();
      yield content('late-tail');
    });
    await h.run('hello', {}, abort.signal);
    const frames = await h.frames();
    expect(
      assistants(frames).flatMap((frame) => frame.message.content),
    ).toEqual([{ type: 'text', text: 'partial' }]);
    expect(JSON.stringify(frames)).not.toContain('late-tail');
    expect(streamEvents(frames).at(-1)).toEqual({ type: 'message_stop' });
  });

  it('stale callbacks cannot append to or finalize the successor adapter', async () => {
    let current = true;
    const h = setup(function* () {
      yield content('old-partial');
      h.bridge.finalizeAssistantMessage();
      current = false;
      h.bridge.emitUserMessage([{ text: 'successor' }]);
      h.bridge.startAssistantMessage();
      h.bridge.processEvent(content('new-partial'));
      yield content('stale-tail');
    });
    await h.run('old', { isCurrentTurn: () => current });
    h.bridge.processEvent(content('-complete'));
    h.bridge.finalizeAssistantMessage();
    const frames = await h.frames();
    expect(
      assistants(frames).flatMap((frame) => frame.message.content),
    ).toEqual([
      { type: 'text', text: 'old-partial' },
      { type: 'text', text: 'new-partial-complete' },
    ]);
    expect(
      streamEvents(frames).filter((event) => event.type === 'message_stop'),
    ).toHaveLength(2);
  });

  it('stale preparation cannot start a stream or publish a user', async () => {
    const h = setup(function* () {});
    await h.run('old', { isCurrentTurn: () => false });
    expect(h.client.sendMessageStream).not.toHaveBeenCalled();
    expect(await h.frames()).toHaveLength(2);
  });
});

function toolHop(onContinuation?: (options: SendMessageOptions) => void) {
  let hop = 0;
  return function* (...args: unknown[]) {
    if (++hop === 1) {
      yield { type: 'tool_call_request', value: request };
      return;
    }
    onContinuation?.(args[3] as SendMessageOptions);
    yield content('after-tool');
  };
}

describe('logical tools and actual permission transitions', () => {
  it('retries a failed model-tool continuation without executing the tool again', async () => {
    const { InteractiveModToolScheduler: RealScheduler } =
      await vi.importActual<
        typeof import('../../services/interactive-mod-tool-scheduler.js')
      >('../../services/interactive-mod-tool-scheduler.js');
    control.schedule.mockImplementation(
      (
        options: SchedulerOptions,
        requests: ToolCallRequestInfo[],
        signal: AbortSignal,
      ) => new RealScheduler(options).schedule(requests, signal),
    );
    let attempt = 0;
    const h = setup(function* () {
      if (++attempt === 1) {
        yield {
          type: LlmEventType.ToolCallRequest,
          value: {
            callId: 'ordinary-tool-call',
            name: 'owned_restore',
            args: { owned: true },
            isClientInitiated: false,
            prompt_id: 'ordinary-tool',
          },
        };
        return;
      }
      if (attempt === 2) throw new Error('continuation failed');
      yield content('retried answer');
    });
    const config = makeFakeConfig({
      targetDir: roots.at(-1)!,
      cwd: roots.at(-1)!,
      disableAllHooks: true,
      usageStatisticsEnabled: false,
    });
    Object.assign(config, h.config);
    const execute = vi.fn(async () => ({
      llmContent: 'restored-result',
      returnDisplay: 'restored-result',
    }));
    const registry = new ToolRegistry(config);
    registry.registerTool(new MockTool({ name: 'owned_restore', execute }));
    vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
    const emitUser = vi.spyOn(h.bridge, 'emitUserMessage');
    const emitResult = vi.spyOn(h.bridge, 'emitToolResult');
    let prepared: PreparedLiveRequest | undefined;
    const options: LivePromptOptions = {
      promptId: 'ordinary-tool',
      dualOutput: h.bridge,
      onPreparedRequest: (request) => {
        prepared = request;
      },
    };
    try {
      await expect(
        drain(
          livePromptEvents(config, 'ordinary model prompt', undefined, options),
        ),
      ).rejects.toThrow('continuation failed');
      expect(execute).toHaveBeenCalledExactlyOnceWith({ owned: true });
      expect(emitUser).toHaveBeenCalledExactlyOnceWith([
        { text: 'ordinary model prompt' },
      ]);
      expect(emitResult).toHaveBeenCalledOnce();
      expect(prepared).toBeDefined();
      const failed = prepared!;
      expect(failed.content).toEqual([
        expect.objectContaining({
          functionResponse: expect.objectContaining({
            name: 'owned_restore',
            response: { output: 'restored-result' },
          }),
        }),
      ]);
      await drain(
        livePromptEvents(config, failed.content, undefined, {
          ...options,
          retry: failed,
        }),
      );
      expect(control.schedule).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledOnce();
      expect(emitResult).toHaveBeenCalledOnce();
      expect(emitUser).toHaveBeenCalledTimes(2);
      expect(emitUser).toHaveBeenLastCalledWith(failed.content);
      expect(h.client.sendMessageStream).toHaveBeenCalledTimes(3);
      expect(h.client.sendMessageStream.mock.calls[0][0]).toBe(
        'ordinary model prompt',
      );
      expect(h.client.sendMessageStream.mock.calls[0][3]).toEqual({
        type: SendMessageType.UserQuery,
      });
      for (const [index, type] of [
        SendMessageType.ToolResult,
        SendMessageType.Retry,
      ].entries()) {
        const call = h.client.sendMessageStream.mock.calls[index + 1];
        expect(call[0]).toBe(failed.content);
        expect(call[2]).toBe('ordinary-tool');
        expect(call[3]).toEqual({ type });
      }
      const frames = await h.frames();
      expect(users(frames)).toHaveLength(3);
      expect(users(frames)[0].message.content).toEqual([
        { type: 'text', text: 'ordinary model prompt' },
      ]);
      expect(users(frames)[1].message.content).toEqual([
        expect.objectContaining({
          type: 'tool_result',
          content: 'restored-result',
        }),
      ]);
      expect(users(frames)[2].message.content).toEqual([
        { type: 'text', text: 'restored-result' },
      ]);
    } finally {
      await config.shutdown({ strictResourceCleanup: true });
    }
  });

  it('finishes a client-restored tool locally and sends only an explicit follow-up', async () => {
    const { InteractiveModToolScheduler: RealScheduler } =
      await vi.importActual<
        typeof import('../../services/interactive-mod-tool-scheduler.js')
      >('../../services/interactive-mod-tool-scheduler.js');
    control.schedule.mockImplementation(
      (
        options: SchedulerOptions,
        requests: ToolCallRequestInfo[],
        signal: AbortSignal,
      ) => new RealScheduler(options).schedule(requests, signal),
    );
    const h = setup(function* () {
      yield content('explicit answer');
    });
    const config = makeFakeConfig({
      targetDir: roots.at(-1)!,
      cwd: roots.at(-1)!,
      disableAllHooks: true,
      usageStatisticsEnabled: false,
    });
    Object.assign(config, h.config);
    const execute = vi.fn(async () => ({
      llmContent: 'restored-result',
      returnDisplay: 'restored-result',
    }));
    const registry = new ToolRegistry(config);
    registry.registerTool(new MockTool({ name: 'owned_restore', execute }));
    vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
    const emitUser = vi.spyOn(h.bridge, 'emitUserMessage');
    const emitResult = vi.spyOn(h.bridge, 'emitToolResult');
    const prepared = vi.fn();
    try {
      await drain(
        livePromptEvents(config, [], undefined, {
          promptId: 'restored-tool',
          toolCall: { name: 'owned_restore', args: { owned: true } },
          dualOutput: h.bridge,
          onPreparedRequest: prepared,
        }),
      );
      expect(execute).toHaveBeenCalledExactlyOnceWith({ owned: true });
      expect(control.schedule).toHaveBeenCalledOnce();
      expect(h.client.sendMessageStream).not.toHaveBeenCalled();
      expect(prepared).not.toHaveBeenCalled();
      expect(emitUser).not.toHaveBeenCalled();
      expect(emitResult).toHaveBeenCalledOnce();
      await drain(
        livePromptEvents(config, 'explain restored result', undefined, {
          promptId: 'explicit-followup',
          dualOutput: h.bridge,
        }),
      );
      expect(h.client.sendMessageStream).toHaveBeenCalledOnce();
      expect(h.client.sendMessageStream.mock.calls[0][0]).toBe(
        'explain restored result',
      );
      expect(h.client.sendMessageStream.mock.calls[0][3]).toEqual({
        type: SendMessageType.UserQuery,
      });
      expect(execute).toHaveBeenCalledOnce();
      expect(control.schedule).toHaveBeenCalledOnce();
      expect(emitResult).toHaveBeenCalledOnce();
      expect(emitUser).toHaveBeenCalledExactlyOnceWith([
        { text: 'explain restored result' },
      ]);
      const frames = await h.frames();
      expect(users(frames)).toHaveLength(2);
      expect(users(frames)[0].message.content).toEqual([
        expect.objectContaining({
          type: 'tool_result',
          content: 'restored-result',
        }),
      ]);
      expect(users(frames)[1].message.content).toEqual([
        { type: 'text', text: 'explain restored result' },
      ]);
      expect(
        assistants(frames).flatMap((frame) => frame.message.content),
      ).toEqual([{ type: 'text', text: 'explicit answer' }]);
    } finally {
      await config.shutdown({ strictResourceCleanup: true });
    }
  });

  it('emits one logical result between tool-use and the next model message', async () => {
    const h = setup(toolHop());
    await h.run();
    const frames = await h.frames();
    expect(users(frames)).toHaveLength(2);
    expect(users(frames)[1].message.content).toEqual([
      expect.objectContaining({
        type: 'tool_result',
        tool_use_id: request.callId,
        is_error: false,
      }),
    ]);
    const toolResultIndex = frames.indexOf(users(frames)[1]);
    expect(toolResultIndex).toBeGreaterThan(
      frames.indexOf(assistants(frames)[0]),
    );
    expect(toolResultIndex).toBeLessThan(
      frames.indexOf(assistants(frames).at(-1)!),
    );
    expect(h.client.sendMessageStream).toHaveBeenCalledTimes(2);
  });

  it.each(['success', 'error', 'cancelled'] as const)(
    'pairs the actual %s transition once even when the call list immediately disappears',
    async (status) => {
      control.schedule.mockImplementation(async (options: SchedulerOptions) => {
        options.onToolCallsUpdate?.([waiting()]);
        options.onToolCallsUpdate?.([waiting()]);
        options.onToolCallsUpdate?.([completed(status)]);
        options.onToolCallsUpdate?.([]);
        await options.onAllToolCallsComplete([completed(status)]);
      });
      const h = setup(toolHop());
      await h.run();
      const frames = await h.frames();
      const requests = frames.filter(
        (frame) => frame.type === 'control_request',
      );
      const responses = frames.filter(
        (frame) => frame.type === 'control_response',
      );
      expect(requests).toHaveLength(1);
      expect(responses).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        request: {
          subtype: 'can_use_tool',
          tool_use_id: request.callId,
          tool_name: request.name,
          input: request.args,
        },
      });
      expect(responses[0]).toMatchObject({
        response: {
          request_id: requests[0].request_id,
          response: { allowed: status === 'success' },
        },
      });
      if (status === 'cancelled') {
        expect(h.client.sendMessageStream).toHaveBeenCalledTimes(1);
        expect(users(frames)).toHaveLength(1);
        expect(h.client.addHistory).toHaveBeenCalledOnce();
      }
    },
  );

  it('uses completed-call evidence when the pending list clears without a terminal update', async () => {
    control.schedule.mockImplementation(async (options: SchedulerOptions) => {
      options.onToolCallsUpdate?.([waiting()]);
      options.onToolCallsUpdate?.([]);
      await options.onAllToolCallsComplete([completed('cancelled')]);
    });
    const h = setup(toolHop());
    await h.run();
    const responses = (await h.frames()).filter(
      (frame) => frame.type === 'control_response',
    );
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      response: { response: { allowed: false } },
    });
  });

  it('does not approve a MOD scheduled placeholder after abort while final cancellation is pending', async () => {
    const abort = new AbortController();
    const h = setup(toolHop());
    const response = vi.spyOn(h.bridge, 'emitControlResponse');
    control.schedule.mockImplementation(async (options: SchedulerOptions) => {
      options.onToolCallsUpdate?.([waiting()]);
      abort.abort();
      options.onToolCallsUpdate?.([
        { status: 'scheduled', request, nativeAttemptsObserved: true },
      ]);
      expect(response).not.toHaveBeenCalled();
      await options.onAllToolCallsComplete([completed('cancelled')]);
    });
    await h.run('initial', {}, abort.signal);
    const frames = await h.frames();
    const responses = frames.filter(
      (frame) => frame.type === 'control_response',
    );
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      response: { response: { allowed: false } },
    });
    expect(h.client.sendMessageStream).toHaveBeenCalledOnce();
  });

  it.each(['cancelled', 'error'] as const)(
    'waits for the actual MOD %s decision without requiring a turn abort',
    async (status) => {
      const h = setup(toolHop());
      const response = vi.spyOn(h.bridge, 'emitControlResponse');
      control.schedule.mockImplementation(async (options: SchedulerOptions) => {
        options.onToolCallsUpdate?.([
          { ...waiting(), nativeAttemptsObserved: true },
        ]);
        options.onToolCallsUpdate?.([
          { status: 'scheduled', request, nativeAttemptsObserved: true },
        ]);
        expect(response).not.toHaveBeenCalled();
        const result = { ...completed(status), nativeAttemptsObserved: true };
        options.onToolCallsUpdate?.([result]);
        await options.onAllToolCallsComplete([result]);
      });
      await h.run();
      const frames = await h.frames();
      const requests = frames.filter(
        (frame) => frame.type === 'control_request',
      );
      const responses = frames.filter(
        (frame) => frame.type === 'control_response',
      );
      expect(requests).toHaveLength(1);
      expect(responses).toHaveLength(1);
      expect(responses[0]).toMatchObject({
        response: {
          request_id: requests[0].request_id,
          response: { allowed: false },
        },
      });
    },
  );

  it('never interprets a vanished call as approval', async () => {
    control.schedule.mockImplementation(async (options: SchedulerOptions) => {
      options.onToolCallsUpdate?.([waiting()]);
      options.onToolCallsUpdate?.([]);
      await options.onAllToolCallsComplete([]);
    });
    const h = setup(toolHop());
    await h.run();
    const frames = await h.frames();
    expect(
      frames.filter((frame) => frame.type === 'control_request'),
    ).toHaveLength(1);
    expect(
      frames.filter((frame) => frame.type === 'control_response'),
    ).toHaveLength(0);
  });

  it.each([false, true])(
    'pairs each native hook re-ask, including MOD=%s',
    async (nativeAttemptsObserved) => {
      control.schedule.mockImplementation(async (options: SchedulerOptions) => {
        options.onToolCallsUpdate?.([waiting()]);
        options.onToolCallsUpdate?.([
          {
            status: 'scheduled',
            request,
            nativeAttemptsObserved,
            tool,
            invocation: tool.build(request.args),
          },
        ]);
        options.onToolCallsUpdate?.([waiting()]);
        options.onToolCallsUpdate?.([completed('cancelled')]);
        await options.onAllToolCallsComplete([completed('cancelled')]);
      });
      const h = setup(toolHop());
      await h.run();
      const frames = await h.frames();
      const requests = frames.filter(
        (frame) => frame.type === 'control_request',
      );
      const responses = frames.filter(
        (frame) => frame.type === 'control_response',
      );
      expect(requests).toHaveLength(2);
      expect(responses).toHaveLength(2);
      expect(requests[0].request_id).not.toBe(requests[1].request_id);
      expect(responses).toMatchObject([
        {
          response: {
            request_id: requests[0].request_id,
            response: { allowed: true },
          },
        },
        {
          response: {
            request_id: requests[1].request_id,
            response: { allowed: false },
          },
        },
      ]);
    },
  );

  it('emits mixed results once, while preserving the all-cancelled omission', async () => {
    control.schedule.mockImplementation(async (options: SchedulerOptions) => {
      await options.onAllToolCallsComplete([
        completed(),
        completed('cancelled', 'call-two'),
      ]);
    });
    const h = setup(toolHop());
    await h.run();
    const results = userBlocks(await h.frames()).filter(
      (block) => block.type === 'tool_result',
    );
    expect(results.map((block) => block.tool_use_id)).toEqual([
      'call-one',
      'call-two',
    ]);
  });

  it.each([
    {
      label: 'nonempty',
      resultDisplay: 'tool-result',
      expectedContent: 'tool-result',
    },
    {
      label: 'empty',
      resultDisplay: '',
      expectedContent: 'final-logical-output',
    },
  ])(
    'keeps finalized MOD parts and projects the $label display once',
    async ({ resultDisplay, expectedContent }) => {
      const finalParts: Part[] = [
        {
          functionResponse: {
            id: request.callId,
            name: request.name,
            response: { output: 'final-logical-output' },
          },
        },
      ];
      const call = { ...completed(), nativeAttemptsObserved: true };
      call.response.resultDisplay = resultDisplay;
      control.finalize.mockResolvedValue([{ responseParts: finalParts }]);
      control.schedule.mockImplementation(async (options: SchedulerOptions) => {
        await options.onAllToolCallsComplete([call]);
      });
      const h = setup(toolHop());
      const emitToolResult = vi.spyOn(h.bridge, 'emitToolResult');
      await h.run();

      expect(control.finalize).toHaveBeenCalledOnce();
      expect(control.finalize).toHaveBeenCalledWith(h.config, [
        {
          callId: request.callId,
          toolName: request.name,
          responseParts: call.response.responseParts,
          persistedOutputFiles: undefined,
          artifacts: undefined,
        },
      ]);
      expect(emitToolResult).toHaveBeenCalledOnce();
      expect(emitToolResult).toHaveBeenCalledWith(
        request,
        expect.objectContaining({ responseParts: finalParts, resultDisplay }),
      );
      expect(h.client.sendMessageStream).toHaveBeenCalledTimes(2);
      expect(h.client.sendMessageStream.mock.calls[1][0]).toEqual(finalParts);
      expect(h.client.sendMessageStream.mock.calls[1][3]).toEqual({
        type: SendMessageType.ToolResult,
      });
      expect(h.recorder.recordToolResult).toHaveBeenCalledOnce();
      expect(h.recorder.recordToolResult).toHaveBeenCalledWith(
        finalParts,
        expect.objectContaining({ callId: request.callId, resultDisplay }),
        undefined,
      );

      const frames = await h.frames();
      const results = userBlocks(frames).filter(
        (block) => block.type === 'tool_result',
      );
      expect(results).toEqual([
        {
          type: 'tool_result',
          tool_use_id: request.callId,
          is_error: false,
          content: expectedContent,
        },
      ]);
      const toolResultIndex = frames.indexOf(users(frames)[1]);
      expect(toolResultIndex).toBeGreaterThan(
        frames.indexOf(assistants(frames)[0]),
      );
      expect(toolResultIndex).toBeLessThan(
        frames.indexOf(assistants(frames).at(-1)!),
      );
    },
  );

  it('does not let stale tool completion or permission updates touch a successor', async () => {
    let current = true;
    control.schedule.mockImplementation(async (options: SchedulerOptions) => {
      current = false;
      options.onToolCallsUpdate?.([waiting()]);
      await options.onAllToolCallsComplete([completed()]);
    });
    const h = setup(toolHop());
    await h.run('old', { isCurrentTurn: () => current });
    const frames = await h.frames();
    expect(frames.filter((frame) => frame.type.startsWith('control_'))).toEqual(
      [],
    );
    expect(users(frames)).toHaveLength(1);
    expect(h.client.sendMessageStream).toHaveBeenCalledOnce();
  });
});

describe('SteerInput history acceptance', () => {
  it.each(['accept', 'restore'] as const)(
    'only publishes steering after core %s, never on drain',
    async (decision) => {
      const restore = vi.fn();
      const h = setup(
        toolHop((options) => {
          options.steerInput?.[decision]();
          options.steerInput?.[decision]();
        }),
      );
      await h.run('initial', {
        drainSteering: () => [{ text: 'steered', content: 'steered' }],
        restoreSteering: restore,
      });
      const text = userBlocks(await h.frames())
        .filter((block) => block.type === 'text')
        .map((block) => block.text);
      expect(text).toEqual(
        decision === 'accept' ? ['initial', 'steered'] : ['initial'],
      );
      expect(h.recorder.recordMidTurnUserMessage).toHaveBeenCalledTimes(
        decision === 'accept' ? 1 : 0,
      );
      expect(restore).toHaveBeenCalledTimes(decision === 'restore' ? 1 : 0);
    },
  );

  it('rejects a late accepted steer after reset without recording into a successor', async () => {
    let current = true;
    const h = setup(
      toolHop((options) => {
        current = false;
        options.steerInput?.accept();
        options.steerInput?.accept();
      }),
    );
    await h.run('initial', {
      isCurrentTurn: () => current,
      drainSteering: () => [{ text: 'late-steer', content: 'late-steer' }],
    });
    expect(h.recorder.recordMidTurnUserMessage).not.toHaveBeenCalled();
    expect(
      userBlocks(await h.frames()).filter((block) => block.type === 'text'),
    ).toEqual([{ type: 'text', text: 'initial' }]);
  });

  it('does not publish restored steering after a synchronous continuation failure', async () => {
    let hop = 0;
    const restore = vi.fn();
    const h = setup(function* () {
      if (++hop === 1) {
        yield { type: 'tool_call_request', value: request };
        return;
      }
      throw new Error('before-history');
    });
    await expect(
      h.run('initial', {
        drainSteering: () => [{ text: 'pending', content: 'pending' }],
        restoreSteering: restore,
      }),
    ).rejects.toThrow('before-history');
    expect(restore).toHaveBeenCalledOnce();
    expect(
      userBlocks(await h.frames()).filter((block) => block.type === 'text'),
    ).toEqual([{ type: 'text', text: 'initial' }]);
  });
});
