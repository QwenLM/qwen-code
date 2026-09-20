/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { Part } from '@google/genai';
import type {
  Config,
  ToolResult,
  CompletedToolCall,
} from '@qwen-code/qwen-code-core';
import {
  ApprovalMode,
  CoreToolScheduler,
  MockTool,
} from '@qwen-code/qwen-code-core';
import {
  mapToDisplay,
  type TrackedToolCall,
  useReactToolScheduler,
} from './useReactToolScheduler.js';
import { MAX_INLINE_IMAGES_PER_ITEM } from '../utils/inline-image-parts.js';

// Build a minimal successful tracked tool call with the fields mapToDisplay's
// success branch reads. `displayName` drives the collapsible gate.
const makeCompleted = (
  status: 'success' | 'error' | 'cancelled',
  displayName: string,
  responseMedia: Part[] = [],
): TrackedToolCall =>
  ({
    status,
    request: { callId: 'call-1', name: 'read_file', args: {} },
    tool: { displayName, isOutputMarkdown: false },
    invocation: { getDescription: () => 'reading' },
    response: {
      resultDisplay: 'Read 1 file',
      responseParts: [
        {
          functionResponse: {
            id: 'call-1',
            name: 'read_file',
            response: { output: 'FULL FILE CONTENT' },
            ...(responseMedia.length > 0 ? { parts: responseMedia } : {}),
          },
        },
      ],
    },
  }) as unknown as TrackedToolCall;

const makeSuccess = (
  displayName: string,
  responseMedia: Part[] = [],
): TrackedToolCall => makeCompleted('success', displayName, responseMedia);

describe('mapToDisplay — raw args (ui.showToolCallArgs)', () => {
  it('carries the request args through to the display object', () => {
    const call = {
      status: 'success',
      request: {
        callId: 'call-1',
        name: 'edit',
        args: { file_path: 'a.ts', old_string: 'x', new_string: 'y' },
      },
      tool: { displayName: 'Edit', isOutputMarkdown: false },
      invocation: { getDescription: () => 'a.ts' },
      response: { resultDisplay: 'ok', responseParts: [] },
    } as unknown as TrackedToolCall;

    // `description` summarizes the args away (Edit shows only the filename);
    // the raw args are what the setting renders instead.
    expect(mapToDisplay(call).tools[0].args).toEqual({
      file_path: 'a.ts',
      old_string: 'x',
      new_string: 'y',
    });
  });

  it('carries args through the error branch too', () => {
    const call = {
      status: 'error',
      request: { callId: 'call-2', name: 'broken', args: { a: 1 } },
      response: { resultDisplay: 'boom', responseParts: [] },
    } as unknown as TrackedToolCall;

    expect(mapToDisplay(call).tools[0].args).toEqual({ a: 1 });
  });
});

describe('mapToDisplay — detailedDisplay (§4.9 live path)', () => {
  it('extracts detailedDisplay for a collapsible (read/search/list) tool', () => {
    const group = mapToDisplay(makeSuccess('Read File'));
    const tool = group.tools[0];
    // Summary stays the compact resultDisplay; full detail is derived from the
    // persisted functionResponse for the Ctrl+O transcript.
    expect(tool.resultDisplay).toBe('Read 1 file');
    expect(tool.detailedDisplay).toBe('FULL FILE CONTENT');
  });

  it('leaves detailedDisplay undefined for a non-collapsible tool', () => {
    // 'Edit' → 'edit' category → not collapsible, so the extraction is skipped
    // (the transcript never reads it for edit/write/command/agent tools).
    const group = mapToDisplay(makeSuccess('Edit'));
    expect(group.tools[0].detailedDisplay).toBeUndefined();
  });

  it.each(['success', 'error', 'cancelled'] as const)(
    'extracts nested inline images from %s tool response parts',
    (status) => {
      const group = mapToDisplay(
        makeCompleted(status, 'Read File', [
          {
            inlineData: {
              data: 'dG9vbC1pbWFnZQ==',
              mimeType: 'image/png',
              displayName: 'result.png',
            },
          },
        ]),
      );

      expect(group.tools[0].images).toEqual([
        {
          data: 'dG9vbC1pbWFnZQ==',
          mimeType: 'image/png',
        },
      ]);
    },
  );

  it('caps tool images and reports the overflow count', () => {
    const images = Array.from(
      { length: MAX_INLINE_IMAGES_PER_ITEM + 2 },
      (_, index) => ({
        inlineData: {
          data: Buffer.from(`tool-image-${index}`).toString('base64'),
          mimeType: 'image/png',
        },
      }),
    );

    const tool = mapToDisplay(makeCompleted('success', 'Read File', images))
      .tools[0];

    expect(tool.images).toEqual(
      images
        .slice(0, MAX_INLINE_IMAGES_PER_ITEM)
        .map((part) => part.inlineData),
    );
    expect(tool.omittedImageCount).toBe(2);
  });
});

describe('useReactToolScheduler', () => {
  it('handles a queued tool cancellation at the fire-and-forget boundary', async () => {
    const scheduleSpy = vi
      .spyOn(CoreToolScheduler.prototype, 'schedule')
      .mockRejectedValueOnce(new Error('Tool call cancelled while in queue.'));
    const abortController = new AbortController();
    abortController.abort();
    const onComplete = vi.fn();

    const { result } = renderHook(() =>
      useReactToolScheduler(
        onComplete,
        { getToolRegistry: () => ({}) } as unknown as Config,
        () => undefined,
        vi.fn(),
      ),
    );

    act(() => {
      result.current[1](
        {
          callId: 'queued-call',
          name: 'read_file',
          args: {},
          isClientInitiated: false,
          prompt_id: 'queued-prompt',
        },
        abortController.signal,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(scheduleSpy).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith([
      expect.objectContaining({
        status: 'cancelled',
        request: expect.objectContaining({ callId: 'queued-call' }),
        response: expect.objectContaining({
          error: undefined,
          errorType: undefined,
          executionStatus: 'not_started',
        }),
      }),
    ]);
    scheduleSpy.mockRestore();
  });

  it('keeps the same scheduler so a later tool queues after callback identities change', async () => {
    let resolveFirst: ((result: ToolResult) => void) | undefined;
    const execute = vi.fn(
      (params: { [key: string]: unknown }): Promise<ToolResult> => {
        if (params['which'] === 'first') {
          return new Promise<ToolResult>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve({
          llmContent: 'second',
          returnDisplay: 'second',
        });
      },
    );
    const mockTool = new MockTool({
      name: 'mockTool',
      displayName: 'Mock Tool',
      execute,
    });
    const mockToolRegistry = {
      getTool: vi.fn(() => mockTool),
      ensureTool: vi.fn(async () => mockTool),
      getAllToolNames: vi.fn(() => ['mockTool']),
    };
    const mockConfig = {
      getToolRegistry: () => mockToolRegistry,
      getApprovalMode: () => ApprovalMode.YOLO,
      getSessionId: () => 'test-session-id',
      getUsageStatisticsEnabled: () => true,
      getDebugMode: () => false,
      storage: { getProjectTempDir: () => '/tmp' },
      getTruncateToolOutputThreshold: () => 4_000_000,
      getTruncateToolOutputLines: () => 1000,
      getPermissionsAllow: () => [],
      getContentGeneratorConfig: () => ({
        model: 'test-model',
        authType: 'gemini',
      }),
      getBaseLlmClient: vi.fn(),
      getUseModelRouter: () => false,
      getLlmClient: () => null,
      getShellExecutionConfig: () => ({
        terminalWidth: 80,
        terminalHeight: 24,
      }),
      getChatRecordingService: () => undefined,
      getMessageBus: () => undefined,
      getDisableAllHooks: () => true,
      getHookSystem: () => undefined,
      getDebugLogger: () => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
    } as unknown as Config;

    type SchedulerProps = {
      onComplete: (tools: CompletedToolCall[]) => Promise<void>;
      onEditorClose: () => void;
      onToolResultFullTurnModel?: (model: string) => boolean;
    };

    const firstOnComplete = vi.fn(async (_tools: CompletedToolCall[]) => {});
    const { result, rerender } = renderHook<
      ReturnType<typeof useReactToolScheduler>,
      SchedulerProps
    >(
      ({ onComplete, onEditorClose, onToolResultFullTurnModel }) =>
        useReactToolScheduler(
          onComplete,
          mockConfig,
          () => undefined,
          onEditorClose,
          onToolResultFullTurnModel,
        ),
      {
        initialProps: {
          onComplete: firstOnComplete,
          onEditorClose: vi.fn(),
        },
      },
    );

    const signal = new AbortController().signal;
    act(() => {
      result.current[1](
        {
          callId: 'call-1',
          name: 'mockTool',
          args: { which: 'first' },
          isClientInitiated: false,
          prompt_id: 'prompt-1',
        },
        signal,
      );
    });

    await waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(1);
    });
    expect(resolveFirst).toBeDefined();

    const latestOnComplete = vi.fn(async (_tools: CompletedToolCall[]) => {});
    rerender({
      onComplete: latestOnComplete,
      onEditorClose: vi.fn(),
      onToolResultFullTurnModel: vi.fn(() => false),
    });

    act(() => {
      result.current[1](
        {
          callId: 'call-2',
          name: 'mockTool',
          args: { which: 'second' },
          isClientInitiated: false,
          prompt_id: 'prompt-2',
        },
        signal,
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(execute).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst!({
        llmContent: 'first',
        returnDisplay: 'first',
      });
    });

    await waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(latestOnComplete).toHaveBeenCalled();
    });
    const reportedCallIds = latestOnComplete.mock.calls
      .flat(2)
      .map((call) => call.request.callId);
    expect(reportedCallIds).toEqual(
      expect.arrayContaining(['call-1', 'call-2']),
    );
    expect(firstOnComplete).not.toHaveBeenCalled();
  });

  it('resolves the tool registry lazily so a scheduler created before initialize still runs tools', async () => {
    const execute = vi.fn(
      (): Promise<ToolResult> =>
        Promise.resolve({
          llmContent: 'ok',
          returnDisplay: 'ok',
        }),
    );
    const mockTool = new MockTool({
      name: 'mockTool',
      displayName: 'Mock Tool',
      execute,
    });
    const mockToolRegistry = {
      getTool: vi.fn(() => mockTool),
      ensureTool: vi.fn(async () => mockTool),
      getAllToolNames: vi.fn(() => ['mockTool']),
    };
    const getToolRegistry = vi.fn(
      (): typeof mockToolRegistry | undefined => undefined,
    );
    const mockConfig = {
      getToolRegistry,
      getApprovalMode: () => ApprovalMode.YOLO,
      getSessionId: () => 'test-session-id',
      getUsageStatisticsEnabled: () => true,
      getDebugMode: () => false,
      storage: { getProjectTempDir: () => '/tmp' },
      getTruncateToolOutputThreshold: () => 4_000_000,
      getTruncateToolOutputLines: () => 1000,
      getPermissionsAllow: () => [],
      getContentGeneratorConfig: () => ({
        model: 'test-model',
        authType: 'gemini',
      }),
      getBaseLlmClient: vi.fn(),
      getUseModelRouter: () => false,
      getLlmClient: () => null,
      getShellExecutionConfig: () => ({
        terminalWidth: 80,
        terminalHeight: 24,
      }),
      getChatRecordingService: () => undefined,
      getMessageBus: () => undefined,
      getDisableAllHooks: () => true,
      getHookSystem: () => undefined,
      getDebugLogger: () => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
    } as unknown as Config;

    const onComplete = vi.fn(async (_tools: CompletedToolCall[]) => {});
    const { result, rerender } = renderHook(() =>
      useReactToolScheduler(onComplete, mockConfig, () => undefined, vi.fn()),
    );

    getToolRegistry.mockReturnValue(mockToolRegistry);
    rerender();

    act(() => {
      result.current[1](
        {
          callId: 'call-late-registry',
          name: 'mockTool',
          args: {},
          isClientInitiated: false,
          prompt_id: 'prompt-late-registry',
        },
        new AbortController().signal,
      );
    });

    await waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(onComplete).toHaveBeenCalled();
    });
    const completedCalls = onComplete.mock.calls[0]?.[0];
    expect(completedCalls?.[0]?.status).toBe('success');
  });
});
