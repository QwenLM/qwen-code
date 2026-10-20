/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { beforeEach, expect, it, vi } from 'vitest';
import type { CompletedToolCall, Config } from '@qwen-code/qwen-code-core';
import { observeInteractiveModTool } from './interactive-mod-tool-observer.js';
const mocks = vi.hoisted(() => ({
  managed: vi.fn(),
  context: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('@qwen-code/qwen-code-core/memory/refresh.js', () => ({
  refreshMemoryAfterManagedWrite: mocks.managed,
  didWriteProjectContextFile: mocks.context,
  refreshMemoryInstruction: mocks.refresh,
}));
beforeEach(() => {
  vi.resetAllMocks();
  mocks.context.mockReturnValue(true);
  mocks.managed.mockResolvedValue(false);
});
it.each(['error', 'cancelled'] as const)(
  'preserves successful writes followed by native %s',
  async (status) => {
    const record = vi.fn();
    const config = {
      getLlmClient: () => ({ recordCompletedToolCall: record }),
      getProjectRoot: () => '/workspace',
    } as unknown as Config;
    const call: CompletedToolCall = {
      status,
      request: {
        callId: 'same',
        name: 'write_file',
        args: { file_path: '/workspace/QWEN.md' },
        isClientInitiated: false,
        prompt_id: 'turn',
      },
      response: {
        callId: 'same',
        responseParts: [],
        resultDisplay: 'post hook stopped',
        error: new Error('post hook stopped'),
        errorType: undefined,
        executionStatus: 'success',
      },
    };
    await observeInteractiveModTool(config, call, true);
    await observeInteractiveModTool(config, call, true);
    expect(record).toHaveBeenCalledTimes(2);
    expect(mocks.managed).toHaveBeenCalledTimes(2);
    expect(mocks.managed.mock.calls[0][1][0].status).toBe('success');
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
    expect(call.status).toBe(status);
  },
);
it('does not turn validation rejection or client calls into writes', async () => {
  const record = vi.fn();
  const config = {
    getLlmClient: () => ({ recordCompletedToolCall: record }),
    getProjectRoot: () => '/workspace',
  } as unknown as Config;
  const call: CompletedToolCall = {
    status: 'error',
    request: {
      callId: 'call',
      name: 'write_file',
      args: {},
      isClientInitiated: false,
      prompt_id: 'turn',
    },
    response: {
      callId: 'call',
      responseParts: [],
      resultDisplay: undefined,
      error: new Error('invalid'),
      errorType: undefined,
      executionStatus: 'not_started',
    },
  };
  await observeInteractiveModTool(config, call, true);
  expect(mocks.managed.mock.calls[0][1][0].status).toBe('error');
  expect(mocks.refresh).not.toHaveBeenCalled();
  call.request.isClientInitiated = true;
  await observeInteractiveModTool(config, call, true);
  expect(record).toHaveBeenCalledOnce();
});
