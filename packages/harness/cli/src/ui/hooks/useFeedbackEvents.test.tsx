/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { renderHook } from '../../test-utils/render.js';
import { coreEvents } from '@qwen-code/core';
import { MessageType } from '../types.js';
import { useFeedbackEvents } from './useFeedbackEvents.js';

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual = await importOriginal();
  const handlers = new Map<string, (payload: unknown) => void>();
  return {
    ...(actual as Record<string, unknown>),
    coreEvents: {
      ...((actual as Record<string, unknown>)['coreEvents'] as Record<
        string,
        unknown
      >),
      on: vi.fn((event: string, handler: (payload: unknown) => void) => {
        handlers.set(event, handler);
      }),
      off: vi.fn((event: string) => {
        handlers.delete(event);
      }),
      drainBacklogs: vi.fn(),
      _trigger: (event: string, payload: unknown) => {
        handlers.get(event)?.(payload);
      },
    },
    runLogger: { warn: vi.fn() },
  };
});

describe('useFeedbackEvents', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('drains backlog on mount', async () => {
    const addItem = vi.fn();
    await renderHook(() => useFeedbackEvents({ addItem }));
    expect(coreEvents.drainBacklogs).toHaveBeenCalled();
  });

  it('routes UserFeedback severities to MessageType variants', async () => {
    const addItem = vi.fn();
    await renderHook(() => useFeedbackEvents({ addItem }));

    act(() => {
      // @ts-expect-error - test helper
      coreEvents._trigger('user-feedback', {
        severity: 'error',
        message: 'boom',
      });
      // @ts-expect-error - test helper
      coreEvents._trigger('user-feedback', {
        severity: 'warning',
        message: 'careful',
      });
      // @ts-expect-error - test helper
      coreEvents._trigger('user-feedback', {
        severity: 'info',
        message: 'fyi',
      });
    });

    expect(
      addItem.mock.calls.map((c) => (c[0] as { type: MessageType }).type),
    ).toEqual([MessageType.ERROR, MessageType.WARNING, MessageType.INFO]);
  });

  it('preserves the instruction to omit feedback from the transcript', async () => {
    const addItem = vi.fn();
    await renderHook(() => useFeedbackEvents({ addItem }));

    act(() => {
      // @ts-expect-error - test helper
      coreEvents._trigger('user-feedback', {
        severity: 'info',
        message: 'display only',
        omitFromTranscript: true,
      });
    });

    expect(addItem).toHaveBeenCalledWith(
      {
        type: MessageType.INFO,
        text: 'display only',
        omitFromTranscript: true,
      },
      expect.any(Number),
    );
  });

  it('throws on unknown severity', async () => {
    const addItem = vi.fn();
    await renderHook(() => useFeedbackEvents({ addItem }));

    expect(() =>
      act(() => {
        // @ts-expect-error - test helper
        coreEvents._trigger('user-feedback', {
          severity: 'critical',
          message: '?',
        });
      }),
    ).toThrow(/Unexpected severity/);
  });

  it('logs error details to runLogger when payload.error is present', async () => {
    const addItem = vi.fn();
    await renderHook(() => useFeedbackEvents({ addItem }));
    const { runLogger } = await import('@qwen-code/core');

    act(() => {
      // @ts-expect-error - test helper
      coreEvents._trigger('user-feedback', {
        severity: 'error',
        message: 'oops',
        error: new Error('detail'),
      });
    });

    expect(runLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('oops'),
      expect.any(Error),
    );
  });
});
