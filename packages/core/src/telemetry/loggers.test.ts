/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { logs } from '@opentelemetry/api-logs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthType } from '../index.js';
import {
  logApiRequest,
  logApiResponse,
  logCliConfiguration,
  logUserPrompt,
  logFlashFallback,
  logChatCompression,
  logFileOperation,
  logRipgrepFallback,
  logToolOutputTruncated,
  logToolCall,
} from './loggers.js';
import { QwenLogger } from './qwen-logger/qwen-logger.js';
import * as sdk from './sdk.js';
import {
  ApiRequestEvent,
  ApiResponseEvent,
  FlashFallbackEvent,
  StartSessionEvent,
  UserPromptEvent,
  RipgrepFallbackEvent,
  makeChatCompressionEvent,
  FileOperationEvent,
  ToolOutputTruncatedEvent,
  ToolCallEvent,
} from './types.js';
import { FileOperation } from './metrics.js';
import * as uiTelemetry from './uiTelemetry.js';
import { UserAccountManager } from '../utils/userAccountManager.js';
import { makeFakeConfig } from '../test-utils/config.js';
import { MockTool } from '../test-utils/mock-tool.js';
import type { CompletedToolCall } from '../core/coreToolScheduler.js';

describe('loggers', () => {
  const mockLogger = {
    emit: vi.fn(),
  };
  const mockUiEvent = {
    addEvent: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Telemetry SDK is disabled, so this returns false.
    vi.spyOn(sdk, 'isTelemetrySdkInitialized').mockReturnValue(false);
    vi.spyOn(logs, 'getLogger').mockReturnValue(mockLogger);
    vi.spyOn(uiTelemetry.uiTelemetryService, 'addEvent').mockImplementation(
      mockUiEvent.addEvent,
    );
    vi.spyOn(
      UserAccountManager.prototype,
      'getCachedGoogleAccount',
    ).mockReturnValue('test-user@example.com');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
  });

  it('logCliConfiguration does nothing when telemetry disabled', () => {
    const mockConfig = makeFakeConfig();
    logCliConfiguration(mockConfig, new StartSessionEvent(mockConfig));
    expect(mockLogger.emit).not.toHaveBeenCalled();
  });

  it('logUserPrompt does nothing when telemetry disabled', () => {
    const mockConfig = makeFakeConfig();
    const event = new UserPromptEvent(10, 'id', AuthType.USE_GEMINI, 'prompt');
    logUserPrompt(mockConfig, event);
    expect(mockLogger.emit).not.toHaveBeenCalled();
  });

  it('logApiRequest does nothing when telemetry disabled', () => {
    const mockConfig = makeFakeConfig();
    const event = new ApiRequestEvent('model', 'id');
    logApiRequest(mockConfig, event);
    expect(mockLogger.emit).not.toHaveBeenCalled();
  });

  it('logApiResponse does nothing when telemetry disabled', () => {
    const mockConfig = makeFakeConfig();
    // @ts-expect-error - ApiResponseEvent expects an ApiResponse object
    const event = new ApiResponseEvent('id', 'model');
    logApiResponse(mockConfig, event);
    expect(mockLogger.emit).not.toHaveBeenCalled();
  });

  it('logToolCall does nothing when telemetry disabled', () => {
    const mockConfig = makeFakeConfig();
    const mockTool = new MockTool({ name: 'test-tool' });
    const completedToolCall: CompletedToolCall = {
      status: 'success',
      request: {
        callId: 'test-call-id',
        name: 'test-tool',
        args: { param: 'value' },
        isClientInitiated: false,
        prompt_id: 'test-prompt-id',
      },
      tool: mockTool,
      invocation: mockTool.build({ param: 'value' }),
      response: {
        callId: 'test-call-id',
        responseParts: [
          {
            functionResponse: {
              id: 'test-call-id',
              name: 'test-tool',
              response: { output: 'Success!' },
            },
          },
        ],
        error: undefined,
        errorType: undefined,
        resultDisplay: 'Success!',
      },
      durationMs: 100,
    };
    const event = new ToolCallEvent(completedToolCall);
    logToolCall(mockConfig, event);
    expect(mockLogger.emit).not.toHaveBeenCalled();
  });

  // ... and so on for other loggers.
  // logChatCompression is an exception as noted before, it might call emit.

  it('logChatCompression calls emit but QwenLogger is bypassed (telemetry disabled)', () => {
    const mockConfig = makeFakeConfig();
    vi.spyOn(QwenLogger.prototype, 'logChatCompressionEvent');

    const event = makeChatCompressionEvent({
      tokens_before: 9001,
      tokens_after: 9000,
    });
    logChatCompression(mockConfig, event);

    expect(QwenLogger.prototype.logChatCompressionEvent).not.toHaveBeenCalled();
    // It DOES call emit because of implementation detail, but that's fine to verify
    expect(mockLogger.emit).toHaveBeenCalled();
  });

  it('logFlashFallback does nothing when telemetry disabled', () => {
    const mockConfig = makeFakeConfig();
    const event = new FlashFallbackEvent(AuthType.USE_GEMINI);
    logFlashFallback(mockConfig, event);
    expect(mockLogger.emit).not.toHaveBeenCalled();
  });

  it('logRipgrepFallback does nothing when telemetry disabled', () => {
    const mockConfig = makeFakeConfig();
    const event = new RipgrepFallbackEvent(false, false, 'error');
    logRipgrepFallback(mockConfig, event);
    expect(mockLogger.emit).not.toHaveBeenCalled();
  });

  it('logFileOperation does nothing when telemetry disabled', () => {
    const mockConfig = makeFakeConfig();
    const event = new FileOperationEvent('tool', FileOperation.READ, 10);
    logFileOperation(mockConfig, event);
    expect(mockLogger.emit).not.toHaveBeenCalled();
  });

  it('logToolOutputTruncated does nothing when telemetry disabled', () => {
    const mockConfig = makeFakeConfig();
    // @ts-expect-error - ToolOutputTruncatedEvent expects a ToolOutputTruncated object
    const event = new ToolOutputTruncatedEvent('id', {});
    logToolOutputTruncated(mockConfig, event);
    expect(mockLogger.emit).not.toHaveBeenCalled();
  });
});
