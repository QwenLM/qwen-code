/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import type { MutableRefObject } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { VSCodeAPI } from '../useVSCode.js';
import { useSessionManagement } from './useSessionManagement.js';

function HookHarness({
  api,
  resultRef,
}: {
  api: VSCodeAPI;
  resultRef: MutableRefObject<ReturnType<typeof useSessionManagement> | null>;
}) {
  const result = useSessionManagement(api);
  resultRef.current = result;
  return null;
}

const renderHook = (api: VSCodeAPI) => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const resultRef: MutableRefObject<ReturnType<
    typeof useSessionManagement
  > | null> = {
    current: null,
  };

  act(() => {
    root.render(<HookHarness api={api} resultRef={resultRef} />);
  });

  return {
    resultRef: resultRef as MutableRefObject<
      ReturnType<typeof useSessionManagement>
    >,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
};

describe('useSessionManagement', () => {
  let api: VSCodeAPI;

  beforeEach(() => {
    api = {
      postMessage: vi.fn(),
      getState: vi.fn(() => ({})),
      setState: vi.fn(),
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  it('loads sessions and opens selector', () => {
    const { resultRef, unmount } = renderHook(api);

    act(() => {
      resultRef.current.handleLoadQwenSessions();
    });

    expect(api.postMessage).toHaveBeenCalledWith({
      type: 'getQwenSessions',
      data: { size: 20 },
    });
    expect(resultRef.current.showSessionSelector).toBe(true);
    expect(resultRef.current.isLoading).toBe(true);
    expect(resultRef.current.nextCursor).toBeUndefined();
    expect(resultRef.current.hasMore).toBe(true);

    unmount();
  });

  it('loads more sessions when cursor is available', () => {
    const { resultRef, unmount } = renderHook(api);

    act(() => {
      resultRef.current.setNextCursor(42);
      resultRef.current.setHasMore(true);
      resultRef.current.setIsLoading(false);
    });

    act(() => {
      resultRef.current.handleLoadMoreSessions();
    });

    expect(api.postMessage).toHaveBeenCalledWith({
      type: 'getQwenSessions',
      data: { cursor: 42, size: 20 },
    });

    unmount();
  });

  it('does not switch when selecting current session', () => {
    const { resultRef, unmount } = renderHook(api);

    act(() => {
      resultRef.current.setCurrentSessionId('abc');
    });

    act(() => {
      resultRef.current.handleSwitchSession('abc');
    });

    expect(api.postMessage).not.toHaveBeenCalled();
    expect(resultRef.current.showSessionSelector).toBe(false);

    unmount();
  });

  it('switches session and posts message for new id', () => {
    const { resultRef, unmount } = renderHook(api);

    act(() => {
      resultRef.current.handleSwitchSession('xyz');
    });

    expect(api.postMessage).toHaveBeenCalledWith({
      type: 'switchQwenSession',
      data: { sessionId: 'xyz' },
    });

    unmount();
  });

  it('stores saved session tags from response', () => {
    const { resultRef, unmount } = renderHook(api);

    act(() => {
      resultRef.current.handleSaveSessionResponse({
        success: true,
        message: 'saved with tag: foo',
      });
    });

    expect(resultRef.current.savedSessionTags).toEqual(['foo']);

    unmount();
  });
});
