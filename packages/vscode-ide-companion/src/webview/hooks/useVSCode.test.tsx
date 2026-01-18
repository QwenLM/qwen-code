/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * useVSCode Hook Tests
 *
 * Test objective: Ensure VSCode API communication works correctly, preventing WebView-Extension communication failures.
 *
 * Key test scenarios:
 * 1. API acquisition - Ensure VSCode API can be correctly acquired
 * 2. postMessage - Ensure messages can be sent to extension
 * 3. getState/setState - Ensure state can be correctly persisted
 * 4. Singleton pattern - Ensure API instance is created only once
 * 5. Fallback handling - Ensure fallback exists in non-VSCode environments
 */

/** @vitest-environment jsdom */

import type React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

// Declare global types
declare global {
  var acquireVsCodeApi:
    | (() => {
        postMessage: (message: unknown) => void;
        getState: () => unknown;
        setState: (state: unknown) => void;
      })
    | undefined;
}

// VSCode API interface
interface VSCodeAPI {
  postMessage: (message: unknown) => void;
  getState: () => unknown;
  setState: (state: unknown) => void;
}

// Test Harness component
function TestHarness({
  resultRef,
  useVSCode,
}: {
  resultRef: React.MutableRefObject<VSCodeAPI | null>;
  useVSCode: () => VSCodeAPI;
}) {
  const hookResult = useVSCode();
  resultRef.current = hookResult;
  return null;
}

// Helper function to render hook
async function renderVSCodeHook() {
  const { useVSCode } = await import('./useVSCode.js');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const resultRef: React.MutableRefObject<VSCodeAPI | null> = { current: null };

  act(() => {
    root.render(<TestHarness resultRef={resultRef} useVSCode={useVSCode} />);
  });

  return {
    result: resultRef as React.MutableRefObject<VSCodeAPI>,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe('useVSCode', () => {
  let originalAcquireVsCodeApi: typeof globalThis.acquireVsCodeApi;

  beforeEach(() => {
    // Save original value
    originalAcquireVsCodeApi = globalThis.acquireVsCodeApi;
    // Reset modules to clear cached API instance
    vi.resetModules();
  });

  afterEach(() => {
    // Restore original value
    globalThis.acquireVsCodeApi = originalAcquireVsCodeApi;
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  describe('API Acquisition - VSCode API acquisition', () => {
    /**
     * Test: Acquire VSCode API
     *
     * Verifies API can be correctly acquired in VSCode environment.
     * This is the foundation for WebView-Extension communication.
     */
    it('should acquire VSCode API when available', async () => {
      const mockApi = {
        postMessage: vi.fn(),
        getState: vi.fn(() => ({})),
        setState: vi.fn(),
      };

      globalThis.acquireVsCodeApi = vi.fn(() => mockApi);

      const { result, unmount } = await renderVSCodeHook();

      expect(result.current).toBeDefined();
      expect(result.current.postMessage).toBeDefined();
      expect(result.current.getState).toBeDefined();
      expect(result.current.setState).toBeDefined();

      unmount();
    });

    /**
     * Test: Development environment fallback
     *
     * Verifies mock implementation is provided in non-VSCode environments.
     * Allows development and testing in browser.
     */
    it('should provide fallback when acquireVsCodeApi is not available', async () => {
      globalThis.acquireVsCodeApi = undefined;

      const { result, unmount } = await renderVSCodeHook();

      expect(result.current).toBeDefined();
      expect(typeof result.current.postMessage).toBe('function');
      expect(typeof result.current.getState).toBe('function');
      expect(typeof result.current.setState).toBe('function');

      unmount();
    });
  });

  describe('postMessage - Message sending', () => {
    /**
     * Test: Send message to extension
     *
     * Verifies postMessage correctly calls VSCode API.
     * This is how WebView sends commands to extension.
     */
    it('should call postMessage on VSCode API', async () => {
      const mockPostMessage = vi.fn();
      globalThis.acquireVsCodeApi = vi.fn(() => ({
        postMessage: mockPostMessage,
        getState: vi.fn(() => ({})),
        setState: vi.fn(),
      }));

      const { result, unmount } = await renderVSCodeHook();

      const testMessage = { type: 'test', data: { foo: 'bar' } };
      result.current.postMessage(testMessage);

      expect(mockPostMessage).toHaveBeenCalledWith(testMessage);

      unmount();
    });

    /**
     * Test: Send different message types
     *
     * Verifies various message types can be correctly sent.
     */
    it('should handle different message types', async () => {
      const mockPostMessage = vi.fn();
      globalThis.acquireVsCodeApi = vi.fn(() => ({
        postMessage: mockPostMessage,
        getState: vi.fn(() => ({})),
        setState: vi.fn(),
      }));

      const { result, unmount } = await renderVSCodeHook();

      // Test various message types
      const messages = [
        { type: 'sendMessage', data: { content: 'Hello' } },
        { type: 'cancelStreaming', data: {} },
        { type: 'newSession', data: {} },
        { type: 'permissionResponse', data: { optionId: 'allow' } },
        { type: 'login', data: {} },
      ];

      messages.forEach((msg) => {
        result.current.postMessage(msg);
      });

      expect(mockPostMessage).toHaveBeenCalledTimes(messages.length);

      unmount();
    });
  });

  describe('getState/setState - State persistence', () => {
    /**
     * Test: Get state
     *
     * Verifies WebView persisted state can be correctly retrieved.
     */
    it('should get state from VSCode API', async () => {
      const mockState = { messages: [], sessionId: 'test-123' };
      globalThis.acquireVsCodeApi = vi.fn(() => ({
        postMessage: vi.fn(),
        getState: vi.fn(() => mockState),
        setState: vi.fn(),
      }));

      const { result, unmount } = await renderVSCodeHook();

      const state = result.current.getState();
      expect(state).toEqual(mockState);

      unmount();
    });

    /**
     * Test: Set state
     *
     * Verifies WebView persisted state can be correctly set.
     * State persists even after WebView is hidden.
     */
    it('should set state on VSCode API', async () => {
      const mockSetState = vi.fn();
      globalThis.acquireVsCodeApi = vi.fn(() => ({
        postMessage: vi.fn(),
        getState: vi.fn(() => ({})),
        setState: mockSetState,
      }));

      const { result, unmount } = await renderVSCodeHook();

      const newState = { messages: [{ content: 'test' }] };
      result.current.setState(newState);

      expect(mockSetState).toHaveBeenCalledWith(newState);

      unmount();
    });
  });

  describe('Singleton Pattern', () => {
    /**
     * Test: API instance created only once
     *
     * Verifies acquireVsCodeApi is called only once.
     * VSCode requires this function to be called only once.
     */
    it('should only call acquireVsCodeApi once', async () => {
      const mockAcquire = vi.fn(() => ({
        postMessage: vi.fn(),
        getState: vi.fn(() => ({})),
        setState: vi.fn(),
      }));
      globalThis.acquireVsCodeApi = mockAcquire;

      const { unmount: unmount1 } = await renderVSCodeHook();
      const { unmount: unmount2 } = await renderVSCodeHook();
      const { unmount: unmount3 } = await renderVSCodeHook();

      // acquireVsCodeApi should only be called once
      expect(mockAcquire).toHaveBeenCalledTimes(1);

      unmount1();
      unmount2();
      unmount3();
    });
  });

  describe('Fallback Behavior', () => {
    /**
     * Test: Fallback postMessage doesn't throw
     *
     * Verifies mock postMessage works in development environment.
     */
    it('should not throw on fallback postMessage', async () => {
      globalThis.acquireVsCodeApi = undefined;

      const { result, unmount } = await renderVSCodeHook();

      expect(() => {
        result.current.postMessage({ type: 'test', data: {} });
      }).not.toThrow();

      unmount();
    });

    /**
     * Test: Fallback getState returns empty object
     *
     * Verifies getState returns empty object in development environment.
     */
    it('should return empty object on fallback getState', async () => {
      globalThis.acquireVsCodeApi = undefined;

      const { result, unmount } = await renderVSCodeHook();

      const state = result.current.getState();
      expect(state).toEqual({});

      unmount();
    });

    /**
     * Test: Fallback setState doesn't throw
     *
     * Verifies mock setState works in development environment.
     */
    it('should not throw on fallback setState', async () => {
      globalThis.acquireVsCodeApi = undefined;

      const { result, unmount } = await renderVSCodeHook();

      expect(() => {
        result.current.setState({ test: 'value' });
      }).not.toThrow();

      unmount();
    });
  });
});
