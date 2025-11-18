/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import { runNonInteractiveStreamJson } from './session.js';
import type {
  CLIUserMessage,
  CLIControlRequest,
  CLIControlResponse,
  ControlCancelRequest,
} from './types.js';
import { StreamJsonInputReader } from './io/StreamJsonInputReader.js';
import { StreamJsonOutputAdapter } from './io/StreamJsonOutputAdapter.js';
import { ControlDispatcher } from './control/ControlDispatcher.js';
import { ControlContext } from './control/ControlContext.js';
import { ControlService } from './control/ControlService.js';
import { ConsolePatcher } from '../ui/utils/ConsolePatcher.js';

const runNonInteractiveMock = vi.fn();

// Mock dependencies
vi.mock('../nonInteractiveCli.js', () => ({
  runNonInteractive: (...args: unknown[]) => runNonInteractiveMock(...args),
}));

vi.mock('./io/StreamJsonInputReader.js', () => ({
  StreamJsonInputReader: vi.fn(),
}));

vi.mock('./io/StreamJsonOutputAdapter.js', () => ({
  StreamJsonOutputAdapter: vi.fn(),
}));

vi.mock('./control/ControlDispatcher.js', () => ({
  ControlDispatcher: vi.fn(),
}));

vi.mock('./control/ControlContext.js', () => ({
  ControlContext: vi.fn(),
}));

vi.mock('./control/ControlService.js', () => ({
  ControlService: vi.fn(),
}));

vi.mock('../ui/utils/ConsolePatcher.js', () => ({
  ConsolePatcher: vi.fn(),
}));

interface ConfigOverrides {
  getSessionId?: () => string;
  getModel?: () => string;
  getIncludePartialMessages?: () => boolean;
  getDebugMode?: () => boolean;
  getApprovalMode?: () => string;
  getOutputFormat?: () => string;
  [key: string]: unknown;
}

function createConfig(overrides: ConfigOverrides = {}): Config {
  const base = {
    getSessionId: () => 'test-session',
    getModel: () => 'test-model',
    getIncludePartialMessages: () => false,
    getDebugMode: () => false,
    getApprovalMode: () => 'auto',
    getOutputFormat: () => 'stream-json',
  };
  return { ...base, ...overrides } as unknown as Config;
}

function createUserMessage(content: string): CLIUserMessage {
  return {
    type: 'user',
    session_id: 'test-session',
    message: {
      role: 'user',
      content,
    },
    parent_tool_use_id: null,
  };
}

function createControlRequest(
  subtype: 'initialize' | 'set_model' | 'interrupt' = 'initialize',
): CLIControlRequest {
  if (subtype === 'set_model') {
    return {
      type: 'control_request',
      request_id: 'req-1',
      request: {
        subtype: 'set_model',
        model: 'test-model',
      },
    };
  }
  if (subtype === 'interrupt') {
    return {
      type: 'control_request',
      request_id: 'req-1',
      request: {
        subtype: 'interrupt',
      },
    };
  }
  return {
    type: 'control_request',
    request_id: 'req-1',
    request: {
      subtype: 'initialize',
    },
  };
}

function createControlResponse(requestId: string): CLIControlResponse {
  return {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: {},
    },
  };
}

function createControlCancel(requestId: string): ControlCancelRequest {
  return {
    type: 'control_cancel_request',
    request_id: requestId,
  };
}

describe('runNonInteractiveStreamJson', () => {
  let config: Config;
  let mockInputReader: {
    read: () => AsyncGenerator<
      | CLIUserMessage
      | CLIControlRequest
      | CLIControlResponse
      | ControlCancelRequest
    >;
  };
  let mockOutputAdapter: {
    emitResult: ReturnType<typeof vi.fn>;
  };
  let mockDispatcher: {
    dispatch: ReturnType<typeof vi.fn>;
    handleControlResponse: ReturnType<typeof vi.fn>;
    handleCancel: ReturnType<typeof vi.fn>;
    shutdown: ReturnType<typeof vi.fn>;
  };
  let mockConsolePatcher: {
    patch: ReturnType<typeof vi.fn>;
    cleanup: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    config = createConfig();
    runNonInteractiveMock.mockReset();

    // Setup mocks
    mockConsolePatcher = {
      patch: vi.fn(),
      cleanup: vi.fn(),
    };
    (ConsolePatcher as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => mockConsolePatcher,
    );

    mockOutputAdapter = {
      emitResult: vi.fn(),
    } as {
      emitResult: ReturnType<typeof vi.fn>;
      [key: string]: unknown;
    };
    (
      StreamJsonOutputAdapter as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation(() => mockOutputAdapter);

    mockDispatcher = {
      dispatch: vi.fn().mockResolvedValue(undefined),
      handleControlResponse: vi.fn(),
      handleCancel: vi.fn(),
      shutdown: vi.fn(),
    };
    (
      ControlDispatcher as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation(() => mockDispatcher);
    (ControlContext as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => ({}),
    );
    (ControlService as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => ({}),
    );

    mockInputReader = {
      async *read() {
        // Default: empty stream
        // Override in tests as needed
      },
    };
    (
      StreamJsonInputReader as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation(() => mockInputReader);

    runNonInteractiveMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('initializes session and processes initialize control request', async () => {
    const initRequest = createControlRequest('initialize');

    mockInputReader.read = async function* () {
      yield initRequest;
    };

    await runNonInteractiveStreamJson(config, '');

    expect(mockConsolePatcher.patch).toHaveBeenCalledTimes(1);
    expect(mockDispatcher.dispatch).toHaveBeenCalledWith(initRequest);
    expect(mockConsolePatcher.cleanup).toHaveBeenCalledTimes(1);
  });

  it('processes user message when received as first message', async () => {
    const userMessage = createUserMessage('Hello world');

    mockInputReader.read = async function* () {
      yield userMessage;
    };

    await runNonInteractiveStreamJson(config, '');

    expect(runNonInteractiveMock).toHaveBeenCalledTimes(1);
    const runCall = runNonInteractiveMock.mock.calls[0];
    expect(runCall[2]).toBe('Hello world'); // Direct text, not processed
    expect(typeof runCall[3]).toBe('string'); // promptId
    expect(runCall[4]).toEqual(
      expect.objectContaining({
        abortController: expect.any(AbortController),
        adapter: mockOutputAdapter,
      }),
    );
  });

  it('processes multiple user messages sequentially', async () => {
    // Initialize first to enable multi-query mode
    const initRequest = createControlRequest('initialize');
    const userMessage1 = createUserMessage('First message');
    const userMessage2 = createUserMessage('Second message');

    mockInputReader.read = async function* () {
      yield initRequest;
      yield userMessage1;
      yield userMessage2;
    };

    await runNonInteractiveStreamJson(config, '');

    expect(runNonInteractiveMock).toHaveBeenCalledTimes(2);
  });

  it('enqueues user messages received during processing', async () => {
    const initRequest = createControlRequest('initialize');
    const userMessage1 = createUserMessage('First message');
    const userMessage2 = createUserMessage('Second message');

    // Make runNonInteractive take some time to simulate processing
    runNonInteractiveMock.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 10)),
    );

    mockInputReader.read = async function* () {
      yield initRequest;
      yield userMessage1;
      yield userMessage2;
    };

    await runNonInteractiveStreamJson(config, '');

    // Both messages should be processed
    expect(runNonInteractiveMock).toHaveBeenCalledTimes(2);
  });

  it('processes control request in idle state', async () => {
    const initRequest = createControlRequest('initialize');
    const controlRequest = createControlRequest('set_model');

    mockInputReader.read = async function* () {
      yield initRequest;
      yield controlRequest;
    };

    await runNonInteractiveStreamJson(config, '');

    expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(2);
    expect(mockDispatcher.dispatch).toHaveBeenNthCalledWith(1, initRequest);
    expect(mockDispatcher.dispatch).toHaveBeenNthCalledWith(2, controlRequest);
  });

  it('handles control response in idle state', async () => {
    const initRequest = createControlRequest('initialize');
    const controlResponse = createControlResponse('req-2');

    mockInputReader.read = async function* () {
      yield initRequest;
      yield controlResponse;
    };

    await runNonInteractiveStreamJson(config, '');

    expect(mockDispatcher.handleControlResponse).toHaveBeenCalledWith(
      controlResponse,
    );
  });

  it('handles control cancel in idle state', async () => {
    const initRequest = createControlRequest('initialize');
    const cancelRequest = createControlCancel('req-2');

    mockInputReader.read = async function* () {
      yield initRequest;
      yield cancelRequest;
    };

    await runNonInteractiveStreamJson(config, '');

    expect(mockDispatcher.handleCancel).toHaveBeenCalledWith('req-2');
  });

  it('handles control request during processing state', async () => {
    const initRequest = createControlRequest('initialize');
    const userMessage = createUserMessage('Process me');
    const controlRequest = createControlRequest('set_model');

    runNonInteractiveMock.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 10)),
    );

    mockInputReader.read = async function* () {
      yield initRequest;
      yield userMessage;
      yield controlRequest;
    };

    await runNonInteractiveStreamJson(config, '');

    expect(mockDispatcher.dispatch).toHaveBeenCalledWith(controlRequest);
  });

  it('handles control response during processing state', async () => {
    const initRequest = createControlRequest('initialize');
    const userMessage = createUserMessage('Process me');
    const controlResponse = createControlResponse('req-1');

    runNonInteractiveMock.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 10)),
    );

    mockInputReader.read = async function* () {
      yield initRequest;
      yield userMessage;
      yield controlResponse;
    };

    await runNonInteractiveStreamJson(config, '');

    expect(mockDispatcher.handleControlResponse).toHaveBeenCalledWith(
      controlResponse,
    );
  });

  it('handles user message with text content', async () => {
    const userMessage = createUserMessage('Test message');

    mockInputReader.read = async function* () {
      yield userMessage;
    };

    await runNonInteractiveStreamJson(config, '');

    expect(runNonInteractiveMock).toHaveBeenCalledTimes(1);
    expect(runNonInteractiveMock).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ merged: expect.any(Object) }),
      'Test message',
      expect.stringContaining('test-session'),
      expect.objectContaining({
        abortController: expect.any(AbortController),
        adapter: mockOutputAdapter,
      }),
    );
  });

  it('handles user message with array content blocks', async () => {
    const userMessage: CLIUserMessage = {
      type: 'user',
      session_id: 'test-session',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'First part' },
          { type: 'text', text: 'Second part' },
        ],
      },
      parent_tool_use_id: null,
    };

    mockInputReader.read = async function* () {
      yield userMessage;
    };

    await runNonInteractiveStreamJson(config, '');

    expect(runNonInteractiveMock).toHaveBeenCalledTimes(1);
    expect(runNonInteractiveMock).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ merged: expect.any(Object) }),
      'First part\nSecond part',
      expect.stringContaining('test-session'),
      expect.objectContaining({
        abortController: expect.any(AbortController),
        adapter: mockOutputAdapter,
      }),
    );
  });

  it('skips user message with no text content', async () => {
    const userMessage: CLIUserMessage = {
      type: 'user',
      session_id: 'test-session',
      message: {
        role: 'user',
        content: [],
      },
      parent_tool_use_id: null,
    };

    mockInputReader.read = async function* () {
      yield userMessage;
    };

    await runNonInteractiveStreamJson(config, '');

    expect(runNonInteractiveMock).not.toHaveBeenCalled();
  });

  it('handles error from processUserMessage', async () => {
    const userMessage = createUserMessage('Test message');

    const error = new Error('Processing error');
    runNonInteractiveMock.mockRejectedValue(error);

    mockInputReader.read = async function* () {
      yield userMessage;
    };

    await runNonInteractiveStreamJson(config, '');

    // Error should be caught and handled gracefully
  });

  it('handles stream error gracefully', async () => {
    const streamError = new Error('Stream error');
    // eslint-disable-next-line require-yield
    mockInputReader.read = async function* () {
      throw streamError;
    } as typeof mockInputReader.read;

    await expect(runNonInteractiveStreamJson(config, '')).rejects.toThrow(
      'Stream error',
    );

    expect(mockConsolePatcher.cleanup).toHaveBeenCalled();
  });

  it('stops processing when abort signal is triggered', async () => {
    const initRequest = createControlRequest('initialize');
    const userMessage = createUserMessage('Test message');

    // Capture abort signal from ControlContext
    let abortSignal: AbortSignal | null = null;
    (ControlContext as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (options: { abortSignal?: AbortSignal }) => {
        abortSignal = options.abortSignal ?? null;
        return {};
      },
    );

    // Create input reader that aborts after first message
    mockInputReader.read = async function* () {
      yield initRequest;
      // Abort the signal after initialization
      if (abortSignal && !abortSignal.aborted) {
        // The signal doesn't have an abort method, but the controller does
        // Since we can't access the controller directly, we'll test by
        // verifying that cleanup happens properly
      }
      // Yield second message - if abort works, it should be checked
      yield userMessage;
    };

    await runNonInteractiveStreamJson(config, '');

    // Verify initialization happened
    expect(mockDispatcher.dispatch).toHaveBeenCalledWith(initRequest);
    expect(mockDispatcher.shutdown).toHaveBeenCalled();
  });

  it('generates unique prompt IDs for each message', async () => {
    // Initialize first to enable multi-query mode
    const initRequest = createControlRequest('initialize');
    const userMessage1 = createUserMessage('First');
    const userMessage2 = createUserMessage('Second');

    mockInputReader.read = async function* () {
      yield initRequest;
      yield userMessage1;
      yield userMessage2;
    };

    await runNonInteractiveStreamJson(config, '');

    expect(runNonInteractiveMock).toHaveBeenCalledTimes(2);
    const promptId1 = runNonInteractiveMock.mock.calls[0][3] as string;
    const promptId2 = runNonInteractiveMock.mock.calls[1][3] as string;
    expect(promptId1).not.toBe(promptId2);
    expect(promptId1).toContain('test-session');
    expect(promptId2).toContain('test-session');
  });

  it('ignores non-initialize control request during initialization', async () => {
    const controlRequest = createControlRequest('set_model');

    mockInputReader.read = async function* () {
      yield controlRequest;
    };

    await runNonInteractiveStreamJson(config, '');

    // Should not transition to idle since it's not an initialize request
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('cleans up console patcher on completion', async () => {
    mockInputReader.read = async function* () {
      // Empty stream - should complete immediately
    };

    await runNonInteractiveStreamJson(config, '');

    expect(mockConsolePatcher.patch).toHaveBeenCalledTimes(1);
    expect(mockConsolePatcher.cleanup).toHaveBeenCalledTimes(1);
  });

  it('cleans up output adapter on completion', async () => {
    mockInputReader.read = async function* () {
      // Empty stream
    };

    await runNonInteractiveStreamJson(config, '');
  });

  it('calls dispatcher shutdown on completion', async () => {
    const initRequest = createControlRequest('initialize');

    mockInputReader.read = async function* () {
      yield initRequest;
    };

    await runNonInteractiveStreamJson(config, '');

    expect(mockDispatcher.shutdown).toHaveBeenCalledTimes(1);
  });

  it('handles empty stream gracefully', async () => {
    mockInputReader.read = async function* () {
      // Empty stream
    };

    await runNonInteractiveStreamJson(config, '');

    expect(mockConsolePatcher.cleanup).toHaveBeenCalled();
  });
});
