/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import type { Part } from '@google/genai';
import type {
  Config,
  ToolCallRequestInfo,
  ToolInvocationGuard,
} from '@qwen-code/qwen-code-core';
import { CoreToolScheduler } from '@qwen-code/qwen-code-core';
import { act, renderHook, waitFor } from '@testing-library/react';
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

describe('useReactToolScheduler turn guard forwarding', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const request: ToolCallRequestInfo = {
    callId: 'guarded-call',
    name: 'read_file',
    args: { file_path: 'README.md' },
    isClientInitiated: false,
    prompt_id: 'guarded-prompt',
  };
  const guard: ToolInvocationGuard = async () => ({ allowed: true });

  function renderScheduler(config: Config) {
    return renderHook(() =>
      useReactToolScheduler(
        async () => {},
        config,
        () => undefined,
        () => {},
      ),
    );
  }

  function createConfig(overrides: Record<string, unknown> = {}): Config {
    return {
      getToolRegistry: vi.fn().mockReturnValue({}),
      ...overrides,
    } as unknown as Config;
  }

  it('forwards the guard on the ordinary scheduler path', () => {
    const schedule = vi
      .spyOn(CoreToolScheduler.prototype, 'schedule')
      .mockResolvedValue();
    const config = createConfig();
    const { result } = renderScheduler(config);
    const signal = new AbortController().signal;

    act(() => result.current[1](request, signal, undefined, guard));

    expect(schedule).toHaveBeenCalledWith(request, signal, undefined, guard);
  });

  it('forwards the guard after resolving a full-turn model runtime', async () => {
    const runtimeView = {};
    const resolveForModel = vi.fn().mockResolvedValue(runtimeView);
    const schedule = vi
      .spyOn(CoreToolScheduler.prototype, 'schedule')
      .mockResolvedValue();
    const config = createConfig({
      getBaseLlmClient: vi.fn().mockReturnValue({ resolveForModel }),
    });
    const { result } = renderScheduler(config);
    const signal = new AbortController().signal;

    act(() => result.current[1](request, signal, 'guard-model\0', guard));

    await waitFor(() => {
      expect(schedule).toHaveBeenCalledWith(
        request,
        signal,
        runtimeView,
        guard,
      );
    });
    expect(resolveForModel).toHaveBeenCalledWith('guard-model', {
      failClosed: true,
    });
  });
});

describe('useReactToolScheduler', () => {
  it('handles a queued tool cancellation at the fire-and-forget boundary', async () => {
    const scheduleSpy = vi
      .spyOn(CoreToolScheduler.prototype, 'schedule')
      .mockRejectedValueOnce(new Error('Tool call cancelled while in queue.'));
    const abortController = new AbortController();
    abortController.abort();

    const { result } = renderHook(() =>
      useReactToolScheduler(
        vi.fn(),
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
    scheduleSpy.mockRestore();
  });
});
